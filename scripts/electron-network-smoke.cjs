const { app } = require("electron");
const { createServer } = require("node:http");
const assert = require("node:assert/strict");

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
    const resolved = await resolveLink(process.argv[2]);
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
