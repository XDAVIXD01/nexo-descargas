import { describe, expect, it, vi } from "vitest";
import { expandGofile } from "./gofile.js";
import { DownloadManager } from "./download-manager.js";
import { JsonStore } from "./store.js";
import type { DownloadItem } from "./types.js";

vi.mock("./gofile.js", async importOriginal => {
  const original = await importOriginal<typeof import("./gofile.js")>();
  return { ...original, expandGofile: vi.fn() };
});

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

describe("carpetas GoFile", () => {
  function createManager() {
    const store = new JsonStore("work/gofile-test.json", {
      downloadDirectory: "work", concurrentDownloads: 1, speedLimitKbps: 0, startAutomatically: false
    });
    store.schedule = () => undefined;
    store.downloads.push(item("existente"));
    return { store, manager: new DownloadManager(store) };
  }

  it("añade cada archivo al final con metadatos y conserva el orden sin duplicar", async () => {
    vi.mocked(expandGofile).mockResolvedValue([1, 2].map(part => ({
      sourceUrl: `https://gofile.io/d/folder#file=file${part}`,
      directUrl: `https://store.gofile.io/download/file${part}`,
      fileName: `archivo.part0${part}.rar`, size: 1000 * part, host: "GoFile"
    })));
    const { store, manager } = createManager();
    expect(await manager.add("https://gofile.io/d/folder")).toEqual({ added: 2, rejected: [] });
    expect(store.downloads.map(file => file.name)).toEqual(["existente", "archivo.part01.rar", "archivo.part02.rar"]);
    expect(store.downloads.slice(1).map(file => [file.status, file.totalBytes])).toEqual([["queued", 1000], ["queued", 2000]]);
    expect((await manager.add("https://gofile.io/d/folder")).added).toBe(0);
    expect(store.downloads).toHaveLength(3);
  });

  it("explica los errores de acceso sin alterar la cola existente", async () => {
    vi.mocked(expandGofile).mockRejectedValue(new Error("GoFile: contenido privado"));
    const { store, manager } = createManager();
    expect(await manager.add("https://gofile.io/d/private")).toEqual({
      added: 0, rejected: [{ url: "https://gofile.io/d/private", reason: "GoFile: contenido privado" }]
    });
    expect(store.downloads.map(file => file.id)).toEqual(["existente"]);
  });
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
