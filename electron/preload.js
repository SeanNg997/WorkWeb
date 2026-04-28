const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('workwebDesktop', {
  platform: process.platform,
  minimizeWindow: () => ipcRenderer.invoke('workweb:minimizeWindow'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('workweb:toggleMaximizeWindow'),
  closeWindow: () => ipcRenderer.invoke('workweb:closeWindow'),
  isWindowMaximized: () => ipcRenderer.invoke('workweb:isWindowMaximized'),
  onWindowMaximized: callback => {
    const listener = (_event, maximized) => callback?.(maximized);
    ipcRenderer.on('workweb:windowMaximized', listener);
    return () => ipcRenderer.removeListener('workweb:windowMaximized', listener);
  },
  selectDirectory: options => ipcRenderer.invoke('workweb:selectDirectory', options || {}),
  selectImportFile: () => ipcRenderer.invoke('workweb:selectImportFile'),
  getSetting: key => ipcRenderer.invoke('workweb:getSetting', key),
  setSetting: (key, value) => ipcRenderer.invoke('workweb:setSetting', key, value),
  getUpdateState: () => ipcRenderer.invoke('workweb:getUpdateState'),
  checkForUpdates: () => ipcRenderer.invoke('workweb:checkForUpdates'),
  downloadUpdate: () => ipcRenderer.invoke('workweb:downloadUpdate'),
  onUpdateState: callback => {
    const listener = (_event, state) => callback?.(state);
    ipcRenderer.on('workweb:updateState', listener);
    return () => ipcRenderer.removeListener('workweb:updateState', listener);
  }
});
