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

  constructor(private readonly file: string, defaults: Settings) {
    this.state = { downloads: [], settings: defaults };
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, "utf8")) as Partial<State>;
      this.state.downloads = (raw.downloads || []).map(item => ({
        ...item,
        status: item.status === "checking"
          ? "queued"
          : item.status === "downloading" || item.status === "resolving"
            ? "paused"
            : item.status,
        speed: 0
      }));
      this.state.settings = { ...this.state.settings, ...raw.settings };
    } catch (error: any) {
      if (error?.code !== "ENOENT") console.error("No se pudo leer el estado", error);
    }
  }

  get downloads(): DownloadItem[] {
    return this.state.downloads;
  }

  get settings(): Settings {
    return this.state.settings;
  }

  setSettings(settings: Partial<Settings>): Settings {
    this.state.settings = { ...this.state.settings, ...settings };
    this.schedule();
    return this.state.settings;
  }

  schedule(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.save(), 120);
  }

  async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this.state, null, 2), "utf8");
  }
}
