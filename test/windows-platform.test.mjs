import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  antigravityLayout,
  atomicRenameWithRetry,
  cleanupIpcEndpoint,
  defaultAntigravityAppPath,
  defaultAntigravityInstallDirs,
  defaultAntigravityProfileDir,
  defaultAppSupportDir,
  defaultGravityBoxCacheDir,
  defaultGravityBoxStateDir,
  defaultTrashDir,
  finalizeIpcEndpointAfterListen,
  isNamedPipe,
  isOwnedByCurrentUser,
  isPathUnder,
  normalizePathForCompare,
  pathsEqual,
  prepareIpcEndpointForListen,
  resolveIpcEndpoint,
  safeOpenFlagsNoFollow,
  validateIpcEndpointForClient,
} from '../dist/platform/index.js';
import {
  applicationTarget,
  matchingTargetForLanguageServerCommand,
  resolveBundleLayout,
  targetForApp,
} from '../dist/application-target.js';
import { inspectBundle, normalizePeVersionString } from '../dist/discovery.js';
import { readInstalledAppBundleVersion } from '../dist/pricing-catalog-runtime.js';
import {
  AccountsManager,
  MockKeychainAdapter,
  cloudOriginFromCommand,
  cloudProviderContextFromCommand,
  decodeKeychainOauthPayload,
  encodeKeychainOauthPayload,
  syncAccountToKeychain,
  validCachedCloudProviderContext,
} from '../dist/accounts.js';
import {
  clearLiveEndpointCache,
  probeLiveLanguageServerOnce,
} from '../dist/account-probe.js';
import { groupToQuotaGroup, modelQuotaFromNormalized } from '../dist/account-quota.js';
import { AccountSwitchService, DatabaseTransaction } from '../dist/account-switch.js';
import {
  CacheMaintenance,
  hasAntigravityCommand,
  hasBrowserProfileCommand,
  isStrictSubpath,
} from '../dist/maintenance.js';
import { acquireProcessLease } from '../dist/process-lock.js';
import { detectSystemLocales, normalizeLocale, resolveLocale } from '../dist/i18n.js';

function buildMinimalAsar(filesObj, payloadBuffers) {
  const headerBuf = Buffer.from(JSON.stringify({ files: filesObj }), 'utf8');
  const alignedHeaderSize = Math.ceil((headerBuf.length + 4) / 4) * 4;
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(alignedHeaderSize + 4, 4);
  prefix.writeUInt32LE(alignedHeaderSize, 8);
  prefix.writeUInt32LE(headerBuf.length, 12);
  const paddedHeader = Buffer.alloc(alignedHeaderSize - 4);
  headerBuf.copy(paddedHeader, 0);
  return Buffer.concat([prefix, paddedHeader, ...payloadBuffers]);
}

test('platform/paths: Windows 与 macOS 路径解析、布局及比较零回归', () => {
  const winEnv = {
    APPDATA: 'C:\\Users\\demo\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local',
    ProgramFiles: 'C:\\Program Files',
  };
  assert.equal(defaultAppSupportDir('C:\\Users\\demo', winEnv, 'win32'), 'C:\\Users\\demo\\AppData\\Roaming');
  assert.equal(defaultGravityBoxStateDir('C:\\Users\\demo', winEnv, 'win32'), 'C:\\Users\\demo\\AppData\\Roaming\\GravityBox');
  assert.equal(defaultGravityBoxCacheDir('C:\\Users\\demo', winEnv, 'win32'), 'C:\\Users\\demo\\AppData\\Local\\GravityBox\\Cache');
  assert.equal(defaultAntigravityProfileDir('C:\\Users\\demo', winEnv, 'win32'), 'C:\\Users\\demo\\AppData\\Roaming\\Antigravity');
  assert.equal(defaultTrashDir('C:\\Users\\demo', winEnv, 'win32'), 'C:\\Users\\demo\\AppData\\Local\\GravityBox\\Cache\\maintenance-trash');
  assert.deepEqual(defaultAntigravityInstallDirs('C:\\Users\\demo', winEnv, 'win32'), [
    'C:\\Users\\demo\\AppData\\Local\\Programs',
    'C:\\Program Files',
  ]);

  // 自动探测优先 LOCALAPPDATA\Programs\Antigravity，不存在时回退 ProgramFiles\Antigravity
  const pfApp = defaultAntigravityAppPath(
    'C:\\Users\\demo',
    winEnv,
    'win32',
    (p) => p.toLowerCase() === 'c:\\program files\\antigravity\\antigravity.exe',
  );
  assert.equal(pfApp, 'C:\\Program Files\\Antigravity');

  // macOS 路径语义完全保持不变
  assert.equal(defaultAppSupportDir('/Users/demo', {}, 'darwin'), '/Users/demo/Library/Application Support');
  assert.equal(defaultGravityBoxStateDir('/Users/demo', {}, 'darwin'), '/Users/demo/Library/Application Support/GravityBox');
  assert.equal(defaultGravityBoxCacheDir('/Users/demo', {}, 'darwin'), '/Users/demo/Library/Caches/GravityBox');
  assert.equal(defaultTrashDir('/Users/demo', {}, 'darwin'), '/Users/demo/.Trash');
  assert.equal(defaultAntigravityAppPath('/Users/demo', {}, 'darwin'), '/Applications/Antigravity.app');

  // 布局解析
  const winLayout = antigravityLayout('C:\\Users\\demo\\AppData\\Local\\Programs\\Antigravity', 'win32');
  assert.equal(winLayout.executableName, 'Antigravity.exe');
  assert.equal(winLayout.executablePath, 'C:\\Users\\demo\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe');
  assert.equal(winLayout.asarPath, 'C:\\Users\\demo\\AppData\\Local\\Programs\\Antigravity\\resources\\app.asar');
  assert.equal(winLayout.languageServerPath, 'C:\\Users\\demo\\AppData\\Local\\Programs\\Antigravity\\resources\\bin\\language_server.exe');
  assert.equal(winLayout.infoPlistPath, null);

  const macLayout = resolveBundleLayout('/Applications/Antigravity.app');
  assert.equal(macLayout.executableName, 'Antigravity');
  assert.equal(macLayout.asarPath, '/Applications/Antigravity.app/Contents/Resources/app.asar');
  assert.equal(macLayout.languageServerPath, '/Applications/Antigravity.app/Contents/Resources/bin/language_server');

  // Windows 路径归一化与子路径边界防碰撞
  assert.equal(normalizePathForCompare('\\\\?\\C:\\Users\\Demo\\App\\', 'win32'), 'c:/users/demo/app');
  assert.equal(pathsEqual('C:\\Users\\demo\\Programs\\Antigravity', 'c:/users/demo/programs/antigravity/', 'win32'), true);
  assert.equal(isPathUnder('C:\\Users\\demo\\App\\sub\\file.txt', 'c:/users/demo/app', 'win32'), true);
  assert.equal(isPathUnder('C:\\Users\\demo\\App2\\file.txt', 'C:\\Users\\demo\\App', 'win32'), false);
  assert.equal(isStrictSubpath('C:\\Users\\demo\\App', 'D:\\Users\\demo\\App\\file.txt'), false);
});

test('application-target & account-probe: Windows 引号路径、大小写混合命令行与 .exe 后缀匹配', () => {
  if (process.platform !== 'win32') return;
  const appPath = 'C:\\Program Files\\Antigravity';
  const target = targetForApp(appPath, 'C:\\Users\\alice');
  assert.equal(target.executable, 'Antigravity.exe');

  const quotedCmd = '"C:\\Program Files\\antigravity\\resources\\bin\\language_server.exe" --app_data_dir antigravity --cloud_code_endpoint https://daily-cloudcode-pa.googleapis.com --subclient_type hub --override_ide_version 2.34.0';
  const unquotedCmd = 'c:\\program files\\antigravity\\resources\\bin\\language_server.exe --app_data_dir antigravity --cloud_code_endpoint=https://daily-cloudcode-pa.googleapis.com --subclient_type=hub';

  assert.equal(matchingTargetForLanguageServerCommand(quotedCmd, target)?.appPath, appPath);
  assert.equal(matchingTargetForLanguageServerCommand(unquotedCmd, target)?.appPath, appPath);
  assert.equal(cloudOriginFromCommand(quotedCmd, target), 'https://daily-cloudcode-pa.googleapis.com');

  const ctx = cloudProviderContextFromCommand(quotedCmd, '2.34.0', target);
  assert.ok(ctx);
  assert.equal(ctx.userAgent, 'antigravity/hub/2.34.0');
  assert.equal(validCachedCloudProviderContext(ctx, '2.34.0', target), true);

  // Insiders 必须被拒绝
  const insidersCmd = '"C:\\Program Files\\Antigravity - Insiders\\resources\\bin\\language_server.exe" --app_data_dir antigravity-insiders --cloud_code_endpoint https://daily-cloudcode-pa.googleapis.com';
  assert.equal(matchingTargetForLanguageServerCommand(insidersCmd, target), null);
  assert.equal(cloudOriginFromCommand(quotedCmd.replace('antigravity ', 'antigravity-insiders '), target), null);
  assert.throws(() => targetForApp('C:\\Users\\alice\\AppData\\Local\\Programs\\Antigravity - Insiders'), /仅支持/);
});

test('platform/ipc: Windows Named Pipe 确定性端点、监听、重复实例拒绝与安全清理', async (t) => {
  const dirA = 'C:\\Users\\demo\\AppData\\Roaming\\GravityBox';
  const dirB = 'c:\\users\\demo\\appdata\\roaming\\gravitybox\\';
  const pipeA = resolveIpcEndpoint(dirA, 'win32');
  const pipeB = resolveIpcEndpoint(dirB, 'win32');
  assert.equal(isNamedPipe(pipeA), true);
  assert.match(pipeA, /^\\\\\.\\pipe\\gravitybox-[0-9a-f]{24}$/);
  assert.equal(pipeA, pipeB, 'Windows Named Pipe 哈希必须大小写与尾斜杠无关');
  assert.equal(resolveIpcEndpoint('/Users/demo/Library/Application Support/GravityBox', 'darwin'), '/Users/demo/Library/Application Support/GravityBox/control.sock');
  assert.equal(isNamedPipe('/tmp/control.sock'), false);

  if (process.platform !== 'win32') return;
  const temp = await mkdtemp(join(tmpdir(), 'gb-win-pipe-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const endpoint = resolveIpcEndpoint(temp);
  assert.equal(isNamedPipe(endpoint), true);

  // 尚未监听时 prepare 通过
  await prepareIpcEndpointForListen(endpoint);
  const server = createServer((socket) => {
    socket.end('{"ok":true}\n');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, resolve);
  });
  t.after(() => new Promise((resolve) => server.close(() => resolve())));

  await finalizeIpcEndpointAfterListen(endpoint);
  await validateIpcEndpointForClient(endpoint);
  // 已有活服务监听同一 Named Pipe 时必须拒绝二次启动
  await assert.rejects(prepareIpcEndpointForListen(endpoint), /已运行|已在运行|already running/i);

  await new Promise((resolve) => server.close(() => resolve()));
  await cleanupIpcEndpoint(endpoint);
});

test('platform/fs & process-lock: 跨平台所有权校验、退避重试重命名与无 lsof 陈旧锁回收', async (t) => {
  assert.equal(isOwnedByCurrentUser({ uid: 0 }, 'win32', undefined), true);
  assert.equal(isOwnedByCurrentUser({ uid: 501 }, 'darwin', 501), true);
  assert.equal(isOwnedByCurrentUser({ uid: 0 }, 'darwin', 501), false);
  assert.equal(safeOpenFlagsNoFollow('win32'), 0);

  // atomicRenameWithRetry: Windows 遇到 EBUSY / EPERM 时重试成功
  let attempts = 0;
  await atomicRenameWithRetry('src', 'dest', {
    platform: 'win32',
    maxRetries: 4,
    baseDelayMs: 5,
    renameFn: () => {
      attempts++;
      if (attempts < 3) {
        const err = new Error('locked');
        err.code = attempts === 1 ? 'EBUSY' : 'EPERM';
        throw err;
      }
    },
  });
  assert.equal(attempts, 3);

  // macOS 上不做重试
  let macAttempts = 0;
  await assert.rejects(
    atomicRenameWithRetry('src', 'dest', {
      platform: 'darwin',
      renameFn: () => {
        macAttempts++;
        const err = new Error('busy');
        err.code = 'EBUSY';
        throw err;
      },
    }),
  );
  assert.equal(macAttempts, 1);

  // 无 lsof 回收陈旧空锁与死进程锁
  const dir = await mkdtemp(join(tmpdir(), 'gb-win-lock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lockPath = join(dir, 'service.lock');
  await writeFile(lockPath, '');
  const past = new Date(Date.now() - 30_000);
  await utimes(lockPath, past, past);
  const lease1 = await acquireProcessLease(lockPath, 2000);
  await assert.rejects(acquireProcessLease(lockPath, 30), /已有|等待|锁|占用/);
  await lease1.release();

  // 死 PID 锁自动回收
  await writeFile(lockPath, JSON.stringify({ pid: 999_999, nonce: 'dead-owner' }));
  const lease2 = await acquireProcessLease(lockPath, 2000);
  await lease2.release();
});

test('account-keychain & account-switch: Windows raw UTF-8 JSON 编码、node:sqlite 事务及无 state.vscdb 切号回滚', async (t) => {
  const sampleAcc = {
    email: 'alice@example.invalid',
    token: {
      access_token: 'synthetic-access',
      refresh_token: '1//synthetic-refresh',
      expiry_timestamp: 1900000000,
      project_id: 'proj-win',
      is_gcp_tos: false,
    },
  };

  // Windows raw JSON 与 macOS go-keyring-base64 互通解析
  const rawPayload = encodeKeychainOauthPayload(sampleAcc, 'raw');
  assert.equal(rawPayload.startsWith('{'), true);
  assert.equal(rawPayload.startsWith('go-keyring-base64:'), false);
  assert.equal(JSON.parse(decodeKeychainOauthPayload(rawPayload)).token.refresh_token, '1//synthetic-refresh');

  const macPayload = encodeKeychainOauthPayload(sampleAcc, 'go-keyring-base64');
  assert.equal(macPayload.startsWith('go-keyring-base64:'), true);
  assert.equal(JSON.parse(decodeKeychainOauthPayload(macPayload)).token.email, 'alice@example.invalid');

  // syncAccountToKeychain 按 adapter.payloadEncoding 写入原生 raw JSON
  const winKeychain = new MockKeychainAdapter({ payloadEncoding: 'raw' });
  await syncAccountToKeychain(sampleAcc, winKeychain);
  const storedRaw = await winKeychain.readPassword('gemini', 'antigravity');
  assert.ok(storedRaw && storedRaw.startsWith('{'));
  assert.equal(JSON.parse(storedRaw).id_token_email, 'alice@example.invalid');

  // DatabaseTransaction (node:sqlite) 直接提交与回滚测试
  const root = await mkdtemp(join(tmpdir(), 'gb-win-switch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, 'state');
  const profileDir = join(root, 'profile');
  await mkdir(join(profileDir, 'User', 'globalStorage'), { recursive: true });
  const dbPath = join(profileDir, 'User', 'globalStorage', 'state.vscdb');
  const initDb = new DatabaseSync(dbPath);
  try {
    initDb.exec("CREATE TABLE ItemTable(key TEXT PRIMARY KEY, value TEXT); INSERT INTO ItemTable VALUES('unrelated', 'keep');");
  } finally {
    initDb.close();
  }

  const tx = new DatabaseTransaction(dbPath);
  await tx.begin();
  await tx.replace({ antigravityOnboarding: 'true' });
  await tx.finish(false); // rollback
  await tx.close(); // 幂等 close

  const checkConn = new DatabaseSync(dbPath);
  try {
    const checkRows = checkConn.prepare('SELECT key, value FROM ItemTable').all().map((r) => ({ ...r }));
    assert.deepEqual(checkRows, [{ key: 'unrelated', value: 'keep' }]);
  } finally {
    checkConn.close();
  }

  // 完整四阶段切号 + 回滚（带 state.vscdb + raw JSON Keychain）
  const mgr = new AccountsManager(stateDir);
  const acc = await mgr.upsertAccount({
    email: 'switch-win@example.invalid',
    name: 'Win Switch',
    refreshToken: '1//win-refresh-01',
    accessToken: 'synthetic-win-access',
    expiresIn: 3600,
  });
  const initialRawCred = JSON.stringify({
    token: { access_token: 'prev', refresh_token: '1//prev-win', email: 'prev@example.invalid', expiry_timestamp: 1900000000 },
    id_token_email: 'prev@example.invalid',
  });
  await winKeychain.writePassword('gemini', 'antigravity', initialRawCred);

  const service = new AccountSwitchService(mgr, {
    stateDir,
    profile: profileDir,
    keychain: winKeychain,
    isRunning: async () => false,
  });
  const res = await service.switchAccount(acc.id);
  assert.equal(res.switchedTo, 'switch-win@example.invalid');
  const afterSwitchCred = await winKeychain.readPassword('gemini', 'antigravity');
  assert.ok(afterSwitchCred?.startsWith('{'), 'Windows 切号写入 Credential Manager 必须为 raw UTF-8 JSON');
  assert.equal(JSON.parse(afterSwitchCred).id_token_email, 'switch-win@example.invalid');

  // saveCurrentAccount 可直接读取 raw JSON 凭据
  const readbackMgr = new AccountsManager(join(root, 'readback'));
  const savedCurrent = await readbackMgr.saveCurrentAccount({
    keychain: winKeychain,
    homeDir: join(root, 'empty-home'),
    appSupportDir: join(root, 'empty-appdata'),
  });
  assert.equal(savedCurrent.email, 'switch-win@example.invalid');

  // 回滚精确恢复 raw JSON 与数据库
  await service.rollback();
  assert.equal(await winKeychain.readPassword('gemini', 'antigravity'), initialRawCred);
});

test('account-probe: Windows lsInspect 路径多端口探测并严格脱敏 csrfToken', async () => {
  if (process.platform !== 'win32') return;
  clearLiveEndpointCache();
  const winAppPath = 'C:\\Users\\demo\\AppData\\Local\\Programs\\Antigravity';
  const target = targetForApp(winAppPath, 'C:\\Users\\demo');
  const csrf = 'synthetic-win-peb-csrf-token-36-chars';

  const lsInspectImpl = async () => [
    {
      pid: 1001,
      exePath: 'C:\\Users\\demo\\AppData\\Local\\Programs\\Antigravity - Insiders\\resources\\bin\\language_server.exe',
      cmdLine: '"C:\\Users\\demo\\AppData\\Local\\Programs\\Antigravity - Insiders\\resources\\bin\\language_server.exe" --app_data_dir antigravity-insiders',
      ports: [51001],
      csrfToken: 'insiders-should-ignore',
    },
    {
      pid: 2002,
      exePath: 'C:\\Users\\demo\\AppData\\Local\\Programs\\antigravity\\resources\\bin\\language_server.exe',
      cmdLine: '"C:\\Users\\demo\\AppData\\Local\\Programs\\antigravity\\resources\\bin\\language_server.exe" --app_data_dir antigravity --subclient_type hub',
      ports: [52001, 52002],
      csrfToken: csrf,
    },
  ];

  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    const port = Number(parsed.port);
    const token = init?.headers?.['x-codeium-csrf-token'];
    if (port !== 52002 || token !== csrf) return new Response('nope', { status: 403 });
    if (parsed.pathname.endsWith('/GetUserStatus')) {
      return Response.json({
        userStatus: {
          email: 'win-live@example.invalid',
          name: 'Win Live User',
          userTier: { id: 'g1-ultra-tier', name: 'Google AI Ultra' },
          cascadeModelConfigData: {
            clientModelConfigs: [{ modelId: 'gemini-3-pro', label: 'Gemini 3 Pro', quotaInfo: { remainingFraction: 0.9 } }],
          },
        },
      });
    }
    if (parsed.pathname.endsWith('/RetrieveUserQuotaSummary')) {
      return Response.json({
        groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.9 }] }],
      });
    }
    return new Response('not found', { status: 404 });
  };

  const live = await probeLiveLanguageServerOnce(
    target,
    fetchImpl,
    { lsInspectImpl },
    { modelQuotaFromNormalized, groupToQuotaGroup },
  );
  assert.ok(live);
  assert.equal(live.email, 'win-live@example.invalid');
  assert.equal(live.tier, 'ULTRA');
  assert.equal(live.quota.models[0]?.percentage, 90);
  assert.equal(JSON.stringify(live).includes(csrf), false, '返回体绝不得包含 csrfToken');
});

test('discovery & pricing-catalog-runtime: Windows 安装包无签名正常探测且不误读 Electron version 文件', async (t) => {
  assert.equal(normalizePeVersionString('2.34.0.0'), '2.34.0');
  assert.equal(normalizePeVersionString('2.34.0'), '2.34.0');
  if (process.platform !== 'win32') return;

  const dir = await mkdtemp(join(tmpdir(), 'gb-win-bundle-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const appDir = join(dir, 'Antigravity');
  await mkdir(join(appDir, 'resources'), { recursive: true });
  // 故意放置 Electron 的 version 文件 (44.9.1)，校验绝不被误读
  await writeFile(join(appDir, 'version'), '44.9.1\n');
  await writeFile(join(appDir, 'Antigravity.exe'), Buffer.from('MZ-synthetic-unsigned-placeholder'));
  const pkgBuf = Buffer.from(JSON.stringify({ name: 'antigravity', version: '2.34.0', productName: 'Antigravity' }), 'utf8');
  const asarBuf = buildMinimalAsar({ 'package.json': { size: pkgBuf.length, offset: '0' } }, [pkgBuf]);
  await writeFile(join(appDir, 'resources', 'app.asar'), asarBuf);

  const inspected = await inspectBundle(appDir);
  assert.equal(inspected.version, '2.34.0');
  assert.equal(inspected.legacyPatch, false);

  const installedVer = await readInstalledAppBundleVersion(appDir);
  assert.equal(installedVer, '2.34.0');
});

test('maintenance: Windows 回收站清理成功路径与不可用时自动平滑降级到 fallbackTrashDir 可撤回恢复', async (t) => {
  assert.equal(
    hasAntigravityCommand(
      ['"C:\\Users\\demo\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe" --type=renderer'],
      'C:\\Users\\demo\\AppData\\Local\\Programs\\Antigravity',
    ),
    true,
  );
  if (process.platform !== 'win32') return;
  assert.equal(
    hasBrowserProfileCommand(
      ['"C:\\Program Files\\Chrome\\chrome.exe" --user-data-dir=c:/users/demo/.gemini/antigravity/browser_profile'],
      'C:\\Users\\demo\\.gemini\\antigravity\\browser_profile',
    ),
    true,
  );

  // 场景 A: 系统回收站可用，清理后通过 moveToSystemTrash 移入回收站
  const rootA = await mkdtemp(join(tmpdir(), 'gb-win-trash-ok-'));
  t.after(() => rm(rootA, { recursive: true, force: true }));
  const profileA = join(rootA, 'profile');
  const stateA = join(rootA, 'state');
  await mkdir(join(profileA, 'Cache'), { recursive: true });
  await mkdir(stateA, { recursive: true });
  await writeFile(join(profileA, 'Cache', 'blob.bin'), Buffer.alloc(1024, 5));

  const trashedPaths = [];
  const maintA = new CacheMaintenance(profileA, undefined, async () => false, {
    stateDir: stateA,
    browserRunning: async () => false,
    moveToSystemTrash: async (paths) => {
      trashedPaths.push(...paths);
      for (const p of paths) await rm(p, { recursive: true, force: true });
      return { moved: [...paths] };
    },
  });
  const scanA = await maintA.scan();
  const clearA = await maintA.clear(scanA.token, ['Cache']);
  assert.equal(clearA.ok, true);
  assert.equal(clearA.moved, 1);
  assert.equal(clearA.movedToSystemTrash, true);
  assert.equal(clearA.usingFallbackTrash, false);
  assert.equal(clearA.restorableInApp, false);
  assert.equal(clearA.trashDir, 'Recycle Bin');
  assert.equal(trashedPaths.length, 1);

  // 场景 B: 系统回收站不可用，平滑降级到 fallbackTrashDir 并完整支持 restore 一键撤回
  const rootB = await mkdtemp(join(tmpdir(), 'gb-win-trash-fb-'));
  t.after(() => rm(rootB, { recursive: true, force: true }));
  const profileB = join(rootB, 'profile');
  const stateB = join(rootB, 'state');
  await mkdir(join(profileB, 'Cache'), { recursive: true });
  await mkdir(stateB, { recursive: true });
  await writeFile(join(profileB, 'Cache', 'restore-me.txt'), 'original-cache-data');

  const maintB = new CacheMaintenance(profileB, undefined, async () => false, {
    stateDir: stateB,
    browserRunning: async () => false,
    moveToSystemTrash: async () => {
      throw new Error('Recycle Bin unavailable');
    },
  });
  const scanB = await maintB.scan();
  const clearB = await maintB.clear(scanB.token, ['Cache']);
  assert.equal(clearB.ok, true);
  assert.equal(clearB.movedToSystemTrash, false);
  assert.equal(clearB.usingFallbackTrash, true);
  assert.equal(clearB.restorableInApp, true);
  assert.ok(clearB.restorePath.includes('maintenance-trash'));

  const restored = await maintB.restore(clearB.snapshotId);
  assert.equal(restored.ok, true);
  assert.equal(await readFile(join(profileB, 'Cache', 'restore-me.txt'), 'utf8'), 'original-cache-data');
});

test('i18n: Windows 系统语言检测走 Intl 且无需 macOS defaults', () => {
  const detected = detectSystemLocales();
  assert.ok(Array.isArray(detected) && detected.length > 0);
  assert.equal(normalizeLocale('zh-CN'), 'zh-Hans');
  assert.equal(normalizeLocale('zh-Hans-CN'), 'zh-Hans');
  assert.equal(resolveLocale('system', ['zh-CN']), 'zh-Hans');
  assert.equal(resolveLocale('system', ['en-US']), 'en');
});
