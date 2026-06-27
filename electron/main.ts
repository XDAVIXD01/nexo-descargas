import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JsonStore } from "./store.js";
import { DownloadManager } from "./download-manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;

async function createWindow(): Promise<void> {
  const store = new JsonStore(path.join(app.getPath("userData"), "state.json"), {
    downloadDirectory: app.getPath("downloads"),
    concurrentDownloads: 2,
    speedLimitKbps: 0,
    startAutomatically: true
  });
  await store.load();
  const manager = new DownloadManager(store);

  mainWindow = new BrowserWindow({
    width: 1220,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0d111a",
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#0d111a", symbolColor: "#dbe5ff", height: 44 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) await mainWindow.loadURL(devUrl);
  else await mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));

  manager.on("changed", state => mainWindow?.webContents.send("state:changed", state));
  ipcMain.handle("state:get", () => manager.snapshot());
  ipcMain.handle("downloads:add", (_event, text: string) => manager.add(text));
  ipcMain.handle("downloads:action", async (_event, action: string, id?: string, extra?: unknown) => {
    if (action === "start" && id) await manager.start(id);
    else if (action === "pause" && id) manager.pause(id);
    else if (action === "retry" && id) await manager.retry(id);
    else if (action === "remove" && id) await manager.remove(id, Boolean(extra));
    else if (action === "clearCompleted") await manager.clearCompleted();
    return manager.snapshot();
  });
  ipcMain.handle("settings:update", (_event, patch) => manager.updateSettings(patch));
  ipcMain.handle("directory:choose", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ["openDirectory", "createDirectory"] });
    if (!result.canceled && result.filePaths[0]) manager.updateSettings({ downloadDirectory: result.filePaths[0] });
    return result.filePaths[0];
  });
  ipcMain.handle("path:open", (_event, target: string) => shell.showItemInFolder(target));

  mainWindow.on("closed", () => {
    void store.save();
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (!BrowserWindow.getAllWindows().length) void createWindow();
});
