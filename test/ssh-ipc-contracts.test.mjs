import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Controller } from '../dist/controller.js';
import { dictionaryFromEntries } from '../dist/dictionary.js';
import { buildRemoteWindowKey } from '../dist/ssh-context.js';

function startMockCdpServer({ dictVersion = 'test-dict', onEvaluate } = {}) {
  let targets = [];
  const sockets = new Set();
  const socketByTargetId = new Map();
  const bootedTargets = new Set();

  function encodeWsTextFrame(text) {
    const payload = Buffer.from(text, 'utf8');
    if (payload.length < 126) {
      return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
    }
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }

  function decodeWsFrames(buf, onMessage) {
    let offset = 0;
    while (offset + 2 <= buf.length) {
      const opcode = buf[offset] & 0x0f;
      const masked = (buf[offset + 1] & 0x80) !== 0;
      let len = buf[offset + 1] & 0x7f;
      let pos = offset + 2;
      if (len === 126) {
        if (pos + 2 > buf.length) break;
        len = buf.readUInt16BE(pos);
        pos += 2;
      } else if (len === 127) {
        if (pos + 8 > buf.length) break;
        len = Number(buf.readBigUInt64BE(pos));
        pos += 8;
      }
      const maskStart = pos;
      const dataStart = masked ? pos + 4 : pos;
      if (dataStart + len > buf.length) break;
      const payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) {
        payload[i] = masked ? buf[dataStart + i] ^ buf[maskStart + (i % 4)] : buf[dataStart + i];
      }
      offset = dataStart + len;
      if (opcode === 0x8) return Buffer.alloc(0);
      if (opcode === 0x1) onMessage(payload.toString('utf8'));
    }
    return buf.subarray(offset);
  }

  const server = http.createServer((req, res) => {
    if (req.url === '/json/version') {
      const addr = server.address();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${addr.port}/devtools/browser/b1` }));
      return;
    }
    if (req.url === '/json/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(targets));
      return;
    }
    res.writeHead(404).end();
  });

  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    const targetId = req.url?.startsWith('/devtools/page/') ? req.url.split('/').pop() : 'browser';
    if (targetId && targetId !== 'browser') socketByTargetId.set(targetId, socket);
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      buffer = decodeWsFrames(buffer, raw => {
        const msg = JSON.parse(raw);
        let result = {};
        if (msg.method === 'Target.getTargets') {
          result = {
            targetInfos: targets.map(t => ({ targetId: t.id, browserContextId: t.browserContextId || 'ctx-default' })),
          };
        } else if (msg.method === 'Page.getFrameTree') {
          const t = targets.find(x => x.id === targetId) || { url: 'http://127.0.0.1:44139/' };
          result = { frameTree: { frame: { id: `frame-${targetId}`, url: t.url } } };
        } else if (msg.method === 'Page.createIsolatedWorld') {
          result = { executionContextId: 100 };
        } else if (msg.method === 'Page.addScriptToEvaluateOnNewDocument') {
          result = { identifier: `reg-${targetId}` };
        } else if (msg.method === 'Runtime.evaluate') {
          const expr = String(msg.params?.expression || '');
          if (expr.includes('__GRAVITYBOX_BOOT__')) bootedTargets.add(targetId);
          const custom = onEvaluate?.(targetId, expr, msg.params?.contextId);
          if (custom !== undefined) {
            result = { result: { value: custom } };
          } else if (expr.includes('crypto.subtle.digest')) {
            result = {
              result: {
                value: {
                  hash: 'f066a497c9c61198394cb3218e42ff61d85b03910d81282589c3ef066905f347',
                  bytes: 1024,
                },
              },
            };
          } else if (expr.includes('document.querySelector')) {
            result = { result: { value: true } };
          } else if (expr.includes('__GRAVITYBOX_ENGINE_V1__?.state()')) {
            result = {
              result: {
                value: bootedTargets.has(targetId)
                  ? { version: dictVersion, active: true, languageMode: 'zh' }
                  : null,
              },
            };
          } else {
            result = { result: { value: { version: dictVersion, active: true } } };
          }
        }
        socket.write(encodeWsTextFrame(JSON.stringify({ id: msg.id, result })));
      });
    });
  });

  return {
    async start() {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();
      return {
        port,
        setTargets(next) {
          targets = next.map(t => ({
            ...t,
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${t.id}`,
          }));
        },
        emitFocus(targetId, contextId = 100) {
          const targetSocket = socketByTargetId.get(targetId);
          if (!targetSocket) return;
          try {
            targetSocket.write(encodeWsTextFrame(JSON.stringify({
              method: 'Runtime.bindingCalled',
              params: {
                name: '__gravityboxWindowFocus',
                payload: String(Date.now()),
                executionContextId: contextId,
              },
            })));
          } catch {}
        },
        async stop() {
          for (const s of sockets) s.destroy();
          await new Promise(resolve => server.close(resolve));
        },
      };
    },
  };
}

function exchange(directory, request, { timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(join(directory, 'control.sock'));
    let value = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('IPC 超时')); }, timeout);
    const finish = error => { clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); };
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', chunk => { value += chunk; if (value.includes('\n')) finish(); });
    socket.on('error', finish);
  });
}

test('Controller remoteSessions：30s 缓存、并发去重、10m 断连保留、焦点追踪与 auth_expired 保留旧快照', async () => {
  const dict = dictionaryFromEntries({});
  let probeCalls = 0;
  let remoteMode = 'ok';
  const cdpServer = await startMockCdpServer({
    dictVersion: dict.version,
    onEvaluate(targetId, expr) {
      if (targetId === 'remote-1' && expr.includes('GetUserStatus')) {
        probeCalls++;
        if (remoteMode === 'auth_expired') {
          return { ok: false, reason: 'auth_expired', authExpired: true, status: 401 };
        }
        return {
          ok: true,
          latencyMs: 12,
          data: {
            userStatusData: {
              userStatus: {
                email: 'remote-ssh@example.invalid',
                name: 'Remote Dev',
                userTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
                cascadeModelConfigData: {
                  clientModelConfigs: [
                    { modelOrAlias: { model: 'gemini-3.8-flash' }, label: 'Gemini 3.8 Flash', quotaInfo: { remainingFraction: 0.77, resetTime: '2026-11-20T18:00:00Z' } },
                  ],
                },
              },
            },
            quotaSummaryData: {
              groups: [
                { displayName: 'Gemini Models', buckets: [{ window: 'WINDOW_5_HOUR', remainingFraction: 0.77, resetTime: '2026-11-20T18:00:00Z' }] },
              ],
            },
          },
        };
      }
      if (expr.includes('maintenanceState')) return { busy: false };
      if (expr.includes('draftState')) return { busy: false, checked: true };
      return undefined;
    },
  }).start();

  const remoteKey = buildRemoteWindowKey('demo-ssh-host', 'https://127.0.0.1:44139');
  cdpServer.setTargets([
    { id: 'remote-1', type: 'page', url: 'https://127.0.0.1:44139/', browserContextId: 'ctx-remote-1' },
  ]);

  let lastStatus = null;
  const controller = new Controller({
    appPath: '/Applications/Antigravity.app',
    profile: '/tmp/nonexistent-profile',
    dictionary: dict,
    hudEnabled: false,
    discoverEndpoint: async () => ({
      port: cdpServer.port,
      browserURL: `ws://127.0.0.1:${cdpServer.port}/devtools/browser/b1`,
      pid: process.pid,
      appVersion: '2.33.0',
      legacyPatch: false,
    }),
    inspectPage: async () => 'unlisted',
    verifyRemoteWindow: async ({ url, browserContextId }) => ({
      status: 'verified',
      identity: {
        kind: 'remote',
        remoteKey: buildRemoteWindowKey('demo-ssh-host', new URL(url).origin),
        hostLabel: 'demo-ssh-host',
        browserContextId: browserContextId || 'ctx-remote-1',
        origin: 'https://127.0.0.1:44139',
        verifiedBy: 'process',
      },
    }),
    onStatus: (s) => { lastStatus = s; },
  });

  await controller.start();
  try {
    // status 快照不包含邮箱等账号字段
    assert.equal(Object.hasOwn(lastStatus, 'remoteSessions'), false);
    assert.equal(lastStatus.sshWindowsCount, 1);
    assert.deepEqual(lastStatus.activeSshHosts, ['demo-ssh-host']);
    assert.deepEqual(controller.getActiveSshWindowsSummary(), { count: 1, hosts: ['demo-ssh-host'] });

    // 并发 probe 去重 + 30s 缓存
    const t0 = Date.now();
    const [r1, r2, r3] = await Promise.all([
      controller.probeRemoteSessions({ nowMs: t0, matchAccountId: e => (e === 'remote-ssh@example.invalid' ? 'local-acc-1' : null) }),
      controller.probeRemoteSessions({ nowMs: t0 }),
      controller.probeRemoteSessions({ nowMs: t0 + 5000 }),
    ]);
    assert.equal(probeCalls, 1, '同 remoteKey 并发及 30s 内复用应只触发 1 次 RPC');
    assert.equal(r1[0].email, 'remote-ssh@example.invalid');
    assert.equal(r1[0].matchedLocalAccountId, 'local-acc-1');
    assert.equal(r2.length, 1);
    assert.equal(r3.length, 1);

    // 超过 30s 或 force=true 触发新探测；auth_expired 保留上次 email 与 quota
    remoteMode = 'auth_expired';
    const expiredRes = await controller.probeRemoteSessions({ force: true, nowMs: t0 + 35_000 });
    assert.equal(probeCalls, 2);
    assert.equal(expiredRes[0].state, 'auth_expired');
    assert.equal(expiredRes[0].email, 'remote-ssh@example.invalid');
    assert.ok(expiredRes[0].quota, 'auth_expired 必须保留上次配额快照');

    // 焦点追踪：远程窗口触发 focus -> remote:<key>
    await new Promise(r => setTimeout(r, 10));
    cdpServer.emitFocus('remote-1');
    await new Promise(r => setTimeout(r, 25));
    assert.equal(controller.getFocusedContextKey(), `remote:${remoteKey}`);

    // maintenancePreflight 返回活跃 SSH 窗口计数与脱敏主机名
    const mPreflight = await controller.maintenancePreflight();
    assert.equal(mPreflight.activeSshWindowsCount, 1);
    assert.deepEqual(mPreflight.activeSshHosts, ['demo-ssh-host']);

    // 远端窗口关闭 -> 标记 disconnected，10 分钟内保留，焦点自动回落 local；满 10 分钟后清理
    cdpServer.setTargets([]);
    await controller.sync();
    assert.equal(controller.getFocusedContextKey(), 'local');
    const within10m = controller.getRemoteSessionsSnapshot(Date.now() + 5 * 60_000);
    assert.equal(within10m.length, 1);
    assert.equal(within10m[0].remoteKey, remoteKey);
    assert.equal(within10m[0].state, 'disconnected');
    assert.equal(within10m[0].email, 'remote-ssh@example.invalid');

    const after10m = controller.getRemoteSessionsSnapshot(Date.now() + 10 * 60_000 + 5000);
    assert.equal(after10m.length, 0);
  } finally {
    await controller.stop();
    await cdpServer.stop();
  }
});

test('dist/main.js IPC 契约：status / dashboard_summary / remote_quota_refresh / preflight 返回完整 SSH 扩展字段且本机账号隔离', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-ssh-ipc-'));
  await mkdir(join(dir, '词典'), { recursive: true });
  const child = spawn(process.execPath, [
    fileURLToPath(new URL('../dist/main.js', import.meta.url)),
    '--state-dir', dir,
    '--app', '/nonexistent',
    '--profile', join(dir, 'profile'),
    '--home-dir', join(dir, 'home'),
    '--app-support-dir', join(dir, 'appsupport'),
    '--gemini-dir', join(dir, 'gemini'),
  ], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, GRAVITYBOX_PROBE_LS: 'false' } });

  try {
    const deadline = Date.now() + 15_000;
    let bootStatus = null;
    while (Date.now() < deadline) {
      try {
        const res = JSON.parse((await exchange(dir, { command: 'status', includeTasks: false })).split('\n')[0]);
        if (res.ok) { bootStatus = res; break; }
      } catch {}
      await new Promise(r => setTimeout(r, 80));
    }
    assert.ok(bootStatus?.ok);
    assert.equal(Array.isArray(bootStatus.status.remoteSessions), true);
    assert.equal(bootStatus.status.sshWindowsCount, 0);
    assert.deepEqual(bootStatus.status.activeSshHosts, []);
    assert.equal(bootStatus.status.focusedContextKey, 'local');
    assert.equal(typeof bootStatus.status.remoteObservedVersion, 'number');

    const dash = JSON.parse((await exchange(dir, { command: 'dashboard_summary' })).split('\n')[0]);
    assert.equal(dash.ok, true);
    assert.deepEqual(dash.remoteSessions, []);
    assert.equal(dash.focusedContextKey, 'local');
    assert.equal(dash.sshWindowsCount, 0);
    assert.equal(dash.accounts.total, 0);
    assert.equal(dash.usage.selectedEnvironmentId, 'all');

    const dashLocal = JSON.parse((await exchange(dir, { command: 'dashboard_summary', environmentId: 'local' })).split('\n')[0]);
    assert.equal(dashLocal.ok, true);
    assert.equal(dashLocal.usage.selectedEnvironmentId, 'local');
    assert.equal(dashLocal.usage.periods, undefined);

    const refreshRes = JSON.parse((await exchange(dir, { command: 'remote_quota_refresh' })).split('\n')[0]);
    assert.equal(refreshRes.ok, true);
    assert.deepEqual(refreshRes.remoteSessions, []);
    assert.equal(refreshRes.focusedContextKey, 'local');
    assert.equal(typeof refreshRes.remoteObservedVersion, 'number');

    const swPreflight = JSON.parse((await exchange(dir, { command: 'account_switch_preflight', id: 'none' })).split('\n')[0]);
    assert.equal(swPreflight.ok, true);
    assert.equal(swPreflight.activeSshWindowsCount, 0);
    assert.deepEqual(swPreflight.activeSshHosts, []);

    const mPreflight = JSON.parse((await exchange(dir, { command: 'maintenance_preflight' })).split('\n')[0]);
    assert.equal(mPreflight.ok, true);
    assert.equal(mPreflight.activeSshWindowsCount, 0);
    assert.deepEqual(mPreflight.activeSshHosts, []);
  } finally {
    try { await exchange(dir, { command: 'stop' }); } catch {}
    child.kill('SIGTERM');
    await rm(dir, { recursive: true, force: true });
  }
});
