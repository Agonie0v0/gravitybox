import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import {
  classifyAntigravityProcesses,
  parsePsPidPpidCpuArgs,
} from '../dist/antigravity-processes.js';
import { AccountSwitchService } from '../dist/account-switch.js';
import { AccountsManager, MockKeychainAdapter } from '../dist/accounts.js';
import { hasAntigravityCommand } from '../dist/maintenance.js';

test('antigravity-processes: 精确区分主 UI、Chromium 子进程、脱管 sidecar_sdk / language_server、crashpad 与 Insiders', () => {
  const samplePs = [
    '84608     1  0.4 /Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper.app/Contents/MacOS/Antigravity Helper --import=file:///Users/test/.gemini/antigravity/lib/node_modules/sidecar_sdk/register_loader.js main.mjs',
    '84612 84608  0.1 /Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper.app/Contents/MacOS/Antigravity Helper --custom-worker',
    '64189     1  3.2 /Applications/Antigravity.app/Contents/Resources/bin/language_server --standalone --enable_sidecars',
    '64195 64189  0.0 /Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper.app/Contents/MacOS/Antigravity Helper --worker',
    '64200     1  0.0 /Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper.app/Contents/MacOS/chrome_crashpad_handler --monitor-self',
    '90001     1  0.0 /bin/zsh -c ls /Applications/Antigravity.app/Contents/Resources',
    '90002     1  0.0 /bin/zsh -c ls /Applications/Antigravity.app/Contents/Resources/bin/language_server',
  ].join('\n');

  const entries = parsePsPidPpidCpuArgs(samplePs);
  assert.equal(entries.length, 7);

  const detachedOnly = classifyAntigravityProcesses(entries);
  assert.equal(detachedOnly.uiRunning, false);
  assert.deepEqual(detachedOnly.uiRoles, []);
  assert.equal(detachedOnly.insidersRunning, false);
  assert.deepEqual(detachedOnly.detachedDaemonKinds, ['language_server', 'sidecar']);
  assert.deepEqual(
    detachedOnly.detachedDaemons.map(d => [d.pid, d.kind]),
    [
      [84608, 'sidecar'],
      [84612, 'sidecar'],
      [64189, 'language_server'],
      [64195, 'sidecar'],
    ],
  );
  assert.equal(detachedOnly.maxLsCpu, 3.2);

  // 主进程与 Chromium helper 必须判定为 uiRunning
  const withUi = classifyAntigravityProcesses([
    ...entries,
    {
      pid: 70001,
      ppid: 1,
      cpu: 5.0,
      args: '/Applications/Antigravity.app/Contents/MacOS/Antigravity --remote-debugging-port=0',
    },
    {
      pid: 70002,
      ppid: 70001,
      cpu: 1.0,
      args: '/Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper (Renderer).app/Contents/MacOS/Antigravity Helper (Renderer) --type=renderer',
    },
  ]);
  assert.equal(withUi.uiRunning, true);
  assert.deepEqual(withUi.uiRoles, ['main', 'renderer']);
  assert.equal(withUi.detachedDaemons.length, 4);

  // 常规 Electron GPU Helper（无 sidecar_sdk 特征）必须算入 UI 而非 detachedDaemons
  const withGpuHelper = classifyAntigravityProcesses([
    {
      pid: 71001,
      ppid: 1,
      cpu: 0.5,
      args: '/Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper (GPU).app/Contents/MacOS/Antigravity Helper (GPU)',
    },
  ]);
  assert.equal(withGpuHelper.uiRunning, true);
  assert.deepEqual(withGpuHelper.detachedDaemons, []);

  // Insiders 只触发 insidersRunning，绝不并入 detachedDaemons
  const withInsiders = classifyAntigravityProcesses([
    {
      pid: 72001,
      ppid: 1,
      cpu: 0.2,
      args: '/Applications/Antigravity - Insiders.app/Contents/Resources/bin/language_server --standalone',
    },
  ]);
  assert.equal(withInsiders.insidersRunning, true);
  assert.equal(withInsiders.uiRunning, false);
  assert.deepEqual(withInsiders.detachedDaemons, []);
});

test('AccountSwitchService.guardStopped 区分 UI 运行、仅残留守护进程与无害 crashpad', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gb-proc-guard-'));
  const stateDir = join(root, 'state');
  const profile = join(root, 'profile');
  try {
    await mkdir(join(profile, 'User', 'globalStorage'), { recursive: true });
    const db = new DatabaseSync(join(profile, 'User', 'globalStorage', 'state.vscdb'));
    db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
    db.close();
    const manager = new AccountsManager(stateDir);
    await manager.init();
    const acc = await manager.upsertAccount({
      id: 'acc-guard',
      email: 'guard@example.test',
      name: 'Guard Test',
      refreshToken: '1//refresh-guard',
      accessToken: 'access-guard',
      expiresIn: 3600,
      projectId: null,
      isGcpTos: true,
    });
    const keychain = new MockKeychainAdapter();

    // 1. 仅存在脱管 sidecar_sdk：不得误报「保存工作并退出应用」，应抛出专属残留守护进程错误
    const detachedSvc = new AccountSwitchService(manager, {
      stateDir,
      profile,
      keychain,
      inspectProcesses: async () =>
        classifyAntigravityProcesses([
          {
            pid: 84608,
            ppid: 1,
            cpu: 0.1,
            args: '/Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper.app/Contents/MacOS/Antigravity Helper --import=file:///Users/test/.gemini/antigravity/lib/node_modules/sidecar_sdk/register_loader.js main.mjs',
          },
        ]),
    });
    await assert.rejects(() => detachedSvc.switchAccount(acc.id), err => {
      assert.match(err.message, /84608/);
      assert.match(err.message, /sidecar|守护进程|daemon/i);
      assert.equal(/保存工作并手动退出/.test(err.message), false);
      return true;
    });

    // 2. 主 UI 运行中：继续报 stop_app_first
    const uiSvc = new AccountSwitchService(manager, {
      stateDir,
      profile,
      keychain,
      inspectProcesses: async () =>
        classifyAntigravityProcesses([
          {
            pid: 70001,
            ppid: 1,
            cpu: 1.0,
            args: '/Applications/Antigravity.app/Contents/MacOS/Antigravity',
          },
        ]),
    });
    await assert.rejects(() => uiSvc.switchAccount(acc.id), /Antigravity/);

    // 3. 仅剩 chrome_crashpad_handler：视为已退出，切号必须成功放行
    const crashpadOnlySvc = new AccountSwitchService(manager, {
      stateDir,
      profile,
      keychain,
      inspectProcesses: async () =>
        classifyAntigravityProcesses([
          {
            pid: 64200,
            ppid: 1,
            cpu: 0.0,
            args: '/Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper.app/Contents/MacOS/chrome_crashpad_handler --monitor-self',
          },
        ]),
    });
    const okRes = await crashpadOnlySvc.switchAccount(acc.id);
    assert.equal(okRes.switchedTo, 'guard@example.test');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('hasAntigravityCommand 排除 chrome_crashpad_handler 同时保留 Helper (GPU) 与 language_server 保护', () => {
  assert.equal(
    hasAntigravityCommand([
      '/Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper.app/Contents/MacOS/chrome_crashpad_handler --monitor-self',
    ]),
    false,
  );
  assert.equal(
    hasAntigravityCommand([
      '/Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper (GPU).app/Contents/MacOS/Antigravity Helper (GPU)',
    ]),
    true,
  );
  assert.equal(
    hasAntigravityCommand([
      '/Applications/Antigravity.app/Contents/Resources/bin/language_server --standalone',
    ]),
    true,
  );
  assert.equal(
    hasAntigravityCommand([
      '/bin/zsh -c ls /Applications/Antigravity.app/Contents/Resources/bin/language_server',
    ]),
    false,
  );
});
