'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('unbox', {
  setupStatus: () => ipcRenderer.invoke('setup:status'),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  runSetupAction: (actionId) => ipcRenderer.invoke('setup:run', actionId),
  chooseGhidra: () => ipcRenderer.invoke('ghidra:choose'),
  resetGhidra: () => ipcRenderer.invoke('ghidra:reset'),

  listProjects: () => ipcRenderer.invoke('projects:list'),
  createProject: (name) => ipcRenderer.invoke('projects:create', name),
  getProject: (id) => ipcRenderer.invoke('projects:get', id),
  renameProject: (id, name) => ipcRenderer.invoke('projects:rename', id, name),
  addTargets: (id, kind) => ipcRenderer.invoke('projects:add', id, kind),
  dropTargets: (id, files) => ipcRenderer.invoke('projects:drop', id, [...files].map((file) => webUtils.getPathForFile(file))),
  removeTarget: (id, targetPath) => ipcRenderer.invoke('projects:remove', id, targetPath),
  revealProject: (id) => ipcRenderer.invoke('projects:reveal', id),
  openProjectFile: (id, rel) => ipcRenderer.invoke('projects:openFile', id, rel),
  revealProjectFile: (id, rel) => ipcRenderer.invoke('projects:revealFile', id, rel),
  removeTurn: (id, turnId) => ipcRenderer.invoke('projects:removeTurn', id, turnId),

  startRun: (id, request) => ipcRenderer.invoke('run:start', id, request),
  stopRun: () => ipcRenderer.invoke('run:stop'),
  onRunEvent: (callback) => subscribe('run:event', callback),
});
