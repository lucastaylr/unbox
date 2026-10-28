'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell } = require('electron');
const { reaStatus, scan } = require('./rea');
const { AGENTS, agentStatus, runAgent } = require('./agents');
const { buildPrompt } = require('./prompts');
const { ProjectStore } = require('./projects');

let mainWindow = null;
let store = null;
// The single active run: { projectId, turnId, controller, agent }.
let activeRun = null;

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function createWindow() {
  const mac = process.platform === 'darwin';
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 660,
    show: false,
    title: 'Unbox',
    titleBarStyle: mac ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 20, y: 20 },
    // Native macOS blur gives the glass something real to show through.
    vibrancy: mac ? 'under-window' : undefined,
    visualEffectState: mac ? 'active' : undefined,
    backgroundColor: mac ? '#00000000' : '#12151c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

/* Setup */

ipcMain.handle('setup:status', async () => {
  const [rea, claude, codex] = await Promise.all([
    reaStatus(store.root),
    agentStatus('claude'),
    agentStatus('codex'),
  ]);
  return { rea, agents: [claude, codex] };
});

ipcMain.handle('clipboard:write', (_event, text) => clipboard.writeText(String(text).slice(0, 2000)));

/* Projects */

ipcMain.handle('projects:list', () => store.list());
ipcMain.handle('projects:create', (_event, name) => store.create(name));
ipcMain.handle('projects:get', (_event, id) => store.get(id));
ipcMain.handle('projects:rename', (_event, id, name) => store.rename(id, name));

ipcMain.handle('projects:add', async (_event, id, kind) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: kind === 'folder' ? 'Add a folder' : 'Add files',
    buttonLabel: 'Add',
    // With openFile, macOS .app bundles are selectable as a single item.
    properties: kind === 'folder' ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
  });
  if (result.canceled) return store.get(id);
  return store.addTargets(id, result.filePaths);
});

// Paths come from files the user dropped onto the window.
ipcMain.handle('projects:drop', (_event, id, paths) => store.addTargets(id, Array.isArray(paths) ? paths : []));
ipcMain.handle('projects:remove', (_event, id, targetPath) => store.removeTarget(id, targetPath));

ipcMain.handle('projects:reveal', (_event, id) => shell.openPath(store.dir(id)));

/* Runs */

ipcMain.handle('run:start', async (_event, id, request) => {
  if (activeRun) throw new Error('Another run is still going. Stop it first.');
  const prompt = String(request?.prompt || '').trim().slice(0, 8000);
  const agentId = request?.agent;
  if (!prompt) throw new Error('Type a request first.');
  if (!AGENTS[agentId]) throw new Error('Choose an agent.');
  const project = store.get(id);
  if (!project.targets.length) throw new Error('Add a file or folder first.');
  const status = await agentStatus(agentId);
  if (!status.ready) throw new Error(status.hint || `${status.name} is not ready.`);

  const turn = {
    id: crypto.randomBytes(6).toString('hex'),
    prompt,
    agent: agentId,
    createdAt: new Date().toISOString(),
    status: 'running',
    scans: [],
    steps: [],
    answer: '',
    error: null,
  };
  store.update(id, (draft) => draft.turns.push(turn));
  const controller = new AbortController();
  activeRun = { projectId: id, turnId: turn.id, controller, agent: null };
  executeRun(id, turn, controller).catch((error) => finishTurn(id, turn, { ok: false, text: error.message }));
  return turn;
});

ipcMain.handle('run:stop', () => {
  if (!activeRun) return;
  activeRun.controller.abort();
  activeRun.agent?.stop();
});

function emit(projectId, turnId, event) {
  send('run:event', { projectId, turnId, event });
}

async function executeRun(projectId, turn, controller) {
  const workspace = store.dir(projectId);
  let project = store.get(projectId);

  // Scan anything REA has not seen yet, one target at a time.
  for (const [index, target] of project.targets.entries()) {
    if (target.scan && !target.scan.error) continue;
    if (controller.signal.aborted) return finishTurn(projectId, turn, { ok: false, text: 'Stopped.' });
    emit(projectId, turn.id, { kind: 'scan', name: target.name, state: 'running', text: 'Starting REA' });
    const result = await scan(target.path, {
      workspace,
      evidenceFile: `scan-${index + 1}-${target.name.replace(/[^\w.-]+/g, '_').slice(0, 40)}.json`,
      signal: controller.signal,
      onProgress: (text) => emit(projectId, turn.id, { kind: 'scan', name: target.name, state: 'running', text }),
    });
    if (result.cancelled) return finishTurn(projectId, turn, { ok: false, text: 'Stopped.' });
    project = store.update(projectId, (draft) => {
      const stored = draft.targets.find((item) => item.path === target.path);
      if (stored) stored.scan = result;
    });
    const summary = { name: target.name, ok: !result.error, kind: result.kind, headline: result.headline, error: result.error };
    turn.scans.push(summary);
    emit(projectId, turn.id, { kind: 'scan', name: target.name, state: 'done', summary });
  }
  if (controller.signal.aborted) return finishTurn(projectId, turn, { ok: false, text: 'Stopped.' });

  const fullPrompt = buildPrompt({ prompt: turn.prompt, targets: project.targets });
  fs.writeFileSync(path.join(workspace, 'last-prompt.md'), fullPrompt);
  const answer = [];
  activeRun.agent = runAgent({
    id: turn.agent,
    prompt: fullPrompt,
    workspace,
    targetPaths: project.targets.map((target) => target.path),
    onEvent: (event) => {
      if (event.kind === 'text') answer.push(event.text);
      if (event.kind === 'tool') turn.steps.push({ name: event.name, detail: event.detail });
      if (event.kind === 'done') {
        turn.answer = answer.join('\n\n');
        return finishTurn(projectId, turn, event);
      }
      emit(projectId, turn.id, event);
    },
  });
}

function finishTurn(projectId, turn, event) {
  if (turn.status !== 'running') return;
  turn.status = event.ok ? 'done' : 'stopped';
  turn.error = event.ok ? null : event.text || 'The run stopped.';
  turn.finishedAt = new Date().toISOString();
  store.update(projectId, (draft) => {
    const index = draft.turns.findIndex((item) => item.id === turn.id);
    if (index >= 0) draft.turns[index] = turn;
  });
  if (activeRun?.turnId === turn.id) activeRun = null;
  emit(projectId, turn.id, { kind: 'done', ok: event.ok, text: turn.error, turn });
}

/* App lifecycle */

app.whenReady().then(() => {
  // Unbox is dark-only; this also makes the native glass material dark.
  nativeTheme.themeSource = 'dark';
  store = new ProjectStore(path.join(app.getPath('userData'), 'projects'));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  activeRun?.controller.abort();
  activeRun?.agent?.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
