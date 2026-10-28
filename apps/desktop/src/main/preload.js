'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('unbox', {
  status: () => ipcRenderer.invoke('status:get'),
  pickTarget: (kind) => ipcRenderer.invoke('target:pick', kind),
  dropTarget: (file) => ipcRenderer.invoke('target:drop', webUtils.getPathForFile(file)),
  scan: (targetPath) => ipcRenderer.invoke('scan:start', targetPath),
  cancelScan: () => ipcRenderer.invoke('scan:cancel'),
  onScanProgress: (callback) => subscribe('scan:progress', callback),
  startAgent: (request) => ipcRenderer.invoke('agent:start', request),
  stopAgent: () => ipcRenderer.invoke('agent:stop'),
  onAgentEvent: (callback) => subscribe('agent:event', callback),
  openWorkspace: (dir) => ipcRenderer.invoke('workspace:open', dir),
  readReport: (dir) => ipcRenderer.invoke('workspace:report', dir),
});
