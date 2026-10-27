import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const desktopRoot = await realpath(join(dirname(fileURLToPath(import.meta.url)), '..'));

export async function listeners(port) {
  try {
    const { stdout } = await exec('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-t']);
    return [...new Set(stdout.trim().split(/\s+/).filter(Boolean).map(Number))];
  } catch (error) {
    if (error.code === 1 && !error.stdout?.trim()) return [];
    throw new Error('无法检查开发端口，请确认 lsof 可用：' + error.message);
  }
}

export async function existingDesktopSession({ root = desktopRoot } = {}) {
  root = await realpath(root);
  const { stdout } = await exec('ps', ['-axo', 'pid=,uid=,command=']);
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    const [, pidText, uidText, command] = match;
    const pid = Number(pidText);
    // Earlier launchers take precedence when commands are started together.
    if (pid >= process.pid || Number(uidText) !== process.getuid?.()) continue;
    if (!/^(?:\S*\/)?node(?:\s|$)/.test(command) || !/start-dev\.mjs\s+desktop(?:\s|$)/.test(command)) continue;
    try {
      const { stdout: directory } = await exec('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
      const cwd = directory.split('\n').find(value => value.startsWith('n'))?.slice(1);
      if (cwd && await realpath(cwd) === root) return pid;
    } catch (error) {
      if (error.code !== 1 && error.code !== 'ENOENT') throw error;
    }
  }
  return null;
}

export async function freeDevPort({ port = 1420, log = console.log } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('开发端口无效');
  const pids = await listeners(port);
  if (!pids.length) return;
  if (pids.includes(process.pid)) throw new Error('开发端口由启动器自身占用，无法自动结束');
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); log('[dev] 结束端口占用进程 PID ' + pid + '，释放端口 ' + port); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    const remaining = await listeners(port);
    if (!remaining.length) return;
    if (attempt === 15) {
      for (const pid of remaining) {
        if (pids.includes(pid)) {
          try { process.kill(pid, 'SIGKILL'); log('[dev] 强制结束未退出的端口占用进程 PID ' + pid); }
          catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
      }
    }
    await sleep(100);
  }
  throw new Error('端口 ' + port + ' 未能释放，已停止启动，请检查占用进程。');
}

async function main() {
  const mode = process.argv[2];
  if (!['desktop', 'web'].includes(mode)) throw new Error('用法：node scripts/start-dev.mjs desktop|web [--check]');
  if (mode === 'desktop' && !process.argv.includes('--check')) {
    const existing = await existingDesktopSession();
    if (existing) {
      console.log('[dev] 本项目开发环境已运行（PID ' + existing + '），继续使用已有实例；修改代码会自动更新。');
      return;
    }
  }
  await freeDevPort();
  if (process.argv.includes('--check')) {
    console.log('[dev] 端口 1420 已空闲，启动检查通过（未启动桌面应用）。');
    return;
  }
  const target = mode === 'desktop'
    ? [join(desktopRoot, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'), 'dev']
    : [join(desktopRoot, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', '1420', '--strictPort'];
  console.log('[dev] 启动 ' + (mode === 'desktop' ? 'Tauri 桌面开发环境' : 'Vite http://127.0.0.1:1420/'));
  const child = spawn(process.execPath, target, { cwd: desktopRoot, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', error => { console.error('[dev] ' + error.message); process.exitCode = 1; });
  child.on('exit', (code, signal) => {
    process.exitCode = code === 130 || code === 143 ? 0 : code ?? (signal === 'SIGINT' || signal === 'SIGTERM' ? 0 : 1);
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => { console.error('[dev] ' + error.message); process.exitCode = 1; });
}
