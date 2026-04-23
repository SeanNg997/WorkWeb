const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('workwebDesktop', {
  readData: key => ipcRenderer.invoke('data:read', key),
  writeData: (key, data) => ipcRenderer.invoke('data:write', key, data)
});
