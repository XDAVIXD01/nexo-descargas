import { createWriteStream, existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AddResult, DownloadItem, Settings } from "./types.js";
import { JsonStore } from "./store.js";
import { resolveLink, supportsUrl } from "./resolvers.js";

class DownloadHttpError extends Error {
  constructor(readonly status: number) {
    super(`El servidor respondió ${status}`);
  }
}

class TransientDownloadError extends Error {}

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
  private retryTimers = new Map<string, NodeJS.Timeout>();
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
    const addedItems: DownloadItem[] = [];
    for (const sourceUrl of urls) {
      if (!supportsUrl(sourceUrl)) {
        result.rejected.push({ url: sourceUrl, reason: "Sitio no compatible" });
        continue;
      }
      if (this.store.downloads.some(item => item.sourceUrl === sourceUrl && item.status !== "cancelled")) {
        result.rejected.push({ url: sourceUrl, reason: "El enlace ya está en la lista" });
        continue;
      }
      const item: DownloadItem = {
        id: randomUUID(),
        sourceUrl,
        name: "Consultando archivo…",
        host: new URL(sourceUrl).hostname,
        status: "checking",
        downloadedBytes: 0,
        speed: 0,
        addedAt: Date.now()
      };
      this.store.downloads.push(item);
      addedItems.push(item);
      result.added++;
    }
    this.changed();
    addedItems.forEach(item => void this.inspect(item));
    return result;
  }

  async start(id: string): Promise<void> {
    const item = this.find(id);
    if (!item || item.status === "completed" || item.status === "downloading") return;
    this.clearRetry(id);
    item.status = "queued";
    item.error = undefined;
    this.changed();
    await this.pump();
  }

  pause(id: string): void {
    const item = this.find(id);
    if (!item) return;
    this.controllers.get(id)?.abort();
    this.clearRetry(id);
    if (item.status !== "completed") item.status = "paused";
    item.speed = 0;
    this.changed();
  }

  async retry(id: string): Promise<void> {
    const item = this.find(id);
    if (!item) return;
    this.clearRetry(id);
    item.status = "queued";
    item.error = undefined;
    item.directUrl = undefined;
    item.retryAttempt = 0;
    item.retryAt = undefined;
    this.changed();
    await this.pump();
  }

  async remove(id: string, deleteFile = false): Promise<void> {
    const index = this.store.downloads.findIndex(item => item.id === id);
    if (index < 0) return;
    const [item] = this.store.downloads.splice(index, 1);
    this.controllers.get(id)?.abort();
    this.clearRetry(id);
    if (deleteFile && item.savePath) await fs.rm(item.savePath, { force: true }).catch(() => undefined);
    this.changed();
  }

  async clearCompleted(): Promise<void> {
    for (let i = this.store.downloads.length - 1; i >= 0; i--) {
      if (this.store.downloads[i].status === "completed") this.store.downloads.splice(i, 1);
    }
    this.changed();
  }

  reorder(id: string, targetId: string, after = false): void {
    if (id === targetId) return;
    const fromIndex = this.store.downloads.findIndex(item => item.id === id);
    if (fromIndex < 0) return;
    const [item] = this.store.downloads.splice(fromIndex, 1);
    const targetIndex = this.store.downloads.findIndex(value => value.id === targetId);
    if (targetIndex < 0) {
      this.store.downloads.splice(fromIndex, 0, item);
      return;
    }
    this.store.downloads.splice(targetIndex + (after ? 1 : 0), 0, item);
    this.changed();
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const settings = this.store.setSettings(patch);
    void this.pump();
    this.changed();
    return settings;
  }

  resumePending(): void {
    const wasInterrupted = this.store.downloads.some(item => item.resumeOnLaunch);
    this.store.downloads.forEach(item => { item.resumeOnLaunch = undefined; });
    if (this.store.settings.startAutomatically || wasInterrupted) void this.pump();
  }

  private find(id: string): DownloadItem | undefined {
    return this.store.downloads.find(item => item.id === id);
  }

  private changed(): void {
    this.store.schedule();
    this.emit("changed", this.snapshot());
  }

  private clearRetry(id: string): void {
    const timer = this.retryTimers.get(id);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(id);
  }

  private isRetryable(error: any): boolean {
    if (error instanceof DownloadHttpError) {
      return [401, 403, 408, 409, 425, 429].includes(error.status) || error.status >= 500;
    }
    if (error instanceof TransientDownloadError) return true;
    const code = String(error?.code || error?.cause?.code || "");
    const message = String(error?.message || "");
    return /ECONN|ETIMEDOUT|ENET|EAI_AGAIN|UND_ERR|fetch failed|socket|network/i.test(`${code} ${message}`);
  }

  private queueRetry(item: DownloadItem, error: any): void {
    const attempt = (item.retryAttempt || 0) + 1;
    const delaySeconds = Math.min(60, 5 * 2 ** Math.min(attempt - 1, 4));
    item.retryAttempt = attempt;
    item.retryAt = Date.now() + delaySeconds * 1000;
    item.status = "retrying";
    item.error = `${error?.message || "Fallo de red"}. Reintentando automáticamente`;
    this.clearRetry(item.id);
    const timer = setTimeout(() => {
      this.retryTimers.delete(item.id);
      if (!this.find(item.id) || item.status !== "retrying") return;
      item.status = "queued";
      item.retryAt = undefined;
      item.directUrl = undefined;
      this.changed();
      void this.pump();
    }, delaySeconds * 1000);
    this.retryTimers.set(item.id, timer);
  }

  private async inspect(item: DownloadItem): Promise<void> {
    try {
      const resolved = await resolveLink(item.sourceUrl);
      if (!this.find(item.id)) return;
      Object.assign(item, {
        directUrl: resolved.directUrl,
        name: resolved.fileName,
        host: resolved.host,
        totalBytes: resolved.size,
        status: "queued" as const,
        error: undefined
      });
    } catch (error: any) {
      if (!this.find(item.id)) return;
      item.status = "error";
      item.error = `No se pudieron consultar los datos: ${error?.message || "error desconocido"}`;
    }
    this.changed();
    if (this.store.settings.startAutomatically && item.status === "queued") void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (true) {
        const active = this.store.downloads.filter(item => ["resolving", "recovering", "downloading"].includes(item.status)).length;
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
    let output: ReturnType<typeof createWriteStream> | undefined;
    let outputError: Error | undefined;
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
      if (response.status === 416 && item.totalBytes && existing >= item.totalBytes) {
        item.status = "completed";
        item.downloadedBytes = item.totalBytes;
        item.speed = 0;
        item.error = undefined;
        return;
      }
      if (!response.ok && response.status !== 206) throw new DownloadHttpError(response.status);
      const contentLength = Number(response.headers.get("content-length")) || 0;
      const serverSupportsResume = existing > 0 && response.status === 206;
      let bytesToSkip = existing > 0 && response.status === 200 ? existing : 0;
      item.totalBytes = response.status === 206
        ? existing + contentLength || item.totalBytes
        : contentLength || item.totalBytes;
      item.recoveryBytesRemaining = bytesToSkip || undefined;
      item.status = bytesToSkip ? "recovering" : "downloading";
      this.changed();

      output = createWriteStream(item.savePath, { flags: existing ? "a" : "w" });
      output.on("error", error => {
        outputError = error;
        controller.abort();
      });
      const reader = response.body?.getReader();
      if (!reader) throw new Error("El servidor no entregó datos");
      const transferStartedAt = Date.now();
      let networkBytes = 0;
      let lastUiUpdate = transferStartedAt;
      let samples = [{ at: transferStartedAt, bytes: networkBytes }];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (controller.signal.aborted) throw new DOMException("Abortado", "AbortError");
        networkBytes += value.byteLength;
        let writable = value;
        if (!serverSupportsResume && bytesToSkip > 0) {
          const skipped = Math.min(bytesToSkip, writable.byteLength);
          bytesToSkip -= skipped;
          writable = writable.subarray(skipped);
          item.recoveryBytesRemaining = bytesToSkip || undefined;
          if (bytesToSkip === 0) {
            item.status = "downloading";
            this.changed();
          }
        }
        if (writable.byteLength > 0) {
          if (!output.write(writable)) await new Promise<void>(resolve => output!.once("drain", resolve));
          item.downloadedBytes += writable.byteLength;
        }
        const limit = this.store.settings.speedLimitKbps * 1024;
        if (limit > 0) {
          const expectedElapsed = (networkBytes / limit) * 1000;
          const delay = expectedElapsed - (Date.now() - transferStartedAt);
          if (delay > 1) await new Promise(resolve => setTimeout(resolve, delay));
        }
        const now = Date.now();
        samples.push({ at: now, bytes: networkBytes });
        samples = samples.filter(sample => sample.at >= now - 5000);
        if (now - lastUiUpdate >= 1000) {
          const oldest = samples[0];
          const elapsed = now - oldest.at;
          item.speed = elapsed > 0 ? ((networkBytes - oldest.bytes) * 1000) / elapsed : 0;
          lastUiUpdate = now;
          this.changed();
        }
      }
      await new Promise<void>((resolve, reject) => {
        output!.once("error", reject);
        output!.end(resolve);
      });
      output = undefined;
      if (item.totalBytes && item.downloadedBytes < item.totalBytes) {
        throw new TransientDownloadError(
          `La conexión terminó antes de completar el archivo (${item.downloadedBytes} de ${item.totalBytes} bytes)`
        );
      }
      item.status = "completed";
      item.speed = 0;
      item.retryAttempt = 0;
      item.retryAt = undefined;
      item.recoveryBytesRemaining = undefined;
      item.error = undefined;
      if (!item.totalBytes) item.totalBytes = item.downloadedBytes;
    } catch (error: any) {
      output?.destroy();
      output = undefined;
      if (outputError) {
        item.status = "error";
        item.error = `No se pudo escribir el archivo: ${outputError.message}`;
      } else if (error?.name === "AbortError" || controller.signal.aborted) {
        if (item.status !== "paused") item.status = "paused";
      } else if (this.isRetryable(error)) {
        this.queueRetry(item, error);
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
