'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, shell, nativeTheme } = require('electron');
const { reaStatus, scan } = require('./rea');
const { AGENTS, agentStatus, runAgent } = require('./agents');
const { TASKS, buildPrompt } = require('./prompts');

let mainWindow = null;
let activeScan = null;
let activeAgent = null;
// Only paths the user picked or dropped can be analyzed.
const approvedTargets = new Set();
// One workspace folder per target, holding scan.json and the agent's output.
const workspaces = new Map();

function workspaceRoot() {
  const dir = path.join(app.getPath('userData'), 'workspaces');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function workspaceFor(targetPath) {
  if (workspaces.has(targetPath)) return workspaces.get(targetPath);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = path.basename(targetPath).replace(/[^\w.-]+/g, '_').slice(0, 60) || 'target';
  const dir = path.join(workspaceRoot(), `${stamp}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  workspaces.set(targetPath, dir);
  return dir;
}

function describeTarget(targetPath) {
  const stat = fs.statSync(targetPath);
  return {
    path: targetPath,
    name: path.basename(targetPath),
    isDirectory: stat.isDirectory(),
    size: stat.isDirectory() ? null : stat.size,
  };
}

function approve(targetPath) {
  if (typeof targetPath !== 'string' || !path.isAbsolute(targetPath) || !fs.existsSync(targetPath)) {
    throw new Error('That file is not available.');
  }
  approvedTargets.add(targetPath);
  return describeTarget(targetPath);
}

function requireApproved(targetPath) {
  if (!approvedTargets.has(targetPath)) throw new Error('Choose the target again before analyzing it.');
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'Unbox',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0c0d10' : '#f6f7f9',
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

ipcMain.handle('status:get', async () => {
  const [rea, claude, codex] = await Promise.all([
    reaStatus(workspaceRoot()),
    agentStatus('claude'),
    agentStatus('codex'),
  ]);
  return { rea, agents: [claude, codex], tasks: Object.entries(TASKS).map(([id, task]) => ({ id, label: task.label })) };
});

ipcMain.handle('target:pick', async (_event, kind) => {
  // With openFile, macOS .app bundles are selectable as a single item.
  const properties = kind === 'folder' ? ['openDirectory'] : ['openFile'];
  const result = await dialog.showOpenDialog(mainWindow, {
    title: kind === 'folder' ? 'Choose an application folder' : 'Choose a file to analyze',
    properties,
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return approve(result.filePaths[0]);
});

ipcMain.handle('target:drop', (_event, targetPath) => approve(targetPath));

ipcMain.handle('scan:start', async (_event, targetPath) => {
  requireApproved(targetPath);
  activeScan?.abort();
  const controller = new AbortController();
  activeScan = controller;
  const workspace = workspaceFor(targetPath);
  try {
    const result = await scan(targetPath, {
      workspace,
      signal: controller.signal,
      onProgress: (message) => send('scan:progress', message),
    });
    return { ...result, workspace };
  } catch (error) {
    return { error: { message: error.message }, workspace };
  } finally {
    if (activeScan === controller) activeScan = null;
  }
});

ipcMain.handle('scan:cancel', () => activeScan?.abort());

ipcMain.handle('agent:start', async (_event, request) => {
  const { agent, task, question, targetPath, scan: scanSummary } = request || {};
  requireApproved(targetPath);
  if (!AGENTS[agent]) throw new Error('Unknown agent.');
  if (!TASKS[task]) throw new Error('Unknown task.');
  const status = await agentStatus(agent);
  if (!status.ready) throw new Error(status.hint || `${status.name} is not ready.`);
  activeAgent?.stop();
  const workspace = workspaceFor(targetPath);
  const prompt = buildPrompt({ task, question: String(question || '').slice(0, 4000), targetPath, scan: scanSummary });
  fs.writeFileSync(path.join(workspace, 'PROMPT.md'), prompt);
  const run = runAgent({
    id: agent,
    prompt,
    workspace,
    targetPath,
    onEvent: (event) => {
      if (event.kind === 'done' && activeAgent === run) activeAgent = null;
      send('agent:event', event);
    },
  });
  activeAgent = run;
  return { workspace };
});

ipcMain.handle('agent:stop', () => activeAgent?.stop());

ipcMain.handle('workspace:open', (_event, dir) => {
  if (typeof dir !== 'string' || !dir.startsWith(workspaceRoot())) return;
  shell.openPath(dir);
});

ipcMain.handle('workspace:report', (_event, dir) => {
  if (typeof dir !== 'string' || !dir.startsWith(workspaceRoot())) return null;
  const report = path.join(dir, 'REPORT.md');
  return fs.existsSync(report) ? fs.readFileSync(report, 'utf8').slice(0, 400000) : null;
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  activeScan?.abort();
  activeAgent?.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
