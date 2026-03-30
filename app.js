// ─── State ───────────────────────────────────────────────────────────────────

const state = {
  supervisors: [],
  running: true,
  speed: 5,
  stats: { processed: 0, failed: 0, retried: 0 },
  editingId: null,
};

let _id = 1;
const uid = () => _id++;

const QUEUE_COLORS = [
  '#6c63ff', '#3ecf8e', '#f59e0b', '#ef4444',
  '#06b6d4', '#a78bfa', '#f97316', '#ec4899',
];

function queueColor(i) { return QUEUE_COLORS[i % QUEUE_COLORS.length]; }

// ─── Supervisor / Worker Factories ───────────────────────────────────────────

function makeWorker(index, assignedQueue = null, bornAt = null) {
  return {
    id: uid(),
    index,
    state: 'idle',       // idle | busy | done | failed
    queue: null,         // currently processing queue name
    assignedQueue,       // simple-mode: locked to this queue
    jobId: null,
    progress: 0,
    label: `W${index + 1}`,
    _job: null,
    _startReal: null,
    _flashAt: null,
    _idleSince: null,    // real ms when became idle (for rest)
    _lastEmptyAt: null,  // real ms when last found queue empty (for sleep)
    _jobsProcessed: 0,   // jobs completed (for maxJobs recycling)
    _bornAt: bornAt !== null ? bornAt : performance.now(), // for maxTime recycling
    _recycle: false,     // flag: replace with fresh worker after current job
  };
}

function buildWorkersForSupervisor(sv) {
  if (sv.balance === 'simple') {
    // Evenly split processes across queues (first queues get remainder)
    const workers = [];
    const n = sv.queues.length;
    let wi = 0;
    sv.queues.forEach((q, qi) => {
      const base = Math.floor(sv.processes / n);
      const count = base + (qi < sv.processes % n ? 1 : 0);
      for (let i = 0; i < count; i++) {
        workers.push(makeWorker(wi++, q.name));
      }
    });
    return workers;
  }
  // auto / false: shared pool starting at minProcesses total
  const startCount = sv.balance === 'auto'
    ? sv.minProcesses * sv.queues.length
    : sv.minProcesses;
  return Array.from({ length: Math.max(1, startCount) }, (_, i) => makeWorker(i));
}

function createSupervisor(opts = {}) {
  const balance = opts.balance || 'auto';
  const queues = (opts.queues || ['default']).map((name, i) => ({
    name,
    color: queueColor(i),
    pending: [],
    processed: 0,
    failed: 0,
  }));

  const sv = {
    id: uid(),
    name: opts.name || `supervisor-${state.supervisors.length + 1}`,
    connection: opts.connection || 'redis',
    balance,
    // simple
    processes: opts.processes || 4,
    // auto & false
    minProcesses: opts.minProcesses || 1,
    maxProcesses: opts.maxProcesses || 10,
    // auto only
    autoScalingStrategy: opts.autoScalingStrategy || 'size',
    balanceMaxShift: opts.balanceMaxShift || 1,
    balanceCooldown: opts.balanceCooldown || 3,
    // job behavior
    jobRuntime: opts.jobRuntime || 800,
    failureRate: opts.failureRate || 5,
    tries: opts.tries || 1,
    timeout: opts.timeout || 60,
    backoff: opts.backoff || [0],
    // worker lifecycle
    sleep: opts.sleep ?? 3,
    rest: opts.rest ?? 0,
    maxJobs: opts.maxJobs ?? 0,
    maxTime: opts.maxTime ?? 0,
    memory: opts.memory ?? 128,
    // runtime
    queues,
    workers: [],
    retryPool: [], // [{job, queueName, retryAt (real ms)}]
    _lastBalanceAt: null,
  };

  sv.workers = buildWorkersForSupervisor(sv);
  return sv;
}


// ─── Dispatch ────────────────────────────────────────────────────────────────

function dispatchToQueue(value, count) {
  const [svId, queueName] = value.split('|');
  const sv = state.supervisors.find(s => s.id == svId);
  if (!sv) return;

  const q = sv.queues.find(q => q.name === queueName);
  if (!q) return;

  for (let i = 0; i < count; i++) {
    q.pending.push({ id: uid(), attempts: 0 });
  }
}

// ─── Tick ────────────────────────────────────────────────────────────────────

let lastTick = performance.now();
let throughputWindow = [];

function tick(now) {
  if (!state.running) { lastTick = now; return; }
  lastTick = now;

  for (const sv of state.supervisors) tickSupervisor(sv, now);

  updateStats(now);
  render();
}

function tickSupervisor(sv, now) {
  // Move retry jobs back to queue when their backoff expires
  for (let i = sv.retryPool.length - 1; i >= 0; i--) {
    const entry = sv.retryPool[i];
    if (now >= entry.retryAt) {
      const q = sv.queues.find(q => q.name === entry.queueName);
      if (q) q.pending.unshift(entry.job); // high priority — front of queue
      sv.retryPool.splice(i, 1);
    }
  }

  // Advance busy workers
  for (const worker of sv.workers) {
    if (worker.state !== 'busy') continue;

    const elapsed = now * state.speed - worker._startReal;
    const timeoutElapsed = elapsed >= sv.timeout * 1000;
    const runtimeElapsed = elapsed >= sv.jobRuntime;

    worker.progress = Math.min(1, elapsed / sv.jobRuntime);

    if (runtimeElapsed || timeoutElapsed) {
      const job = worker._job;
      const failed = timeoutElapsed || (Math.random() * 100 < sv.failureRate);

      if (failed && job.attempts < sv.tries) {
        // Retry: calculate backoff delay (exponential if array)
        const backoffSec = Array.isArray(sv.backoff)
          ? (sv.backoff[job.attempts] ?? sv.backoff[sv.backoff.length - 1])
          : sv.backoff;
        const backoffReal = (backoffSec * 1000) / state.speed;
        sv.retryPool.push({ job: { ...job, attempts: job.attempts + 1 }, queueName: worker.queue, retryAt: now + backoffReal });
        state.stats.retried++;
        worker.state = 'failed'; // show failed flash before retry
      } else if (failed) {
        const q = sv.queues.find(q => q.name === worker.queue);
        if (q) q.failed++;
        state.stats.failed++;
        worker._jobsProcessed++;
        worker.state = 'failed';
      } else {
        const q = sv.queues.find(q => q.name === worker.queue);
        if (q) q.processed++;
        state.stats.processed++;
        throughputWindow.push(now);
        worker._jobsProcessed++;
        worker.state = 'done';
      }

      // Flag for recycling if maxJobs or maxTime exceeded
      if (!worker._recycle) {
        if (sv.maxJobs > 0 && worker._jobsProcessed >= sv.maxJobs) worker._recycle = true;
        if (sv.maxTime > 0 && (now - worker._bornAt) * state.speed >= sv.maxTime * 1000) worker._recycle = true;
      }

      worker._flashAt = now;
      worker._job = null;
    }
  }

  // Flash done/failed → idle (or recycle)
  for (let i = sv.workers.length - 1; i >= 0; i--) {
    const worker = sv.workers[i];
    if ((worker.state === 'done' || worker.state === 'failed') && worker._flashAt) {
      if (now - worker._flashAt > 350 / state.speed) {
        if (worker._recycle) {
          sv.workers[i] = makeWorker(worker.index, worker.assignedQueue, now);
        } else {
          worker.state = 'idle';
          worker.queue = null;
          worker.progress = 0;
          worker._flashAt = null;
          worker._idleSince = now;
        }
      }
    }
  }

  // Recycle idle workers that exceeded maxTime
  if (sv.maxTime > 0) {
    for (let i = sv.workers.length - 1; i >= 0; i--) {
      const w = sv.workers[i];
      if (w.state === 'idle' && (now - w._bornAt) * state.speed >= sv.maxTime * 1000) {
        sv.workers[i] = makeWorker(w.index, w.assignedQueue, now);
      }
    }
  }

  // Scale workers (auto and false balance)
  if (sv.balance !== 'simple') scaleWorkers(sv, now);

  // Assign work to idle workers
  assignWork(sv, now);
}

// ─── Scaling ─────────────────────────────────────────────────────────────────

function scaleWorkers(sv, now) {
  // Respect balanceCooldown
  const cooldownReal = (sv.balanceCooldown * 1000) / state.speed;
  if (sv._lastBalanceAt !== null && now - sv._lastBalanceAt < cooldownReal) return;
  sv._lastBalanceAt = now;

  const busyCount = sv.workers.filter(w => w.state === 'busy').length;
  const numQueues = sv.queues.length;
  let target;

  if (sv.balance === 'auto') {
    // minProcesses = per queue, maxProcesses = total
    const minTotal = sv.minProcesses * numQueues;

    if (sv.autoScalingStrategy === 'size') {
      const totalPending = sv.queues.reduce((s, q) => s + q.pending.length, 0);
      target = clamp(totalPending + busyCount, minTotal, sv.maxProcesses);
    } else {
      // time: scale proportionally to queue with most jobs * runtime
      const maxQueueJobs = Math.max(...sv.queues.map(q => q.pending.length));
      const needWorkers = Math.ceil(maxQueueJobs / Math.max(1, sv.jobRuntime / 1000));
      target = clamp(needWorkers + busyCount, minTotal, sv.maxProcesses);
    }
  } else {
    // balance: false — minProcesses/maxProcesses are TOTAL
    const totalPending = sv.queues.reduce((s, q) => s + q.pending.length, 0);
    target = clamp(totalPending + busyCount, sv.minProcesses, sv.maxProcesses);
  }

  const current = sv.workers.length;
  const diff = target - current;
  const shift = Math.min(sv.balanceMaxShift, Math.abs(diff));

  if (diff > 0) {
    for (let i = 0; i < shift; i++) sv.workers.push(makeWorker(sv.workers.length, null, now));
  } else if (diff < 0) {
    let removed = 0;
    for (let i = sv.workers.length - 1; i >= 0 && removed < shift; i--) {
      if (sv.workers[i].state === 'idle') { sv.workers.splice(i, 1); removed++; }
    }
  }
}

function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }

// ─── Work Assignment ─────────────────────────────────────────────────────────

function isWorkerAvailable(worker, sv, now) {
  if (worker.state !== 'idle') return false;
  // rest: mandatory idle period after each job
  if (sv.rest > 0 && worker._idleSince !== null &&
      (now - worker._idleSince) * state.speed < sv.rest * 1000) return false;
  // sleep: poll interval after finding queue empty
  if (sv.sleep > 0 && worker._lastEmptyAt !== null &&
      (now - worker._lastEmptyAt) * state.speed < sv.sleep * 1000) return false;
  return true;
}

function assignWork(sv, now) {
  if (sv.balance === 'auto') return assignAuto(sv, now);
  if (sv.balance === 'simple') return assignSimple(sv, now);
  /* false */                  return assignPriority(sv, now);
}

function assignAuto(sv, now) {
  // Docs: does NOT enforce strict queue priority — assigns by load
  const sortedQueues = [...sv.queues].sort((a, b) => {
    if (sv.autoScalingStrategy === 'time') {
      return (b.pending.length * sv.jobRuntime) - (a.pending.length * sv.jobRuntime);
    }
    return b.pending.length - a.pending.length;
  });

  for (const worker of sv.workers) {
    if (!isWorkerAvailable(worker, sv, now)) continue;
    const q = sortedQueues.find(q => q.pending.length > 0);
    if (!q) { worker._lastEmptyAt = now; break; }
    assignWorkerToJob(worker, q, now);
  }
}

function assignSimple(sv, now) {
  // Workers are locked to their assigned queue
  for (const worker of sv.workers) {
    if (!isWorkerAvailable(worker, sv, now)) continue;
    const q = sv.queues.find(q => q.name === worker.assignedQueue);
    if (!q) continue;
    if (q.pending.length > 0) {
      assignWorkerToJob(worker, q, now);
    } else {
      worker._lastEmptyAt = now;
    }
  }
}

function assignPriority(sv, now) {
  // Docs: strict queue order — first queue always processed first
  // Workers only move to next queue when higher-priority queue is empty
  for (const worker of sv.workers) {
    if (!isWorkerAvailable(worker, sv, now)) continue;
    let assigned = false;
    for (const q of sv.queues) {
      if (q.pending.length > 0) {
        assignWorkerToJob(worker, q, now);
        assigned = true;
        break;
      }
    }
    if (!assigned) { worker._lastEmptyAt = now; break; }
  }
}

function assignWorkerToJob(worker, queue, now) {
  const job = queue.pending.shift();
  if (!job) return;
  worker.state = 'busy';
  worker.queue = queue.name;
  worker.jobId = job.id;
  worker.progress = 0;
  worker._startReal = now * state.speed;
  worker._flashAt = null;
  worker._job = { ...job, attempts: job.attempts + 1 };
  worker._idleSince = null;
  worker._lastEmptyAt = null;
}

// ─── Stats ───────────────────────────────────────────────────────────────────

function updateStats(now) {
  throughputWindow = throughputWindow.filter(t => now - t < 1000);
  document.getElementById('stat-throughput').textContent = Math.round(throughputWindow.length * state.speed);
  document.getElementById('stat-processed').textContent = state.stats.processed;
  document.getElementById('stat-retried').textContent = state.stats.retried;
  document.getElementById('stat-failed').textContent = state.stats.failed;

  const pending = state.supervisors.reduce((s, sv) =>
    s + sv.queues.reduce((qs, q) => qs + q.pending.length, 0)
    + sv.retryPool.length, 0);
  document.getElementById('stat-pending').textContent = pending;

  const active = state.supervisors.reduce((s, sv) =>
    s + sv.workers.filter(w => w.state === 'busy').length, 0);
  document.getElementById('stat-workers').textContent = active;
}

// ─── Render ───────────────────────────────────────────────────────────────────

function render() {
  const container = document.getElementById('supervisors-view');

  if (state.supervisors.length === 0) {
    container.innerHTML = `
      <div class="flex flex-col items-center justify-center gap-3 p-16 text-hz-muted text-center">
        <div class="text-4xl opacity-20">&#9670;</div>
        <p class="text-xs">No supervisors.<br>Add one from the sidebar.</p>
      </div>`;
    return;
  }

  for (const sv of state.supervisors) {
    let card = document.getElementById(`sv-card-${sv.id}`);
    if (!card) {
      card = document.createElement('div');
      card.className = 'bg-hz-surface border border-hz-border rounded-xl overflow-hidden';
      card.id = `sv-card-${sv.id}`;
      container.appendChild(card);
    }
    renderSupervisorCard(card, sv);
  }

  const ids = new Set(state.supervisors.map(s => `sv-card-${s.id}`));
  for (const child of [...container.children]) {
    if (!ids.has(child.id)) child.remove();
  }
}

function renderSupervisorCard(card, sv) {
  const busyCount = sv.workers.filter(w => w.state === 'busy').length;
  const retrying = sv.retryPool.length;

  const strategyLabel = sv.balance === 'auto'
    ? `auto · ${sv.autoScalingStrategy}`
    : sv.balance === 'simple'
      ? `simple · ${sv.processes} proc`
      : `priority`;

  let header = card.querySelector('[data-role="sv-header"]');
  if (!header) { header = document.createElement('div'); header.dataset.role = 'sv-header'; header.className = 'flex items-center justify-between px-4 py-3 border-b border-hz-border bg-hz-surface2'; card.appendChild(header); }

  header.innerHTML = `
    <div class="flex items-center gap-2 text-sm font-bold text-hz-txt flex-wrap">
      <span>${sv.name}</span>
      <span class="text-[10px] px-2 py-0.5 rounded-full font-semibold bg-violet-500/20 text-violet-500 border border-violet-500/40">${strategyLabel}</span>
      <span class="text-[10px] px-2 py-0.5 rounded-full font-semibold bg-emerald-500/15 text-emerald-500 border border-emerald-500/30">${sv.workers.length} workers</span>
      ${retrying > 0 ? `<span class="text-[10px] px-2 py-0.5 rounded-full font-semibold bg-amber-500/15 text-amber-500 border border-amber-500/30">&#8635; ${retrying} retrying</span>` : ''}
    </div>
    <div class="text-[11px] text-hz-muted flex gap-3 flex-wrap">
      <span>${sv.queues.map((q, i) => `<span style="color:${q.color}">&#9679;</span> ${q.name}${sv.balance === 'false' && i < sv.queues.length - 1 ? ' &gt;' : ''}`).join(' ')}</span>
      <span>${busyCount}/${sv.workers.length} busy · tries:${sv.tries} · timeout:${sv.timeout}s${sv.sleep > 0 ? ` · sleep:${sv.sleep}s` : ''}${sv.rest > 0 ? ` · rest:${sv.rest}s` : ''}${sv.maxJobs > 0 ? ` · maxJobs:${sv.maxJobs}` : ''}${sv.maxTime > 0 ? ` · maxTime:${sv.maxTime}s` : ''}</span>
    </div>
  `;

  let body = card.querySelector('[data-role="sv-body"]');
  if (!body) { body = document.createElement('div'); body.dataset.role = 'sv-body'; body.className = 'p-4 flex flex-col gap-4'; card.appendChild(body); }

  for (const q of sv.queues) {
    const key = `${sv.id}-${q.name}`;
    let row = body.querySelector(`[data-queue="${key}"]`);
    if (!row) { row = document.createElement('div'); row.className = 'flex flex-col gap-1.5'; row.dataset.queue = key; body.appendChild(row); }
    renderQueueRow(row, sv, q);
  }
  const queueKeys = new Set(sv.queues.map(q => `${sv.id}-${q.name}`));
  for (const child of [...body.querySelectorAll('[data-queue]')]) {
    if (!queueKeys.has(child.dataset.queue)) child.remove();
  }

  let workersSec = body.querySelector('[data-role="workers"]');
  if (!workersSec) { workersSec = document.createElement('div'); workersSec.dataset.role = 'workers'; body.appendChild(workersSec); }
  renderWorkers(workersSec, sv);
}

function renderQueueRow(row, sv, q) {
  const queueWorkers = sv.workers.filter(w => w.state === 'busy' && w.queue === q.name);
  const retryingHere = sv.retryPool.filter(r => r.queueName === q.name).length;
  const priorityIdx = sv.balance === 'false' ? sv.queues.indexOf(q) : -1;

  row.innerHTML = `
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-1.5 text-xs font-semibold text-hz-muted">
        <span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${q.color};flex-shrink:0"></span>
        ${priorityIdx >= 0 ? `<span class="text-[9px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-500 border border-red-500/25 font-bold">#${priorityIdx + 1}</span>` : ''}
        <span class="text-hz-txt">${q.name}</span>
      </div>
      <div class="flex gap-3 text-[11px]">
        ${retryingHere > 0 ? `<span class="text-amber-500">&#8635; ${retryingHere}</span>` : ''}
        <span class="text-hz-muted">&#9632; ${q.pending.length}</span>
        <span class="text-emerald-500">&#10003; ${q.processed}</span>
        <span class="text-red-500">&#10007; ${q.failed}</span>
      </div>
    </div>
    <div class="flex flex-wrap items-center gap-1 min-h-7 bg-hz-surface2 rounded p-1.5 overflow-hidden">
      ${renderJobBubbles(q, queueWorkers, q.color)}
      ${q.pending.length === 0 && queueWorkers.length === 0
      ? '<span class="text-[10px] text-hz-muted opacity-50">empty</span>'
      : ''}
    </div>
    <div class="h-0.5 bg-hz-surface2 rounded-full overflow-hidden">
      <div style="background:${q.color};width:${Math.min(100, q.pending.length * 4)}%" class="h-full rounded-full transition-all duration-300"></div>
    </div>
  `;
}

function renderJobBubbles(q, queueWorkers, color) {
  const MAX = 50;
  let html = '';
  for (let i = 0; i < queueWorkers.length; i++) {
    html += `<div class="job-processing inline-block w-3.5 h-3.5 rounded-sm flex-shrink-0" style="background:${color}"></div>`;
  }
  const show = Math.min(q.pending.length, MAX);
  for (let i = 0; i < show; i++) {
    html += `<div class="inline-block w-3.5 h-3.5 rounded-sm flex-shrink-0 opacity-50" style="background:${color}"></div>`;
  }
  if (q.pending.length > MAX) {
    html += `<span class="text-[10px] text-hz-muted ml-1">+${q.pending.length - MAX}</span>`;
  }
  return html;
}

function renderWorkers(section, sv) {
  const lifecycleHint = [
    sv.maxJobs > 0 ? `recycle/${sv.maxJobs}jobs` : '',
    sv.maxTime > 0 ? `recycle/${sv.maxTime}s` : '',
  ].filter(Boolean).join(' · ');

  const hint = (sv.balance === 'simple'
    ? 'queue-dedicated · no scaling'
    : sv.balance === 'auto'
      ? `min ${sv.minProcesses}/queue · max ${sv.maxProcesses} total · shift ${sv.balanceMaxShift}`
      : `min ${sv.minProcesses} · max ${sv.maxProcesses} total · strict priority`)
    + (lifecycleHint ? ` · ${lifecycleHint}` : '');

  section.innerHTML = `
    <div class="flex flex-col gap-2">
      <div class="flex items-center gap-2">
        <span class="text-[10px] uppercase tracking-widest text-hz-muted">Workers</span>
        <span class="text-[10px] text-hz-muted opacity-60">${hint}</span>
      </div>
      <div class="flex flex-wrap gap-1.5">
        ${sv.workers.map(w => renderWorker(w, sv)).join('')}
      </div>
    </div>
  `;
}

function renderWorker(w, sv) {
  const now = performance.now();

  // Rest: mandatory idle period after job completion
  const inRest = w.state === 'idle' && sv.rest > 0 && w._idleSince !== null &&
    (now - w._idleSince) * state.speed < sv.rest * 1000;

  // Sleep: poll delay after finding queue empty (only when not already in rest)
  const inSleep = !inRest && w.state === 'idle' && sv.sleep > 0 && w._lastEmptyAt !== null &&
    (now - w._lastEmptyAt) * state.speed < sv.sleep * 1000;

  const restProgress  = inRest  ? Math.max(0, 1 - (now - w._idleSince)   * state.speed / (sv.rest  * 1000)) : 0;
  const sleepProgress = inSleep ? Math.max(0, 1 - (now - w._lastEmptyAt) * state.speed / (sv.sleep * 1000)) : 0;
  const restRemain    = inRest  ? Math.max(0, Math.ceil((sv.rest  * 1000 - (now - w._idleSince)   * state.speed) / 1000)) : 0;
  const sleepRemain   = inSleep ? Math.max(0, Math.ceil((sv.sleep * 1000 - (now - w._lastEmptyAt) * state.speed) / 1000)) : 0;

  const activeQ = sv.queues.find(q => q.name === (w.queue || w.assignedQueue));
  const color = activeQ?.color || null;
  const assignedQ = (w.state === 'idle' && w.assignedQueue)
    ? sv.queues.find(q => q.name === w.assignedQueue)
    : null;
  const idleColor = assignedQ?.color || null;

  let borderStyle, bgStyle, stateClass, innerContent, progressBar;

  if (inRest) {
    borderStyle = 'border-color:#f59e0b88';
    bgStyle     = 'background:#f59e0b0d';
    stateClass  = '';
    innerContent = `<span style="color:#f59e0b;font-size:8px;line-height:1">${restRemain}s</span>`;
    progressBar  = `<div class="absolute bottom-0 left-0 h-0.5" style="width:${Math.round(restProgress * 100)}%;background:#f59e0b"></div>`;
  } else if (inSleep) {
    borderStyle = 'border-color:#06b6d433';
    bgStyle     = '';
    stateClass  = 'bg-hz-surface2';
    innerContent = `<span style="color:#06b6d4;font-size:8px;line-height:1">${sleepRemain}s</span>`;
    progressBar  = `<div class="absolute bottom-0 left-0 h-0.5" style="width:${Math.round(sleepProgress * 100)}%;background:#06b6d4"></div>`;
  } else {
    borderStyle = w.state === 'busy' && color
      ? `border-color:${color}`
      : idleColor ? `border-color:${idleColor}44` : '';
    bgStyle    = w.state === 'busy' && color ? `background:${color}22` : '';
    stateClass = {
      idle:   'border-hz-border bg-hz-surface2 text-hz-muted',
      busy:   'text-violet-500',
      done:   'border-emerald-500/50 bg-emerald-500/10 text-emerald-500',
      failed: 'border-red-500/50 bg-red-500/10 text-red-500',
    }[w.state] || '';
    innerContent = `
      ${w.state === 'idle'   ? `<span style="${idleColor ? `color:${idleColor}` : ''}">${w.label}</span>` : ''}
      ${w.state === 'busy'   ? `<span style="color:${color}">${w.label}</span>` : ''}
      ${w.state === 'done'   ? '&#10003;' : ''}
      ${w.state === 'failed' ? '&#10007;' : ''}
    `;
    progressBar = w.state === 'busy'
      ? `<div class="absolute bottom-0 left-0 h-0.5 transition-all duration-100" style="width:${Math.round(w.progress * 100)}%;background:${color}"></div>`
      : '';
  }

  const titleSuffix = inRest ? ` · rest ${restRemain}s` : inSleep ? ` · sleep ${sleepRemain}s` : '';

  return `
    <div class="relative w-9 h-9 rounded flex items-center justify-center text-[9px] font-bold border overflow-hidden ${stateClass}"
         style="${borderStyle};${bgStyle}"
         title="${w.label}${w.queue ? ` · ${w.queue}` : w.assignedQueue ? ` → ${w.assignedQueue}` : ' · idle'}${titleSuffix}">
      ${innerContent}
      ${progressBar}
    </div>
  `;
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────

function renderSidebarSupervisors() {
  document.getElementById('supervisors-list').innerHTML = state.supervisors.map(sv => `
    <div class="bg-hz-surface2 border border-hz-border rounded px-2.5 py-2 flex items-center justify-between gap-2">
      <span class="text-xs font-semibold text-hz-txt truncate flex-1">${sv.name}</span>
      <div class="flex gap-1 shrink-0">
        <button onclick="openEditModal(${sv.id})" class="text-hz-muted hover:text-hz-txt text-xs px-1.5 py-0.5 rounded transition-colors cursor-pointer">&#9998;</button>
        <button onclick="removeSupervisor(${sv.id})" class="text-hz-muted hover:text-red-500 text-xs px-1.5 py-0.5 rounded transition-colors cursor-pointer">&#10005;</button>
      </div>
    </div>
  `).join('');

  document.getElementById('dispatch-queue').innerHTML =
    state.supervisors.flatMap(sv =>
      sv.queues.map(q =>
        `<option value="${sv.id}|${q.name}">${sv.name} / ${q.name}</option>`
      )
    ).join('');
}

// ─── Modal ───────────────────────────────────────────────────────────────────

function updateModalVisibility(balance) {
  document.querySelectorAll('.balance-group').forEach(el => {
    el.style.display = el.dataset.balance === balance ? '' : 'none';
  });
}

function openAddModal() {
  state.editingId = null;
  document.getElementById('modal-title').textContent = 'Add Supervisor';
  document.getElementById('sv-name').value = `supervisor-${state.supervisors.length + 1}`;
  document.getElementById('sv-queues').value = 'default';
  document.getElementById('sv-balance').value = 'auto';
  document.getElementById('sv-autoscaling').value = 'size';
  document.getElementById('sv-min-processes').value = 1;
  document.getElementById('sv-max-processes').value = 10;
  document.getElementById('sv-balance-max-shift').value = 1;
  document.getElementById('sv-balance-cooldown').value = 3;
  document.getElementById('sv-processes').value = 4;
  document.getElementById('sv-false-min-processes').value = 1;
  document.getElementById('sv-false-max-processes').value = 10;
  document.getElementById('sv-false-balance-max-shift').value = 1;
  document.getElementById('sv-false-balance-cooldown').value = 3;
  document.getElementById('sv-job-runtime').value = 800;
  document.getElementById('sv-failure-rate').value = 5;
  document.getElementById('sv-tries').value = 1;
  document.getElementById('sv-timeout').value = 60;
  document.getElementById('sv-backoff').value = '0';
  document.getElementById('sv-sleep').value = 3;
  document.getElementById('sv-rest').value = 0;
  document.getElementById('sv-max-jobs').value = 0;
  document.getElementById('sv-max-time').value = 0;
  document.getElementById('sv-memory').value = 128;
  updateModalVisibility('auto');
  document.getElementById('modal-overlay').classList.add('modal-open');
}

function openEditModal(id) {
  const sv = state.supervisors.find(s => s.id === id);
  if (!sv) return;
  state.editingId = id;
  document.getElementById('modal-title').textContent = 'Edit Supervisor';
  document.getElementById('sv-name').value = sv.name;
  document.getElementById('sv-queues').value = sv.queues.map(q => q.name).join(', ');
  document.getElementById('sv-balance').value = sv.balance;
  document.getElementById('sv-autoscaling').value = sv.autoScalingStrategy;
  document.getElementById('sv-min-processes').value = sv.minProcesses;
  document.getElementById('sv-max-processes').value = sv.maxProcesses;
  document.getElementById('sv-balance-max-shift').value = sv.balanceMaxShift;
  document.getElementById('sv-balance-cooldown').value = sv.balanceCooldown;
  document.getElementById('sv-processes').value = sv.processes;
  document.getElementById('sv-false-min-processes').value = sv.minProcesses;
  document.getElementById('sv-false-max-processes').value = sv.maxProcesses;
  document.getElementById('sv-false-balance-max-shift').value = sv.balanceMaxShift;
  document.getElementById('sv-false-balance-cooldown').value = sv.balanceCooldown;
  document.getElementById('sv-job-runtime').value = sv.jobRuntime;
  document.getElementById('sv-failure-rate').value = sv.failureRate;
  document.getElementById('sv-tries').value = sv.tries;
  document.getElementById('sv-timeout').value = sv.timeout;
  document.getElementById('sv-backoff').value = sv.backoff.join(',');
  document.getElementById('sv-sleep').value = sv.sleep;
  document.getElementById('sv-rest').value = sv.rest;
  document.getElementById('sv-max-jobs').value = sv.maxJobs;
  document.getElementById('sv-max-time').value = sv.maxTime;
  document.getElementById('sv-memory').value = sv.memory;
  updateModalVisibility(sv.balance);
  document.getElementById('modal-overlay').classList.add('modal-open');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('modal-open');
  state.editingId = null;
}

function saveModal() {
  const balance = document.getElementById('sv-balance').value;
  const queueNames = document.getElementById('sv-queues').value
    .split(',').map(s => s.trim()).filter(Boolean);

  const backoffRaw = document.getElementById('sv-backoff').value;
  const backoff = backoffRaw.split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n));

  const isAuto = balance === 'auto';
  const isFalse = balance === 'false';

  const opts = {
    name: document.getElementById('sv-name').value.trim() || 'supervisor',
    queues: queueNames,
    balance,
    autoScalingStrategy: document.getElementById('sv-autoscaling').value,
    processes: parseInt(document.getElementById('sv-processes').value) || 4,
    minProcesses: isAuto
      ? parseInt(document.getElementById('sv-min-processes').value) || 1
      : isFalse
        ? parseInt(document.getElementById('sv-false-min-processes').value) || 1
        : 1,
    maxProcesses: isAuto
      ? parseInt(document.getElementById('sv-max-processes').value) || 10
      : isFalse
        ? parseInt(document.getElementById('sv-false-max-processes').value) || 10
        : 10,
    balanceMaxShift: isAuto
      ? parseInt(document.getElementById('sv-balance-max-shift').value) || 1
      : isFalse
        ? parseInt(document.getElementById('sv-false-balance-max-shift').value) || 1
        : 1,
    balanceCooldown: isAuto
      ? parseInt(document.getElementById('sv-balance-cooldown').value) || 3
      : isFalse
        ? parseInt(document.getElementById('sv-false-balance-cooldown').value) || 3
        : 3,
    jobRuntime: parseInt(document.getElementById('sv-job-runtime').value) || 800,
    failureRate: parseFloat(document.getElementById('sv-failure-rate').value) || 0,
    tries: parseInt(document.getElementById('sv-tries').value) || 1,
    timeout: parseInt(document.getElementById('sv-timeout').value) || 60,
    backoff: backoff.length ? backoff : [0],
    sleep: parseFloat(document.getElementById('sv-sleep').value) || 0,
    rest: parseFloat(document.getElementById('sv-rest').value) || 0,
    maxJobs: parseInt(document.getElementById('sv-max-jobs').value) || 0,
    maxTime: parseInt(document.getElementById('sv-max-time').value) || 0,
    memory: parseInt(document.getElementById('sv-memory').value) || 128,
  };

  const editedId = state.editingId;
  closeModal();

  if (editedId) {
    const idx = state.supervisors.findIndex(s => s.id === editedId);
    if (idx !== -1) {
      const newSv = createSupervisor(opts);
      newSv.id = editedId;
      // Preserve queue stats
      const oldQueues = new Map(state.supervisors[idx].queues.map(q => [q.name, q]));
      newSv.queues.forEach(q => {
        const old = oldQueues.get(q.name);
        if (old) { q.processed = old.processed; q.failed = old.failed; }
      });
      state.supervisors[idx] = newSv;
      const card = document.getElementById(`sv-card-${editedId}`);
      if (card) card.remove();
    }
  } else {
    state.supervisors.push(createSupervisor(opts));
  }

  renderSidebarSupervisors();
}

function removeSupervisor(id) {
  state.supervisors = state.supervisors.filter(s => s.id !== id);
  document.getElementById(`sv-card-${id}`)?.remove();
  renderSidebarSupervisors();
}

// ─── Loop ────────────────────────────────────────────────────────────────────

function loop(now) {
  tick(now);
  requestAnimationFrame(loop);
}

// ─── Init ────────────────────────────────────────────────────────────────────

function initTheme() {
  const saved = localStorage.getItem('hz-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = saved ? saved === 'dark' : prefersDark;
  document.documentElement.classList.toggle('dark', isDark);
  document.getElementById('theme-icon').textContent = isDark ? '☀' : '☾';
}

function toggleTheme() {
  const isDark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('hz-theme', isDark ? 'dark' : 'light');
  document.getElementById('theme-icon').textContent = isDark ? '☀' : '☾';
}

function init() {
  initTheme();
  renderSidebarSupervisors();
  render();

  document.getElementById('sim-speed').addEventListener('input', e => {
    state.speed = parseFloat(e.target.value);
    document.getElementById('sim-speed-label').textContent = `${state.speed}x`;
  });

  document.getElementById('sim-toggle').addEventListener('click', () => {
    state.running = !state.running;
    document.getElementById('sim-toggle').textContent = state.running ? 'Pause' : 'Resume';
  });

  document.getElementById('sim-reset').addEventListener('click', () => {
    state.stats = { processed: 0, failed: 0, retried: 0 };
    throughputWindow.length = 0;
    for (const sv of state.supervisors) {
      sv.retryPool = [];
      sv._lastBalanceAt = null;
      for (const q of sv.queues) { q.pending = []; q.processed = 0; q.failed = 0; }
      for (const w of sv.workers) {
        w.state = 'idle'; w.queue = null; w.progress = 0;
        w._job = null; w._flashAt = null; w._startReal = null;
      }
    }
  });

  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
  document.getElementById('add-supervisor').addEventListener('click', openAddModal);
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-save').addEventListener('click', saveModal);
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target.id === 'modal-overlay') closeModal();
  });

  document.getElementById('sv-balance').addEventListener('change', e => {
    updateModalVisibility(e.target.value);
  });

  document.getElementById('dispatch-btn').addEventListener('click', () => {
    const q = document.getElementById('dispatch-queue').value;
    const n = parseInt(document.getElementById('dispatch-count').value) || 1;
    dispatchToQueue(q, n);
  });

  document.getElementById('dispatch-burst').addEventListener('click', () => {
    dispatchToQueue(document.getElementById('dispatch-queue').value, 50);
  });

  requestAnimationFrame(loop);
}

init();
