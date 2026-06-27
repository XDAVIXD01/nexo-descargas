import { createWriteStream, existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AddResult, DownloadItem, Settings } from "./types.js";
import { JsonStore } from "./store.js";
import { resolveLink, supportsUrl } from "./resolvers.js";

function uniquePath(directory: string, name: string, current?: string): string {
  const base = path.join(directory, name);
  if (current === base || !existsSync(base)) return base;
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  for (let i = 2; ; i++) {
    const candidate = path.join(directory, `${stem} (${i})${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
}

export class DownloadManager extends EventEmitter {
  private controllers = new Map<string, AbortController>();
  private pumping = false;

  constructor(private readonly store: JsonStore) {
    super();
  }

  snapshot(): { downloads: DownloadItem[]; settings: Settings } {
    return {
      downloads: this.store.downloads.map(item => ({ ...item })),
      settings: { ...this.store.settings }
    };
  }

  async add(rawText: string): Promise<AddResult> {
    const urls = [...new Set(rawText.match(/https?:\/\/[^\s<>"']+/gi) || [])];
    const result: AddResult = { added: 0, rejected: [] };
    for (const sourceUrl of urls) {
      if (!supportsUrl(sourceUrl)) {
        result.rejected.push({ url: sourceUrl, reason: "Sitio no compatible" });
        continue;
      }
      if (this.store.downloads.some(item => item.sourceUrl === sourceUrl && item.status !== "cancelled")) {
        result.rejected.push({ url: sourceUrl, reason: "El enlace ya está en la lista" });
        continue;
      }
      this.store.downloads.unshift({
        id: randomUUID(),
        sourceUrl,
        name: new URL(sourceUrl).pathname.split("/").filter(Boolean).pop() || "Resolviendo…",
        host: new URL(sourceUrl).hostname,
        status: "queued",
        downloadedBytes: 0,
        speed: 0,
        addedAt: Date.now()
      });
      result.added++;
    }
    this.changed();
    if (this.store.settings.startAutomatically) void this.pump();
    return result;
  }

  async start(id: string): Promise<void> {
    const item = this.find(id);
    if (!item || item.status === "completed" || item.status === "downloading") return;
    item.status = "queued";
    item.error = undefined;
    this.changed();
    await this.pump();
  }

  pause(id: string): void {
    const item = this.find(id);
    if (!item) return;
    this.controllers.get(id)?.abort();
    if (item.status !== "completed") item.status = "paused";
    item.speed = 0;
    this.changed();
  }

  async retry(id: string): Promise<void> {
    const item = this.find(id);
    if (!item) return;
    item.status = "queued";
    item.error = undefined;
    item.directUrl = undefined;
    this.changed();
    await this.pump();
  }

  async remove(id: string, deleteFile = false): Promise<void> {
    const index = this.store.downloads.findIndex(item => item.id === id);
    if (index < 0) return;
    const [item] = this.store.downloads.splice(index, 1);
    this.controllers.get(id)?.abort();
    if (deleteFile && item.savePath) await fs.rm(item.savePath, { force: true }).catch(() => undefined);
    this.changed();
  }

  async clearCompleted(): Promise<void> {
    for (let i = this.store.downloads.length - 1; i >= 0; i--) {
      if (this.store.downloads[i].status === "completed") this.store.downloads.splice(i, 1);
    }
    this.changed();
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const settings = this.store.setSettings(patch);
    void this.pump();
    this.changed();
    return settings;
  }

  private find(id: string): DownloadItem | undefined {
    return this.store.downloads.find(item => item.id === id);
  }

  private changed(): void {
    this.store.schedule();
    this.emit("changed", this.snapshot());
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (true) {
        const active = this.store.downloads.filter(item => ["resolving", "downloading"].includes(item.status)).length;
        const slots = Math.max(0, this.store.settings.concurrentDownloads - active);
        if (!slots) break;
        const next = this.store.downloads.filter(item => item.status === "queued").slice(0, slots);
        if (!next.length) break;
        next.forEach(item => void this.run(item).finally(() => void this.pump()));
        break;
      }
    } finally {
      this.pumping = false;
    }
  }

  private async run(item: DownloadItem): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(item.id, controller);
    try {
      item.status = "resolving";
      this.changed();
      const resolved = await resolveLink(item.sourceUrl);
      if (controller.signal.aborted) return;
      Object.assign(item, {
        directUrl: resolved.directUrl,
        name: resolved.fileName,
        host: resolved.host,
        totalBytes: resolved.size || item.totalBytes
      });
      await fs.mkdir(this.store.settings.downloadDirectory, { recursive: true });
      item.savePath = uniquePath(this.store.settings.downloadDirectory, item.name, item.savePath);
      let existing = 0;
      try {
        existing = (await fs.stat(item.savePath)).size;
      } catch {}
      item.downloadedBytes = existing;
      const headers: Record<string, string> = { ...(resolved.headers || {}) };
      if (existing > 0) headers.range = `bytes=${existing}-`;
      let response = await fetch(resolved.directUrl, {
        redirect: "follow",
        headers,
        signal: controller.signal
      });
      if (existing > 0 && response.status === 200) {
        existing = 0;
        item.downloadedBytes = 0;
      }
      if (!response.ok && response.status !== 206) throw new Error(`El servidor respondió ${response.status}`);
      const contentLength = Number(response.headers.get("content-length")) || 0;
      item.totalBytes = existing + contentLength || item.totalBytes;
      item.status = "downloading";
      this.changed();

      const stream = createWriteStream(item.savePath, { flags: existing ? "a" : "w" });
      const reader = response.body?.getReader();
      if (!reader) throw new Error("El servidor no entregó datos");
      let lastTime = Date.now();
      let lastBytes = item.downloadedBytes;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (controller.signal.aborted) throw new DOMException("Abortado", "AbortError");
        if (!stream.write(value)) await new Promise<void>(resolve => stream.once("drain", resolve));
        item.downloadedBytes += value.byteLength;
        const now = Date.now();
        const elapsed = now - lastTime;
        if (elapsed >= 350) {
          item.speed = ((item.downloadedBytes - lastBytes) * 1000) / elapsed;
          lastTime = now;
          lastBytes = item.downloadedBytes;
          this.changed();
        }
        const limit = this.store.settings.speedLimitKbps * 1024;
        if (limit > 0) {
          const idealMs = (value.byteLength / limit) * 1000;
          if (idealMs > 1) await new Promise(resolve => setTimeout(resolve, idealMs));
        }
      }
      await new Promise<void>((resolve, reject) => {
        stream.once("error", reject);
        stream.end(resolve);
      });
      item.status = "completed";
      item.speed = 0;
      if (!item.totalBytes) item.totalBytes = item.downloadedBytes;
    } catch (error: any) {
      if (error?.name === "AbortError" || controller.signal.aborted) {
        if (item.status !== "paused") item.status = "paused";
      } else {
        item.status = "error";
        item.error = error?.message || "Error desconocido";
      }
      item.speed = 0;
    } finally {
      this.controllers.delete(item.id);
      this.changed();
    }
  }
}
