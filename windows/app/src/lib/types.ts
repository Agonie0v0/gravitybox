export type PageKey = 'overview' | 'accounts' | 'usage' | 'settings' | 'about';
export type UsagePeriodKey = 'today' | '7d' | '30d' | 'all';
export type ThemeMode = 'system' | 'light' | 'dark';
export type LanguageSetting = 'system' | 'zh-Hans' | 'en';

export interface UiConfig {
  schema: number;
  lastPage: number;
  quotaRefreshMinutes: number;
  hudEnabled: boolean;
  autoPricingSyncEnabled: boolean;
  syncAntigravityLifecycle: boolean;
  autoUpdateEnabled: boolean;
  accountsCollapsed: boolean;
  menuSelectedTab: number;
  menuUsagePeriod: number;
  menuTrendMetric: 'tokens' | 'requests';
  applicationChannel: string;
  appLanguage: string | null;
  themeMode: ThemeMode;
}

export interface AntigravityInfo {
  installDir: string;
  exePath: string;
  installed: boolean;
  version: string;
  running: boolean;
  debugPortReady: boolean;
}

export interface AppInfo {
  version: string;
  stateDir: string;
  pipeName: string;
  osLabel: string;
  antigravity: AntigravityInfo;
}

export interface LiveStatus {
  mode: string;
  message?: string;
  detail?: string;
  appVersion?: string;
  locale?: string;
  configuredLanguage?: string;
  translationEnabled?: boolean;
  hudEnabled?: boolean;
  oauthClientConfigured?: boolean;
  applicationChannel?: string;
  applicationLabel?: string;
  activeAccountEmail?: string;
  activeFiveHourQuota?: number | null;
  activeSubscriptionTier?: string;
  liveAccountEmail?: string | null;
  accountsRevision?: string;
  pricingRevision?: string | number;
  runningTasks?: number;
  dictionaryError?: string;
  partial?: boolean;
}

export interface TaskRow {
  id: string;
  kind: string;
  title: string;
  state: 'running' | 'completed' | 'failed' | 'cancelled' | string;
  done?: number;
  total?: number;
  message?: string;
  error?: string;
}

export interface HourlyPointRaw {
  hour?: number | string;
  label?: string;
  total_tokens?: number;
  totalTokens?: number;
  request_count?: number;
  requestCount?: number;
  estimated_usd?: number;
  estimatedUsd?: number;
}

export interface DailyTrendRaw {
  date: string;
  total_tokens?: number;
  totalTokens?: number;
  request_count?: number;
  requestCount?: number;
  estimated_usd?: number;
  estimatedUsd?: number;
}

export interface ModelUsageRaw {
  model: string;
  modelId?: string;
  model_id?: string;
  promptTokens?: number;
  input_tokens?: number;
  candidatesTokens?: number;
  output_tokens?: number;
  cachedTokens?: number;
  cached_tokens?: number;
  cacheWriteTokens?: number;
  cache_write_tokens?: number;
  totalTokens?: number;
  total_tokens?: number;
  requestCount?: number;
  request_count?: number;
  estimatedUsd?: number;
  estimated_usd?: number;
  priced?: boolean;
  partiallyPriced?: boolean;
  unpricedTokens?: number;
  unpriced_tokens?: number;
  pricingKey?: string;
  pricingStatus?: string;
  pricingProvenance?: Record<string, unknown> | null;
}

export interface UsagePeriodSummaryData {
  totalTokens?: number;
  promptTokens?: number;
  candidatesTokens?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  requestCount?: number;
  estimatedUsd?: number;
  cacheHitRate?: number;
  databasesScanned?: number;
  databasesDiscovered?: number;
  scanScopeDescription?: string;
  pricedModels?: number;
  unpricedModels?: number;
  failedDatabasesCount?: number;
  skippedLargeRecords?: number;
  lastScannedAt?: number;
  hasError?: boolean;
  availability?: string;
  unknownTimeRecords?: number;
  unknownTimeTokens?: number;
  pricing_warnings?: string[];
  pricing_warning_codes?: string[];
}

export interface UsageSummaryReply {
  ok?: boolean;
  period: UsagePeriodKey;
  snapshotId?: string;
  summary: UsagePeriodSummaryData;
  byModel?: ModelUsageRaw[];
  models?: ModelUsageRaw[];
  dailyTrends?: DailyTrendRaw[];
  todayHourly?: HourlyPointRaw[];
  periods?: Record<UsagePeriodKey, UsageSummaryReply>;
}

export interface AccountRecord {
  id: string;
  email: string;
  name?: string;
  subscription_tier?: string;
  disabled?: boolean;
  validation_blocked?: boolean;
  revision?: string;
  quota_last_updated?: number;
  quotaLastUpdated?: number;
  quota_refresh_error?: string;
  credentialReadiness?: {
    state?: string;
    message?: string;
  };
  standbyRefreshStatus?: {
    mode?: string;
    message?: string;
  };
  quota?: Record<string, unknown> | null;
  quotaGroups?: Array<Record<string, unknown>>;
  familyWindows?: Record<string, unknown>;
  familyModelQuota?: Record<string, unknown>;
  argonStatus?: Record<string, unknown> | null;
  carbonStatus?: Record<string, unknown> | null;
  standaloneModels?: Array<Record<string, unknown>>;
  refreshState?: Record<string, unknown>;
  quotaWarnings?: string[];
  quotaWarningCodes?: string[];
  staleGroups?: Array<Record<string, unknown>>;
  stale_groups?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface AccountsListReply {
  ok?: boolean;
  activeId?: string | null;
  currentAccountId?: string | null;
  identityState?: string;
  accounts: AccountRecord[];
  pendingSwitch?: boolean | { isPending?: boolean };
  recovery?: Record<string, unknown>;
}

export interface AutoSwitchConfig {
  enabled: boolean;
  strategy: 'priority' | 'round_robin' | string;
  monitored_model: string;
  reserve_percentage: number;
  candidate_min_percentage: number;
}

export interface AutoSwitchPreview {
  ok?: boolean;
  currentAccount?: AccountRecord | null;
  bestCandidate?: AccountRecord | null;
  account?: AccountRecord | null;
  shouldSwitch: boolean;
  reason?: string;
}

export interface DashboardSummaryReply {
  ok?: boolean;
  accounts?: (AccountRecord & {
    total?: number;
    currentAccountId?: string | null;
    activeEmail?: string;
    configuredEmail?: string;
    isLiveVerified?: boolean;
    activeName?: string;
    activeTier?: string;
    liveAccountEmail?: string | null;
    quotaRefreshError?: string;
    readyCount?: number;
    autoSwitchEnabled?: boolean;
  }) | null;
  usage?: {
    todayTokens?: number;
    totalTokens?: number;
    estimatedUsd?: number;
    allTimeEstimatedUsd?: number;
    requestCount?: number;
    totalRequestCount?: number;
    pricingModels?: number;
    todayPricedModels?: number;
    todayUnpricedModels?: number;
    unpricedModels?: number;
    pricedModels?: number;
    databasesScanned?: number;
    databasesDiscovered?: number;
    failedDatabasesCount?: number;
    skippedLargeRecords?: number;
    availability?: string;
    unknownTimeRecords?: number;
    todayHourly?: HourlyPointRaw[];
    todayByModel?: ModelUsageRaw[];
    periods?: Record<UsagePeriodKey, UsageSummaryReply>;
  } | null;
  accountsError?: string;
  usageError?: string;
  revision?: string;
  generatedAt?: string;
}

export interface UsageEventRow {
  id?: string;
  timestamp?: number | string;
  model?: string;
  modelId?: string;
  input_tokens?: number;
  inputTokens?: number;
  output_tokens?: number;
  outputTokens?: number;
  cached_tokens?: number;
  cachedTokens?: number;
  cache_write_tokens?: number;
  cacheWriteTokens?: number;
  total_tokens?: number;
  totalTokens?: number;
  estimated_usd?: number;
  estimatedUsd?: number;
  priced?: boolean;
  source?: string;
}

export interface UsageEventsReply {
  ok?: boolean;
  snapshot_id?: string;
  generated_at?: number;
  period?: string;
  scope?: string;
  total: number;
  rows: UsageEventRow[];
  availability?: string;
}

export interface MaintenanceEntry {
  name: string;
  category?: 'safe' | 'stateful' | string;
  bytes: number;
  fileCount?: number;
  clearable?: boolean;
  path?: string;
  description?: string;
  reason?: string;
}

export interface MaintenanceSnapshot {
  id: string;
  timestamp: number;
  totalBytes: number;
  fileCount?: number;
  restorable?: boolean;
  restoredAt?: number;
  snapshotPath?: string;
  items?: Array<{ name: string; bytes: number; fileCount?: number }>;
}

export interface MaintenanceScanReply {
  ok?: boolean;
  token?: string;
  running?: boolean;
  browserBusy?: boolean;
  retentionDays?: number;
  scannedAt?: number;
  trashDir?: string;
  usingFallbackTrash?: boolean;
  safeBytes?: number;
  statefulBytes?: number;
  protectedBytes?: number;
  buckets?: {
    runtimeCache?: { clearableBytes?: number; fileCount?: number };
    historyLogs?: { clearableBytes?: number; fileCount?: number; subagentCount?: number };
  };
  entries?: MaintenanceEntry[];
  protectedEntries?: MaintenanceEntry[];
  snapshots?: MaintenanceSnapshot[];
  latestRestorableSnapshot?: MaintenanceSnapshot | null;
}

export interface PricingPayload {
  ok?: boolean;
  synced?: boolean;
  error?: string;
  healedRecords?: number;
  prices?: Record<string, {
    input?: number;
    output?: number;
    cached?: number;
    cacheWrite?: number;
    state?: string;
    displayName?: string;
    provenance?: {
      checkedAt?: string;
      validUntil?: string;
      sourceUrl?: string;
      state?: string;
    };
  }>;
  catalogState?: Record<string, {
    displayName?: string;
    availability?: string;
    tiers?: string[];
    hostOrder?: number;
    state?: string;
  }>;
  unpricedLiveModels?: Array<{
    key: string;
    displayName?: string;
    disabled?: boolean;
    variants?: string[];
    hostOrder?: number;
  }>;
  status?: {
    version?: string;
    modelCount?: number;
    lastSyncedAt?: number;
    lastCheckedAt?: number;
    source?: string;
    enabled?: boolean;
  };
}
