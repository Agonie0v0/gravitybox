import type { EnvironmentNode } from './types';

export type SshHostState = 'online' | 'auth_expired' | 'offline_recent' | 'historical_only';

export interface NormalizedSshEnv {
  id: string;
  hostLabel: string;
  state: SshHostState;
  windowCount: number;
  email: string;
  name: string;
  tier: string;
  matchedLocalAccountId?: string;
  lastError: string;
  quotaLastUpdated: number;
  lastUsageSyncedAt: number;
  focused: boolean;
  raw: EnvironmentNode;
}

export function normalizeSshState(env: EnvironmentNode): SshHostState {
  const raw = String(env.lifecycleState ?? env.state ?? '')
    .trim()
    .toLowerCase();
  if (raw === 'auth_expired') return 'auth_expired';
  if (raw === 'historical_only') return 'historical_only';
  if (raw === 'disconnected' || raw === 'offline_recent' || raw === 'offline') return 'offline_recent';
  if (raw === 'online' || raw === 'connected') return 'online';
  if (env.online === false) return 'offline_recent';
  return 'online';
}

export function cleanSshHostLabel(raw: string | undefined, fallback: string): string {
  const cleaned = String(raw ?? '')
    .trim()
    .replace(/^ssh:\s*/i, '')
    .replace(/^host:\s*/i, '')
    .trim();
  return cleaned || fallback;
}

export function normalizeSshEnvironment(env: EnvironmentNode, remoteFallback: string): NormalizedSshEnv {
  const id = String(env.environmentId ?? env.id ?? env.remoteKey ?? '').trim();
  const hostLabel = cleanSshHostLabel(env.hostLabel ?? env.host_label ?? env.label ?? id, remoteFallback);
  const state = normalizeSshState(env);
  const rawQuotaTs = Number(env.quotaLastUpdated ?? env.observedAt ?? 0);
  const quotaLastUpdated = rawQuotaTs > 0 && rawQuotaTs < 10_000_000_000 ? rawQuotaTs * 1000 : rawQuotaTs;
  const rawSyncTs = Number(env.lastUsageSyncedAt ?? 0);
  const lastUsageSyncedAt = rawSyncTs > 0 && rawSyncTs < 10_000_000_000 ? rawSyncTs * 1000 : rawSyncTs;

  return {
    id,
    hostLabel,
    state,
    windowCount: Number(env.windowCount ?? 0) || 0,
    email: String(env.email ?? '').trim(),
    name: String(env.name ?? '').trim(),
    tier: String(env.tier ?? '').trim(),
    matchedLocalAccountId: env.matchedLocalAccountId || undefined,
    lastError: String(env.lastError ?? '').trim(),
    quotaLastUpdated,
    lastUsageSyncedAt,
    focused: env.focused === true,
    raw: env,
  };
}

export function sshStateSortOrder(state: SshHostState): number {
  switch (state) {
    case 'online':
      return 3;
    case 'auth_expired':
      return 2;
    case 'offline_recent':
      return 1;
    case 'historical_only':
      return 0;
  }
}

export function sshStatePillClass(state: SshHostState): string {
  switch (state) {
    case 'online':
      return 'gb-pill-success';
    case 'auth_expired':
      return 'gb-pill-warning';
    case 'offline_recent':
    case 'historical_only':
      return 'gb-pill-neutral';
  }
}

export function sshStateI18nKey(state: SshHostState): string {
  return `ssh.picker.state.${state}`;
}

/**
 * Redact credentials from a proxy URL before rendering in UI text or diagnostics.
 * Example: http://user:pass@127.0.0.1:7890 -> http://***@127.0.0.1:7890
 */
export function redactProxyUrl(raw: string | null | undefined): string {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return '';
  const schemeIdx = trimmed.indexOf('://');
  const schemePrefix = schemeIdx >= 0 ? trimmed.slice(0, schemeIdx + 3) : '';
  const rest = schemeIdx >= 0 ? trimmed.slice(schemeIdx + 3) : trimmed;
  const slashIdx = rest.search(/[/?#]/);
  const authority = slashIdx >= 0 ? rest.slice(0, slashIdx) : rest;
  const suffix = slashIdx >= 0 ? rest.slice(slashIdx) : '';
  const atIdx = authority.lastIndexOf('@');
  if (atIdx < 0) return trimmed;
  return `${schemePrefix}***@${authority.slice(atIdx + 1)}${suffix}`;
}
