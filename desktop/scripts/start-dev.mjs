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

async function isProjectVite(pid, root) {
  try {
    const [{ stdout: processInfo }, { stdout: directoryInfo }] = await Promise.all([
      exec('ps', ['-p', String(pid), '-o', 'uid=', '-o', 'command=']),
      exec('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']),
    ]);
    const uid = Number(processInfo.trim().split(/\s+/)[0]);
    if (typeof process.getuid !== 'function' || uid !== process.getuid()) return false;
    const cwd = directoryInfo.split('\n').find(line => line.startsWith('n'))?.slice(1);
    if (!cwd || await realpath(cwd) !== root) return false;
    return [join(root, 'node_modules', '.bin', 'vite'), join(root, 'node_modules', 'vite', 'bin', 'vite.js')]
      .some(binary => processInfo.includes(binary));
  } catch (error) {
    if (error.code === 1 || error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function freeDevPort({ port = 1420, root = desktopRoot, log = console.log } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('开发端口无效');
  root = await realpath(root);
  const pids = await listeners(port);
  if (!pids.length) return;
  // Check every owner before stopping any process. Never kill by port number alone.
  for (const pid of pids) {
    if (!(await isProjectVite(pid, root))) {
      if (!(await listeners(port)).includes(pid)) continue;
      throw new Error('端口 ' + port + ' 被其他程序占用（PID ' + pid + '），未终止该程序。请先核对：lsof -nP -iTCP:' + port + ' -sTCP:LISTEN');
    }
  }
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); log('[dev] 结束旧开发服务 PID ' + pid + '，释放端口 ' + port); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    const remaining = await listeners(port);
    if (!remaining.length) return;
    if (attempt === 15) {
      for (const pid of remaining) {
        if (pids.includes(pid) && await isProjectVite(pid, root)) {
          try { process.kill(pid, 'SIGKILL'); log('[dev] 强制结束未退出的旧开发服务 PID ' + pid); }
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
