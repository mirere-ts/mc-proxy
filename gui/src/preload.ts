/**
 * renderer(mainWorld)に 安全な API だけを渡す橋。
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

const FORWARD_CHANNELS = new Set(["log", "status", "update"]);

contextBridge.exposeInMainWorld("mcproxy", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  saveConfig: (partial: unknown) => ipcRenderer.invoke("config:save", partial),
  startBridge: (input: unknown) => ipcRenderer.invoke("bridge:start", input),
  stopBridge: () => ipcRenderer.invoke("bridge:stop"),
  startServer: (input: unknown) => ipcRenderer.invoke("server:start", input),
  stopServer: () => ipcRenderer.invoke("server:stop"),
  getStatus: () => ipcRenderer.invoke("status:get"),
  logHistory: () => ipcRenderer.invoke("log:history"),
  clearLogs: () => ipcRenderer.invoke("log:clear"),
  appInfo: () => ipcRenderer.invoke("app:info"),
  updateState: () => ipcRenderer.invoke("update:state"),
  checkUpdates: () => ipcRenderer.invoke("update:check"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  openExternal: (url: string) => ipcRenderer.invoke("shell:open", url),
  /** log / status / update の push を購読する。戻り値は解除関数。 */
  on: (channel: string, callback: (data: unknown) => void): (() => void) => {
    if (!FORWARD_CHANNELS.has(channel)) return () => {};
    const listener = (_event: IpcRendererEvent, data: unknown) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
