import type { AddResult, DownloadItem, Settings } from "../electron/types";

interface AppState {
  downloads: DownloadItem[];
  settings: Settings;
}

declare global {
  interface Window {
    nexo: {
      getState(): Promise<AppState>;
      add(text: string): Promise<AddResult>;
      action(name: string, id?: string, extra?: unknown): Promise<AppState>;
      updateSettings(patch: Partial<Settings>): Promise<Settings>;
      chooseDirectory(): Promise<string | undefined>;
      openPath(target: string): Promise<void>;
      onState(callback: (state: AppState) => void): () => void;
    };
  }
}

export {};
