import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "./store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    fs.rm(directory, { recursive: true, force: true })
  ));
});

describe("recuperación persistente", () => {
  it("recupera el tamaño real de un archivo parcial y conserva preferencias", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nexo-store-"));
    temporaryDirectories.push(directory);
    const partialPath = path.join(directory, "archivo.parte");
    const statePath = path.join(directory, "state.json");
    await fs.writeFile(partialPath, Buffer.alloc(37));
    await fs.writeFile(statePath, JSON.stringify({
      downloads: [{
        id: "uno",
        sourceUrl: "https://example.test/uno",
        name: "archivo.parte",
        host: "Prueba",
        status: "downloading",
        downloadedBytes: 5,
        speed: 999,
        addedAt: 1,
        savePath: partialPath,
        totalBytes: 100
      }],
      settings: {
        downloadDirectory: directory,
        concurrentDownloads: 4,
        speedLimitKbps: 2500,
        startAutomatically: false
      }
    }));

    const store = new JsonStore(statePath, {
      downloadDirectory: "predeterminada",
      concurrentDownloads: 2,
      speedLimitKbps: 0,
      startAutomatically: true
    });
    await store.load();

    expect(store.downloads[0]).toMatchObject({
      status: "queued",
      downloadedBytes: 37,
      speed: 0,
      resumeOnLaunch: true
    });
    expect(store.settings).toMatchObject({
      downloadDirectory: directory,
      concurrentDownloads: 4,
      speedLimitKbps: 2500,
      startAutomatically: false
    });

    await store.save();
    const config = JSON.parse(await fs.readFile(path.join(directory, "config.json"), "utf8"));
    expect(config).toEqual(store.settings);
  });

  it("usa la copia de seguridad cuando el estado principal está corrupto", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nexo-backup-"));
    temporaryDirectories.push(directory);
    const statePath = path.join(directory, "state.json");
    await fs.writeFile(statePath, "{contenido roto");
    await fs.writeFile(`${statePath}.bak`, JSON.stringify({
      downloads: [],
      settings: {
        downloadDirectory: directory,
        concurrentDownloads: 3,
        speedLimitKbps: 0,
        startAutomatically: true
      }
    }));
    const store = new JsonStore(statePath, {
      downloadDirectory: "predeterminada",
      concurrentDownloads: 2,
      speedLimitKbps: 0,
      startAutomatically: true
    });

    await store.load();

    expect(store.settings.concurrentDownloads).toBe(3);
    expect(store.settings.downloadDirectory).toBe(directory);
  });
});
