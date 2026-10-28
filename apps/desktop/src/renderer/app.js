'use strict';

const api = window.unbox;
const $ = (id) => document.getElementById(id);

const state = {
  status: null,
  projects: [],
  project: null,
  agent: readPreference('agent'),
  running: null, // { projectId, turnId }
};

/* Small helpers */

function readPreference(key) {
  try {
    return localStorage.getItem(`unbox.${key}`);
  } catch {
    return null;
  }
}

function writePreference(key, value) {
  try {
    localStorage.setItem(`unbox.${key}`, value);
  } catch {
    // preferences are a convenience only
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICON_PATHS = {
  file: ['M11.5 2.5H6a1.5 1.5 0 0 0-1.5 1.5v12A1.5 1.5 0 0 0 6 17.5h8a1.5 1.5 0 0 0 1.5-1.5V6.5l-4-4Z', 'M11.5 2.5v4h4'],
  folder: ['M3 6.5A1.5 1.5 0 0 1 4.5 5H8l1.5 1.5h6A1.5 1.5 0 0 1 17 8v6.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5v-8Z'],
  close: ['M5 5l10 10M15 5 5 15'],
  chevron: ['m8 5 5 5-5 5'],
};

function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ICON_PATHS[name]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

function formatBytes(size) {
  if (size === null || size === undefined) return 'Folder';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function formatTime(iso) {
  const date = new Date(iso);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function cleanError(error) {
  return String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/* Setup */

const DEPENDENCIES = [
  {
    group: 'Required',
    id: 'node',
    name: 'Node.js',
    desc: 'Runs REA on this Mac.',
    check: (s) => (s.rea.node.supported ? ['ready', s.rea.node.version] : ['attention', s.rea.node.version ? 'Too old' : 'Not installed']),
    howto: 'Install Node.js 24 or newer, then check again.',
    commands: ['brew install node'],
  },
  {
    group: 'Required',
    id: 'rea',
    name: 'REA',
    desc: 'Reads files and reports what is inside them.',
    check: (s) => (s.rea.ready ? ['ready', 'Ready'] : ['attention', 'Not available']),
    howto: 'Unbox downloads REA automatically the first time, so it needs an internet connection. It also needs Node.js above.',
    commands: [],
  },
  {
    group: 'At least one agent',
    id: 'claude',
    name: 'Claude Code',
    desc: 'Answers your questions using your Claude plan.',
    check: (s) => agentCheck(s, 'claude'),
    howto: 'Install Claude Code, then sign in with your Claude Pro or Max plan. Unbox never uses an API key.',
    commands: ['npm install -g @anthropic-ai/claude-code', 'claude auth login'],
  },
  {
    group: 'At least one agent',
    id: 'codex',
    name: 'Codex',
    desc: 'Answers your questions using your ChatGPT plan.',
    check: (s) => agentCheck(s, 'codex'),
    howto: 'Install Codex, then choose Sign in with ChatGPT. If a run says your sign-in expired, run the logout command first.',
    commands: ['npm install -g @openai/codex', 'codex login', 'codex logout'],
  },
  {
    group: 'Optional',
    id: 'engine',
    name: 'Decompiler',
    desc: 'Needed only to read native apps and binaries in depth.',
    check: (s) => {
      const found = s.rea.engines.filter((engine) => engine.available).map((engine) => engine.id);
      return found.length ? ['ready', found.join(', ')] : ['muted', 'Not installed'];
    },
    howto: 'Install Ghidra and set GHIDRA_INSTALL_DIR, or let REA install Hopper. JavaScript, Electron and .NET apps work without one.',
    commands: ['npx rea-agents@latest setup --install-hopper'],
  },
];

function agentCheck(status, id) {
  const agent = status.agents.find((item) => item.id === id);
  if (agent.ready) return ['ready', 'Signed in'];
  return ['attention', agent.installed ? 'Sign in needed' : 'Not installed'];
}

function setupReadiness(status) {
  if (!status) return { ready: false, missing: [] };
  const missing = [];
  if (!status.rea.node.supported) missing.push('Node.js');
  if (!status.rea.ready) missing.push('REA');
  if (!status.agents.some((agent) => agent.ready)) missing.push('an agent');
  return { ready: missing.length === 0, missing };
}

async function loadStatus() {
  $('setup-summary').textContent = "Checking what's installed on this Mac…";
  $('setup-recheck').disabled = true;
  renderSetup(null);
  try {
    state.status = await api.setupStatus();
  } finally {
    $('setup-recheck').disabled = false;
  }
  renderSetup(state.status);
  renderSetupLink();
  renderAgentPicker();
  updateComposer();
}

function renderSetup(status) {
  const groups = new Map();
  for (const dep of DEPENDENCIES) {
    if (!groups.has(dep.group)) groups.set(dep.group, []);
    groups.get(dep.group).push(dep);
  }
  let firstOpen = false;
  const nodes = [];
  for (const [title, deps] of groups) {
    const group = el('div', 'group');
    group.append(el('div', 'group-title', title));
    for (const dep of deps) {
      const [level, label] = status ? dep.check(status) : ['muted', 'Checking…'];
      const open = status && level === 'attention' && !firstOpen;
      if (open) firstOpen = true;
      group.append(dependencyRow(dep, level, label, open));
    }
    nodes.push(group);
  }
  $('setup-groups').replaceChildren(...nodes);

  if (!status) return;
  const { ready, missing } = setupReadiness(status);
  $('setup-summary').textContent = ready
    ? 'Everything Unbox needs is ready.'
    : `Unbox still needs ${missing.join(' and ')}. You can skip this and finish later.`;
  $('setup-skip').hidden = ready;
}

function dependencyRow(dep, level, label, open) {
  const wrapper = el('div', `dep${open ? ' open' : ''}`);
  const row = el('button', 'dep-row');
  row.type = 'button';
  row.setAttribute('aria-expanded', String(open));
  const text = el('span');
  text.append(el('span', 'dep-name', dep.name), el('span', 'dep-desc', dep.desc));
  const chevron = icon('chevron');
  chevron.classList.add('dep-chevron');
  row.append(text, el('span', `dep-state ${level}`, label), chevron);

  const howto = el('div', 'dep-howto');
  howto.hidden = !open;
  howto.append(el('p', null, dep.howto));
  for (const command of dep.commands) howto.append(commandLine(command));

  row.addEventListener('click', () => {
    const isOpen = wrapper.classList.toggle('open');
    howto.hidden = !isOpen;
    row.setAttribute('aria-expanded', String(isOpen));
  });
  wrapper.append(row, howto);
  return wrapper;
}

function commandLine(command) {
  const line = el('div', 'command');
  const button = el('button', 'copy', 'Copy');
  button.type = 'button';
  button.addEventListener('click', async () => {
    await api.copy(command);
    button.textContent = 'Copied';
    setTimeout(() => (button.textContent = 'Copy'), 1400);
  });
  line.append(el('code', null, command), button);
  return line;
}

function renderSetupLink() {
  const { ready, missing } = setupReadiness(state.status);
  $('setup-dot').className = `dot ${state.status ? (ready ? 'ready' : 'attention') : ''}`;
  $('setup-link-text').textContent = !state.status ? 'Setup' : ready ? 'Setup' : `Setup needs ${missing.join(' and ')}`;
}

function showSetup() {
  $('setup').hidden = false;
  $('shell').hidden = true;
}

function leaveSetup() {
  $('setup').hidden = true;
  $('shell').hidden = false;
  $('new-project').focus();
}

/* Projects */

async function loadProjects() {
  state.projects = await api.listProjects();
  renderProjectList();
}

function renderProjectList() {
  $('project-list').replaceChildren(
    ...state.projects.map((project) => {
      const item = el('button', 'project-item');
      item.type = 'button';
      item.setAttribute('aria-current', String(project.id === state.project?.id));
      item.append(
        el('strong', null, project.name),
        el('span', null, project.targetCount ? plural(project.targetCount, 'item') : 'Empty'),
      );
      item.addEventListener('click', () => openProject(project.id));
      return item;
    }),
  );
}

async function openProject(id) {
  state.project = await api.getProject(id);
  $('empty').hidden = true;
  $('project').hidden = false;
  $('project-title').value = state.project.name;
  renderProjectList();
  renderTargets();
  renderThread();
  updateComposer();
  $('prompt').focus();
}

function showEmpty() {
  state.project = null;
  $('project').hidden = true;
  $('empty').hidden = false;
  renderProjectList();
}

function openNewProjectDialog() {
  $('new-project-name').value = '';
  $('new-project-dialog').showModal();
  $('new-project-name').focus();
}

async function createProject(event) {
  event.preventDefault();
  const name = $('new-project-name').value.trim();
  if (!name) return;
  $('new-project-dialog').close();
  const project = await api.createProject(name);
  await loadProjects();
  await openProject(project.id);
}

async function renameProject() {
  const name = $('project-title').value.trim();
  if (!state.project || !name || name === state.project.name) {
    $('project-title').value = state.project?.name || '';
    return;
  }
  state.project = await api.renameProject(state.project.id, name);
  await loadProjects();
}

/* Targets */

function renderTargets() {
  const targets = state.project?.targets || [];
  $('targets').replaceChildren(
    ...targets.map((target) => {
      const chip = el('li', 'target');
      chip.title = target.path;
      const remove = el('button', 'target-remove');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${target.name}`);
      remove.append(icon('close'));
      remove.disabled = Boolean(state.running);
      remove.addEventListener('click', async () => {
        state.project = await api.removeTarget(state.project.id, target.path);
        renderTargets();
        updateComposer();
        loadProjects();
      });
      chip.append(
        icon(target.isDirectory ? 'folder' : 'file'),
        el('span', 'target-name', target.name),
        el('span', 'target-meta', formatBytes(target.size)),
        remove,
      );
      return chip;
    }),
  );
  $('prompt').placeholder = targets.length ? 'Ask anything about these files' : 'Add files or a folder with +, then ask about them';
}

async function addTargets(kind) {
  closeMenus();
  state.project = await api.addTargets(state.project.id, kind);
  renderTargets();
  updateComposer();
  loadProjects();
  $('prompt').focus();
}

/* Agent picker */

function renderAgentPicker() {
  const agents = state.status?.agents || [];
  const current = agents.find((agent) => agent.id === state.agent);
  if (!current || (!current.ready && agents.some((agent) => agent.ready))) {
    state.agent = agents.find((agent) => agent.ready)?.id || agents[0]?.id || state.agent;
  }
  const selected = agents.find((agent) => agent.id === state.agent);
  $('agent-label').textContent = selected ? selected.name : 'Agent';
  $('agent-menu').replaceChildren(
    ...agents.map((agent) => {
      const option = el('button');
      option.type = 'button';
      option.setAttribute('role', 'menuitemradio');
      option.setAttribute('aria-checked', String(agent.id === state.agent));
      option.append(el('strong', null, agent.name), el('span', null, agent.ready ? `Uses your ${agent.plan} plan` : 'Not signed in. Open setup to fix.'));
      option.addEventListener('click', () => {
        state.agent = agent.id;
        writePreference('agent', agent.id);
        closeMenus();
        renderAgentPicker();
        updateComposer();
      });
      return option;
    }),
  );
}

/* Menus */

function toggleMenu(button, menu) {
  const open = menu.hidden;
  closeMenus();
  menu.hidden = !open;
  button.setAttribute('aria-expanded', String(open));
  if (open) menu.querySelector('button:not(:disabled)')?.focus();
}

function closeMenus() {
  for (const [button, menu] of [['add-button', 'add-menu'], ['agent-button', 'agent-menu']]) {
    $(menu).hidden = true;
    $(button).setAttribute('aria-expanded', 'false');
  }
}

/* Composer */

function blockingReason() {
  if (!state.project) return null;
  const agent = state.status?.agents.find((item) => item.id === state.agent);
  if (!state.project.targets.length) return { text: 'Add a file or folder to get started.' };
  if (!state.status) return { text: 'Checking your agents…' };
  if (!agent?.ready) return { text: `${agent?.name || 'The agent'} isn't signed in yet.`, action: 'Open setup' };
  return null;
}

function updateComposer() {
  if (!state.project) return;
  const runningHere = state.running?.projectId === state.project.id;
  const reason = blockingReason();
  const prompt = $('prompt').value.trim();
  $('composer').classList.toggle('running', Boolean(runningHere));
  $('send').setAttribute('aria-label', runningHere ? 'Stop' : 'Send');
  $('send').disabled = runningHere ? false : Boolean(state.running || reason || !prompt);

  const hint = $('composer-hint');
  hint.replaceChildren();
  if (reason && !runningHere) {
    hint.append(reason.text, ' ');
    if (reason.action) {
      const link = el('button', null, reason.action);
      link.type = 'button';
      link.addEventListener('click', showSetup);
      hint.append(link);
    }
  } else if (state.running && !runningHere) {
    hint.append('Another project is running. It needs to finish first.');
  }
  hint.hidden = !hint.childNodes.length;
  $('suggestions').hidden = Boolean(state.project.turns.length) || !state.project.targets.length;
}

function autosize() {
  const prompt = $('prompt');
  prompt.style.height = 'auto';
  prompt.style.height = `${Math.min(prompt.scrollHeight, 220)}px`;
}

async function submit(event) {
  event.preventDefault();
  if (state.running?.projectId === state.project?.id) {
    api.stopRun();
    return;
  }
  if ($('send').disabled) return;
  const prompt = $('prompt').value.trim();
  try {
    const turn = await api.startRun(state.project.id, { prompt, agent: state.agent });
    state.running = { projectId: state.project.id, turnId: turn.id };
    state.project.turns.push(turn);
    $('prompt').value = '';
    autosize();
    renderTargets();
    renderThread();
    updateComposer();
  } catch (error) {
    $('composer-hint').hidden = false;
    $('composer-hint').textContent = cleanError(error);
  }
}

/* Thread */

const liveViews = new Map();

function renderThread() {
  liveViews.clear();
  const turns = [...(state.project?.turns || [])].reverse();
  $('thread').replaceChildren(...turns.map(turnView));
}

function turnView(turn) {
  const article = el('article', 'turn');
  article.append(el('div', 'turn-prompt', turn.prompt));

  const agentName = state.status?.agents.find((agent) => agent.id === turn.agent)?.name
    || (turn.agent === 'claude' ? 'Claude Code' : 'Codex');
  const stateLabel = turn.status === 'running' ? 'Working' : turn.status === 'done' ? 'Done' : 'Stopped';
  const meta = el('div', 'turn-meta');
  const status = el('span', `state${turn.status === 'running' ? ' live' : turn.status === 'stopped' ? ' failed' : ''}`, stateLabel);
  meta.append(el('span', null, agentName), el('span', null, formatTime(turn.createdAt)), status);
  article.append(meta);

  const live = el('div', 'live-line');
  live.append(el('span', 'pulse'), el('span', null, 'Starting'));
  live.hidden = turn.status !== 'running';

  const activity = el('details', 'activity');
  const summary = el('summary');
  const list = el('ul', 'activity-list');
  activity.append(summary, list);
  for (const scanned of turn.scans || []) list.append(scanItem(scanned));
  for (const step of turn.steps || []) list.append(stepItem(step));

  const answer = el('div', 'answer markdown');
  const error = el('div', 'turn-error');
  article.append(live, activity, answer, error);

  const view = { turn, status, live, activity, summary, list, answer, error };
  refreshTurn(view);
  if (turn.status === 'running') liveViews.set(turn.id, view);
  return article;
}

function scanItem(scanned) {
  const item = el('li', 'scan');
  const detail = scanned.ok ? scanned.headline || scanned.kind : scanned.error?.message || 'REA could not read this file.';
  item.append(el('span', 'step-name', `Scanned ${scanned.name}`), el('span', 'step-detail', detail));
  item.title = detail;
  return item;
}

function stepItem(step) {
  const item = el('li');
  item.append(el('span', 'step-name', step.name), el('span', 'step-detail', step.detail || ''));
  item.title = step.detail || '';
  return item;
}

function refreshTurn(view) {
  const { turn } = view;
  const scans = turn.scans?.length || 0;
  const steps = turn.steps?.length || 0;
  const parts = [];
  if (scans) parts.push(`scanned ${plural(scans, 'item')}`);
  if (steps) parts.push(`took ${plural(steps, 'step')}`);
  view.activity.hidden = !parts.length;
  view.summary.replaceChildren(icon('chevron'), `${parts.join(' and ').replace(/^./, (c) => c.toUpperCase())}`);

  if (turn.answer) window.renderMarkdown(view.answer, turn.answer);
  view.answer.hidden = !turn.answer;
  view.error.textContent = turn.error || '';
  view.error.hidden = !turn.error;
}

api.onRunEvent(({ projectId, turnId, event }) => {
  const view = liveViews.get(turnId);
  if (event.kind === 'done') {
    if (state.running?.turnId === turnId) state.running = null;
    if (state.project?.id === projectId) {
      const index = state.project.turns.findIndex((turn) => turn.id === turnId);
      if (index >= 0) state.project.turns[index] = event.turn;
      renderThread();
      renderTargets();
      updateComposer();
    }
    loadProjects();
    return;
  }
  if (!view) return;
  const liveText = view.live.lastElementChild;
  if (event.kind === 'scan') {
    if (event.state === 'running') liveText.textContent = `Scanning ${event.name}: ${event.text}`;
    if (event.state === 'done') {
      view.turn.scans.push(event.summary);
      view.list.append(scanItem(event.summary));
    }
  } else if (event.kind === 'tool') {
    view.turn.steps.push({ name: event.name, detail: event.detail });
    view.list.append(stepItem(event));
    liveText.textContent = [event.name, event.detail].filter(Boolean).join('  ');
  } else if (event.kind === 'text') {
    view.turn.answer = [view.turn.answer, event.text].filter(Boolean).join('\n\n');
    liveText.textContent = 'Writing';
  } else if (event.kind === 'status' || event.kind === 'error' || event.kind === 'tool_result') {
    liveText.textContent = event.text;
  }
  refreshTurn(view);
});

/* Drag and drop */

let dragDepth = 0;
window.addEventListener('dragenter', (event) => {
  event.preventDefault();
  if (!state.project || state.running) return;
  dragDepth += 1;
  $('drop-project').textContent = state.project.name;
  $('drop-overlay').hidden = false;
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('drop-overlay').hidden = true;
});
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', async (event) => {
  event.preventDefault();
  dragDepth = 0;
  $('drop-overlay').hidden = true;
  const files = event.dataTransfer?.files;
  if (!state.project || state.running || !files?.length) return;
  state.project = await api.dropTargets(state.project.id, files);
  renderTargets();
  updateComposer();
  loadProjects();
});

/* Wiring */

$('setup-continue').addEventListener('click', leaveSetup);
$('setup-skip').addEventListener('click', leaveSetup);
$('setup-recheck').addEventListener('click', loadStatus);
$('open-setup').addEventListener('click', () => {
  showSetup();
  loadStatus();
});
$('new-project').addEventListener('click', openNewProjectDialog);
$('start-unboxing').addEventListener('click', openNewProjectDialog);
$('new-project-form').addEventListener('submit', createProject);
$('new-project-cancel').addEventListener('click', () => $('new-project-dialog').close());
$('project-title').addEventListener('blur', renameProject);
$('project-title').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') event.target.blur();
  if (event.key === 'Escape') {
    event.target.value = state.project.name;
    event.target.blur();
  }
});
$('reveal-project').addEventListener('click', () => api.revealProject(state.project.id));
$('add-button').addEventListener('click', () => toggleMenu($('add-button'), $('add-menu')));
$('agent-button').addEventListener('click', () => toggleMenu($('agent-button'), $('agent-menu')));
for (const option of document.querySelectorAll('[data-add]')) {
  option.addEventListener('click', () => addTargets(option.dataset.add));
}
for (const suggestion of document.querySelectorAll('[data-prompt]')) {
  suggestion.addEventListener('click', () => {
    $('prompt').value = suggestion.dataset.prompt;
    autosize();
    updateComposer();
    $('prompt').focus();
  });
}
$('composer').addEventListener('submit', submit);
$('prompt').addEventListener('input', () => {
  autosize();
  updateComposer();
});
$('prompt').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('composer').requestSubmit();
  }
});
document.addEventListener('click', (event) => {
  if (!event.target.closest('.menu-anchor')) closeMenus();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMenus();
});

if (/Mac/.test(navigator.platform)) document.body.classList.add('vibrant');
loadStatus();
loadProjects().then(showEmpty);
