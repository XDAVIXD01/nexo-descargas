import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("nexo", {
  getState: () => ipcRenderer.invoke("state:get"),
  add: (text: string) => ipcRenderer.invoke("downloads:add", text),
  action: (name: string, id?: string, extra?: unknown) =>
    ipcRenderer.invoke("downloads:action", name, id, extra),
  updateSettings: (patch: Record<string, unknown>) => ipcRenderer.invoke("settings:update", patch),
  chooseDirectory: () => ipcRenderer.invoke("directory:choose"),
  openPath: (target: string) => ipcRenderer.invoke("path:open", target),
  onState: (callback: (state: unknown) => void) => {
    const listener = (_event: unknown, state: unknown) => callback(state);
    ipcRenderer.on("state:changed", listener);
    return () => ipcRenderer.removeListener("state:changed", listener);
  }
});
