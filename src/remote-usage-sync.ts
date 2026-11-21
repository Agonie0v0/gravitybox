import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicJson } from './files.js';
import { sanitizeHostLabel } from './ssh-context.js';
import {
  parseConnectTimestampSeconds,
  type RemoteGenMetadataRecord,
  type RemoteRpcClientLike,
  type RemoteStepRecord,
  type RemoteTrajectorySummary,
} from './ssh-remote-rpc.js';
import { resolveDatabaseModelFullName } from './usage-types.js';

export type RemoteAccountConfidence = 'observed' | 'inferred' | 'unknown';
export type RemoteAccountType = 'consumer' | 'enterprise_vertex' | 'unknown';

export interface RemoteObservationSegment {
  startedAt: number;
  lastObservedAt: number;
  disconnectedAt?: number;
  accountKey: string;
  accountId?: string;
  email?: string;
  accountType: RemoteAccountType;
}

export interface RemoteSyncedTrajectoryRecord {
  source_id: string;
  last_modified_sec: number;
  synced_at_sec: number;
}

export interface RemoteObservationEnvironmentRecord {
  environment_id: string;
  host_label: string;
  first_observed_at: number;
  updated_at: number;
  segments: RemoteObservationSegment[];
  recent_trajectories: RemoteSyncedTrajectoryRecord[];
}

export interface RemoteAttributionResult {
  account_confidence: RemoteAccountConfidence;
  account_id?: string;
  account_email?: string;
  account_type?: RemoteAccountType;
}

export interface RemoteUsageSyncReceipt {
  source_id: string;
  environment_id: string;
  cursor_offset: number;
  step_offset: number;
  last_modified_sec: number;
  step_count: number;
  committed_at: number;
}

export interface RemoteGenerationEvent {
  event_key: string;
  source_id: string;
  source_observed_at?: number;
  generation_index: number;
  account_confidence: RemoteAccountConfidence;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens?: number;
  total_tokens: number;
  timestamp_seconds: number;
  account_id?: string;
  account_email?: string;
  account_type?: RemoteAccountType;
  environment_kind: 'ssh';
  environment_id: string;
  environment_label: string;
  trajectory_id: string;
  execution?: string;
}

export interface RemoteRpcTargetLike {
  remoteKey: string;
  hostLabel: string;
  environmentId?: string;
  origin?: string;
  rpcClient: RemoteRpcClientLike;
  email?: string;
  name?: string | null;
  accountType?: RemoteAccountType;
  matchedLocalAccountId?: string | null;
  state?: 'connected' | 'disconnected' | 'auth_expired' | 'unverified';
}

export interface RemoteUsageSyncLedgerPort {
  receipts(): Promise<Record<string, RemoteUsageSyncReceipt>>;
  save(
    events: RemoteGenerationEvent[],
    options?: {
      billingPrices?: Record<string, unknown>;
      receipts?: RemoteUsageSyncReceipt[];
    }
  ): Promise<unknown>;
}

export interface SyncRemoteSessionUsageOptions {
  target: RemoteRpcTargetLike;
  receipts?: Readonly<Record<string, RemoteUsageSyncReceipt>>;
  observationStore?: RemoteAccountObservationStore;
  resolveMatchedLocalAccountId?: (email: string) => string | null;
  nowMs?: number;
  maxTrajectories?: number;
  concurrency?: number;
  budgetMs?: number;
  force?: boolean;
  signal?: AbortSignal;
}

export interface SyncRemoteSessionUsageResult {
  ok: boolean;
  environmentId: string;
  hostLabel: string;
  authExpired: boolean;
  abortedByBudget: boolean;
  error?: string;
  trajectoriesTotal: number;
  trajectoriesChanged: number;
  trajectoriesScanned: number;
  trajectoriesFailed: number;
  events: RemoteGenerationEvent[];
  receipts: RemoteUsageSyncReceipt[];
}

export interface RemoteUsageSyncCoordinatorOptions {
  getTargets: () => RemoteRpcTargetLike[];
  ledger?: RemoteUsageSyncLedgerPort;
  observationStore?: RemoteAccountObservationStore;
  stateDir?: string;
  resolveMatchedLocalAccountId?: (email: string) => string | null;
  getBillingPrices?: () => Promise<Record<string, unknown>>;
  maxTrajectoriesPerTarget?: number;
  concurrencyPerTarget?: number;
  budgetMs?: number;
  onCommitted?: (info: { revision: number; eventsSaved: number; receiptsUpdated: number }) => void;
}

export interface RemoteSyncRoundResult {
  ok: boolean;
  revision: number;
  targetCount: number;
  eventsSaved: number;
  receiptsUpdated: number;
  authExpiredTargets: string[];
  abortedByBudget: boolean;
  errors: string[];
}

const DEFAULT_MAX_TRAJECTORIES = 20;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_BUDGET_MS = 12_000;
const MIN_VALID_UNIX_SECONDS = 946684800; // 2000-01-01T00:00:00Z

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeAccountType(raw: unknown): RemoteAccountType {
  if (raw === 'consumer' || raw === 'enterprise_vertex') return raw;
  return 'unknown';
}

function normalizeTokenInt(raw: unknown): number {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number(trimmed);
      return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
    }
  }
  return 0;
}

function normalizePositiveUnixSec(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 0;
  return Math.floor(raw);
}

function normalizeNonNegativeInt(raw: unknown): number {
  const n = typeof raw === 'string' ? Number(raw.trim()) : Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function pickNonEmptyString(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (trimmed) return trimmed;
    }
  }
  return '';
}

function isPlannerStepType(rawType: unknown): boolean {
  if (rawType === 15) return true;
  if (typeof rawType !== 'string') return false;
  const cleaned = rawType.trim().toUpperCase().replace(/^CORTEX_STEP_TYPE_/, '');
  return cleaned === 'PLANNER_RESPONSE';
}

function extractStepTimestampSeconds(step: RemoteStepRecord | undefined): number | null {
  const meta = step?.metadata;
  if (!meta) return null;
  return (
    parseConnectTimestampSeconds(meta.createdAt) ??
    parseConnectTimestampSeconds(meta.startedAt) ??
    parseConnectTimestampSeconds(meta.viewableAt) ??
    parseConnectTimestampSeconds(meta.finishedGeneratingAt) ??
    parseConnectTimestampSeconds(meta.completedAt)
  );
}

/**
 * 基于规范化主机标签生成稳定的远端环境 ID：`ssh:<12位sha256>`。
 */
export function buildRemoteEnvironmentId(hostLabel: string): string {
  const normalizedHostLabel = sanitizeHostLabel(hostLabel).toLowerCase();
  return `ssh:${sha256Hex(JSON.stringify(['ssh-env', normalizedHostLabel])).slice(0, 12)}`;
}

/**
 * 基于远端轨迹锚点生成稳定的远端 source_id（与 SSH 别名/端口/本地文件 inode 解耦）。
 */
export function buildRemoteTrajectorySourceId(trajectoryAnchor: string): string {
  return sha256Hex(JSON.stringify(['ssh', trajectoryAnchor]));
}

/**
 * 生成与可变 Token 数、模型与主机别名彻底解耦的事件主键，支持流式修订同键覆写。
 */
export function buildRemoteEventKey(remoteSourceId: string, genIdx: number, executionId?: string): string {
  return sha256Hex(JSON.stringify([remoteSourceId, genIdx, executionId || '']));
}

interface DiskSegment {
  started_at: number;
  last_observed_at: number;
  disconnected_at?: number;
  account_id?: string;
  email?: string;
  account_type: RemoteAccountType;
}

interface DiskEnvironmentEntry {
  environment_id: string;
  host_label: string;
  first_observed_at: number;
  updated_at: number;
  segments: DiskSegment[];
  recent_trajectories?: RemoteSyncedTrajectoryRecord[];
}

/**
 * SSH 远端账号观测时间线存储（持久化到 `<stateDir>/usage-remote-observations.json`）。
 * 与本机 `usage-account-observations.json` 严格隔离，按 `environment_id` 独立维护。
 */
export class RemoteAccountObservationStore {
  private readonly filePath?: string;
  private readonly maxEnvironments: number;
  private readonly maxSegmentsPerEnvironment: number;
  private readonly maxRecentTrajectoriesPerEnvironment: number;
  private loaded = false;
  private environments = new Map<string, RemoteObservationEnvironmentRecord>();
  private dirty = false;
  private writeChain: Promise<void> = Promise.resolve();
  private pendingWrite?: Promise<void>;

  constructor(options?: {
    stateDir?: string;
    filePath?: string;
    maxEnvironments?: number;
    maxSegmentsPerEnvironment?: number;
    maxRecentTrajectoriesPerEnvironment?: number;
  }) {
    this.filePath =
      options?.filePath ??
      (options?.stateDir ? join(options.stateDir, 'usage-remote-observations.json') : undefined);
    this.maxEnvironments = Math.max(1, Math.floor(options?.maxEnvironments ?? 64));
    this.maxSegmentsPerEnvironment = Math.max(2, Math.floor(options?.maxSegmentsPerEnvironment ?? 200));
    this.maxRecentTrajectoriesPerEnvironment = Math.max(
      1,
      Math.floor(options?.maxRecentTrajectoriesPerEnvironment ?? 100)
    );
  }

  get path(): string | undefined {
    return this.filePath;
  }

  async load(): Promise<void> {
    this.ensureLoaded();
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.filePath) return;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as {
        version?: number;
        environments?: Record<string, any>;
      };
      if (!raw || raw.version !== 1 || !raw.environments || typeof raw.environments !== 'object') {
        return;
      }
      for (const [envId, rawEnv] of Object.entries(raw.environments)) {
        if (!envId || !rawEnv || typeof rawEnv !== 'object') continue;
        const segments: RemoteObservationSegment[] = [];
        if (Array.isArray(rawEnv.segments)) {
          for (const item of rawEnv.segments) {
            if (!item || typeof item !== 'object') continue;
            const startedAt = normalizePositiveUnixSec(item.started_at);
            const lastObservedAt = Math.max(startedAt, normalizePositiveUnixSec(item.last_observed_at));
            if (startedAt <= 0) continue;
            const email = typeof item.email === 'string' && item.email.trim() ? item.email.trim() : undefined;
            const accountId =
              typeof item.account_id === 'string' && item.account_id.trim()
                ? item.account_id.trim()
                : undefined;
            const accountKey = email ? email.toLowerCase() : accountId;
            if (!accountKey) continue;
            // 从磁盘恢复的未闭合段属于上一进程周期，默认于其最后观测时间闭合，避免跨重启停机期被误判为持续在线观测。
            const rawDisconnected = normalizePositiveUnixSec(item.disconnected_at);
            const disconnectedAt = rawDisconnected > 0 ? Math.max(lastObservedAt, rawDisconnected) : lastObservedAt;
            segments.push({
              startedAt,
              lastObservedAt,
              disconnectedAt,
              accountKey,
              ...(accountId ? { accountId } : {}),
              ...(email ? { email } : {}),
              accountType: normalizeAccountType(item.account_type),
            });
          }
        }
        segments.sort((a, b) => a.startedAt - b.startedAt);
        const boundedSegments = segments.slice(-this.maxSegmentsPerEnvironment);
        const firstObserved = normalizePositiveUnixSec(rawEnv.first_observed_at);
        const earliestSeg = boundedSegments[0]?.startedAt ?? 0;
        const resolvedFirst =
          firstObserved > 0 && earliestSeg > 0
            ? Math.min(firstObserved, earliestSeg)
            : firstObserved || earliestSeg;
        if (resolvedFirst <= 0 && boundedSegments.length === 0) continue;
        const recentTrajectories: RemoteSyncedTrajectoryRecord[] = [];
        if (Array.isArray(rawEnv.recent_trajectories)) {
          for (const tr of rawEnv.recent_trajectories) {
            if (!tr || typeof tr !== 'object' || typeof tr.source_id !== 'string' || !tr.source_id) continue;
            recentTrajectories.push({
              source_id: tr.source_id,
              last_modified_sec:
                typeof tr.last_modified_sec === 'number' && Number.isFinite(tr.last_modified_sec) && tr.last_modified_sec >= 0
                  ? tr.last_modified_sec
                  : 0,
              synced_at_sec: normalizePositiveUnixSec(tr.synced_at_sec),
            });
          }
        }
        const updatedAt = Math.max(
          normalizePositiveUnixSec(rawEnv.updated_at),
          boundedSegments.at(-1)?.disconnectedAt ?? boundedSegments.at(-1)?.lastObservedAt ?? resolvedFirst
        );
        this.environments.set(envId, {
          environment_id: envId,
          host_label: sanitizeHostLabel(rawEnv.host_label) || 'ssh-host',
          first_observed_at: resolvedFirst,
          updated_at: updatedAt,
          segments: boundedSegments,
          recent_trajectories: recentTrajectories.slice(-this.maxRecentTrajectoriesPerEnvironment),
        });
      }
      this.pruneEnvironments();
    } catch {
      // 忽略首次不存在或损坏的历史文件，保持安全空状态
    }
  }

  private pruneEnvironments(): void {
    if (this.environments.size <= this.maxEnvironments) return;
    const sorted = [...this.environments.entries()].sort((a, b) => b[1].updated_at - a[1].updated_at);
    this.environments = new Map(sorted.slice(0, this.maxEnvironments));
  }

  private serializeForDisk(): { version: 1; environments: Record<string, DiskEnvironmentEntry> } {
    const sortedIds = [...this.environments.keys()].sort();
    const environments: Record<string, DiskEnvironmentEntry> = Object.create(null);
    for (const envId of sortedIds) {
      const rec = this.environments.get(envId);
      if (!rec) continue;
      environments[envId] = {
        environment_id: rec.environment_id,
        host_label: sanitizeHostLabel(rec.host_label) || 'ssh-host',
        first_observed_at: rec.first_observed_at,
        updated_at: rec.updated_at,
        segments: rec.segments.slice(-this.maxSegmentsPerEnvironment).map(seg => ({
          started_at: seg.startedAt,
          last_observed_at: seg.lastObservedAt,
          ...(seg.disconnectedAt !== undefined ? { disconnected_at: seg.disconnectedAt } : {}),
          ...(seg.accountId ? { account_id: seg.accountId } : {}),
          ...(seg.email ? { email: seg.email } : {}),
          account_type: seg.accountType,
        })),
        ...(rec.recent_trajectories.length > 0
          ? {
              recent_trajectories: rec.recent_trajectories
                .slice(-this.maxRecentTrajectoriesPerEnvironment)
                .map(t => ({
                  source_id: t.source_id,
                  last_modified_sec: t.last_modified_sec,
                  synced_at_sec: t.synced_at_sec,
                })),
            }
          : {}),
      };
    }
    return { version: 1, environments };
  }

  private scheduleSave(): void {
    if (!this.filePath) return;
    this.dirty = true;
    if (this.pendingWrite) return;
    const writeTask = this.writeChain
      .catch(() => {})
      .then(async () => {
        while (this.dirty && this.filePath) {
          this.dirty = false;
          const payload = this.serializeForDisk();
          await atomicJson(this.filePath, payload, undefined, { durability: 'relaxed' });
        }
      })
      .catch(() => {})
      .finally(() => {
        if (this.pendingWrite === writeTask) {
          this.pendingWrite = undefined;
        }
      });
    this.pendingWrite = writeTask;
    this.writeChain = writeTask;
  }

  async flush(): Promise<void> {
    if (!this.filePath) return;
    if (this.dirty && !this.pendingWrite) {
      this.scheduleSave();
    }
    await this.writeChain;
  }

  recordObservation(params: {
    environmentId: string;
    hostLabel?: string;
    email?: string;
    matchedLocalAccountId?: string | null;
    accountType?: RemoteAccountType;
    observedAtSec?: number;
  }): void {
    this.ensureLoaded();
    const envId = typeof params.environmentId === 'string' ? params.environmentId.trim() : '';
    if (!envId) return;

    const email = typeof params.email === 'string' ? params.email.trim() : '';
    const accountId =
      typeof params.matchedLocalAccountId === 'string' && params.matchedLocalAccountId.trim()
        ? params.matchedLocalAccountId.trim()
        : undefined;
    const accountKey = email ? email.toLowerCase() : accountId;
    if (!accountKey) return;

    const nowSec = normalizePositiveUnixSec(params.observedAtSec ?? Math.floor(Date.now() / 1000));
    if (nowSec <= 0) return;

    const accountType = normalizeAccountType(params.accountType);
    const cleanHost = sanitizeHostLabel(params.hostLabel);

    let rec = this.environments.get(envId);
    if (!rec) {
      rec = {
        environment_id: envId,
        host_label: cleanHost || 'ssh-host',
        first_observed_at: nowSec,
        updated_at: nowSec,
        segments: [],
        recent_trajectories: [],
      };
      this.environments.set(envId, rec);
    } else {
      if (cleanHost) rec.host_label = cleanHost;
      rec.first_observed_at = Math.min(rec.first_observed_at, nowSec);
      rec.updated_at = Math.max(rec.updated_at, nowSec);
    }

    const last = rec.segments.at(-1);
    if (last && last.disconnectedAt === undefined) {
      if (last.accountKey === accountKey) {
        if (nowSec >= last.startedAt) {
          last.lastObservedAt = Math.max(last.lastObservedAt, nowSec);
        } else {
          last.startedAt = nowSec;
        }
        if (accountId && !last.accountId) last.accountId = accountId;
        if (email && !last.email) last.email = email;
        if (accountType !== 'unknown' && last.accountType === 'unknown') {
          last.accountType = accountType;
        }
      } else {
        // 连接期检测到账号变化时立即截断上一段观测窗口，避免跨切号窗口继续向后延展。
        last.disconnectedAt = last.lastObservedAt;
        rec.segments.push({
          startedAt: nowSec,
          lastObservedAt: nowSec,
          accountKey,
          ...(accountId ? { accountId } : {}),
          ...(email ? { email } : {}),
          accountType,
        });
      }
    } else {
      rec.segments.push({
        startedAt: nowSec,
        lastObservedAt: nowSec,
        accountKey,
        ...(accountId ? { accountId } : {}),
        ...(email ? { email } : {}),
        accountType,
      });
    }

    rec.segments.sort((a, b) => a.startedAt - b.startedAt);
    if (rec.segments.length > this.maxSegmentsPerEnvironment) {
      rec.segments = rec.segments.slice(-this.maxSegmentsPerEnvironment);
    }
    this.pruneEnvironments();
    this.scheduleSave();
  }

  markDisconnected(environmentId: string, disconnectedAtSec?: number): void {
    this.ensureLoaded();
    const envId = typeof environmentId === 'string' ? environmentId.trim() : '';
    if (!envId) return;
    const rec = this.environments.get(envId);
    const last = rec?.segments.at(-1);
    if (!rec || !last || last.disconnectedAt !== undefined) return;
    const rawSec = normalizePositiveUnixSec(disconnectedAtSec ?? Math.floor(Date.now() / 1000));
    const endSec = rawSec > 0 ? Math.max(last.lastObservedAt, rawSec) : last.lastObservedAt;
    last.disconnectedAt = endSec;
    last.lastObservedAt = endSec;
    rec.updated_at = Math.max(rec.updated_at, endSec);
    this.scheduleSave();
  }

  recordSyncedTrajectories(
    environmentId: string,
    hostLabel: string,
    entries: readonly RemoteSyncedTrajectoryRecord[]
  ): void {
    this.ensureLoaded();
    const envId = typeof environmentId === 'string' ? environmentId.trim() : '';
    if (!envId || entries.length === 0) return;
    let rec = this.environments.get(envId);
    const cleanHost = sanitizeHostLabel(hostLabel);
    if (!rec) {
      const minSynced = entries.reduce(
        (min, item) => (item.synced_at_sec > 0 && item.synced_at_sec < min ? item.synced_at_sec : min),
        Number.POSITIVE_INFINITY
      );
      const fallbackNow = Number.isFinite(minSynced) ? minSynced : Math.floor(Date.now() / 1000);
      rec = {
        environment_id: envId,
        host_label: cleanHost || 'ssh-host',
        first_observed_at: fallbackNow,
        updated_at: fallbackNow,
        segments: [],
        recent_trajectories: [],
      };
      this.environments.set(envId, rec);
    } else if (cleanHost) {
      rec.host_label = cleanHost;
    }

    const bySource = new Map(rec.recent_trajectories.map(item => [item.source_id, item]));
    for (const entry of entries) {
      if (!entry.source_id) continue;
      const syncedSec = normalizePositiveUnixSec(entry.synced_at_sec);
      const lastMod =
        typeof entry.last_modified_sec === 'number' && Number.isFinite(entry.last_modified_sec) && entry.last_modified_sec >= 0
          ? entry.last_modified_sec
          : 0;
      bySource.set(entry.source_id, {
        source_id: entry.source_id,
        last_modified_sec: lastMod,
        synced_at_sec: syncedSec,
      });
      if (syncedSec > 0) rec.updated_at = Math.max(rec.updated_at, syncedSec);
    }
    rec.recent_trajectories = [...bySource.values()]
      .sort((a, b) => b.synced_at_sec - a.synced_at_sec)
      .slice(0, this.maxRecentTrajectoriesPerEnvironment);
    this.pruneEnvironments();
    this.scheduleSave();
  }

  getEnvironmentRecord(environmentId: string): RemoteObservationEnvironmentRecord | undefined {
    this.ensureLoaded();
    const rec = this.environments.get(environmentId);
    if (!rec) return undefined;
    return {
      ...rec,
      segments: rec.segments.map(seg => ({ ...seg })),
      recent_trajectories: rec.recent_trajectories.map(item => ({ ...item })),
    };
  }

  /**
   * 依据对应 `environment_id` 的独立观测时间线判定事件账号归属与置信度：
   * - `observed`: 落在窗口活跃连接观测期内；
   * - `inferred`: 落在断线空窗期内，且断线前与重连后为同一账号（无切号冲突）；
   * - `unknown`: 早于首次观测时间线、空窗期未重连闭环或前后账号冲突不可判定。
   */
  resolveAttribution(environmentId: string, timestampSec: number): RemoteAttributionResult {
    this.ensureLoaded();
    if (!Number.isFinite(timestampSec) || timestampSec <= 0) {
      return { account_confidence: 'unknown' };
    }
    const rec = this.environments.get(environmentId);
    if (!rec || rec.segments.length === 0 || timestampSec < rec.first_observed_at) {
      return { account_confidence: 'unknown' };
    }

    const segments = rec.segments;
    if (timestampSec < segments[0]!.startedAt) {
      return { account_confidence: 'unknown' };
    }

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      const segEnd = seg.disconnectedAt ?? Number.POSITIVE_INFINITY;
      if (timestampSec >= seg.startedAt && timestampSec <= segEnd) {
        return {
          account_confidence: 'observed',
          ...(seg.accountId ? { account_id: seg.accountId } : {}),
          ...(seg.email ? { account_email: seg.email } : {}),
          account_type: seg.accountType,
        };
      }
      const next = segments[i + 1];
      if (next && timestampSec > segEnd && timestampSec < next.startedAt) {
        if (seg.accountKey === next.accountKey) {
          const accountId = next.accountId ?? seg.accountId;
          const accountEmail = next.email ?? seg.email;
          const accountType = next.accountType !== 'unknown' ? next.accountType : seg.accountType;
          return {
            account_confidence: 'inferred',
            ...(accountId ? { account_id: accountId } : {}),
            ...(accountEmail ? { account_email: accountEmail } : {}),
            account_type: accountType,
          };
        }
        return { account_confidence: 'unknown' };
      }
    }

    return { account_confidence: 'unknown' };
  }
}

function resolveEventModelName(
  rec: RemoteGenMetadataRecord,
  linkedStep: RemoteStepRecord | undefined,
  summary: RemoteTrajectorySummary
): string {
  const rawId = pickNonEmptyString(
    rec.responseModel,
    typeof rec.model === 'string' ? rec.model : undefined,
    typeof rec.usage?.model === 'string' ? rec.usage.model : undefined,
    rec.plannerModel?.modelName,
    linkedStep?.metadata?.generatorModel,
    linkedStep?.metadata?.requestedModel,
    summary.requestedModel
  );
  const rawLabel = pickNonEmptyString(rec.modelDisplayName);
  const modelEnum =
    (typeof rec.model === 'number' && rec.model > 0 ? rec.model : undefined) ??
    (typeof rec.usage?.model === 'number' && rec.usage.model > 0 ? rec.usage.model : undefined);

  return resolveDatabaseModelFullName(rawId || undefined, rawLabel || undefined, modelEnum, {
    canonicalUnknown: true,
  });
}

function resolveLinkedStep(
  rec: RemoteGenMetadataRecord,
  stepsByIdx: Map<number, RemoteStepRecord>,
  stepsByExecId: Map<string, RemoteStepRecord>
): RemoteStepRecord | undefined {
  if (Array.isArray(rec.stepIndices) && rec.stepIndices.length > 0) {
    let fallback: RemoteStepRecord | undefined;
    for (const idx of rec.stepIndices) {
      const candidate = stepsByIdx.get(idx);
      if (!candidate) continue;
      if (isPlannerStepType(candidate.type) && extractStepTimestampSeconds(candidate) !== null) {
        return candidate;
      }
      if (!fallback) fallback = candidate;
    }
    if (fallback) return fallback;
  }
  if (typeof rec.executionId === 'string' && rec.executionId.trim()) {
    return stepsByExecId.get(rec.executionId.trim());
  }
  return undefined;
}

function isAuthExpiredResult(res: { ok: boolean; reason?: string; authExpired?: boolean }): boolean {
  return !res.ok && (res.authExpired === true || res.reason === 'auth_expired');
}

function shouldSyncTrajectory(
  prevReceipt: RemoteUsageSyncReceipt | undefined,
  lastModifiedSec: number,
  stepCount: number,
  force: boolean
): boolean {
  if (force || !prevReceipt) return true;
  if (lastModifiedSec > 0 && lastModifiedSec > prevReceipt.last_modified_sec) return true;
  if (lastModifiedSec > 0 && prevReceipt.last_modified_sec === 0) return true;
  if (stepCount !== prevReceipt.step_count) return true;
  return false;
}

/**
 * 对单个已连接的 SSH 远端页面会话执行纯同源 CDP RPC 增量用量采集（不依赖外部 ssh 二进制）。
 */
export async function syncRemoteSessionUsage(
  options: SyncRemoteSessionUsageOptions
): Promise<SyncRemoteSessionUsageResult> {
  const { target, receipts = {}, observationStore } = options;
  const hostLabel = sanitizeHostLabel(target.hostLabel) || 'ssh-host';
  const environmentId = target.environmentId || buildRemoteEnvironmentId(hostLabel);
  const nowMs = options.nowMs ?? Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const maxTrajectories = Math.max(1, Math.min(100, Math.floor(options.maxTrajectories ?? DEFAULT_MAX_TRAJECTORIES)));
  const concurrency = Math.max(1, Math.min(8, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY)));
  const budgetMs = Math.max(50, Math.floor(options.budgetMs ?? DEFAULT_BUDGET_MS));
  const force = options.force === true;

  const emptyFailure = (authExpired: boolean, abortedByBudget: boolean, error?: string): SyncRemoteSessionUsageResult => ({
    ok: false,
    environmentId,
    hostLabel,
    authExpired,
    abortedByBudget,
    ...(error ? { error } : {}),
    trajectoriesTotal: 0,
    trajectoriesChanged: 0,
    trajectoriesScanned: 0,
    trajectoriesFailed: 0,
    events: [],
    receipts: [],
  });

  if (options.signal?.aborted) {
    return emptyFailure(false, true, 'aborted');
  }
  if (target.state === 'auth_expired' && !force) {
    return emptyFailure(true, false, 'auth_expired');
  }

  let effectiveEmail = typeof target.email === 'string' ? target.email.trim() : '';
  let effectiveAccountType = normalizeAccountType(target.accountType);
  let effectiveLocalAccountId = target.matchedLocalAccountId ?? null;

  if (!effectiveEmail && observationStore) {
    const probeRes = await target.rpcClient.probeUserAndQuota();
    if (isAuthExpiredResult(probeRes)) {
      return emptyFailure(true, false, 'auth_expired');
    }
    if (probeRes.ok) {
      effectiveEmail = probeRes.data.email.trim();
      effectiveAccountType = normalizeAccountType(probeRes.data.accountType);
      if (!effectiveLocalAccountId && effectiveEmail && options.resolveMatchedLocalAccountId) {
        effectiveLocalAccountId = options.resolveMatchedLocalAccountId(effectiveEmail);
      }
    }
  } else if (effectiveEmail && !effectiveLocalAccountId && options.resolveMatchedLocalAccountId) {
    effectiveLocalAccountId = options.resolveMatchedLocalAccountId(effectiveEmail);
  }

  const trajectoriesRes = await target.rpcClient.getAllCascadeTrajectories();
  if (!trajectoriesRes.ok) {
    return emptyFailure(
      isAuthExpiredResult(trajectoriesRes),
      false,
      trajectoriesRes.reason || trajectoriesRes.error || 'rpc_error'
    );
  }

  if (observationStore && (effectiveEmail || effectiveLocalAccountId)) {
    observationStore.recordObservation({
      environmentId,
      hostLabel,
      email: effectiveEmail || undefined,
      matchedLocalAccountId: effectiveLocalAccountId,
      accountType: effectiveAccountType,
      observedAtSec: nowSec,
    });
  }

  const summaries = Array.isArray(trajectoriesRes.data) ? trajectoriesRes.data : [];
  const changed = summaries
    .map(summary => {
      const trajectoryId = typeof summary.trajectoryId === 'string' ? summary.trajectoryId.trim() : '';
      const trajectoryAnchor = trajectoryId || `${environmentId}:${summary.cascadeId}`;
      const remoteSourceId = buildRemoteTrajectorySourceId(trajectoryAnchor);
      const prevReceipt = receipts[remoteSourceId];
      const lastModifiedSec = parseConnectTimestampSeconds(summary.lastModifiedTime) ?? 0;
      const stepCount = normalizeNonNegativeInt(summary.stepCount);
      return { summary, trajectoryId, remoteSourceId, prevReceipt, lastModifiedSec, stepCount };
    })
    .filter(item => shouldSyncTrajectory(item.prevReceipt, item.lastModifiedSec, item.stepCount, force));

  changed.sort(
    (a, b) =>
      b.lastModifiedSec - a.lastModifiedSec ||
      b.stepCount - a.stepCount ||
      a.summary.cascadeId.localeCompare(b.summary.cascadeId)
  );

  const selected = changed.slice(0, maxTrajectories);
  if (selected.length === 0) {
    return {
      ok: true,
      environmentId,
      hostLabel,
      authExpired: false,
      abortedByBudget: false,
      trajectoriesTotal: summaries.length,
      trajectoriesChanged: changed.length,
      trajectoriesScanned: 0,
      trajectoriesFailed: 0,
      events: [],
      receipts: [],
    };
  }

  const events: RemoteGenerationEvent[] = [];
  const nextReceipts: RemoteUsageSyncReceipt[] = [];
  let trajectoriesScanned = 0;
  let trajectoriesFailed = 0;
  let authExpired = false;
  let abortedByBudget = false;
  let firstError: string | undefined;
  let finalized = false;

  const deadlineAt = Date.now() + budgetMs;
  let cursor = 0;
  const maxValidTs = Math.floor(nowMs / 1000) + 86400;

  const processOne = async (item: (typeof selected)[number]): Promise<void> => {
    const { summary, trajectoryId, remoteSourceId, prevReceipt, lastModifiedSec, stepCount } = item;
    const prevCursor = prevReceipt?.cursor_offset ?? 0;
    const prevStepOffset = prevReceipt?.step_offset ?? 0;
    const genFetchOffset = Math.max(0, prevCursor - 1);

    const genRes = await target.rpcClient.getGeneratorMetadata(summary.cascadeId, genFetchOffset);
    if (finalized || abortedByBudget || options.signal?.aborted) return;
    if (!genRes.ok) {
      if (isAuthExpiredResult(genRes)) {
        authExpired = true;
        firstError = firstError ?? 'auth_expired';
      } else {
        trajectoriesFailed++;
        firstError = firstError ?? genRes.reason;
      }
      return;
    }

    const genRecords = Array.isArray(genRes.data) ? genRes.data : [];
    let steps: RemoteStepRecord[] = [];
    let minReferencedStepIdx: number | undefined;
    for (const rec of genRecords) {
      if (!Array.isArray(rec.stepIndices)) continue;
      for (const sIdx of rec.stepIndices) {
        if (Number.isSafeInteger(sIdx) && sIdx >= 0) {
          minReferencedStepIdx = minReferencedStepIdx === undefined ? sIdx : Math.min(minReferencedStepIdx, sIdx);
        }
      }
    }

    const stepFetchOffset =
      minReferencedStepIdx !== undefined && minReferencedStepIdx < prevStepOffset
        ? Math.max(0, minReferencedStepIdx)
        : Math.max(0, prevStepOffset - 1);

    if (genRecords.length > 0) {
      if (authExpired || abortedByBudget || options.signal?.aborted || Date.now() >= deadlineAt) {
        if (Date.now() >= deadlineAt) abortedByBudget = true;
        return;
      }
      const stepsRes = await target.rpcClient.getTrajectorySteps(summary.cascadeId, stepFetchOffset);
      if (finalized || abortedByBudget || options.signal?.aborted) return;
      if (!stepsRes.ok) {
        if (isAuthExpiredResult(stepsRes)) {
          authExpired = true;
          firstError = firstError ?? 'auth_expired';
        } else {
          trajectoriesFailed++;
          firstError = firstError ?? stepsRes.reason;
        }
        return;
      }
      steps = Array.isArray(stepsRes.data) ? stepsRes.data : [];
    }

    const stepsByIdx = new Map<number, RemoteStepRecord>();
    const stepsByExecId = new Map<string, RemoteStepRecord>();
    let maxFetchedStepOffset = stepFetchOffset;
    for (const step of steps) {
      if (Number.isSafeInteger(step.idx) && step.idx >= 0) {
        stepsByIdx.set(step.idx, step);
        if (step.idx + 1 > maxFetchedStepOffset) maxFetchedStepOffset = step.idx + 1;
      }
      const execId = typeof step.metadata?.executionId === 'string' ? step.metadata.executionId.trim() : '';
      if (execId) {
        const existing = stepsByExecId.get(execId);
        if (!existing || (!isPlannerStepType(existing.type) && isPlannerStepType(step.type))) {
          stepsByExecId.set(execId, step);
        }
      }
    }

    const localEvents: RemoteGenerationEvent[] = [];
    for (let i = 0; i < genRecords.length; i++) {
      const rec = genRecords[i]!;
      if (!rec.usage) continue;
      const inputTokens = normalizeTokenInt(rec.usage.inputTokens ?? rec.usage.rawInputTokens);
      const outputTokens = normalizeTokenInt(rec.usage.outputTokens);
      const cachedTokens = normalizeTokenInt(rec.usage.cacheReadTokens ?? rec.usage.cachedReadTokens);
      const cacheWriteTokens = normalizeTokenInt(
        rec.usage.cacheCreationInputTokens ?? rec.usage.cacheWriteTokens
      );
      const totalTokens = inputTokens + cachedTokens + cacheWriteTokens + outputTokens;
      if (!Number.isSafeInteger(totalTokens) || totalTokens <= 0) continue;

      const genIdx = genFetchOffset + i;
      const linkedStep = resolveLinkedStep(rec, stepsByIdx, stepsByExecId);
      const rawTs = extractStepTimestampSeconds(linkedStep) ?? (lastModifiedSec > 0 ? lastModifiedSec : null);
      let tsSec = rawTs !== null && Number.isFinite(rawTs) ? Math.floor(rawTs) : 0;
      if (tsSec < MIN_VALID_UNIX_SECONDS || tsSec > maxValidTs) {
        tsSec = 0;
      }

      const executionId =
        typeof rec.executionId === 'string' && rec.executionId.trim() ? rec.executionId.trim() : undefined;
      const model = resolveEventModelName(rec, linkedStep, summary);
      const eventKey = buildRemoteEventKey(remoteSourceId, genIdx, executionId);

      let attribution: RemoteAttributionResult;
      if (observationStore) {
        attribution = observationStore.resolveAttribution(environmentId, tsSec);
      } else if (effectiveEmail || effectiveLocalAccountId) {
        attribution = {
          account_confidence: 'observed',
          ...(effectiveLocalAccountId ? { account_id: effectiveLocalAccountId } : {}),
          ...(effectiveEmail ? { account_email: effectiveEmail } : {}),
          account_type: effectiveAccountType,
        };
      } else {
        attribution = { account_confidence: 'unknown' };
      }

      localEvents.push({
        event_key: eventKey,
        source_id: remoteSourceId,
        source_observed_at: nowMs,
        generation_index: genIdx,
        account_confidence: attribution.account_confidence,
        model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cached_tokens: cachedTokens,
        ...(cacheWriteTokens > 0 ? { cache_write_tokens: cacheWriteTokens } : {}),
        total_tokens: totalTokens,
        timestamp_seconds: tsSec,
        ...(attribution.account_id ? { account_id: attribution.account_id } : {}),
        ...(attribution.account_email ? { account_email: attribution.account_email } : {}),
        ...(attribution.account_type ? { account_type: attribution.account_type } : {}),
        environment_kind: 'ssh',
        environment_id: environmentId,
        environment_label: hostLabel,
        trajectory_id: trajectoryId || summary.cascadeId,
        ...(executionId ? { execution: executionId } : {}),
      });
    }

    if (finalized || abortedByBudget || options.signal?.aborted) return;

    const nextCursorOffset = Math.max(prevCursor, genFetchOffset + genRecords.length);
    const nextStepOffset = Math.max(prevStepOffset, stepCount, maxFetchedStepOffset);
    const nextReceipt: RemoteUsageSyncReceipt = {
      source_id: remoteSourceId,
      environment_id: environmentId,
      cursor_offset: nextCursorOffset,
      step_offset: nextStepOffset,
      last_modified_sec: Math.max(prevReceipt?.last_modified_sec ?? 0, lastModifiedSec),
      step_count: Math.max(prevReceipt?.step_count ?? 0, stepCount),
      committed_at: nowSec,
    };

    events.push(...localEvents);
    nextReceipts.push(nextReceipt);
    trajectoriesScanned++;
  };

  const runWorkers = async (): Promise<void> => {
    const workerCount = Math.min(concurrency, selected.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (cursor < selected.length) {
          if (authExpired || abortedByBudget || finalized) return;
          if (options.signal?.aborted || Date.now() >= deadlineAt) {
            abortedByBudget = true;
            return;
          }
          const item = selected[cursor++]!;
          await processOne(item);
        }
      })
    );
  };

  let budgetTimer: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;
  try {
    const remainingMs = Math.max(1, deadlineAt - Date.now());
    await Promise.race([
      runWorkers(),
      new Promise<void>(resolve => {
        budgetTimer = setTimeout(() => {
          abortedByBudget = true;
          resolve();
        }, remainingMs);
        if (options.signal) {
          abortListener = () => {
            abortedByBudget = true;
            resolve();
          };
          if (options.signal.aborted) {
            abortedByBudget = true;
            resolve();
          } else {
            options.signal.addEventListener('abort', abortListener, { once: true });
          }
        }
      }),
    ]);
  } finally {
    finalized = true;
    if (budgetTimer) clearTimeout(budgetTimer);
    if (options.signal && abortListener) {
      options.signal.removeEventListener('abort', abortListener);
    }
  }

  if (observationStore && nextReceipts.length > 0) {
    observationStore.recordSyncedTrajectories(
      environmentId,
      hostLabel,
      nextReceipts.map(r => ({
        source_id: r.source_id,
        last_modified_sec: r.last_modified_sec,
        synced_at_sec: r.committed_at,
      }))
    );
  }

  return {
    ok: !authExpired && !abortedByBudget && trajectoriesFailed === 0,
    environmentId,
    hostLabel,
    authExpired,
    abortedByBudget,
    ...(firstError ? { error: firstError } : {}),
    trajectoriesTotal: summaries.length,
    trajectoriesChanged: changed.length,
    trajectoriesScanned,
    trajectoriesFailed,
    events,
    receipts: nextReceipts,
  };
}

/**
 * 远端用量采集协调器：单轮单飞互斥（in-flight 去重），不阻塞调用方，按目标聚合入账并推进同步修订号。
 */
export class RemoteUsageSyncCoordinator {
  private readonly getTargets: () => RemoteRpcTargetLike[];
  private readonly ledger?: RemoteUsageSyncLedgerPort;
  readonly observationStore: RemoteAccountObservationStore;
  private readonly resolveMatchedLocalAccountId?: (email: string) => string | null;
  private readonly getBillingPrices?: () => Promise<Record<string, unknown>>;
  private readonly maxTrajectoriesPerTarget: number;
  private readonly concurrencyPerTarget: number;
  private readonly budgetMs: number;
  private readonly onCommitted?: (info: { revision: number; eventsSaved: number; receiptsUpdated: number }) => void;
  private inFlight?: Promise<RemoteSyncRoundResult>;
  private revision = 0;

  constructor(options: RemoteUsageSyncCoordinatorOptions) {
    this.getTargets = options.getTargets;
    this.ledger = options.ledger;
    this.observationStore =
      options.observationStore ?? new RemoteAccountObservationStore({ stateDir: options.stateDir });
    this.resolveMatchedLocalAccountId = options.resolveMatchedLocalAccountId;
    this.getBillingPrices = options.getBillingPrices;
    this.maxTrajectoriesPerTarget = options.maxTrajectoriesPerTarget ?? DEFAULT_MAX_TRAJECTORIES;
    this.concurrencyPerTarget = options.concurrencyPerTarget ?? DEFAULT_CONCURRENCY;
    this.budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
    this.onCommitted = options.onCommitted;
  }

  isSyncing(): boolean {
    return Boolean(this.inFlight);
  }

  getRevision(): number {
    return this.revision;
  }

  recordObservation(params: {
    hostLabel: string;
    environmentId?: string;
    email?: string;
    matchedLocalAccountId?: string | null;
    accountType?: RemoteAccountType;
    observedAtSec?: number;
  }): void {
    const cleanHost = sanitizeHostLabel(params.hostLabel) || 'ssh-host';
    const envId = params.environmentId || buildRemoteEnvironmentId(cleanHost);
    this.observationStore.recordObservation({
      environmentId: envId,
      hostLabel: cleanHost,
      email: params.email,
      matchedLocalAccountId: params.matchedLocalAccountId,
      accountType: params.accountType,
      observedAtSec: params.observedAtSec,
    });
  }

  markEnvironmentDisconnected(hostLabelOrEnvId: string, disconnectedAtSec?: number): void {
    const envId = hostLabelOrEnvId.startsWith('ssh:')
      ? hostLabelOrEnvId
      : buildRemoteEnvironmentId(hostLabelOrEnvId);
    this.observationStore.markDisconnected(envId, disconnectedAtSec);
  }

  /**
   * 触发后台非阻塞同步；若已有轮次在途则直接复用，不重复拉起。
   */
  triggerSync(options?: { force?: boolean; nowMs?: number; signal?: AbortSignal }): boolean {
    if (this.inFlight) return false;
    void this.syncNow(options).catch(() => {});
    return true;
  }

  /**
   * 执行单轮同步；并发调用共享同一 in-flight Promise，避免同一轮重复拉取远端 RPC。
   */
  syncNow(options?: { force?: boolean; nowMs?: number; signal?: AbortSignal }): Promise<RemoteSyncRoundResult> {
    if (this.inFlight) return this.inFlight;
    const task = this.runRound(options).finally(() => {
      if (this.inFlight === task) {
        this.inFlight = undefined;
      }
    });
    this.inFlight = task;
    return task;
  }

  private async runRound(options?: {
    force?: boolean;
    nowMs?: number;
    signal?: AbortSignal;
  }): Promise<RemoteSyncRoundResult> {
    const targets = this.getTargets();
    if (targets.length === 0) {
      return {
        ok: true,
        revision: this.revision,
        targetCount: 0,
        eventsSaved: 0,
        receiptsUpdated: 0,
        authExpiredTargets: [],
        abortedByBudget: false,
        errors: [],
      };
    }

    const roundStartedAt = Date.now();
    const existingReceipts = this.ledger ? await this.ledger.receipts() : {};
    const allEvents: RemoteGenerationEvent[] = [];
    const allReceipts: RemoteUsageSyncReceipt[] = [];
    const authExpiredTargets: string[] = [];
    const errors: string[] = [];
    let abortedByBudget = false;

    for (const target of targets) {
      const elapsed = Date.now() - roundStartedAt;
      const remainingBudget = this.budgetMs - elapsed;
      if (remainingBudget <= 0 || options?.signal?.aborted) {
        abortedByBudget = true;
        break;
      }

      const res = await syncRemoteSessionUsage({
        target,
        receipts: existingReceipts,
        observationStore: this.observationStore,
        resolveMatchedLocalAccountId: this.resolveMatchedLocalAccountId,
        nowMs: options?.nowMs,
        maxTrajectories: this.maxTrajectoriesPerTarget,
        concurrency: this.concurrencyPerTarget,
        budgetMs: remainingBudget,
        force: options?.force,
        signal: options?.signal,
      });

      if (res.authExpired) {
        authExpiredTargets.push(res.environmentId);
      }
      if (res.abortedByBudget) {
        abortedByBudget = true;
      }
      if (res.error && !res.authExpired) {
        errors.push(`${res.hostLabel}: ${res.error}`);
      }
      if (res.events.length > 0) {
        allEvents.push(...res.events);
      }
      if (res.receipts.length > 0) {
        for (const receipt of res.receipts) {
          existingReceipts[receipt.source_id] = receipt;
          allReceipts.push(receipt);
        }
      }
    }

    if (this.ledger && (allEvents.length > 0 || allReceipts.length > 0)) {
      const billingPrices = this.getBillingPrices ? await this.getBillingPrices() : undefined;
      await this.ledger.save(allEvents, {
        ...(billingPrices ? { billingPrices } : {}),
        ...(allReceipts.length > 0 ? { receipts: allReceipts } : {}),
      });
    }

    await this.observationStore.flush();

    if (allEvents.length > 0 || allReceipts.length > 0) {
      this.revision++;
      this.onCommitted?.({
        revision: this.revision,
        eventsSaved: allEvents.length,
        receiptsUpdated: allReceipts.length,
      });
    }

    return {
      ok: authExpiredTargets.length === 0 && !abortedByBudget && errors.length === 0,
      revision: this.revision,
      targetCount: targets.length,
      eventsSaved: allEvents.length,
      receiptsUpdated: allReceipts.length,
      authExpiredTargets,
      abortedByBudget,
      errors,
    };
  }
}
