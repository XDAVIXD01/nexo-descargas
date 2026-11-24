const { app } = require("electron");
const { createServer } = require("node:http");
const assert = require("node:assert/strict");
app.on('window-all-closed', () => {});

const payload = Buffer.alloc(128 * 1024, 97);
let receivedHeaders;
const server = createServer((request, response) => {
  receivedHeaders = request.headers;
  const start = Number(request.headers.range?.match(/^bytes=(\d+)-/)?.[1] || 0);
  response.writeHead(start ? 206 : 200, {
    "content-length": payload.length - start,
    "content-range": `bytes ${start}-${payload.length - 1}/${payload.length}`,
    "content-type": "application/octet-stream",
    connection: "close"
  });
  response.end(payload.subarray(start));
});

async function main() {
  await app.whenReady();
  const { fetch } = await import("../dist-electron/http-client.js");
  if (process.argv[2]) {
    const { resolveLink } = await import("../dist-electron/resolvers.js");
    let resolved;
    if (new URL(process.argv[2]).hostname === 'gofile.io') {
      const { DownloadManager } = await import('../dist-electron/download-manager.js');
      const { JsonStore } = await import('../dist-electron/store.js');
      const store = new JsonStore('work/unused-gofile-smoke.json', {
        downloadDirectory: 'work', concurrentDownloads: 1, speedLimitKbps: 0, startAutomatically: false
      });
      store.schedule = () => {};
      const manager = new DownloadManager(store);
      const added = await manager.add(process.argv[2]);
      assert.ok(added.added > 0);
      assert.equal(added.rejected.length, 0);
      assert.ok(store.downloads.every(file => file.host === 'GoFile' && file.totalBytes > 0 && file.status === 'queued'));
      const duplicate = await manager.add(process.argv[2]);
      assert.equal(duplicate.added, 0);
      assert.equal(store.downloads.length, added.added);
      console.log(`GoFile: ${added.added} archivos en cola, nombre/tamaño disponibles y duplicados omitidos`);
      resolved = await resolveLink(store.downloads[0].sourceUrl);
      const first = await fetch(resolved.directUrl, { headers: { ...resolved.headers, range: 'bytes=0-31' } });
      assert.equal(first.status, 206);
      const bytes = Buffer.from(await first.arrayBuffer());
      assert.equal(bytes.length, 32);
      const resumed = await fetch(resolved.directUrl, { headers: { ...resolved.headers, range: 'bytes=16-31' } });
      assert.equal(resumed.status, 206);
      assert.deepEqual(Buffer.from(await resumed.arrayBuffer()), bytes.subarray(16));
      console.log('GoFile: enlace individual renovado y reanudación por bytes verificada');
    } else resolved = await resolveLink(process.argv[2]);
    assert.ok(resolved.fileName);
    const probe = await fetch(resolved.directUrl, {
      headers: { ...resolved.headers, range: "bytes=0-0" }
    });
    assert.ok(probe.ok);
    await probe.body?.cancel();
    console.log(`Enlace real OK: ${resolved.host}, ${resolved.fileName}, ${resolved.size} bytes, HTTP ${probe.status}`);
    return;
  }
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/file`, {
    headers: {
      cookie: "session=network-smoke",
      referer: `http://127.0.0.1:${address.port}/file`,
      range: "bytes=4096-"
    }
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), `bytes 4096-${payload.length - 1}/${payload.length}`);
  const reader = response.body.getReader();
  let downloaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    downloaded += value.byteLength;
  }
  assert.equal(downloaded, payload.length - 4096);
  assert.equal(receivedHeaders.cookie, "session=network-smoke");
  assert.equal(receivedHeaders.referer, `http://127.0.0.1:${address.port}/file`);
  const delayedResponse = await fetch(`http://127.0.0.1:${address.port}/file`, {
    headers: { cookie: "session=network-smoke", referer: `http://127.0.0.1:${address.port}/file` }
  });
  await new Promise(resolve => setTimeout(resolve, 150));
  await delayedResponse.body.cancel();
  console.log("Electron net.fetch: Range, headers y lectura del flujo OK");
}

main().then(() => {
  if (server.listening) server.close(() => app.exit(0));
  else app.exit(0);
}).catch(error => {
  console.error(error);
  if (server.listening) server.close(() => app.exit(1));
  else app.exit(1);
});
