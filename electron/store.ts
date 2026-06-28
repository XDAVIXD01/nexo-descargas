import { promises as fs } from "node:fs";
import path from "node:path";
import type { DownloadItem, Settings } from "./types.js";

interface State {
  downloads: DownloadItem[];
  settings: Settings;
}

export class JsonStore {
  private state: State;
  private saveTimer?: NodeJS.Timeout;
  private saveChain: Promise<void> = Promise.resolve();
  private readonly settingsFile: string;

  constructor(private readonly file: string, defaults: Settings, settingsFile?: string) {
    this.state = { downloads: [], settings: defaults };
    this.settingsFile = settingsFile || path.join(path.dirname(file), "config.json");
  }

  async load(): Promise<void> {
    let raw: Partial<State> | undefined;
    try {
      raw = JSON.parse(await fs.readFile(this.file, "utf8")) as Partial<State>;
    } catch (error: any) {
      try {
        raw = JSON.parse(await fs.readFile(`${this.file}.bak`, "utf8")) as Partial<State>;
        console.warn("Se recuperó el estado desde la copia de seguridad");
      } catch {
        if (error?.code !== "ENOENT") console.error("No se pudo leer el estado", error);
      }
    }
    if (raw) {
      this.state.downloads = await Promise.all((raw.downloads || []).map(async item => {
        let downloadedBytes = item.downloadedBytes || 0;
        if (item.savePath) {
          try {
            downloadedBytes = (await fs.stat(item.savePath)).size;
          } catch {}
        }
        const interrupted = ["checking", "downloading", "recovering", "resolving", "retrying"].includes(item.status);
        return {
        ...item,
          status: interrupted ? "queued" : item.status,
          downloadedBytes,
          speed: 0,
          retryAt: undefined,
          resumeOnLaunch: interrupted,
          recoveryBytesRemaining: undefined
        } as DownloadItem;
      }));
    }
    const storedSettings = await this.readJson<Partial<Settings>>(this.settingsFile)
      || await this.readJson<Partial<Settings>>(`${this.settingsFile}.bak`)
      || raw?.settings
      || {};
    this.state.settings = this.normalizeSettings({ ...this.state.settings, ...storedSettings });
  }

  get downloads(): DownloadItem[] {
    return this.state.downloads;
  }

  get settings(): Settings {
    return this.state.settings;
  }

  setSettings(settings: Partial<Settings>): Settings {
    this.state.settings = this.normalizeSettings({ ...this.state.settings, ...settings });
    void this.save();
    return this.state.settings;
  }

  schedule(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.save(), 120);
  }

  async save(): Promise<void> {
    clearTimeout(this.saveTimer);
    const snapshot = JSON.stringify(this.state, null, 2);
    const settingsSnapshot = JSON.stringify(this.state.settings, null, 2);
    this.saveChain = this.saveChain.then(async () => {
      await this.writeAtomic(this.file, snapshot);
      await this.writeAtomic(this.settingsFile, settingsSnapshot);
    }).catch(error => console.error("No se pudo guardar el estado", error));
    await this.saveChain;
  }

  private async readJson<T>(file: string): Promise<T | undefined> {
    try {
      return JSON.parse(await fs.readFile(file, "utf8")) as T;
    } catch {
      return undefined;
    }
  }

  private async writeAtomic(file: string, contents: string): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    try {
      await fs.copyFile(file, `${file}.bak`);
    } catch {}
    await fs.writeFile(temporary, contents, "utf8");
    try {
      await fs.rename(temporary, file);
    } catch (error: any) {
      if (!["EEXIST", "EPERM"].includes(error?.code)) throw error;
      await fs.rm(file, { force: true });
      await fs.rename(temporary, file);
    }
  }

  private normalizeSettings(settings: Settings): Settings {
    return {
      downloadDirectory: settings.downloadDirectory || this.state.settings.downloadDirectory,
      concurrentDownloads: Math.max(1, Math.min(8, Number(settings.concurrentDownloads) || 2)),
      speedLimitKbps: Math.max(0, Number(settings.speedLimitKbps) || 0),
      startAutomatically: settings.startAutomatically !== false
    };
  }
}
