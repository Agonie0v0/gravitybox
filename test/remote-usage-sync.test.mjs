import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller } from '../dist/controller.js';
import { dictionaryFromEntries } from '../dist/dictionary.js';
import { buildRemoteWindowKey } from '../dist/ssh-context.js';
import {
  RemoteAccountObservationStore,
  RemoteUsageSyncCoordinator,
  buildRemoteEnvironmentId,
  buildRemoteEventKey,
  buildRemoteTrajectorySourceId,
  syncRemoteSessionUsage,
} from '../dist/remote-usage-sync.js';

function startRemoteMockCdpServer({ dictVersion = 'test-dict', onEvaluate } = {}) {
  let targets = [];
  const sockets = new Set();
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
    const addr = server.address();
    if (req.url === '/json/version') {
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
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      buffer = decodeWsFrames(buffer, raw => {
        const msg = JSON.parse(raw);
        let result = {};
        if (msg.method === 'Target.getTargets') {
          result = {
            targetInfos: targets.map(t => ({
              targetId: t.id,
              browserContextId: t.browserContextId || 'ctx-default',
            })),
          };
        } else if (msg.method === 'Page.getFrameTree') {
          const t = targets.find(x => x.id === targetId) || { url: 'https://127.0.0.1:44139/' };
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
        async stop() {
          for (const s of sockets) s.destroy();
          await new Promise(resolve => server.close(resolve));
        },
      };
    },
  };
}

test('同机多 SSH 别名（改端口/改主机名）共享 trajectoryId 生成一致 remoteSourceId 与 event_key 零双计', async () => {
  assert.equal(
    buildRemoteEnvironmentId('  Demo-SSH-Host \n'),
    buildRemoteEnvironmentId('demo-ssh-host')
  );
  assert.match(buildRemoteEnvironmentId('demo-ssh-host'), /^ssh:[a-f0-9]{12}$/);

  const sharedTrajectoryId = 'traj-shared-host-001';
  const makeClient = (cascadeId) => ({
    async probeUserAndQuota() {
      return { ok: false, reason: 'rpc_error', authExpired: false };
    },
    async getAllCascadeTrajectories() {
      return {
        ok: true,
        data: [
          {
            cascadeId,
            trajectoryId: sharedTrajectoryId,
            stepCount: 2,
            lastModifiedTime: '2026-11-20T05:00:10Z',
          },
        ],
      };
    },
    async getGeneratorMetadata() {
      return {
        ok: true,
        data: [
          {
            stepIndices: [1],
            executionId: 'exec-shared-1',
            model: 'MODEL_PLACEHOLDER_M667',
            modelDisplayName: 'Orchestrator (Carbon)',
            usage: { inputTokens: '500', outputTokens: '120', cacheReadTokens: '300' },
          },
        ],
      };
    },
    async getTrajectorySteps() {
      return {
        ok: true,
        data: [
          {
            idx: 1,
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'CORTEX_STEP_STATUS_DONE',
            metadata: { createdAt: '2026-11-20T05:00:05Z', executionId: 'exec-shared-1' },
          },
        ],
      };
    },
  });

  const nowMs = Date.UTC(2026, 10, 20, 5, 1, 0);
  const aliasA = await syncRemoteSessionUsage({
    target: {
      remoteKey: 'rk-alias-1',
      hostLabel: 'demo-ssh-host',
      origin: 'https://127.0.0.1:44101',
      rpcClient: makeClient('conv-alias-a'),
      email: 'remote-dev@example.invalid',
      matchedLocalAccountId: 'acc-1',
      accountType: 'consumer',
    },
    nowMs,
  });

  const aliasB = await syncRemoteSessionUsage({
    target: {
      remoteKey: 'rk-alias-2',
      hostLabel: 'demo-ssh-host-port2222',
      origin: 'https://127.0.0.1:44202',
      rpcClient: makeClient('conv-alias-b'),
      email: 'remote-dev@example.invalid',
      matchedLocalAccountId: 'acc-1',
      accountType: 'consumer',
    },
    nowMs,
  });

  assert.equal(aliasA.ok, true);
  assert.equal(aliasB.ok, true);
  assert.notEqual(aliasA.environmentId, aliasB.environmentId);
  assert.equal(aliasA.events.length, 1);
  assert.equal(aliasB.events.length, 1);
  assert.equal(aliasA.events[0].source_id, buildRemoteTrajectorySourceId(sharedTrajectoryId));
  assert.equal(aliasA.events[0].source_id, aliasB.events[0].source_id);
  assert.equal(
    aliasA.events[0].event_key,
    buildRemoteEventKey(aliasA.events[0].source_id, 0, 'exec-shared-1')
  );
  assert.equal(aliasA.events[0].event_key, aliasB.events[0].event_key);
  assert.equal(aliasA.events[0].model, 'gemini-4-carbon');
  assert.equal(aliasA.events[0].account_id, 'acc-1');
  assert.equal(aliasA.events[0].environment_kind, 'ssh');
  assert.equal(aliasA.events[0].trajectory_id, sharedTrajectoryId);
  assert.equal(aliasA.events[0].execution, 'exec-shared-1');
});

test('尾重叠游标 cursor_offset - 1 捕获流式 10 -> 12 修订并稳定推进 SyncReceipt，无变更轮次零 RPC 跳过', async () => {
  const genOffsets = [];
  const stepOffsets = [];
  let stage = 1;

  const allGenerations = () => {
    if (stage === 1) {
      return [
        {
          stepIndices: [1],
          executionId: 'exec-stream-0',
          responseModel: 'gemini-3.8-flash-n',
          usage: { inputTokens: '7', outputTokens: '3' },
        },
      ];
    }
    if (stage === 2) {
      return [
        {
          stepIndices: [1],
          executionId: 'exec-stream-0',
          responseModel: 'gemini-3.8-flash-n',
          usage: { inputTokens: '8', outputTokens: '4' },
        },
        {
          stepIndices: [3],
          executionId: 'exec-stream-1',
          responseModel: 'gemini-3.8-flash-n',
          usage: { inputTokens: '20', outputTokens: '10' },
        },
      ];
    }
    return [
      {
        stepIndices: [1],
        executionId: 'exec-stream-0',
        responseModel: 'gemini-3.8-flash-n',
        usage: { inputTokens: '8', outputTokens: '4' },
      },
      {
        stepIndices: [3],
        executionId: 'exec-stream-1',
        responseModel: 'gemini-3.8-flash-n',
        usage: { inputTokens: '30', outputTokens: '15' },
      },
    ];
  };

  const allSteps = [
    { idx: 0, type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE', metadata: { createdAt: '2026-11-20T06:00:00Z' } },
    { idx: 1, type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE', metadata: { createdAt: '2026-11-20T06:00:01Z', executionId: 'exec-stream-0' } },
    { idx: 2, type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE', metadata: { createdAt: '2026-11-20T06:01:00Z' } },
    { idx: 3, type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE', metadata: { createdAt: '2026-11-20T06:01:02Z', executionId: 'exec-stream-1' } },
  ];

  const rpcClient = {
    async probeUserAndQuota() {
      return { ok: false, reason: 'rpc_error', authExpired: false };
    },
    async getAllCascadeTrajectories() {
      return {
        ok: true,
        data: [
          {
            cascadeId: 'conv-stream',
            trajectoryId: 'traj-stream-1',
            stepCount: stage === 1 ? 2 : 4,
            lastModifiedTime:
              stage === 1
                ? '2026-11-20T06:00:05Z'
                : stage === 2
                  ? '2026-11-20T06:01:05Z'
                  : '2026-11-20T06:01:10Z',
          },
        ],
      };
    },
    async getGeneratorMetadata(_cid, offset = 0) {
      genOffsets.push(offset);
      return { ok: true, data: allGenerations().slice(offset) };
    },
    async getTrajectorySteps(_cid, offset = 0) {
      stepOffsets.push(offset);
      const visibleSteps = stage === 1 ? allSteps.slice(0, 2) : allSteps;
      return { ok: true, data: visibleSteps.slice(offset) };
    },
  };

  const target = {
    remoteKey: 'rk-stream',
    hostLabel: 'demo-ssh-host',
    rpcClient,
    email: 'stream-user@example.invalid',
    accountType: 'consumer',
  };

  // Round 1: 捕获流式初态 10 tokens，receipt cursor_offset = 1
  const r1 = await syncRemoteSessionUsage({ target, receipts: {}, nowMs: Date.UTC(2026, 10, 20, 6, 0, 6) });
  assert.equal(r1.ok, true);
  assert.equal(r1.events.length, 1);
  assert.equal(r1.events[0].total_tokens, 10);
  assert.equal(r1.events[0].generation_index, 0);
  assert.equal(r1.receipts.length, 1);
  assert.equal(r1.receipts[0].cursor_offset, 1);
  assert.equal(r1.receipts[0].step_offset, 2);

  const receipts = { [r1.receipts[0].source_id]: r1.receipts[0] };

  // Round 2: gen0 从 10 闭合为 12，且新增 gen1=30
  stage = 2;
  const r2 = await syncRemoteSessionUsage({ target, receipts, nowMs: Date.UTC(2026, 10, 20, 6, 1, 6) });
  assert.equal(r2.ok, true);
  assert.equal(genOffsets.at(-1), 0, 'Math.max(0, 1 - 1) 应回卷 1 条捕获尾部修订');
  assert.equal(r2.events.length, 2);
  assert.equal(r2.events[0].event_key, r1.events[0].event_key, '10 -> 12 修订必须保持同 event_key');
  assert.equal(r2.events[0].total_tokens, 12);
  assert.equal(r2.events[1].total_tokens, 30);
  assert.equal(r2.events[1].generation_index, 1);
  assert.equal(r2.receipts[0].cursor_offset, 2);
  assert.equal(r2.receipts[0].step_offset, 4);

  receipts[r2.receipts[0].source_id] = r2.receipts[0];

  // Round 3: gen1 从 30 更新为 45，游标从 cursor_offset - 1 = 1 拉取（跳过已落定 gen0）
  stage = 3;
  const r3 = await syncRemoteSessionUsage({ target, receipts, nowMs: Date.UTC(2026, 10, 20, 6, 1, 12) });
  assert.equal(r3.ok, true);
  assert.equal(genOffsets.at(-1), 1, 'cursor_offset=2 时应从 2 - 1 = 1 拉取');
  assert.equal(r3.events.length, 1);
  assert.equal(r3.events[0].event_key, r2.events[1].event_key);
  assert.equal(r3.events[0].total_tokens, 45);
  assert.equal(r3.receipts[0].cursor_offset, 2);

  receipts[r3.receipts[0].source_id] = r3.receipts[0];

  // Round 4: 无变化时跳过明细 RPC
  const genCallsBeforeIdle = genOffsets.length;
  const stepCallsBeforeIdle = stepOffsets.length;
  const r4 = await syncRemoteSessionUsage({ target, receipts, nowMs: Date.UTC(2026, 10, 20, 6, 1, 15) });
  assert.equal(r4.ok, true);
  assert.equal(r4.trajectoriesScanned, 0);
  assert.equal(genOffsets.length, genCallsBeforeIdle);
  assert.equal(stepOffsets.length, stepCallsBeforeIdle);
});

test('本机账号 A 与远端账号 B 独立观测时间线隔离：精准判定 observed / inferred / unknown 与 0o600 持久化', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-remote-obs-'));
  try {
    // 预置本机 usage-account-observations.json（本机账号 A），确认远端 store 绝对不读也不改写该文件
    const localObsPath = join(dir, 'usage-account-observations.json');
    const localObsPayload = JSON.stringify({
      version: 1,
      entries: [{ at: 1_795_000_000, id: 'local-a', email: 'local-a@example.invalid', account_type: 'consumer' }],
    });
    await writeFile(localObsPath, localObsPayload, 'utf8');

    const envB = buildRemoteEnvironmentId('demo-ssh-host');
    const envC = buildRemoteEnvironmentId('demo-ssh-host-other');
    const store = new RemoteAccountObservationStore({ stateDir: dir });

    // t=1000..1020：远端 B 窗口在线观测
    const baseSec = 1_795_000_000;
    store.recordObservation({
      environmentId: envB,
      hostLabel: 'demo-ssh-host',
      email: 'remote-b@example.invalid',
      matchedLocalAccountId: 'acc-remote-b',
      accountType: 'consumer',
      observedAtSec: baseSec + 1000,
    });
    // 另一台远端主机 envC 观测为账号 C，验证环境间严格隔离
    store.recordObservation({
      environmentId: envC,
      hostLabel: 'demo-ssh-host-other',
      email: 'remote-c@example.invalid',
      matchedLocalAccountId: 'acc-remote-c',
      accountType: 'enterprise_vertex',
      observedAtSec: baseSec + 1000,
    });

    // 断线于 t=1020；后台跑完一个任务于 t=1045；重连于 t=1080（仍为 B）
    store.markDisconnected(envB, baseSec + 1020);
    store.recordObservation({
      environmentId: envB,
      hostLabel: 'demo-ssh-host',
      email: 'remote-b@example.invalid',
      matchedLocalAccountId: 'acc-remote-b',
      accountType: 'consumer',
      observedAtSec: baseSec + 1080,
    });

    // 再断线于 t=1100，重连于 t=1160 时切换成了账号 C，空窗期 t=1130 冲突应为 unknown
    store.markDisconnected(envB, baseSec + 1100);
    store.recordObservation({
      environmentId: envB,
      hostLabel: 'demo-ssh-host',
      email: 'remote-c@example.invalid',
      matchedLocalAccountId: 'acc-remote-c',
      accountType: 'enterprise_vertex',
      observedAtSec: baseSec + 1160,
    });

    // 当前进程活跃观测期内 -> observed (账号 C)
    assert.deepEqual(store.resolveAttribution(envB, baseSec + 1170), {
      account_confidence: 'observed',
      account_id: 'acc-remote-c',
      account_email: 'remote-c@example.invalid',
      account_type: 'enterprise_vertex',
    });

    await store.flush();

    // 验证磁盘隔离与 0o600 权限
    assert.equal(await readFile(localObsPath, 'utf8'), localObsPayload, '本机观测文件不得被远端 store 污染');
    const remoteObsStat = await stat(join(dir, 'usage-remote-observations.json'));
    assert.equal(remoteObsStat.mode & 0o777, 0o600);

    // 重新从磁盘加载（模拟重启恢复）再验证全部分段判定
    const reloaded = new RemoteAccountObservationStore({ stateDir: dir });
    await reloaded.load();

    // 早于首次观测时间线（冷历史） -> unknown
    assert.deepEqual(reloaded.resolveAttribution(envB, baseSec + 900), {
      account_confidence: 'unknown',
    });

    // 当前观测窗口期内 -> observed (账号 B)
    assert.deepEqual(reloaded.resolveAttribution(envB, baseSec + 1010), {
      account_confidence: 'observed',
      account_id: 'acc-remote-b',
      account_email: 'remote-b@example.invalid',
      account_type: 'consumer',
    });

    // 断线后台跑完重连后且无切号冲突 -> inferred (账号 B)
    assert.deepEqual(reloaded.resolveAttribution(envB, baseSec + 1045), {
      account_confidence: 'inferred',
      account_id: 'acc-remote-b',
      account_email: 'remote-b@example.invalid',
      account_type: 'consumer',
    });

    // 重连后观测期内 -> observed (账号 B)
    assert.deepEqual(reloaded.resolveAttribution(envB, baseSec + 1090), {
      account_confidence: 'observed',
      account_id: 'acc-remote-b',
      account_email: 'remote-b@example.invalid',
      account_type: 'consumer',
    });

    // 断线期间发生切号 B -> C，空窗期不可判定 -> unknown
    assert.deepEqual(reloaded.resolveAttribution(envB, baseSec + 1130), {
      account_confidence: 'unknown',
    });

    // 重启前最后确认时刻 t=1160 -> observed；重启后尚未重新观测的空窗期 t=1170 -> unknown
    assert.deepEqual(reloaded.resolveAttribution(envB, baseSec + 1160), {
      account_confidence: 'observed',
      account_id: 'acc-remote-c',
      account_email: 'remote-c@example.invalid',
      account_type: 'enterprise_vertex',
    });
    assert.deepEqual(reloaded.resolveAttribution(envB, baseSec + 1170), {
      account_confidence: 'unknown',
    });

    // 重启后重新连回同账号 C 于 t=1180 -> 停机空窗 t=1170 升级为 inferred，新观测期 t=1185 为 observed
    reloaded.recordObservation({
      environmentId: envB,
      hostLabel: 'demo-ssh-host',
      email: 'remote-c@example.invalid',
      matchedLocalAccountId: 'acc-remote-c',
      accountType: 'enterprise_vertex',
      observedAtSec: baseSec + 1180,
    });
    assert.deepEqual(reloaded.resolveAttribution(envB, baseSec + 1170), {
      account_confidence: 'inferred',
      account_id: 'acc-remote-c',
      account_email: 'remote-c@example.invalid',
      account_type: 'enterprise_vertex',
    });
    assert.deepEqual(reloaded.resolveAttribution(envB, baseSec + 1185), {
      account_confidence: 'observed',
      account_id: 'acc-remote-c',
      account_email: 'remote-c@example.invalid',
      account_type: 'enterprise_vertex',
    });

    // 未知环境 / 无时间戳 -> unknown
    assert.deepEqual(reloaded.resolveAttribution(buildRemoteEnvironmentId('unknown-ssh-host'), baseSec + 1010), {
      account_confidence: 'unknown',
    });
    assert.deepEqual(reloaded.resolveAttribution(envB, 0), {
      account_confidence: 'unknown',
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('auth_expired 立即中止会话同步且安全保留前次 SyncReceipt 不推进损坏游标', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-remote-auth-'));
  try {
    const sourceId1 = buildRemoteTrajectorySourceId('traj-auth-1');
    const savedReceipts = {
      [sourceId1]: {
        source_id: sourceId1,
        environment_id: buildRemoteEnvironmentId('demo-ssh-host'),
        cursor_offset: 3,
        step_offset: 6,
        last_modified_sec: 1_795_000_000,
        step_count: 6,
        committed_at: 1_795_000_005,
      },
    };
    const fetchedMetadataIds = [];
    let saveCalls = 0;

    const ledger = {
      async receipts() {
        return { ...savedReceipts };
      },
      async save(events, opts) {
        saveCalls++;
        for (const r of opts?.receipts ?? []) {
          savedReceipts[r.source_id] = r;
        }
        return { saved: events.length };
      },
    };

    const coordinator = new RemoteUsageSyncCoordinator({
      stateDir: dir,
      ledger,
      getTargets: () => [
        {
          remoteKey: 'rk-auth',
          hostLabel: 'demo-ssh-host',
          email: 'remote-auth@example.invalid',
          accountType: 'consumer',
          rpcClient: {
            async probeUserAndQuota() {
              return { ok: false, reason: 'auth_expired', authExpired: true };
            },
            async getAllCascadeTrajectories() {
              return {
                ok: true,
                data: [
                  { cascadeId: 'conv-1', trajectoryId: 'traj-auth-1', stepCount: 8, lastModifiedTime: '2026-11-20T07:00:00Z' },
                  { cascadeId: 'conv-2', trajectoryId: 'traj-auth-2', stepCount: 4, lastModifiedTime: '2026-11-20T06:59:00Z' },
                  { cascadeId: 'conv-3', trajectoryId: 'traj-auth-3', stepCount: 4, lastModifiedTime: '2026-11-20T06:58:00Z' },
                  { cascadeId: 'conv-4', trajectoryId: 'traj-auth-4', stepCount: 4, lastModifiedTime: '2026-11-20T06:57:00Z' },
                ],
              };
            },
            async getGeneratorMetadata(cid) {
              fetchedMetadataIds.push(cid);
              return { ok: false, reason: 'auth_expired', authExpired: true, status: 401 };
            },
            async getTrajectorySteps() {
              throw new Error('auth_expired 后不应继续拉取 steps');
            },
          },
        },
      ],
      concurrencyPerTarget: 1,
    });

    const round = await coordinator.syncNow({ nowMs: Date.UTC(2026, 10, 20, 7, 0, 5) });
    assert.equal(round.ok, false);
    assert.deepEqual(round.authExpiredTargets, [buildRemoteEnvironmentId('demo-ssh-host')]);
    assert.equal(round.eventsSaved, 0);
    assert.equal(round.receiptsUpdated, 0);
    assert.equal(saveCalls, 0);
    assert.deepEqual(fetchedMetadataIds, ['conv-1'], '命中 auth_expired 应立即中止后续轨迹拉取');
    assert.equal(savedReceipts[sourceId1].cursor_offset, 3, '前次有效游标必须原样保留');
    assert.equal(savedReceipts[sourceId1].step_count, 6);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('资源预算门禁：单轮最多 20 条变更轨迹、并发上限 3、12s 预算硬截断与单飞互斥去重', async () => {
  // 1) 25 条变更轨迹，验证按 lastModifiedTime 降序最多扫 20 条，且并发峰值 <= 3
  let activeInFlight = 0;
  let maxObservedConcurrency = 0;
  const scannedIds = [];
  const trajectories = Array.from({ length: 25 }, (_, i) => ({
    cascadeId: `conv-${String(i).padStart(2, '0')}`,
    trajectoryId: `traj-${String(i).padStart(2, '0')}`,
    stepCount: 2,
    lastModifiedTime: new Date(Date.UTC(2026, 10, 20, 5, 0, i)).toISOString(),
  }));

  const cappedResult = await syncRemoteSessionUsage({
    target: {
      remoteKey: 'rk-cap',
      hostLabel: 'demo-ssh-host',
      email: 'cap@example.invalid',
      rpcClient: {
        async probeUserAndQuota() {
          return { ok: false, reason: 'rpc_error', authExpired: false };
        },
        async getAllCascadeTrajectories() {
          return { ok: true, data: trajectories };
        },
        async getGeneratorMetadata(cid) {
          scannedIds.push(cid);
          activeInFlight++;
          maxObservedConcurrency = Math.max(maxObservedConcurrency, activeInFlight);
          await new Promise(r => setTimeout(r, 8));
          activeInFlight--;
          return {
            ok: true,
            data: [
              {
                stepIndices: [1],
                executionId: `exec-${cid}`,
                responseModel: 'gemini-3.8-flash-n',
                usage: { inputTokens: '100', outputTokens: '20' },
              },
            ],
          };
        },
        async getTrajectorySteps() {
          return {
            ok: true,
            data: [
              {
                idx: 1,
                type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                status: 'CORTEX_STEP_STATUS_DONE',
                metadata: { createdAt: '2026-11-20T05:00:00Z' },
              },
            ],
          };
        },
      },
    },
    nowMs: Date.UTC(2026, 10, 20, 5, 1, 0),
  });

  assert.equal(cappedResult.ok, true);
  assert.equal(cappedResult.trajectoriesTotal, 25);
  assert.equal(cappedResult.trajectoriesChanged, 25);
  assert.equal(cappedResult.trajectoriesScanned, 20);
  assert.equal(scannedIds.length, 20);
  assert.equal(scannedIds.includes('conv-24'), true, '应优先扫描最近修改的轨迹');
  assert.equal(scannedIds.includes('conv-00'), false, '超出 20 条预算的较旧轨迹留待下轮');
  assert.ok(maxObservedConcurrency >= 2 && maxObservedConcurrency <= 3, `并发峰值应在 2..3 之间，实际=${maxObservedConcurrency}`);

  // 2) 预算超时硬截断
  const budgetResult = await syncRemoteSessionUsage({
    target: {
      remoteKey: 'rk-budget',
      hostLabel: 'demo-ssh-host',
      email: 'budget@example.invalid',
      rpcClient: {
        async probeUserAndQuota() {
          return { ok: false, reason: 'rpc_error', authExpired: false };
        },
        async getAllCascadeTrajectories() {
          return { ok: true, data: trajectories.slice(0, 6) };
        },
        async getGeneratorMetadata() {
          await new Promise(r => setTimeout(r, 120));
          return {
            ok: true,
            data: [{ stepIndices: [1], responseModel: 'gemini-3.8-flash-n', usage: { inputTokens: '50', outputTokens: '10' } }],
          };
        },
        async getTrajectorySteps() {
          return { ok: true, data: [] };
        },
      },
    },
    budgetMs: 50,
    nowMs: Date.UTC(2026, 10, 20, 5, 1, 0),
  });
  assert.equal(budgetResult.ok, false);
  assert.equal(budgetResult.abortedByBudget, true);

  // 3) RemoteUsageSyncCoordinator 单飞互斥去重 + triggerSync 非阻塞
  let listCalls = 0;
  const savedEvents = [];
  const coordinator = new RemoteUsageSyncCoordinator({
    ledger: {
      async receipts() {
        return {};
      },
      async save(events) {
        savedEvents.push(...events);
        return { saved: events.length };
      },
    },
    getTargets: () => [
      {
        remoteKey: 'rk-sf',
        hostLabel: 'demo-ssh-host',
        email: 'sf@example.invalid',
        rpcClient: {
          async probeUserAndQuota() {
            return { ok: false, reason: 'rpc_error', authExpired: false };
          },
          async getAllCascadeTrajectories() {
            listCalls++;
            await new Promise(r => setTimeout(r, 25));
            return {
              ok: true,
              data: [{ cascadeId: 'conv-sf', trajectoryId: 'traj-sf', stepCount: 1, lastModifiedTime: '2026-11-20T05:00:00Z' }],
            };
          },
          async getGeneratorMetadata() {
            return {
              ok: true,
              data: [{ stepIndices: [0], executionId: 'e-sf', responseModel: 'gemini-3.8-flash-n', usage: { inputTokens: '10', outputTokens: '5' } }],
            };
          },
          async getTrajectorySteps() {
            return {
              ok: true,
              data: [{ idx: 0, type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', metadata: { createdAt: '2026-11-20T05:00:00Z' } }],
            };
          },
        },
      },
    ],
  });

  const startedFirst = coordinator.triggerSync({ nowMs: Date.UTC(2026, 10, 20, 5, 1, 0) });
  const startedSecond = coordinator.triggerSync({ nowMs: Date.UTC(2026, 10, 20, 5, 1, 0) });
  assert.equal(startedFirst, true);
  assert.equal(startedSecond, false);
  assert.equal(coordinator.isSyncing(), true);

  const [s1, s2] = await Promise.all([
    coordinator.syncNow({ nowMs: Date.UTC(2026, 10, 20, 5, 1, 0) }),
    coordinator.syncNow({ nowMs: Date.UTC(2026, 10, 20, 5, 1, 0) }),
  ]);
  assert.equal(listCalls, 1, '并发 syncNow/triggerSync 必须共享同一单飞轮次');
  assert.equal(s1.revision, 1);
  assert.equal(s2.revision, 1);
  assert.equal(savedEvents.length, 1);
  assert.equal(coordinator.isSyncing(), false);
});

test('Controller.getConnectedRemoteRpcTargets 只读导出目标并驱动 Coordinator 完成远端同步', async () => {
  const dict = dictionaryFromEntries({});
  const cdpServer = await startRemoteMockCdpServer({
    dictVersion: dict.version,
    onEvaluate(targetId, expr) {
      if (targetId !== 'remote-usage-1') return undefined;
      if (expr.includes('GetUserStatus')) {
        return {
          ok: true,
          latencyMs: 5,
          data: {
            userStatusData: {
              userStatus: {
                email: 'remote-ssh@example.invalid',
                name: 'Remote Dev',
                userTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
                cascadeModelConfigData: {
                  clientModelConfigs: [
                    { modelOrAlias: { model: 'gemini-3.8-flash' }, label: 'Gemini 3.8 Flash', quotaInfo: { remainingFraction: 0.8, resetTime: '2026-11-20T18:00:00Z' } },
                  ],
                },
              },
            },
            quotaSummaryData: { groups: [] },
          },
        };
      }
      if (expr.includes('GetAllCascadeTrajectories')) {
        return {
          ok: true,
          latencyMs: 5,
          data: [
            { cascadeId: 'c-ctrl-1', trajectoryId: 't-ctrl-1', stepCount: 2, lastModifiedTime: '2026-11-20T06:30:00Z' },
          ],
        };
      }
      if (expr.includes('GetCascadeTrajectoryGeneratorMetadata')) {
        return {
          ok: true,
          latencyMs: 5,
          data: [
            { stepIndices: [1], executionId: 'ex-ctrl-1', responseModel: 'gemini-3.8-flash-n', usage: { inputTokens: '300', outputTokens: '75' } },
          ],
        };
      }
      if (expr.includes('GetCascadeTrajectorySteps')) {
        return {
          ok: true,
          latencyMs: 5,
          data: [
            { idx: 1, type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', metadata: { createdAt: '2026-11-20T06:29:58Z', executionId: 'ex-ctrl-1' } },
          ],
        };
      }
      return undefined;
    },
  }).start();

  const remoteKey = buildRemoteWindowKey('demo-ssh-host', 'https://127.0.0.1:44139');
  cdpServer.setTargets([
    { id: 'remote-usage-1', type: 'page', url: 'https://127.0.0.1:44139/', browserContextId: 'ctx-remote-usage' },
  ]);

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
    verifyRemoteWindow: async ({ browserContextId }) => ({
      status: 'verified',
      identity: {
        kind: 'remote',
        remoteKey,
        hostLabel: 'demo-ssh-host',
        browserContextId: browserContextId || 'ctx-remote-usage',
        origin: 'https://127.0.0.1:44139',
        verifiedBy: 'process',
      },
    }),
    onStatus: () => {},
  });

  await controller.start();
  try {
    await controller.probeRemoteSessions({
      matchAccountId: email => (email === 'remote-ssh@example.invalid' ? 'local-matched-1' : null),
    });

    const targets = controller.getConnectedRemoteRpcTargets();
    assert.equal(targets.length, 1);
    assert.equal(targets[0].remoteKey, remoteKey);
    assert.equal(targets[0].hostLabel, 'demo-ssh-host');
    assert.equal(targets[0].environmentId, buildRemoteEnvironmentId('demo-ssh-host'));
    assert.equal(targets[0].origin, 'https://127.0.0.1:44139');
    assert.equal(targets[0].email, 'remote-ssh@example.invalid');
    assert.equal(targets[0].matchedLocalAccountId, 'local-matched-1');
    assert.equal(targets[0].state, 'connected');

    const capturedEvents = [];
    const coordinator = new RemoteUsageSyncCoordinator({
      getTargets: () => controller.getConnectedRemoteRpcTargets(),
      ledger: {
        async receipts() {
          return {};
        },
        async save(events) {
          capturedEvents.push(...events);
          return { saved: events.length };
        },
      },
    });
    coordinator.recordObservation({
      hostLabel: targets[0].hostLabel,
      environmentId: targets[0].environmentId,
      email: targets[0].email,
      matchedLocalAccountId: targets[0].matchedLocalAccountId,
      accountType: targets[0].accountType,
      observedAtSec: Math.floor(Date.UTC(2026, 10, 20, 6, 29, 0) / 1000),
    });

    const round = await coordinator.syncNow({ nowMs: Date.UTC(2026, 10, 20, 6, 30, 5) });
    assert.equal(round.ok, true);
    assert.equal(round.eventsSaved, 1);
    assert.equal(capturedEvents.length, 1);
    assert.equal(capturedEvents[0].environment_id, buildRemoteEnvironmentId('demo-ssh-host'));
    assert.equal(capturedEvents[0].environment_label, 'demo-ssh-host');
    assert.equal(capturedEvents[0].account_id, 'local-matched-1');
    assert.equal(capturedEvents[0].account_email, 'remote-ssh@example.invalid');
    assert.equal(capturedEvents[0].total_tokens, 375);
  } finally {
    await controller.stop();
    await cdpServer.stop();
  }
});
