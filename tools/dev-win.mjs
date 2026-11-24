import { spawn } from 'node:child_process';
import { existsSync, watch } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cleanDist } from './clean-dist.mjs';
import { copyRuntime } from './copy-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const tscBin = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const winAppDir = join(root, 'windows', 'app');
const winHelperDir = join(root, 'windows', 'win-helper');
const winHelperManifest = join(winHelperDir, 'Cargo.toml');
const winHelperRelease = join(winHelperDir, 'target', 'release', 'gravitybox-win-helper.exe');
const winHelperDebug = join(winHelperDir, 'target', 'debug', 'gravitybox-win-helper.exe');

function runOnce(command, args, cwd = root) {
  return new Promise((resolveDone, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', windowsHide: false });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolveDone();
      else reject(new Error(`Command exited with code ${code ?? 1}: ${command} ${args.join(' ')}`));
    });
  });
}

function npmCommand(args) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && existsSync(npmExecPath)) {
    return { command: process.execPath, args: [npmExecPath, ...args] };
  }
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot?.trim() || process.env.WINDIR?.trim() || 'C:\\Windows';
    return { command: join(systemRoot, 'System32', 'cmd.exe'), args: ['/d', '/s', '/c', 'npm', ...args] };
  }
  return { command: 'npm', args };
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('dev:win 仅支持在 Windows 环境下运行');
  }
  if (!existsSync(join(winAppDir, 'package.json'))) {
    throw new Error('未找到 windows/app/package.json，请先初始化 Windows 桌面端工程');
  }

  process.stdout.write('[dev:win] 1/3 构建后端 TypeScript 与 runtime...\n');
  await cleanDist();
  await runOnce(process.execPath, [tscBin]);
  await copyRuntime();

  if (existsSync(winHelperManifest) && !existsSync(winHelperRelease) && !existsSync(winHelperDebug)) {
    process.stdout.write('[dev:win] 2/3 编译 gravitybox-win-helper.exe...\n');
    await runOnce('cargo', ['build'], winHelperDir);
  } else {
    process.stdout.write('[dev:win] 2/3 已检测到 gravitybox-win-helper.exe，跳过首次编译\n');
  }

  if (!existsSync(join(winAppDir, 'node_modules'))) {
    process.stdout.write('[dev:win] 安装 windows/app 前端依赖...\n');
    const install = npmCommand(['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
    await runOnce(install.command, install.args, winAppDir);
  }

  process.stdout.write('[dev:win] 3/3 启动后端 tsc --watch + Tauri 热重载（Vite HMR + Rust 自动重启）...\n');

  const tscWatch = spawn(process.execPath, [tscBin, '--watch', '--preserveWatchOutput'], {
    cwd: root,
    stdio: 'inherit',
  });

  let runtimeTimer = null;
  const runtimeWatchers = [];
  const triggerRuntime = () => {
    if (runtimeTimer) clearTimeout(runtimeTimer);
    runtimeTimer = setTimeout(async () => {
      runtimeTimer = null;
      try {
        await copyRuntime();
        process.stdout.write('[dev:win] 已同步重建 dist/engine.js\n');
      } catch (error) {
        process.stderr.write(`[dev:win] 重建 dist/engine.js 失败: ${error?.message ?? error}\n`);
      }
    }, 200);
  };
  for (const dir of [join(root, 'runtime'), join(root, 'assets', 'i18n')]) {
    try { runtimeWatchers.push(watch(dir, triggerRuntime)); } catch {}
  }

  const tauriDev = npmCommand(['run', 'tauri:dev']);
  const appProcess = spawn(tauriDev.command, tauriDev.args, {
    cwd: winAppDir,
    stdio: 'inherit',
  });

  let shuttingDown = false;
  const shutdown = (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (runtimeTimer) clearTimeout(runtimeTimer);
    for (const w of runtimeWatchers) { try { w.close(); } catch {} }
    for (const child of [appProcess, tscWatch]) {
      try { child.kill('SIGTERM'); } catch {}
    }
    setTimeout(() => process.exit(code), 150).unref();
  };

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  appProcess.once('exit', (code) => shutdown(code ?? 0));
  tscWatch.once('exit', (code) => {
    if (!shuttingDown) {
      process.stderr.write(`[dev:win] tsc --watch 退出 (code=${code ?? 'null'})\n`);
      shutdown(code ?? 1);
    }
  });
}

function isDirectEntry() {
  if (!process.argv[1]) return false;
  if (process.platform === 'win32') {
    return resolve(process.argv[1]).toLowerCase() === resolve(fileURLToPath(import.meta.url)).toLowerCase();
  }
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectEntry()) {
  main().catch((error) => {
    process.stderr.write(`[dev:win] 启动失败: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
