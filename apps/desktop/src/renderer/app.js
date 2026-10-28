'use strict';

const api = window.unbox;
const $ = (id) => document.getElementById(id);

const state = {
  status: null,
  projects: [],
  project: null,
  agent: readPreference('agent'),
  models: readModels(), // chosen model per agent; '' means the CLI's default
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

function readModels() {
  const models = { claude: '', codex: '' };
  try {
    const saved = JSON.parse(readPreference('models') || '{}');
    for (const id of Object.keys(models)) if (typeof saved[id] === 'string') models[id] = saved[id];
  } catch {
    // fall back to each CLI's default
  }
  return models;
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
  check: ['m4.5 10.5 3.5 3.5 7.5-8'],
  chip: ['M6.5 5.5h7a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z', 'M8.5 3v2.5M11.5 3v2.5M8.5 14.5V17M11.5 14.5V17M3 8.5h2.5M3 11.5h2.5M14.5 8.5H17M14.5 11.5H17'],
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

/* Brand logos */

const AGENT_INFO = {
  claude: { name: 'Claude Code', company: 'Anthropic', logo: 'claude' },
  codex: { name: 'Codex', company: 'OpenAI', logo: 'openai' },
};

function brandIcon(name, className) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', window.BRAND_PATHS[name]);
  svg.append(path);
  return svg;
}

/* Setup */

function setupReadiness(status) {
  if (!status) return { ready: false, missing: [] };
  const missing = [];
  if (!status.rea.node.supported) missing.push('Node.js');
  if (!status.rea.ready) missing.push('REA');
  if (!status.agents.some((agent) => agent.ready)) missing.push('an agent');
  return { ready: missing.length === 0, missing };
}

let statusRequest = null;

function loadStatus() {
  // Coalesce overlapping checks (focus events can fire several at once).
  statusRequest ??= (async () => {
    $('setup-recheck').disabled = true;
    try {
      state.status = await api.setupStatus();
    } finally {
      $('setup-recheck').disabled = false;
      statusRequest = null;
    }
    renderSetup();
    renderSetupLink();
    renderModelPicker();
    updateComposer();
    return state.status;
  })();
  return statusRequest;
}

function renderSetup() {
  const status = state.status;
  $('agent-tiles').replaceChildren(
    ...Object.keys(AGENT_INFO).map((id) => agentTile(id, status?.agents.find((agent) => agent.id === id))),
  );
  $('tool-tiles').replaceChildren(...toolTiles(status));
  const { ready, missing } = setupReadiness(status);
  $('setup-summary').textContent = !status
    ? 'Checking what is installed on this Mac…'
    : ready
      ? 'You are connected. Pick a default model for each agent; you can switch any time from the composer.'
      : missing.includes('an agent')
        ? 'Unbox works through the AI plan you already pay for. Connect at least one.'
        : `Unbox still needs ${missing.join(' and ')}.`;
}

function tileStatus(level, text) {
  const status = el('div', 'tile-status');
  status.append(el('span', `dot ${level}`), el('span', 'tile-status-text', text));
  return status;
}

function agentTile(id, agent) {
  const info = AGENT_INFO[id];
  const tile = el('div', `tile${agent?.ready ? ' ready' : ''}`);

  const head = el('div', 'tile-head');
  const logo = el('span', 'brand');
  logo.append(brandIcon(info.logo));
  const names = el('div');
  names.append(el('div', 'tile-name', info.name), el('span', 'tile-company', info.company));
  head.append(logo, names);

  let status;
  if (!agent) {
    status = tileStatus('', 'Checking…');
  } else if (agent.ready) {
    status = tileStatus('ready', 'Signed in');
    status.append(actionButton('link', 'Sign in again', `${id}:signin`, 'sign in'));
  } else {
    const install = !agent.installed;
    status = el('div', 'tile-status');
    status.append(actionButton('btn solid', install ? `Install ${info.name}` : 'Sign in', `${id}:${install ? 'install' : 'signin'}`, install ? `install ${info.name}` : 'sign in'));
  }

  const label = el('label', null, 'Default model');
  label.append(...modelSelect(id, agent));
  tile.append(head, status, label);
  return tile;
}

const CUSTOM = '__custom__';

// A grouped <select> of the agent's models, plus a custom model ID field.
function modelSelect(id, agent) {
  const models = agent?.models || [{ id: '', label: 'Default', group: '' }];
  const current = state.models[id] || '';
  const isCustom = current !== '' && !models.some((model) => model.id === current);
  const select = el('select', 'select');
  const groups = new Map();
  for (const model of models) {
    const option = el('option', null, model.label);
    option.value = model.id;
    if (!model.group) {
      select.append(option);
      continue;
    }
    if (!groups.has(model.group)) {
      const group = el('optgroup');
      group.label = model.group;
      groups.set(model.group, group);
      select.append(group);
    }
    groups.get(model.group).append(option);
  }
  const custom = el('option', null, 'Custom model ID…');
  custom.value = CUSTOM;
  select.append(custom);
  select.value = isCustom ? CUSTOM : current;
  select.disabled = !agent;

  const input = el('input', 'custom-model');
  input.placeholder = id === 'claude' ? 'e.g. claude-opus-5-5' : 'e.g. gpt-6.1-sol';
  input.spellcheck = false;
  input.value = isCustom ? current : '';
  input.hidden = !isCustom;
  input.setAttribute('aria-label', `${AGENT_INFO[id].name} model ID`);
  const commit = () => {
    const value = input.value.trim();
    if (/^[\w.:-]{1,80}$/.test(value)) chooseModel(id, value, { keepAgent: true });
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (event) => event.key === 'Enter' && commit());

  select.addEventListener('change', () => {
    if (select.value === CUSTOM) {
      input.hidden = false;
      input.focus();
      return;
    }
    input.hidden = true;
    chooseModel(id, select.value, { keepAgent: true });
  });
  return [select, input];
}

function toolTiles(status) {
  const rea = status?.rea;
  if (!rea) {
    return [
      toolTile({ glyph: brandIcon('node'), name: 'Node.js', desc: 'Runs REA' }),
      toolTile({ glyph: markIcon(), name: 'REA', desc: 'Inspects files safely' }),
      toolTile({ glyph: outlined(icon('chip')), name: 'Ghidra', desc: 'Optional decompiler' }),
    ];
  }
  const node = rea.node.supported
    ? toolTile({ glyph: brandIcon('node'), name: 'Node.js', desc: 'Runs REA', state: ['ready', rea.node.version] })
    : toolTile({
      glyph: brandIcon('node'),
      name: 'Node.js',
      desc: 'Runs REA',
      state: rea.node.version ? ['attention', `${rea.node.version} is too old`] : null,
      actions: [actionButton('btn solid', rea.node.version ? 'Update Node.js' : 'Install Node.js', 'node:install', 'install Node.js')],
    });
  const reaTile = toolTile({
    glyph: markIcon(),
    name: 'REA',
    desc: 'Inspects files safely',
    state: rea.ready ? ['ready', rea.source === 'npx' ? 'Ready' : rea.version ? `v${rea.version}` : 'Installed'] : null,
    actions: rea.node.supported && (!rea.ready || rea.source === 'npx')
      ? [actionButton(rea.ready ? 'link' : 'btn solid', 'Install', 'rea:install', 'install REA')]
      : [],
  });
  return [node, reaTile, ghidraTile(rea)];
}

function shortPath(dir) {
  return dir.replace(/^\/Users\/[^/]+/, '~');
}

// Plain-language reasons for REA's Ghidra checks; the full detail is the tooltip.
function ghidraProblem(engine) {
  const { code, detail } = engine.problem || {};
  if (code === 'unsupported_version') return engine.version ? `${engine.version} needs a newer REA` : 'Needs a newer REA';
  if (/java/i.test(code || '') || /\bjava|jdk\b/i.test(detail || '')) return 'Needs a newer Java';
  if (/decompiler/i.test(code || '') || /decompil/i.test(detail || '')) return 'Mac decompiler not built yet';
  return 'REA cannot use this folder';
}

function ghidraTile(rea) {
  const engine = rea.engines.find((item) => item.id === 'ghidra');
  const location = rea.ghidra || {};
  const others = rea.engines.filter((item) => item.available && item.id !== 'ghidra').map((item) => item.id);
  const actions = [];
  const choose = el('button', location.dir ? 'link' : 'btn', location.dir ? 'Change folder' : 'Choose folder');
  choose.type = 'button';
  choose.addEventListener('click', async () => {
    try {
      const result = await api.chooseGhidra();
      if (result.cancelled) return;
      toast(`Using Ghidra at ${shortPath(result.dir)}. Checking it now…`);
      loadStatus();
    } catch (error) {
      toast(cleanError(error));
    }
  });

  let state = null;
  let desc = 'Optional decompiler';
  let descTitle = '';
  if (location.dir) {
    desc = `${shortPath(location.dir)}${location.source === 'detected' ? ', found automatically' : ''}`;
    descTitle = location.dir;
    state = engine?.available
      ? ['ready', engine.version ? `v${engine.version}` : 'Ready']
      : ['attention', ghidraProblem(engine || {}), engine?.problem?.detail];
    if (!engine?.available && /decompil/i.test(engine?.problem?.detail || '')) {
      actions.push(actionButton('btn solid', 'Build decompiler', 'ghidra:build', 'build the Mac decompiler (a few minutes)'));
    }
    actions.push(choose);
    if (location.source === 'chosen') {
      const reset = el('button', 'link', 'Reset');
      reset.type = 'button';
      reset.title = 'Forget this folder and find Ghidra automatically';
      reset.addEventListener('click', async () => {
        await api.resetGhidra();
        loadStatus();
      });
      actions.push(reset);
    }
  } else {
    if (others.length) state = ['ready', `Using ${others.join(', ')}`];
    actions.push(actionButton('btn solid', 'Download', 'ghidra:install', 'download Ghidra 12.1.4'), choose);
  }
  return toolTile({ glyph: outlined(icon('chip')), name: 'Ghidra', desc, descTitle, state, actions });
}

// One tile: icon, name and description, then an optional status line and
// actions pinned to the bottom.
function toolTile({ glyph, name, desc, descTitle = '', state, actions = [] }) {
  const tile = el('div', `tile tool${state?.[0] === 'ready' ? ' ready' : ''}`);
  const head = el('div', 'tile-head');
  const badge = el('span', 'brand small');
  badge.append(glyph);
  const names = el('div');
  const description = el('span', `tile-company${descTitle ? ' path' : ''}`, desc);
  if (descTitle) description.title = descTitle;
  names.append(el('div', 'tile-name', name), description);
  head.append(badge, names);
  const footer = el('div', 'tile-footer');
  if (state === undefined && !actions.length) {
    footer.append(tileStatus('', 'Checking…'));
  } else {
    if (state) {
      const line = tileStatus(state[0], state[1]);
      if (state[2]) line.title = state[2];
      footer.append(line);
    }
    if (actions.length) {
      const row = el('div', 'tile-actions');
      row.append(...actions);
      footer.append(row);
    }
  }
  tile.append(head, footer);
  return tile;
}

function outlined(svg) {
  svg.classList.add('outline');
  return svg;
}

function markIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 40 40');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'outline');
  for (const d of ['M20 4 6 11.5v17L20 36l14-7.5v-17L20 4Z', 'M6 11.5 20 19l14-7.5M20 19v17']) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('stroke-width', '2.6');
    svg.append(path);
  }
  return svg;
}

function actionButton(className, label, actionId, verb) {
  const button = el('button', className, label);
  button.type = 'button';
  button.addEventListener('click', async () => {
    const result = await api.runSetupAction(actionId);
    toast(result.website
      ? `Opened the download page in your browser. Install it, then come back here.`
      : result.opened
        ? `Terminal is open to ${verb}. Come back here when it finishes; Unbox checks again automatically.`
        : `Copied "${result.command}". Paste it into Terminal to ${verb}.`);
  });
  return button;
}

let toastTimer = null;
function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('toast').hidden = true), 6000);
}

function renderSetupLink() {
  const { ready, missing } = setupReadiness(state.status);
  $('setup-dot').className = `dot ${state.status ? (ready ? 'ready' : 'attention') : ''}`;
  $('setup-link-text').textContent = !state.status || ready ? 'Setup' : `Setup needs ${missing.join(' and ')}`;
}

function showSetup() {
  closeMenus();
  renderSetup();
  if (!$('setup-dialog').open) $('setup-dialog').showModal();
  loadStatus();
}

function closeSetup() {
  $('setup-dialog').close();
  writePreference('setupSeen', '1');
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
  state.notice = null;
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

/* Model picker */

function chooseModel(agentId, modelId, { keepAgent = false } = {}) {
  state.models[agentId] = modelId;
  writePreference('models', JSON.stringify(state.models));
  if (!keepAgent) {
    state.agent = agentId;
    writePreference('agent', agentId);
  }
  renderModelPicker();
  updateComposer();
}

function modelLabel(agentId, modelId) {
  const agent = state.status?.agents.find((item) => item.id === agentId);
  const model = agent?.models.find((item) => item.id === modelId);
  return modelId ? model?.label || modelId : AGENT_INFO[agentId].name;
}

function renderModelPicker() {
  const agents = state.status?.agents || [];
  const current = agents.find((agent) => agent.id === state.agent);
  if (!current || (!current.ready && agents.some((agent) => agent.ready))) {
    state.agent = agents.find((agent) => agent.ready)?.id || agents[0]?.id || state.agent || 'claude';
  }
  const agentId = state.agent;
  $('model-logo').replaceChildren(brandIcon(AGENT_INFO[agentId].logo));
  $('model-label').textContent = modelLabel(agentId, state.models[agentId] || '');
  if (!agents.length) return;
  state.menuAgent = agents.some((agent) => agent.id === state.menuAgent) ? state.menuAgent : agentId;

  // Tabs switch which agent's models are listed; picking a model selects both.
  const tabs = el('div', 'model-tabs');
  tabs.setAttribute('role', 'tablist');
  for (const agent of agents) {
    const tab = el('button', 'model-tab');
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(agent.id === state.menuAgent));
    tab.append(brandIcon(AGENT_INFO[agent.id].logo), AGENT_INFO[agent.id].name);
    if (!agent.ready) tab.append(el('span', 'dot attention'));
    tab.addEventListener('click', (event) => {
      event.stopPropagation();
      state.menuAgent = agent.id;
      renderModelPicker();
      $('model-menu').querySelector('[aria-selected="true"]')?.focus();
    });
    tabs.append(tab);
  }

  const agent = agents.find((item) => item.id === state.menuAgent);
  const list = el('div', 'model-list');
  if (!agent.ready) {
    const empty = el('div', 'model-empty');
    empty.append(el('p', null, agent.installed ? `Sign in to ${agent.name} to use its models.` : `${agent.name} is not installed yet.`));
    const fix = el('button', 'btn solid', agent.installed ? 'Sign in' : 'Open setup');
    fix.type = 'button';
    fix.addEventListener('click', () => (agent.installed ? api.runSetupAction(`${agent.id}:signin`).then(() => toast('Terminal is open to sign in. Unbox checks again when you come back.')) : showSetup()));
    empty.append(fix);
    list.append(empty);
  } else {
    let lastGroup = null;
    const selectedId = state.models[agent.id] || '';
    const known = agent.models.some((model) => model.id === selectedId);
    for (const model of agent.models) {
      if (model.group && model.group !== lastGroup) list.append(el('div', 'model-group-label', model.group));
      lastGroup = model.group;
      list.append(modelOption(agent.id, model, agent.id === state.agent && selectedId === model.id));
    }
    if (!known && selectedId) {
      list.append(el('div', 'model-group-label', 'Custom'));
      list.append(modelOption(agent.id, { id: selectedId, label: selectedId }, agent.id === state.agent));
    }
    const custom = el('input', 'custom-model in-menu');
    custom.placeholder = 'Custom model ID, then Enter';
    custom.spellcheck = false;
    custom.setAttribute('aria-label', `Custom ${agent.name} model ID`);
    custom.addEventListener('click', (event) => event.stopPropagation());
    custom.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') closeMenus();
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const value = custom.value.trim();
      if (!/^[\w.:-]{1,80}$/.test(value)) return;
      closeMenus();
      chooseModel(agent.id, value);
    });
    list.append(custom);
  }
  $('model-menu').replaceChildren(tabs, list);
}

function modelOption(agentId, model, selected) {
  const option = el('button', 'model-option');
  option.type = 'button';
  option.setAttribute('role', 'menuitemradio');
  option.setAttribute('aria-checked', String(selected));
  const check = icon('check');
  check.classList.add('check');
  option.append(el('strong', null, model.label), check);
  if (model.description) option.append(el('span', null, model.description));
  option.addEventListener('click', () => {
    closeMenus();
    chooseModel(agentId, model.id);
  });
  return option;
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
  for (const [button, menu] of [['add-button', 'add-menu'], ['model-button', 'model-menu']]) {
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
  } else if (state.notice && !runningHere) {
    // The last request failed before doing anything; say so once, here.
    hint.append(state.notice, ' ');
    if (/sign.?in|log ?in|setup|install/i.test(state.notice)) {
      const link = el('button', null, 'Open setup');
      link.type = 'button';
      link.addEventListener('click', showSetup);
      hint.append(link);
    }
  }
  hint.classList.toggle('error', Boolean(state.notice && !reason && !state.running));
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
  state.notice = null;
  try {
    const turn = await api.startRun(state.project.id, { prompt, agent: state.agent, model: state.models[state.agent] || '' });
    state.running = { projectId: state.project.id, turnId: turn.id };
    state.project.turns.push(turn);
    $('prompt').value = '';
    autosize();
    renderTargets();
    renderThread();
    updateComposer();
  } catch (error) {
    state.notice = cleanError(error);
    updateComposer();
  }
}

/* Thread */

const liveViews = new Map();
const FILE_TOOLS = new Set(['write', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit']);
const SOURCE_LABELS = { rea: 'REA', shell: 'Shell', files: 'Files', other: 'Tool' };

// Runs saved before steps were tagged are classified by tool name.
function stepSource(step) {
  if (step.source) return step.source;
  if (step.name === 'shell') return 'shell';
  return FILE_TOOLS.has(step.name) ? 'files' : 'rea';
}

function renderThread() {
  liveViews.clear();
  const turns = [...(state.project?.turns || [])].reverse();
  $('thread').replaceChildren(...turns.map(turnView));
}

function turnView(saved) {
  // Runs saved before notes and answers were separated hold everything in
  // one block, which would read as an answer. Show it as a transcript instead.
  const legacy = saved.status === 'done' && saved.notes === undefined && Boolean(saved.answer);
  const turn = legacy ? { ...saved, notes: [saved.answer], answer: '', legacy: true } : saved;
  const article = el('article', 'turn');
  const head = el('div', 'turn-head');
  head.append(el('div', 'turn-prompt', turn.prompt));
  if (turn.status !== 'running') {
    const remove = el('button', 'turn-remove');
    remove.type = 'button';
    remove.title = 'Remove from this project';
    remove.setAttribute('aria-label', 'Remove this run');
    remove.append(icon('close'));
    remove.addEventListener('click', async () => {
      try {
        state.project = await api.removeTurn(state.project.id, turn.id);
        renderThread();
        updateComposer();
      } catch (error) {
        toast(cleanError(error));
      }
    });
    head.append(remove);
  }
  article.append(head);

  const agentName = AGENT_INFO[turn.agent]?.name || turn.agent;
  const model = turn.model ? modelLabel(turn.agent, turn.model) : null;
  const stateLabel = turn.status === 'running' ? 'Working' : turn.status === 'done' ? 'Done' : 'Stopped';
  const meta = el('div', 'turn-meta');
  const status = el('span', `state${turn.status === 'running' ? ' live' : turn.status === 'stopped' ? ' failed' : ''}`, stateLabel);
  const reaBadge = el('span', 'rea-badge');
  meta.append(el('span', null, model ? `${agentName}, ${model}` : agentName), el('span', null, formatTime(turn.createdAt)), status, reaBadge);
  article.append(meta);

  const live = el('div', 'live-line');
  live.append(el('span', 'pulse'), el('span', null, 'Starting'));
  live.hidden = turn.status !== 'running';

  const answer = el('div', 'answer markdown');
  if (turn.legacy) {
    answer.className = 'legacy-note';
    answer.textContent = 'This run was saved before Unbox kept the final summary separate, so its progress notes and summary are together under How it got there. Ask again to get a single summary.';
  }
  const output = el('section', 'output');
  const error = el('div', 'turn-error');

  const activity = el('details', 'activity');
  const summary = el('summary');
  const notes = el('div', 'activity-notes');
  const list = el('ul', 'activity-list');
  activity.append(summary, notes, list);
  for (const note of turn.notes || []) notes.append(noteItem(note));
  for (const scanned of turn.scans || []) list.append(scanItem(scanned));
  for (const step of turn.steps || []) list.append(stepItem(step));

  // The files a run produced are its result, so they come first.
  article.append(live, output, answer, error, activity);
  const view = { turn, status, reaBadge, live, activity, summary, notes, list, answer, output, error };
  refreshTurn(view);
  if (turn.status === 'running') liveViews.set(turn.id, view);
  return article;
}

function noteItem(text) {
  const note = el('div', 'note markdown');
  window.renderMarkdown(note, text);
  return note;
}

function scanItem(scanned) {
  const item = el('li', 'scan');
  const detail = scanned.ok ? scanned.headline || scanned.kind : scanned.error?.message || 'REA could not read this file.';
  item.append(el('span', 'source rea', 'REA'), el('span', 'step-name', `Scanned ${scanned.name}`), el('span', 'step-detail', detail));
  item.title = detail;
  return item;
}

function stepItem(step) {
  const source = stepSource(step);
  const detail = stepDetail(step);
  const item = el('li');
  item.append(el('span', `source ${source}`, SOURCE_LABELS[source] || 'Tool'), el('span', 'step-name', step.name), el('span', 'step-detail', detail));
  item.title = step.detail || '';
  return item;
}

// Shorter labels for steps saved before the agent runner tidied them:
// no shell wrapper, file names instead of full paths.
function stepDetail(step) {
  const detail = String(step.detail || '');
  if (step.name === 'shell') {
    const inner = /^\S*\/(?:ba|z)?sh\s+-l?c\s+([\s\S]*)$/.exec(detail)?.[1] ?? detail;
    return inner.replace(/^(['"])([\s\S]*)\1$/, '$2');
  }
  if (detail.startsWith('/')) return detail.split(/,\s*/).map((part) => part.split('/').pop()).join(', ');
  return detail;
}

function outputList(turn) {
  const files = turn.files || [];
  if (!files.length) return [];
  const heading = el('div', 'output-head');
  heading.append(el('span', null, `Output, ${plural(files.length, 'file')}`));
  const reveal = el('button', 'link', 'Show in Finder');
  reveal.type = 'button';
  reveal.addEventListener('click', () => api.revealProjectFile(state.project.id, files[0].path).catch((error) => toast(cleanError(error))));
  heading.append(reveal);
  const list = el('ul', 'output-list');
  for (const file of files) {
    const row = el('li');
    const open = el('button', 'output-file');
    open.type = 'button';
    open.title = `Open ${file.path}`;
    const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/') + 1) : '';
    const name = el('span', 'output-name');
    if (dir) name.append(el('span', 'output-dir', dir));
    name.append(file.path.slice(dir.length));
    open.append(icon('file'), name, el('span', 'output-meta', `${{ new: 'New', changed: 'Updated', linked: 'Linked' }[file.status] || 'File'}, ${formatBytes(file.size)}`));
    open.addEventListener('click', () => openOutput(file.path));
    row.append(open);
    list.append(row);
  }
  return [heading, list];
}

async function openOutput(rel) {
  try {
    const result = await api.openProjectFile(state.project.id, rel);
    if (result?.revealed) toast(`${rel} could run code, so it is shown in Finder instead of opened.`);
  } catch (error) {
    toast(cleanError(error));
  }
}

function refreshTurn(view) {
  const { turn } = view;
  const steps = turn.steps || [];
  const counts = { rea: (turn.scans || []).length, shell: 0, files: 0, other: 0 };
  for (const step of steps) counts[stepSource(step)] += 1;
  const reaCalls = counts.rea;

  // Whether REA did the reading is the key fact, so it sits in the meta row.
  view.reaBadge.className = `rea-badge ${reaCalls ? 'used' : turn.status === 'running' ? 'pending' : 'unused'}`;
  view.reaBadge.textContent = reaCalls ? `REA, ${plural(reaCalls, 'call')}` : turn.status === 'running' ? '' : 'No REA calls';
  view.reaBadge.hidden = !view.reaBadge.textContent;
  view.reaBadge.title = reaCalls
    ? 'The agent read the target through REA.'
    : 'The agent answered without calling REA, so the answer is not backed by REA evidence.';

  const parts = [];
  if (counts.rea) parts.push(plural(counts.rea, 'REA call'));
  if (counts.shell) parts.push(plural(counts.shell, 'shell command'));
  if (counts.files) parts.push(plural(counts.files, 'file step'));
  if (turn.legacy) parts.push('saved transcript');
  else if (turn.notes?.length) parts.push(plural(turn.notes.length, 'note'));
  view.activity.hidden = !parts.length;
  view.summary.replaceChildren(icon('chevron'), `How it got there: ${parts.join(', ')}`);

  if (turn.answer) window.renderMarkdown(view.answer, turn.answer);
  view.answer.hidden = !turn.answer && !turn.legacy;
  view.output.replaceChildren(...outputList(turn));
  view.output.hidden = !view.output.childNodes.length;
  view.error.textContent = turn.error || '';
  view.error.hidden = !turn.error;
}

// Links in answers point at files the agent wrote; open them in place.
window.onMarkdownLink = (target) => openOutput(target);

api.onRunEvent(({ projectId, turnId, event }) => {
  const view = liveViews.get(turnId);
  if (event.kind === 'done') {
    if (state.running?.turnId === turnId) state.running = null;
    if (state.project?.id === projectId) {
      if (event.discarded) {
        // Nothing ran: drop the run, give the request back, explain once.
        state.project.turns = state.project.turns.filter((turn) => turn.id !== turnId);
        if (!$('prompt').value.trim()) {
          $('prompt').value = event.prompt || '';
          autosize();
        }
        state.notice = event.text;
      } else {
        const index = state.project.turns.findIndex((turn) => turn.id === turnId);
        if (index >= 0) state.project.turns[index] = event.turn;
      }
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
    if (event.state === 'running') liveText.textContent = `REA is scanning ${event.name}: ${event.text}`;
    if (event.state === 'done') {
      view.turn.scans.push(event.summary);
      view.list.append(scanItem(event.summary));
    }
  } else if (event.kind === 'tool') {
    view.turn.steps.push({ name: event.name, detail: event.detail, source: event.source });
    view.list.append(stepItem(event));
    liveText.textContent = `${SOURCE_LABELS[stepSource(event)] || 'Tool'}: ${[event.name, event.detail].filter(Boolean).join('  ')}`;
  } else if (event.kind === 'text') {
    // Until the run ends, every message is a progress note.
    (view.turn.notes ||= []).push(event.text);
    view.notes.append(noteItem(event.text));
    liveText.textContent = event.text.split('\n')[0].slice(0, 160);
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

$('setup-done').addEventListener('click', closeSetup);
$('setup-close').addEventListener('click', closeSetup);
$('setup-dialog').addEventListener('cancel', () => writePreference('setupSeen', '1'));
$('setup-recheck').addEventListener('click', loadStatus);
$('open-setup').addEventListener('click', showSetup);
// Signing in happens in Terminal and the browser; re-check when the user comes back.
window.addEventListener('focus', () => {
  if ($('setup-dialog').open) loadStatus();
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
$('model-button').addEventListener('click', () => {
  // Open on the tab of the agent in use.
  state.menuAgent = state.agent;
  renderModelPicker();
  toggleMenu($('model-button'), $('model-menu'));
});
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
renderModelPicker();
loadProjects().then(showEmpty);
// Setup opens at launch the first time, and whenever something required is missing.
if (!readPreference('setupSeen')) showSetup();
loadStatus().then((status) => {
  if (!setupReadiness(status).ready) showSetup();
});
