import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
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

for (const stubborn of [false, true]) {
  test(`conflicting server is stopped${stubborn ? ' forcibly when SIGTERM is ignored' : ''}`, async t => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { createServer } from 'node:http';
      ${stubborn ? "process.on('SIGTERM', () => {});" : ''}
      const server = createServer((_, res) => res.end('ok'));
      server.listen(0, '127.0.0.1', () => console.log(server.address().port));
    `], { stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = once(child, 'exit');
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    });
    const [output] = await once(child.stdout, 'data');
    const port = Number(output.toString().trim());
    const messages = [];
    await freeDevPort({ port, log: text => messages.push(text) });
    await exited;
    assert.deepEqual(await listeners(port), []);
    assert.equal(child.signalCode, stubborn ? 'SIGKILL' : 'SIGTERM');
    assert.ok(messages.some(text => text.includes(String(child.pid))));
    if (stubborn) assert.ok(messages.some(text => text.includes('强制结束')));
  });
}

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

test('desktop reuse recognizes only a live launcher in the same project directory', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jd-dev-reuse-'));
  const other = await mkdtemp(join(tmpdir(), 'jd-dev-other-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'scripts/start-dev.mjs', 'desktop'], { cwd: directory, stdio: 'ignore' });
  const exited = once(child, 'exit');
  t.after(async () => {
    child.kill('SIGTERM'); await exited;
    await rm(directory, { recursive: true }); await rm(other, { recursive: true });
  });
  await once(child, 'spawn');
  const moduleUrl = new URL('./start-dev.mjs', import.meta.url).href;
  const run = promisify(execFile);
  for (const [root, expected] of [[directory, child.pid], [other, null]]) {
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', `
      import { existingDesktopSession } from ${JSON.stringify(moduleUrl)};
      console.log(JSON.stringify(await existingDesktopSession({ root: ${JSON.stringify(root)} })));
    `]);
    assert.equal(JSON.parse(stdout), expected);
  }
});
