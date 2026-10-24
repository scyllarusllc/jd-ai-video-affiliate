import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { desktopRoot, freeDevPort, listeners } from './start-dev.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function httpServer() {
  const server = createServer((_, response) => response.end('unrelated server is alive'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, port: server.address().port };
}

test('no conflict leaves the port free', async () => {
  const { server, port } = await httpServer();
  await new Promise(resolve => server.close(resolve));
  await freeDevPort({ port, log() {} });
  assert.deepEqual(await listeners(port), []);
});

test('unrelated listener is never terminated', async () => {
  const { server, port } = await httpServer();
  try {
    await assert.rejects(freeDevPort({ port, log() {} }), /被其他程序占用/);
    assert.equal(await (await fetch('http://127.0.0.1:' + port)).text(), 'unrelated server is alive');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('same-project Vite is stopped and its port is released', async t => {
  const { server, port } = await httpServer();
  await new Promise(resolve => server.close(resolve));
  const child = spawn(process.execPath, [join(desktopRoot, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: desktopRoot, stdio: 'ignore' });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    try { if ((await fetch('http://127.0.0.1:' + port)).ok) { ready = true; break; } } catch {}
    await sleep(50);
  }
  assert.ok(ready, 'test Vite must start before checking cleanup');
  const messages = [];
  await freeDevPort({ port, log: text => messages.push(text) });
  await exited;
  assert.deepEqual(await listeners(port), []);
  assert.ok(messages.some(text => text.includes(String(child.pid))));
});

test('invalid port is rejected before process inspection', async () => {
  await assert.rejects(freeDevPort({ port: 0 }), /开发端口无效/);
});
