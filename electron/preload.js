const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('workwebDesktop', {
  selectDirectory: options => ipcRenderer.invoke('workweb:selectDirectory', options || {}),
  selectImportFile: () => ipcRenderer.invoke('workweb:selectImportFile')
});
