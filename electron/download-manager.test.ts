import { describe, expect, it } from "vitest";
import { DownloadManager } from "./download-manager.js";
import { JsonStore } from "./store.js";
import type { DownloadItem } from "./types.js";

const item = (id: string): DownloadItem => ({
  id,
  sourceUrl: `https://example.test/${id}`,
  name: id,
  host: "Prueba",
  status: "queued",
  downloadedBytes: 0,
  speed: 0,
  addedAt: 0
});

describe("orden de la cola", () => {
  it("mueve un archivo antes o después de otro y conserva los demás", () => {
    const store = new JsonStore("work/reorder-test.json", {
      downloadDirectory: "work",
      concurrentDownloads: 1,
      speedLimitKbps: 0,
      startAutomatically: false
    });
    store.schedule = () => undefined;
    store.downloads.push(item("a"), item("b"), item("c"));
    const manager = new DownloadManager(store);

    manager.reorder("c", "a");
    expect(manager.snapshot().downloads.map(value => value.id)).toEqual(["c", "a", "b"]);

    manager.reorder("c", "b", true);
    expect(manager.snapshot().downloads.map(value => value.id)).toEqual(["a", "b", "c"]);
  });
});
