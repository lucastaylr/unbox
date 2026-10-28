'use strict';

const api = window.unbox;
const $ = (id) => document.getElementById(id);

const state = {
  status: null,
  target: null,
  scan: null,
  workspace: null,
  agent: null,
  task: 'explain',
  running: false,
  scanning: false,
};

const ICONS = {
  file: '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M14 3v5h5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function statusRow({ level, title, detail }) {
  const row = el('li', `status-row is-${level}`);
  row.append(el('span', 'dot'));
  const body = el('div');
  body.append(el('strong', null, title));
  if (detail) body.append(el('span', 'detail', detail));
  row.append(body);
  return row;
}

function formatBytes(size) {
  if (size === null || size === undefined) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

/* Environment */

async function loadStatus() {
  const button = $('refresh');
  button.classList.add('spinning');
  $('env-status').replaceChildren(statusRow({ level: 'pending', title: 'Checking REA…' }));
  $('agent-status').replaceChildren();
  try {
    state.status = await api.status();
  } finally {
    button.classList.remove('spinning');
  }
  renderStatus();
  renderAgentPicker();
  renderTaskPicker();
}

function renderStatus() {
  const { rea, agents } = state.status;
  const env = $('env-status');
  env.replaceChildren(
    statusRow({
      level: rea.node.supported ? 'ok' : 'bad',
      title: 'Node.js',
      detail: rea.node.version || 'Not found',
    }),
    statusRow({
      level: rea.ready ? 'ok' : 'bad',
      title: 'REA',
      detail: rea.ready ? rea.source : rea.hint,
    }),
  );
  if (rea.ready) {
    const available = rea.engines.filter((engine) => engine.available).map((engine) => engine.id);
    env.append(statusRow({
      level: available.length ? 'ok' : 'warn',
      title: 'Native engines',
      detail: available.length ? available.join(', ') : 'None found. Native decompiling needs Ghidra, Hopper or IDA.',
    }));
  }
  $('agent-status').replaceChildren(
    ...agents.map((agent) => statusRow({
      level: agent.ready ? 'ok' : agent.installed ? 'warn' : 'bad',
      title: agent.name,
      detail: agent.ready ? `Signed in · ${agent.plan}` : agent.hint,
    })),
  );
}

/* Pickers */

function segmented(container, options, selected, onSelect) {
  container.replaceChildren(
    ...options.map((option) => {
      const button = el('button');
      button.type = 'button';
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(option.id === selected));
      button.disabled = Boolean(option.disabled);
      if (option.title) button.title = option.title;
      if (option.dot) button.append(el('span', `dot ${option.dot}`));
      button.append(option.label);
      button.addEventListener('click', () => onSelect(option.id));
      return button;
    }),
  );
}

function renderAgentPicker() {
  const agents = state.status?.agents || [];
  if (!state.agent || !agents.find((agent) => agent.id === state.agent)?.ready) {
    state.agent = agents.find((agent) => agent.ready)?.id || agents[0]?.id || null;
  }
  segmented(
    $('agent-picker'),
    agents.map((agent) => ({ id: agent.id, label: agent.name, title: agent.ready ? '' : agent.hint })),
    state.agent,
    (id) => {
      state.agent = id;
      renderAgentPicker();
    },
  );
  updateRunState();
}

function renderTaskPicker() {
  segmented($('task-picker'), state.status?.tasks || [], state.task, (id) => {
    state.task = id;
    renderTaskPicker();
  });
  $('question-row').classList.toggle('hidden', state.task !== 'ask');
  updateRunState();
}

function selectedAgent() {
  return state.status?.agents.find((agent) => agent.id === state.agent);
}

function updateRunState() {
  const agent = selectedAgent();
  const hint = $('agent-hint');
  let reason = '';
  if (!state.target) reason = 'Choose a target first.';
  else if (state.scanning) reason = 'Waiting for the scan to finish…';
  else if (!agent) reason = 'Checking agents…';
  else if (!agent.ready) reason = agent.hint;
  else if (state.task === 'ask' && !$('question').value.trim()) reason = 'Type a question to ask.';
  hint.textContent = reason || `Runs on your ${agent.name} sign-in (${agent.plan}). No API key is used.`;
  $('run-agent').disabled = Boolean(reason) || state.running;
  $('run-agent').classList.toggle('hidden', state.running);
  $('stop-agent').classList.toggle('hidden', !state.running);
}

/* Target and scan */

async function chooseTarget(kind) {
  try {
    const target = await api.pickTarget(kind);
    if (target) openTarget(target);
  } catch (error) {
    alert(error.message);
  }
}

function openTarget(target) {
  state.target = target;
  state.scan = null;
  state.workspace = null;
  $('dropzone').classList.add('hidden');
  $('workspace').classList.remove('hidden');
  $('target-name').textContent = target.name;
  $('target-path').textContent = [target.path, formatBytes(target.size)].filter(Boolean).join('  ·  ');
  $('target-icon').innerHTML = target.isDirectory ? ICONS.folder : ICONS.file;
  resetAgentOutput();
  $('report-card').classList.add('hidden');
  updateRunState();
  runScan();
}

function closeTarget() {
  api.cancelScan();
  state.target = null;
  state.scanning = false;
  $('workspace').classList.add('hidden');
  $('dropzone').classList.remove('hidden');
}

async function runScan() {
  const target = state.target;
  const badge = $('scan-badge');
  badge.className = 'badge run';
  badge.textContent = 'Scanning';
  $('scan-progress').classList.remove('hidden');
  $('scan-message').textContent = 'Starting REA…';
  $('scan-result').replaceChildren();
  state.scanning = true;
  updateRunState();
  const result = await api.scan(target.path);
  if (state.target !== target || result.cancelled) return;
  state.scanning = false;
  updateRunState();
  state.scan = result;
  state.workspace = result.workspace;
  $('scan-progress').classList.add('hidden');
  renderScan(result);
}

function renderScan(result) {
  const badge = $('scan-badge');
  const container = $('scan-result');
  if (result.error) {
    badge.className = 'badge bad';
    badge.textContent = 'Needs attention';
    const callout = el('div', 'callout');
    callout.append(el('strong', null, result.error.code ? `REA: ${result.error.code}` : 'Scan failed'));
    callout.append(el('div', null, result.error.message));
    if (result.error.action) callout.append(el('div', 'action', result.error.action));
    container.replaceChildren(callout);
    return;
  }
  badge.className = 'badge ok';
  badge.textContent = 'Complete';

  const facts = el('div', 'facts');
  for (const fact of result.facts) {
    const card = el('div', 'fact');
    const isText = typeof fact.value === 'string';
    card.append(el('div', `value${isText ? ' text' : ''}`, fact.value));
    card.append(el('div', 'label', fact.label));
    card.title = `${fact.label}: ${fact.value}`;
    facts.append(card);
  }

  const meta = el('div', 'meta');
  meta.append(metaItem('Type', result.kind));
  if (result.format) meta.append(metaItem('Format', result.format));
  if (result.sha256) meta.append(metaItem('SHA-256', `${result.sha256.slice(0, 16)}…`, result.sha256));
  const nodes = [meta, facts];

  if (result.nextSteps.length) {
    nodes.push(el('div', 'section-title', 'REA suggests next'));
    const list = el('ul', 'list');
    for (const step of result.nextSteps) {
      const li = el('li');
      li.append(el('span', 'op', step.operation), el('span', null, step.rationale));
      list.append(li);
    }
    nodes.push(list);
  }
  if (result.limitations.length) {
    const details = el('details');
    details.append(el('summary', null, `What this scan can't tell you (${result.limitations.length})`));
    const list = el('ul');
    for (const limitation of result.limitations) list.append(el('li', null, limitation));
    details.append(list);
    nodes.push(details);
  }
  container.replaceChildren(...nodes);
}

function metaItem(label, value, title) {
  const span = el('span');
  span.append(`${label} `, el('span', 'mono', value));
  if (title) span.title = title;
  return span;
}

/* Agent */

function resetAgentOutput() {
  $('transcript').replaceChildren();
  $('transcript').classList.add('hidden');
  $('done-row').classList.add('hidden');
}

async function runAgentTask() {
  resetAgentOutput();
  $('report-card').classList.add('hidden');
  $('transcript').classList.remove('hidden');
  appendEvent({ kind: 'status', text: 'Starting agent…' });
  state.running = true;
  updateRunState();
  try {
    const { workspace } = await api.startAgent({
      agent: state.agent,
      task: state.task,
      question: $('question').value,
      targetPath: state.target.path,
      scan: state.scan && !state.scan.error ? state.scan : null,
    });
    state.workspace = workspace;
  } catch (error) {
    state.running = false;
    appendEvent({ kind: 'done', ok: false, text: error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') });
    updateRunState();
  }
}

function appendEvent(event) {
  const transcript = $('transcript');
  const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 60;
  // Keep one live status line instead of stacking retries and progress notes.
  const last = transcript.lastElementChild;
  if (event.kind === 'status' && last?.classList.contains('status')) {
    last.textContent = event.text;
    return;
  }
  let node;
  if (event.kind === 'tool') {
    node = el('div', 'event tool');
    node.append(el('span', 'name', event.name), el('span', 'detail', event.detail || ''));
    node.title = event.detail || '';
  } else if (event.kind === 'text') {
    node = el('div', 'event text markdown');
    window.renderMarkdown(node, event.text);
  } else if (event.kind === 'done') {
    const label = event.ok ? 'Finished' : 'Stopped';
    const extra = [event.turns ? `${event.turns} turns` : '', event.durationMs ? `${Math.round(event.durationMs / 1000)}s` : '']
      .filter(Boolean).join(' · ');
    node = el('div', `event done ${event.ok ? 'ok' : 'bad'}`, [label, extra, event.text].filter(Boolean).join(' — '));
  } else {
    node = el('div', `event ${event.kind}`, event.text);
  }
  transcript.append(node);
  if (nearBottom) transcript.scrollTop = transcript.scrollHeight;
}

api.onAgentEvent((event) => {
  if (!state.running) return;
  appendEvent(event);
  if (event.kind === 'done') {
    state.running = false;
    updateRunState();
    if (state.workspace) $('done-row').classList.remove('hidden');
    $('view-report').classList.toggle('hidden', !event.ok);
    if (event.ok) showReport();
  }
});

async function showReport() {
  const report = await api.readReport(state.workspace);
  const card = $('report-card');
  if (!report) {
    card.classList.add('hidden');
    return;
  }
  window.renderMarkdown($('report'), report);
  card.classList.remove('hidden');
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

api.onScanProgress((message) => {
  $('scan-message').textContent = message;
});

/* Drag and drop */

let dragDepth = 0;
window.addEventListener('dragenter', (event) => {
  event.preventDefault();
  dragDepth += 1;
  $('drop-overlay').classList.remove('hidden');
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('drop-overlay').classList.add('hidden');
});
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', async (event) => {
  event.preventDefault();
  dragDepth = 0;
  $('drop-overlay').classList.add('hidden');
  const file = event.dataTransfer?.files?.[0];
  if (!file || state.running) return;
  try {
    openTarget(await api.dropTarget(file));
  } catch (error) {
    alert(error.message);
  }
});

/* Wiring */

$('pick-file').addEventListener('click', () => chooseTarget('file'));
$('pick-folder').addEventListener('click', () => chooseTarget('folder'));
$('change-target').addEventListener('click', () => {
  if (!state.running) closeTarget();
});
$('refresh').addEventListener('click', loadStatus);
$('run-agent').addEventListener('click', runAgentTask);
$('stop-agent').addEventListener('click', () => api.stopAgent());
$('question').addEventListener('input', updateRunState);
$('open-workspace').addEventListener('click', () => api.openWorkspace(state.workspace));
$('view-report').addEventListener('click', showReport);

loadStatus();
