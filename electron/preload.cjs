const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("ymliuCaoXingAgent", {
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  onUpdateState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("app:update-state", listener);
    return () => ipcRenderer.removeListener("app:update-state", listener);
  },
  openPath: (filePath) => ipcRenderer.invoke("shell:openPath", filePath),
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return file?.path || "";
    }
  },
});
