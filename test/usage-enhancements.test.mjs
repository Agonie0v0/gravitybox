import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  extractThinkingEffort,
  normalizeThinkingEffort,
} from '../dist/model-identity.js';
import {
  GENERATION_PROJECTION,
  USAGE_PROJECTION_VERSION,
} from '../dist/protobuf-projection.js';
import { ProtobufWriter as W } from '../dist/protobuf.js';
import {
  OUTPUT_SPEED_WINDOW_SIZE,
  RecentSpeedTracker,
  computeEventOutputTps,
  parseLocalDateRange,
} from '../dist/usage-speed.js';
import {
  parseProtobufDurationSeconds,
  scanDatabaseEvents,
} from '../dist/usage-scanner.js';
import { syncRemoteSessionUsage } from '../dist/remote-usage-sync.js';
import { UsageLedger } from '../dist/usage-ledger.js';
import { aggregateLedger, ledgerEventPage } from '../dist/usage-aggregate.js';
import { buildUsageSummaryReport } from '../dist/usage-report.js';
import { UsageStatsManager } from '../dist/usage.js';
import { projectUsagePeriodSummary } from '../dist/ipc-projections.js';
import { sendBackendRpc, stopBackendChild } from './test-ipc.mjs';

function encodeDuration(seconds, nanos = 0) {
  const parts = [];
  if (seconds !== 0) parts.push(W.encodeVarintField(1, BigInt(seconds)));
  if (nanos !== 0) parts.push(W.encodeVarintField(2, BigInt(nanos)));
  return Buffer.concat(parts);
}

function makeGenBlob({
  model = 'gemini-3.8-flash',
  label,
  input = 1000,
  output = 200,
  cached = 0,
  cacheWrite = 0,
  timestampSec = 1763700000,
  ttft,
  streaming,
  execution = 'exec-1',
  paddingBytes = 0,
}) {
  const usageFields = [
    W.encodeField(1, 0, W.encodeVarint(0)),
    W.encodeField(2, 0, W.encodeVarint(input)),
    W.encodeField(3, 0, W.encodeVarint(output)),
  ];
  if (cacheWrite > 0) usageFields.push(W.encodeField(4, 0, W.encodeVarint(cacheWrite)));
  if (cached > 0) usageFields.push(W.encodeField(5, 0, W.encodeVarint(cached)));

  const wrappedFields = [
    W.encodeField(4, 2, Buffer.concat(usageFields)),
    W.encodeString(19, model),
  ];
  if (label) wrappedFields.push(W.encodeString(21, label));
  if (timestampSec > 0) {
    const innerTiming = W.encodeVarintField(1, timestampSec);
    wrappedFields.push(W.encodeField(9, 2, W.encodeField(4, 2, innerTiming)));
  }
  if (ttft) {
    wrappedFields.push(W.encodeLengthDelimited(11, encodeDuration(ttft.seconds ?? 0, ttft.nanos ?? 0)));
  }
  if (streaming) {
    wrappedFields.push(W.encodeLengthDelimited(12, encodeDuration(streaming.seconds ?? 0, streaming.nanos ?? 0)));
  }

  const rootFields = [];
  if (paddingBytes > 0) {
    rootFields.push(W.encodeLengthDelimited(8, Buffer.alloc(paddingBytes)));
  }
  rootFields.push(W.encodeField(1, 2, Buffer.concat(wrappedFields)));
  if (execution) rootFields.push(W.encodeString(4, execution));
  return Buffer.concat(rootFields);
}

async function withTempDir(t, fn) {
  const root = await mkdtemp(join(tmpdir(), 'gb-usage-enh-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return fn(root);
}

test('normalizeThinkingEffort & extractThinkingEffort support all 8 levels and prefer specific effort over thinking', () => {
  assert.equal(normalizeThinkingEffort('Minimal'), 'minimal');
  assert.equal(normalizeThinkingEffort('(Extra Low)'), 'extra_low');
  assert.equal(normalizeThinkingEffort('extra-low'), 'extra_low');
  assert.equal(normalizeThinkingEffort('LOW'), 'low');
  assert.equal(normalizeThinkingEffort('medium'), 'medium');
  assert.equal(normalizeThinkingEffort('High'), 'high');
  assert.equal(normalizeThinkingEffort('XHigh'), 'xhigh');
  assert.equal(normalizeThinkingEffort('Extra High'), 'xhigh');
  assert.equal(normalizeThinkingEffort('extra-high'), 'xhigh');
  assert.equal(normalizeThinkingEffort('max'), 'max');
  assert.equal(normalizeThinkingEffort('Thinking'), 'thinking');
  assert.equal(normalizeThinkingEffort('unknown-mode'), undefined);
  assert.equal(normalizeThinkingEffort(null), undefined);

  assert.equal(extractThinkingEffort('gemini-3.8-flash-minimal', null), 'minimal');
  assert.equal(extractThinkingEffort('gemini-4-carbon-extra-low', null), 'extra_low');
  assert.equal(extractThinkingEffort('gemini-4-hydrogen-tiered-low', null), 'low');
  assert.equal(extractThinkingEffort('gpt-oss-120b-medium', null), 'medium');
  assert.equal(extractThinkingEffort('publishers/google/models/gemini-4-carbon-high:generateContent', null), 'high');
  assert.equal(extractThinkingEffort('gemini-4-hydrogen-tiered-extra-high', null), 'xhigh');
  assert.equal(extractThinkingEffort('gemini-4-neon-tiered-extra', null), 'xhigh');
  assert.equal(extractThinkingEffort('claude-opus-5-5-max', null), 'max');
  assert.equal(extractThinkingEffort('claude-3-7-sonnet-thinking', 'Claude 3.7 Sonnet (Thinking)'), 'thinking');

  assert.equal(extractThinkingEffort(null, 'Gemini 3.8 Flash (XHigh)'), 'xhigh');
  assert.equal(extractThinkingEffort(null, 'Gemini 3.8 Flash (Extra High)'), 'xhigh');
  assert.equal(extractThinkingEffort(null, 'Gemini 3.8 Flash (Extra Low)'), 'extra_low');
  assert.equal(extractThinkingEffort(null, 'Gemini 3.8 Flash (Minimal)'), 'minimal');
  assert.equal(extractThinkingEffort(null, 'Gemini 4 Argon (Max)'), 'max');
  assert.equal(extractThinkingEffort(null, 'Gemini 3.8 Flash Extra High'), 'xhigh');
  assert.equal(extractThinkingEffort('gemini-flash-worker-agy', 'Orchestrator (Gemini 3.8 Flash (High))'), 'high');
  assert.equal(extractThinkingEffort('gemini-flash-worker-agy', 'Gemini 3.8 Flash (Medium) (Orchestrator)'), 'medium');

  // Prefer explicit specific effort over generic 'thinking'
  assert.equal(extractThinkingEffort('claude-opus-5-5-thinking-high', 'Claude Opus 5.5 (Thinking)'), 'high');
  assert.equal(extractThinkingEffort('claude-opus-5-5-thinking', 'Claude Opus 5.5 (Thinking) (XHigh)'), 'xhigh');
  assert.equal(extractThinkingEffort('claude-opus-5-5-high', 'Claude Opus 5.5 (Thinking)'), 'high');
  assert.equal(extractThinkingEffort('gemini-3.8-flash', 'Gemini 3.8 Flash'), undefined);
});

test('computeEventOutputTps & RecentSpeedTracker retain latest 10 samples ordered by (timestamp_seconds DESC, seq DESC)', () => {
  assert.equal(OUTPUT_SPEED_WINDOW_SIZE, 10);
  assert.equal(computeEventOutputTps({ output_tokens: 150, streaming_duration_seconds: 3 }), 50);
  assert.equal(computeEventOutputTps({ output_tokens: 0, streaming_duration_seconds: 3 }), null);
  assert.equal(computeEventOutputTps({ output_tokens: 100, streaming_duration_seconds: 0 }), null);
  assert.equal(computeEventOutputTps({ output_tokens: 100, streaming_duration_seconds: -2 }), null);
  assert.equal(computeEventOutputTps({ output_tokens: 100, streaming_duration_seconds: Number.NaN }), null);
  assert.equal(computeEventOutputTps({ output_tokens: 100 }), null);

  const emptyTracker = new RecentSpeedTracker();
  assert.deepEqual(emptyTracker.summary(), { median_output_tps: null, speed_sample_count: 0 });

  // Odd count median
  const oddTracker = new RecentSpeedTracker();
  oddTracker.add({ output_tokens: 100, streaming_duration_seconds: 10, timestamp_seconds: 100 }); // 10
  oddTracker.add({ output_tokens: 300, streaming_duration_seconds: 10, timestamp_seconds: 101 }); // 30
  oddTracker.add({ output_tokens: 200, streaming_duration_seconds: 10, timestamp_seconds: 102 }); // 20
  assert.deepEqual(oddTracker.summary(), { median_output_tps: 20, speed_sample_count: 3 });

  // Even count median rounded to 2 decimals + latest-10 window eviction
  const tracker = new RecentSpeedTracker();
  // Older outliers (should be evicted once 10 newer samples arrive)
  tracker.add({ output_tokens: 1000, streaming_duration_seconds: 1, timestamp_seconds: 10 }); // 1000
  tracker.add({ output_tokens: 1000, streaming_duration_seconds: 1, timestamp_seconds: 20 }); // 1000
  tracker.add({ output_tokens: 1000, streaming_duration_seconds: 1, timestamp_seconds: 25 }); // 1000
  // Invalid sample ignored
  assert.equal(tracker.add({ output_tokens: 0, streaming_duration_seconds: 2, timestamp_seconds: 999 }), false);

  // Add 10 newer samples out of order:
  // 2 samples at ts=100 (seq tie-break keeps the later one if window fills),
  // plus 9 samples at ts=200..208 => 9 from 200..208 + latest 1 from ts=100
  tracker.add({ output_tokens: 9990, streaming_duration_seconds: 1, timestamp_seconds: 100 }); // older seq at ts=100 (evicted)
  tracker.add({ output_tokens: 100, streaming_duration_seconds: 3, timestamp_seconds: 100 });  // 33.3333... (kept)
  for (let i = 0; i < 9; i++) {
    // TPS values: 10, 20, 30, 40, 50, 60, 70, 80, 90
    tracker.add({ output_tokens: (i + 1) * 10, streaming_duration_seconds: 1, timestamp_seconds: 200 + i });
  }
  // Kept TPS sorted: [10, 20, 30, 33.3333..., 40, 50, 60, 70, 80, 90]
  // Middle two (idx 4, 5): (40 + 50) / 2 = 45
  assert.deepEqual(tracker.summary(), { median_output_tps: 45, speed_sample_count: 10 });

  // Verify 2-decimal rounding on even median
  const roundTracker = new RecentSpeedTracker();
  roundTracker.add({ output_tokens: 100, streaming_duration_seconds: 3, timestamp_seconds: 10 }); // 33.33333...
  roundTracker.add({ output_tokens: 101, streaming_duration_seconds: 3, timestamp_seconds: 11 }); // 33.66666...
  roundTracker.add({ output_tokens: 100, streaming_duration_seconds: 4, timestamp_seconds: 12 }); // 25
  roundTracker.add({ output_tokens: 121, streaming_duration_seconds: 3, timestamp_seconds: 13 }); // 40.33333...
  // Sorted: [25, 33.33333..., 33.66666..., 40.33333...] -> avg middle two = 33.5
  assert.deepEqual(roundTracker.summary(), { median_output_tps: 33.5, speed_sample_count: 4 });
});

test('GENERATION_PROJECTION, parseProtobufDurationSeconds, and scanDatabaseEvents extract TTFT, streaming duration, and effort', async t => {
  assert.equal(USAGE_PROJECTION_VERSION, 4);
  assert.equal(GENERATION_PROJECTION[1][11], true);
  assert.equal(GENERATION_PROJECTION[1][12], true);

  assert.equal(parseProtobufDurationSeconds(encodeDuration(2, 487_000_000)), 2.487);
  assert.equal(parseProtobufDurationSeconds(encodeDuration(0, 350_000_000)), 0.35);
  assert.equal(parseProtobufDurationSeconds(encodeDuration(86400, 0)), 86400);
  assert.equal(parseProtobufDurationSeconds(encodeDuration(0, 0)), undefined);
  assert.equal(parseProtobufDurationSeconds(encodeDuration(86401, 0)), undefined);
  assert.equal(parseProtobufDurationSeconds(encodeDuration(86400, 1)), undefined);
  assert.equal(parseProtobufDurationSeconds(Buffer.from('ffffffffffffffffff01', 'hex')), undefined);
  assert.equal(parseProtobufDurationSeconds(Buffer.from([0x08, 0x80])), undefined);

  await withTempDir(t, async root => {
    const convDir = join(root, 'antigravity', 'conversations');
    await mkdir(convDir, { recursive: true });
    const dbPath = join(convDir, 'speed-proj.db');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB); CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB);');
    const ts = Math.floor(Date.now() / 1000) - 60;
    const blobWithoutDuration = makeGenBlob({
      model: 'gemini-4-hydrogen-tiered-high',
      label: 'Gemini 4 Hydrogen (High)',
      input: 100,
      output: 400,
      timestampSec: ts,
      execution: 'exec-same',
    });
    const blobWithDurationAndPadding = makeGenBlob({
      model: 'gemini-4-hydrogen-tiered-high',
      label: 'Gemini 4 Hydrogen (High)',
      input: 100,
      output: 400,
      timestampSec: ts,
      ttft: { seconds: 0, nanos: 420_000_000 },
      streaming: { seconds: 4, nanos: 0 },
      execution: 'exec-same',
      paddingBytes: 17 * 1024 * 1024, // exercises GENERATION_PROJECTION > 16MB projection path
    });
    db.prepare('INSERT INTO gen_metadata VALUES(?, ?)').run(0, blobWithoutDuration);
    db.prepare('INSERT INTO gen_metadata VALUES(?, ?)').run(1, blobWithDurationAndPadding);
    db.close();

    const mgr = new UsageStatsManager({ geminiDir: root, stateDir: join(root, 'state') });
    const scan = await mgr.scanDatabaseEvents(dbPath, true);
    assert.equal(scan.hasError, false);
    assert.equal(scan.skippedLargeRecords, 0);
    assert.equal(scan.events.length, 2);

    const [ev0, ev1] = scan.events;
    assert.equal(ev0.model, 'gemini-4-hydrogen');
    assert.equal(ev0.thinking_effort, 'high');
    assert.equal(ev0.ttft_seconds, undefined);
    assert.equal(ev0.streaming_duration_seconds, undefined);

    assert.equal(ev1.model, 'gemini-4-hydrogen');
    assert.equal(ev1.thinking_effort, 'high');
    assert.equal(ev1.ttft_seconds, 0.42);
    assert.equal(ev1.streaming_duration_seconds, 4);

    // event_key and legacy_event_key depend only on index/execution/raw model, unaffected by duration
    const refDir = join(root, 'ref-dir');
    await mkdir(refDir, { recursive: true });
    const dbRefPath = join(refDir, 'speed-proj.db');
    const dbRef = new DatabaseSync(dbRefPath);
    dbRef.exec('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB); CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB);');
    dbRef.prepare('INSERT INTO gen_metadata VALUES(?, ?)').run(1, makeGenBlob({
      model: 'gemini-4-hydrogen-tiered-high',
      label: 'Gemini 4 Hydrogen (High)',
      input: 100,
      output: 400,
      timestampSec: ts,
      execution: 'exec-same',
    }));
    dbRef.close();
    const scanRef = await scanDatabaseEvents({
      discoveredStats: new Map(),
      fileCache: new Map(),
      setFileCacheEntry: () => {},
      markFileCacheDirty: () => {},
      lookupObservedContext: () => null,
      loadUsageLedger: async () => {},
      upsertLedger: () => {},
      getLedgerEvent: () => undefined,
    }, dbRefPath, true);
    assert.equal(scanRef.events[0].legacy_event_key, ev1.legacy_event_key);
    assert.equal(scanRef.events[0].model, ev1.model);
  });
});

test('remote-usage-sync extracts durations & thinking_effort and ledger preserves them across merges', async t => {
  const t0 = Date.UTC(2026, 10, 22, 12, 0, 0);
  const res = await syncRemoteSessionUsage({
    target: {
      remoteKey: 'rk-speed-1',
      hostLabel: 'demo-ssh-host',
      email: 'remote@example.invalid',
      accountType: 'consumer',
      lastIdentityVerifiedAt: t0,
      rpcClient: {
        async getAllCascadeTrajectories() {
          return {
            ok: true,
            data: [
              {
                cascadeId: 'conv-remote-speed',
                trajectoryId: 'traj-remote-speed',
                trajectoryType: 2,
                stepCount: 2,
                lastModifiedTime: '2026-11-22T11:59:00Z',
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
                executionId: 'exec-rem-1',
                responseModel: 'gemini-4-hydrogen-tiered-extra-high',
                modelDisplayName: 'Gemini 4 Hydrogen (Thinking)',
                timeToFirstToken: '0.55s',
                streamingDuration: { seconds: 5, nanos: 0 },
                createdAt: '2026-11-22T11:58:00Z',
                usage: { inputTokens: '500', outputTokens: '250', cacheReadTokens: '0' },
              },
            ],
          };
        },
        async getTrajectorySteps() {
          return { ok: true, data: [] };
        },
      },
    },
    nowMs: t0,
  });

  assert.equal(res.ok, true);
  assert.equal(res.events.length, 1);
  const remEv = res.events[0];
  assert.equal(remEv.model, 'gemini-4-hydrogen');
  assert.equal(remEv.thinking_effort, 'xhigh');
  assert.equal(remEv.ttft_seconds, 0.55);
  assert.equal(remEv.streaming_duration_seconds, 5);

  await withTempDir(t, async stateDir => {
    const mgr = new UsageStatsManager({ stateDir, geminiDir: join(stateDir, 'empty-gemini') });
    const legacyKey = createHash('sha256').update('remote-legacy-1').digest('hex');
    await mgr.ingestRemoteUsageBatch([
      {
        event_key: remEv.event_key,
        legacy_event_key: legacyKey,
        source_id: remEv.source_id,
        source_observed_at: t0,
        generation_index: 0,
        account_confidence: 'observed',
        account_email: 'remote@example.invalid',
        model: 'gemini-4-hydrogen-tiered-extra-high',
        input_tokens: 500,
        output_tokens: 250,
        cached_tokens: 0,
        total_tokens: 750,
        timestamp_seconds: Math.floor(t0 / 1000) - 60,
        streaming_duration_seconds: 5,
        ttft_seconds: 0.55,
        environment_kind: 'ssh',
        environment_id: 'ssh:demo',
        environment_label: 'demo-ssh-host',
      },
    ]);

    // Later re-ingest without duration/effort should preserve existing values via mergeLedgerEventRecord & worker
    await mgr.ingestRemoteUsageBatch([
      {
        event_key: remEv.event_key,
        legacy_event_key: legacyKey,
        source_id: remEv.source_id,
        source_observed_at: t0 + 5000,
        generation_index: 0,
        account_confidence: 'observed',
        account_email: 'remote@example.invalid',
        model: 'gemini-4-hydrogen',
        input_tokens: 500,
        output_tokens: 250,
        cached_tokens: 0,
        total_tokens: 750,
        timestamp_seconds: Math.floor(t0 / 1000) - 60,
        environment_kind: 'ssh',
        environment_id: 'ssh:demo',
        environment_label: 'demo-ssh-host',
      },
    ]);

    const reloaded = await new UsageLedger(stateDir).load();
    assert.equal(reloaded.length, 1);
    assert.equal(reloaded[0].thinking_effort, 'xhigh');
    assert.equal(reloaded[0].streaming_duration_seconds, 5);
    assert.equal(reloaded[0].ttft_seconds, 0.55);
  });
});

test('by_model_effort, speed medians, and custom date range align across buildUsageSummaryReport and aggregateLedger', async t => {
  await withTempDir(t, async stateDir => {
    const prices = {
      'gemini-4-neon': { model: 'gemini-4-neon', input: 1, output: 4, cached: 0.1 },
      'gemini-4-hydrogen': { model: 'gemini-4-hydrogen', input: 4, output: 20, cached: 0.2, cacheWrite: 5 },
    };
    const day1 = '2026-11-10';
    const day2 = '2026-11-11';
    const day3 = '2026-11-12';
    const tsDay1H9 = Math.floor(new Date(2026, 10, 10, 9, 15, 0, 0).getTime() / 1000);
    const tsDay1H14 = Math.floor(new Date(2026, 10, 10, 14, 30, 0, 0).getTime() / 1000);
    const tsDay3H10 = Math.floor(new Date(2026, 10, 12, 10, 0, 0, 0).getTime() / 1000);
    const tsOutside = Math.floor(new Date(2026, 10, 15, 10, 0, 0, 0).getTime() / 1000);
    const now = tsOutside + 3600;

    const mkKey = label => createHash('sha256').update(label).digest('hex');
    const events = [
      {
        event_key: mkKey('ev-1'),
        source_id: 'src-1',
        model: 'gemini-4-hydrogen-tiered-high', // raw model without pre-set thinking_effort -> inferred before fold
        input_tokens: 1000,
        output_tokens: 200,
        cached_tokens: 0,
        total_tokens: 1200,
        timestamp_seconds: tsDay1H9,
        streaming_duration_seconds: 4, // 50 tok/s
        ttft_seconds: 0.4,
      },
      {
        event_key: mkKey('ev-2'),
        source_id: 'src-1',
        model: 'gemini-4-hydrogen',
        thinking_effort: 'xhigh',
        input_tokens: 2000,
        output_tokens: 600,
        cached_tokens: 0,
        total_tokens: 2600,
        timestamp_seconds: tsDay1H14,
        streaming_duration_seconds: 6, // 100 tok/s
        ttft_seconds: 0.6,
      },
      {
        event_key: mkKey('ev-3'),
        source_id: 'src-1',
        model: 'gemini-4-hydrogen', // no effort
        input_tokens: 500,
        output_tokens: 100,
        cached_tokens: 0,
        total_tokens: 600,
        timestamp_seconds: tsDay3H10,
        streaming_duration_seconds: 5, // 20 tok/s
      },
      {
        event_key: mkKey('ev-4'),
        source_id: 'src-1',
        model: 'gemini-4-neon-tiered-medium',
        input_tokens: 400,
        output_tokens: 300,
        cached_tokens: 0,
        total_tokens: 700,
        timestamp_seconds: tsOutside,
        streaming_duration_seconds: 3, // 100 tok/s (outside custom range)
      },
    ];

    const multiRange = parseLocalDateRange(day1, day3);
    assert.equal(multiRange.dayCount, 3);
    assert.equal(multiRange.isSingleDay, false);

    // 1. Small-ledger report via buildUsageSummaryReport
    const smallReport = buildUsageSummaryReport({
      allEvents: events,
      effectiveEvents: events,
      knownReceiptKeys: new Set(events.map(e => e.event_key)),
      unattributedRequests: 4,
      unattributedTokens: 5100,
      accountMap: new Map([['all', { id: 'all', label: '全部账号', type: 'all', total_tokens: 5100, request_count: 4 }]]),
      accountId: 'all',
      accKey: 'all',
      now,
      rawPricing: prices,
      pricing: prices,
      calKey: '2026-11-15',
      rateLocks: {},
      resolvePricing: (table, name) => table[name] ?? null,
      lockedCost: () => 0.05,
      dbPathsCount: 1,
      archivedDbCount: 0,
      lastDiscoveredDatabaseCount: 1,
      cachedDatabasesCount: 0,
      liveEventsCount: 4,
      generationsScanned: 4,
      skippedLargeRecords: 0,
      failedDatabasesCount: 0,
      diagnostics: [],
      ledgerCorrupt: false,
      archivedUnavailable: false,
      storageWarnings: new Set(),
      pricingWarnings: [],
      customRange: multiRange,
    });

    // 2. Large-ledger path via UsageLedger.aggregate
    const ledger = new UsageLedger(stateDir);
    await ledger.save(events, { billingPrices: prices });
    const aggReport = await ledger.aggregate({
      prices,
      accounts: [],
      now,
      customRange: multiRange,
    });

    for (const report of [smallReport, aggReport]) {
      // by_model keeps unique canonical model keys
      assert.deepEqual(
        report.all_time.by_model.map(m => m.model).sort(),
        ['gemini-4-hydrogen', 'gemini-4-neon']
      );
      const hydrogenModel = report.all_time.by_model.find(m => m.model === 'gemini-4-hydrogen');
      assert.equal(hydrogenModel.total_tokens, 4400);
      assert.equal(hydrogenModel.speed_sample_count, 3);
      assert.equal(hydrogenModel.median_output_tps, 50); // [20, 50, 100] -> 50

      // by_model_effort splits flatly by (canonicalModel, thinking_effort ?? '')
      assert.equal(report.all_time.by_model_effort.length, 4);
      assert.deepEqual(
        report.all_time.by_model_effort.map(m => `${m.model}::${m.thinking_effort ?? ''}`),
        [
          'gemini-4-hydrogen::xhigh',
          'gemini-4-hydrogen::high',
          'gemini-4-neon::medium',
          'gemini-4-hydrogen::',
        ]
      );
      assert.equal(report.all_time.by_model_effort[0].median_output_tps, 100);
      assert.equal(report.all_time.by_model_effort[1].priced, true);
      assert.equal(report.all_time.by_model_effort[1].pricingKey, 'gemini-4-hydrogen');
      assert.equal(report.all_time.by_model_effort[1].median_output_tps, 50);

      // Period speed stats: all_time [20, 50, 100, 100] -> avg(50, 100) = 75
      assert.equal(report.all_time.totals.speed_sample_count, 4);
      assert.equal(report.all_time.totals.median_output_tps, 75);

      // Custom 3-day range excludes ev-4, zero-fills day2
      assert.equal(report.custom.totals.total_tokens, 4400);
      assert.equal(report.custom.totals.request_count, 3);
      assert.equal(report.custom.totals.median_output_tps, 50);
      assert.equal(report.custom.totals.speed_sample_count, 3);
      assert.deepEqual(
        report.custom_daily_trends.map(d => [d.date, d.total_tokens]),
        [
          [day1, 3800],
          [day2, 0],
          [day3, 600],
        ]
      );
      assert.equal(report.custom_hourly, undefined);
    }

    // IPC projection for custom multi-day
    const projectedMulti = projectUsagePeriodSummary(aggReport, 'custom', { includeAllPeriods: true });
    assert.equal(projectedMulti.period, 'custom');
    assert.equal(projectedMulti.summary.totalTokens, 4400);
    assert.equal(projectedMulti.summary.medianOutputTps, 50);
    assert.equal(projectedMulti.summary.speedSampleCount, 3);
    assert.equal(projectedMulti.summary.custom, undefined);
    assert.equal(projectedMulti.byModel.length, 1);
    assert.equal(projectedMulti.byModelEffort.length, 3);
    assert.equal(projectedMulti.dailyTrends.length, 3);
    assert.deepEqual(projectedMulti.todayHourly, []);
    assert.deepEqual(projectedMulti.customRange, multiRange);
    assert.deepEqual(Object.keys(projectedMulti.periods).sort(), ['30d', '7d', 'all', 'today']);

    // Single-day range builds custom_hourly + ledgerEventPage filtering
    const singleRange = parseLocalDateRange(day1, day1);
    assert.equal(singleRange.isSingleDay, true);
    const aggSingle = await ledger.aggregate({
      prices,
      accounts: [],
      now,
      customRange: singleRange,
    });
    assert.equal(aggSingle.custom.totals.total_tokens, 3800);
    assert.deepEqual(
      aggSingle.custom_hourly.map(h => [h.hour, h.total_tokens]),
      [
        ['2026-11-10 09:00', 1200],
        ['2026-11-10 14:00', 2600],
      ]
    );
    const projectedSingle = projectUsagePeriodSummary(aggSingle, 'custom');
    assert.equal(projectedSingle.todayHourly.length, 2);

    const dbRead = new DatabaseSync(ledger.path, { readOnly: false });
    try {
      const page = ledgerEventPage(dbRead, {
        snapshot: aggSingle.ledger_snapshot,
        period: 'custom',
        query: '',
        offset: 0,
        limit: 50,
        customRange: singleRange,
      });
      assert.equal(page.total, 2);
      assert.equal(page.rows[0].thinking_effort, 'xhigh');
      assert.equal(page.rows[0].streaming_duration_seconds, 6);
      assert.equal(page.rows[0].ttft_seconds, 0.6);
      assert.equal(page.rows[0].output_tps, 100);
      assert.equal(page.rows[1].thinking_effort, 'high');
      assert.equal(page.rows[1].output_tps, 50);
    } finally {
      dbRead.close();
    }

    // Ranges > 366 days skip zero-fill of empty days
    const longRange = parseLocalDateRange('2020-01-01', '2026-11-15');
    assert.ok(longRange.dayCount > 366);
    const aggLong = await ledger.aggregate({ prices, accounts: [], now, customRange: longRange });
    assert.equal(aggLong.custom_daily_trends.length, 3);
  });
});

test('parseLocalDateRange validates calendar dates, ordering, leap years, and max 3660-day bound', () => {
  assert.throws(() => parseLocalDateRange('2026-02-30', '2026-03-01'), /calendar|date|日期/i);
  assert.throws(() => parseLocalDateRange('2025-02-29', '2025-03-01'), /calendar|date|日期/i);
  assert.throws(() => parseLocalDateRange('2026-13-01', '2026-13-02'), /calendar|date|日期/i);
  assert.throws(() => parseLocalDateRange('2026/11/01', '2026-11-02'), /YYYY-MM-DD|format|格式/i);
  assert.throws(() => parseLocalDateRange('2026-11-10', '2026-11-05'), /Start date|before|after|开始日期|结束日期|早于|晚于|大于|小于/i);
  assert.throws(() => parseLocalDateRange('2010-01-01', '2025-01-01'), /3660/);

  const leap = parseLocalDateRange('2024-02-29', '2024-02-29');
  assert.equal(leap.isSingleDay, true);
  assert.equal(leap.dayCount, 1);

  const maxAllowed = parseLocalDateRange('2016-01-01', '2026-01-07'); // 3660 days (2016, 2020, 2024 leap)
  assert.equal(maxAllowed.dayCount, 3660);
});

test('UsageStatsManager.getUsageEvents & main.ts IPC support custom period and emit speed/effort fields', async t => {
  await withTempDir(t, async dir => {
    const mockGeminiDir = join(dir, 'gemini');
    const mockHomeDir = join(dir, 'home');
    const mockAppSupportDir = join(dir, 'app-support');
    const convDir = join(mockGeminiDir, 'antigravity', 'conversations');
    await mkdir(join(dir, '词典'), { recursive: true });
    await mkdir(convDir, { recursive: true });
    await mkdir(mockHomeDir, { recursive: true });
    await mkdir(mockAppSupportDir, { recursive: true });

    const ts1 = Math.floor(new Date(2026, 10, 5, 11, 0, 0, 0).getTime() / 1000);
    const ts2 = Math.floor(new Date(2026, 10, 8, 16, 0, 0, 0).getTime() / 1000);
    const dbPath = join(convDir, 'ipc-custom.db');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB); CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB);');
    db.prepare('INSERT INTO gen_metadata VALUES(?, ?)').run(0, makeGenBlob({
      model: 'gemini-3.8-flash-high',
      label: 'Gemini 3.8 Flash (High)',
      input: 100,
      output: 300,
      timestampSec: ts1,
      ttft: { seconds: 0, nanos: 250_000_000 },
      streaming: { seconds: 3, nanos: 0 },
      execution: 'ipc-ex-1',
    }));
    db.prepare('INSERT INTO gen_metadata VALUES(?, ?)').run(1, makeGenBlob({
      model: 'gemini-3.8-flash-low',
      label: 'Gemini 3.8 Flash (Low)',
      input: 200,
      output: 100,
      timestampSec: ts2,
      execution: 'ipc-ex-2',
    }));
    db.close();

    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('../dist/main.js', import.meta.url)),
        '--state-dir', dir,
        '--app', '/nonexistent',
        '--profile', join(dir, 'profile'),
        '--gemini-dir', mockGeminiDir,
        '--home-dir', mockHomeDir,
        '--app-support-dir', mockAppSupportDir,
      ],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, GRAVITYBOX_PROBE_LS: 'false' },
      }
    );
    t.after(() => stopBackendChild(child));

    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try {
        const st = await sendBackendRpc(dir, { command: 'status' }, { timeoutMs: 2000 });
        if (st.ok) break;
      } catch {}
      await new Promise(r => setTimeout(r, 40));
    }

    const customSum = await sendBackendRpc(dir, {
      command: 'usage_summary',
      period: 'custom',
      startDate: '2026-11-05',
      endDate: '2026-11-05',
    });
    assert.equal(customSum.ok, true);
    assert.equal(customSum.period, 'custom');
    assert.equal(customSum.summary.totalTokens, 400);
    assert.equal(customSum.summary.medianOutputTps, 100);
    assert.equal(customSum.summary.speedSampleCount, 1);
    assert.equal(customSum.byModelEffort.length, 1);
    assert.equal(customSum.byModelEffort[0].thinkingEffort, 'high');
    assert.equal(customSum.todayHourly.length, 1);
    assert.equal(customSum.customRange.isSingleDay, true);

    const customEvents = await sendBackendRpc(dir, {
      command: 'usage_events',
      period: 'custom',
      startDate: '2026-11-05',
      endDate: '2026-11-05',
    });
    assert.equal(customEvents.ok, true);
    assert.equal(customEvents.total, 1);
    assert.equal(customEvents.rows[0].thinking_effort, 'high');
    assert.equal(customEvents.rows[0].streaming_duration_seconds, 3);
    assert.equal(customEvents.rows[0].ttft_seconds, 0.25);
    assert.equal(customEvents.rows[0].output_tps, 100);

    const invalidCustom = await sendBackendRpc(dir, {
      command: 'usage_summary',
      period: 'custom',
      startDate: '2026-11-10',
      endDate: '2026-11-05',
    });
    assert.equal(invalidCustom.ok, false);
  });
});
