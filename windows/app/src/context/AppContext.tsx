import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  getSystemLocales,
  normalizeLanguageSetting,
  resolveLocale,
  translate,
  type ResolvedLocale,
} from '../lib/i18n';
import {
  backendRequest,
  getAppInfo,
  getAntigravityRunning,
  launchAntigravity,
  listenEvent,
  loadUiConfig,
  quitAntigravityAndWait,
  restartBackend,
  safeRelaunchAntigravity,
  saveUiConfig,
  setWindowDarkMode,
  syncTrayLanguage,
} from '../lib/tauri';
import type {
  AccountRecord,
  AccountsListReply,
  AppInfo,
  AutoSwitchConfig,
  AutoSwitchPreview,
  DashboardSummaryReply,
  LanguageSetting,
  LiveStatus,
  MaintenanceScanReply,
  PageKey,
  ThemeMode,
  UiConfig,
  UsagePeriodKey,
  UsageSummaryReply,
} from '../lib/types';
import type { ToastMessage } from '../components/Toast';

export interface ConfirmDialogState {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  resolve: (confirmed: boolean) => void;
}

const DEFAULT_CONFIG: UiConfig = {
  schema: 2,
  lastPage: 0,
  quotaRefreshMinutes: 0,
  hudEnabled: true,
  autoPricingSyncEnabled: false,
  syncAntigravityLifecycle: false,
  autoUpdateEnabled: false,
  accountsCollapsed: false,
  menuSelectedTab: 0,
  menuUsagePeriod: 0,
  menuTrendMetric: 'tokens',
  applicationChannel: 'stable',
  appLanguage: 'system',
  themeMode: 'system',
};

const PAGE_INDEX_MAP: PageKey[] = ['overview', 'accounts', 'usage', 'settings', 'about'];

interface AppContextValue {
  windowRole: 'main' | 'tray';
  config: UiConfig;
  updateConfig: (patch: Partial<UiConfig>) => Promise<void>;
  locale: ResolvedLocale;
  languageSetting: LanguageSetting;
  setLanguage: (lang: LanguageSetting) => Promise<void>;
  themeMode: ThemeMode;
  isDark: boolean;
  setThemeMode: (mode: ThemeMode) => Promise<void>;
  t: (key: string, params?: Record<string, string | number>, fallback?: string) => string;

  activePage: PageKey;
  setActivePage: (page: PageKey) => void;

  appInfo: AppInfo | null;
  reachable: boolean;
  status: LiveStatus;
  dashboard: DashboardSummaryReply | null;
  accountsPayload: AccountsListReply | null;
  accounts: AccountRecord[];
  activeAccountId: string;
  hasPendingSwitch: boolean;
  autoSwitchConfig: AutoSwitchConfig;
  autoSwitchPreview: AutoSwitchPreview | null;
  usageByPeriod: Partial<Record<UsagePeriodKey, UsageSummaryReply>>;
  usageLoading: Partial<Record<UsagePeriodKey, boolean>>;
  usageErrors: Partial<Record<UsagePeriodKey, string>>;
  maintenanceScan: MaintenanceScanReply | null;

  quotaRefreshing: boolean;
  refreshingAccountIds: Set<string>;
  relaunching: boolean;
  switchingAccount: boolean;

  refreshAll: (force?: boolean) => Promise<void>;
  fetchDashboard: (force?: boolean) => Promise<void>;
  fetchAccounts: () => Promise<void>;
  fetchAutoSwitch: () => Promise<void>;
  fetchUsage: (period: UsagePeriodKey, force?: boolean) => Promise<UsageSummaryReply | null>;
  fetchMaintenanceScan: (retentionDays?: number, force?: boolean) => Promise<MaintenanceScanReply | null>;
  refreshAllQuotas: () => Promise<void>;
  refreshSingleAccountQuota: (id: string) => Promise<void>;
  toggleLocalization: (enable: boolean) => Promise<void>;
  toggleHud: (enable: boolean) => Promise<void>;
  openAntigravity: () => Promise<void>;
  triggerSafeRelaunch: () => Promise<void>;
  interactiveSwitchAccount: (acc: { id: string; email: string; name?: string }) => Promise<void>;
  reconnectBackend: () => Promise<void>;

  toast: ToastMessage | null;
  showToast: (message: string, error?: boolean) => void;
  clearToast: () => void;
  confirmDialog: ConfirmDialogState | null;
  askConfirm: (opts: Omit<ConfirmDialogState, 'resolve'>) => Promise<boolean>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({
  windowRole,
  children,
}: {
  windowRole: 'main' | 'tray';
  children: ReactNode;
}) {
  const [config, setConfig] = useState<UiConfig>(DEFAULT_CONFIG);
  const [systemDark, setSystemDark] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)').matches : false,
  );
  const [activePage, setActivePageState] = useState<PageKey>('overview');
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [reachable, setReachable] = useState<boolean>(false);
  const [status, setStatus] = useState<LiveStatus>({ mode: 'starting' });
  const [dashboard, setDashboard] = useState<DashboardSummaryReply | null>(null);
  const [accountsPayload, setAccountsPayload] = useState<AccountsListReply | null>(null);
  const [autoSwitchConfig, setAutoSwitchConfig] = useState<AutoSwitchConfig>({
    enabled: false,
    strategy: 'priority',
    monitored_model: 'all',
    reserve_percentage: 10,
    candidate_min_percentage: 30,
  });
  const [autoSwitchPreview, setAutoSwitchPreview] = useState<AutoSwitchPreview | null>(null);
  const [usageByPeriod, setUsageByPeriod] = useState<Partial<Record<UsagePeriodKey, UsageSummaryReply>>>({});
  const [usageLoading, setUsageLoading] = useState<Partial<Record<UsagePeriodKey, boolean>>>({});
  const [usageErrors, setUsageErrors] = useState<Partial<Record<UsagePeriodKey, string>>>({});
  const [maintenanceScan, setMaintenanceScan] = useState<MaintenanceScanReply | null>(null);

  const [quotaRefreshing, setQuotaRefreshing] = useState(false);
  const [refreshingAccountIds, setRefreshingAccountIds] = useState<Set<string>>(new Set());
  const [relaunching, setRelaunching] = useState(false);
  const [switchingAccount, setSwitchingAccount] = useState(false);

  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const configRef = useRef<UiConfig>(DEFAULT_CONFIG);

  const languageSetting = normalizeLanguageSetting(config.appLanguage);
  const locale: ResolvedLocale = useMemo(() => resolveLocale(languageSetting), [languageSetting]);
  const themeMode: ThemeMode = config.themeMode ?? 'system';
  const isDark = themeMode === 'dark' || (themeMode === 'system' && systemDark);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>, fallback?: string) =>
      translate(locale, key, params, fallback),
    [locale],
  );

  const showToast = useCallback((message: string, error = false) => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    setToast({ id: Date.now(), message, error });
    toastTimerRef.current = window.setTimeout(() => setToast(null), error ? 5500 : 3400);
  }, []);

  const clearToast = useCallback(() => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    setToast(null);
  }, []);

  const askConfirm = useCallback((opts: Omit<ConfirmDialogState, 'resolve'>) => {
    return new Promise<boolean>((resolve) => {
      setConfirmDialog({
        ...opts,
        resolve: (confirmed: boolean) => {
          setConfirmDialog(null);
          resolve(confirmed);
        },
      });
    });
  }, []);

  // Apply theme to DOM and native Windows 11 DWM titlebar
  useEffect(() => {
    document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
    void setWindowDarkMode(isDark);
  }, [isDark]);

  // Listen to OS color scheme changes
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Keep native tray menu language synced
  useEffect(() => {
    void syncTrayLanguage(locale === 'en');
  }, [locale]);

  const updateConfig = useCallback(async (patch: Partial<UiConfig>) => {
    const next: UiConfig = { ...configRef.current, ...patch };
    configRef.current = next;
    setConfig(next);
    try {
      await saveUiConfig(next);
    } catch {
      // Ignore transient disk write failure
    }
  }, []);

  const setActivePage = useCallback(
    (page: PageKey) => {
      setActivePageState(page);
      const idx = PAGE_INDEX_MAP.indexOf(page);
      if (idx >= 0 && windowRole === 'main') {
        void updateConfig({ lastPage: idx });
      }
    },
    [updateConfig, windowRole],
  );

  const fetchStatus = useCallback(async (): Promise<boolean> => {
    try {
      const res = await backendRequest<{ ok?: boolean; status?: LiveStatus }>({
        command: 'status',
        includeTasks: false,
      });
      setReachable(true);
      if (res?.status) {
        setStatus(res.status);
      }
      return true;
    } catch {
      setReachable(false);
      return false;
    }
  }, []);

  const fetchDashboard = useCallback(async (_force = false) => {
    try {
      const res = await backendRequest<DashboardSummaryReply>({ command: 'dashboard_summary' });
      setReachable(true);
      setDashboard(res);
      if (res?.usage?.periods) {
        setUsageByPeriod((prev) => ({ ...prev, ...res.usage!.periods }));
      }
    } catch {
      // Retain previous dashboard snapshot on transient failure
    }
  }, []);

  const fetchAccounts = useCallback(async () => {
    try {
      const res = await backendRequest<AccountsListReply>({ command: 'account_list' });
      setReachable(true);
      setAccountsPayload(res);
    } catch {
      // Keep last known list
    }
  }, []);

  const fetchAutoSwitch = useCallback(async () => {
    try {
      const res = await backendRequest<{ config?: AutoSwitchConfig }>({ command: 'auto_switch_get' });
      if (res?.config) {
        setAutoSwitchConfig(res.config);
        if (res.config.enabled) {
          const preview = await backendRequest<AutoSwitchPreview>({
            command: 'auto_switch_best',
            preview: true,
          }).catch(() => null);
          setAutoSwitchPreview(preview);
        } else {
          setAutoSwitchPreview(null);
        }
      }
    } catch {
      // Ignore
    }
  }, []);

  const fetchUsage = useCallback(
    async (period: UsagePeriodKey, force = false): Promise<UsageSummaryReply | null> => {
      setUsageLoading((prev) => ({ ...prev, [period]: true }));
      try {
        const res = await backendRequest<UsageSummaryReply>({
          command: 'usage_summary',
          period,
          ...(force ? { force: true } : {}),
        });
        setReachable(true);
        setUsageErrors((prev) => ({ ...prev, [period]: undefined }));
        if (res?.periods) {
          setUsageByPeriod((prev) => ({ ...prev, ...res.periods, [period]: res }));
        } else if (res) {
          setUsageByPeriod((prev) => ({ ...prev, [period]: res }));
        }
        return res;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setUsageErrors((prev) => ({ ...prev, [period]: msg }));
        return null;
      } finally {
        setUsageLoading((prev) => ({ ...prev, [period]: false }));
      }
    },
    [],
  );

  const fetchMaintenanceScan = useCallback(
    async (retentionDays = 7, _force = false): Promise<MaintenanceScanReply | null> => {
      try {
        const res = await backendRequest<MaintenanceScanReply>({
          command: 'maintenance_scan',
          retentionDays,
        });
        setMaintenanceScan(res);
        return res;
      } catch {
        return null;
      }
    },
    [],
  );

  const refreshAll = useCallback(
    async (force = false) => {
      const ok = await fetchStatus();
      if (!ok) return;
      await Promise.all([
        fetchDashboard(force),
        fetchAccounts(),
        fetchAutoSwitch(),
      ]);
      void getAppInfo().then(setAppInfo).catch(() => {});
    },
    [fetchAccounts, fetchAutoSwitch, fetchDashboard, fetchStatus],
  );

  const setLanguage = useCallback(
    async (lang: LanguageSetting) => {
      await updateConfig({ appLanguage: lang });
      try {
        const res = await backendRequest<{ status?: LiveStatus }>({
          command: 'language_set',
          language: lang,
          systemLocales: getSystemLocales(),
        });
        if (res?.status) setStatus(res.status);
        void fetchDashboard(true);
        void fetchAccounts();
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), true);
      }
    },
    [fetchAccounts, fetchDashboard, showToast, updateConfig],
  );

  const setThemeMode = useCallback(
    async (mode: ThemeMode) => {
      await updateConfig({ themeMode: mode });
    },
    [updateConfig],
  );

  const toggleLocalization = useCallback(
    async (enable: boolean) => {
      setStatus((prev) => ({ ...prev, translationEnabled: enable }));
      try {
        const res = await backendRequest<{ status?: LiveStatus }>({
          command: enable ? 'resume' : 'pause',
        });
        if (res?.status) setStatus(res.status);
        void fetchStatus();
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), true);
        void fetchStatus();
      }
    },
    [fetchStatus, showToast],
  );

  const toggleHud = useCallback(
    async (enable: boolean) => {
      setStatus((prev) => ({ ...prev, hudEnabled: enable }));
      await updateConfig({ hudEnabled: enable });
      try {
        const res = await backendRequest<{ status?: LiveStatus }>({
          command: 'hud_set',
          enabled: enable,
        });
        if (res?.status) setStatus(res.status);
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), true);
        void fetchStatus();
      }
    },
    [fetchStatus, showToast, updateConfig],
  );

  const triggerSafeRelaunch = useCallback(async () => {
    if (relaunching) return;
    const confirmed = await askConfirm({
      title: t('assistant.safe_relaunch_title'),
      body: t('assistant.safe_relaunch_body'),
      confirmLabel: t('assistant.safe_relaunch_confirm'),
    });
    if (!confirmed) return;
    setRelaunching(true);
    try {
      const res = await safeRelaunchAntigravity();
      showToast(res.message);
      setTimeout(() => void refreshAll(true), 1200);
    } catch (err) {
      showToast(
        t('assistant.safe_relaunch_failed', {
          detail: err instanceof Error ? err.message : String(err),
        }),
        true,
      );
    } finally {
      setRelaunching(false);
    }
  }, [askConfirm, refreshAll, relaunching, showToast, t]);

  const openAntigravity = useCallback(async () => {
    if (status.mode === 'debug-port-missing') {
      await triggerSafeRelaunch();
      return;
    }
    try {
      await launchAntigravity();
      setTimeout(() => void fetchStatus(), 1500);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true);
    }
  }, [fetchStatus, showToast, status.mode, triggerSafeRelaunch]);

  const refreshAllQuotas = useCallback(async () => {
    if (quotaRefreshing || !reachable) return;
    setQuotaRefreshing(true);
    try {
      const start = await backendRequest<{ taskId?: string }>({ command: 'quota_refresh_start' });
      const taskId = start?.taskId;
      if (taskId) {
        // Poll task completion up to 60s
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 450));
          const list = await backendRequest<{ tasks?: Array<{ id: string; state: string; message?: string; error?: string }> }>({
            command: 'task_list',
          }).catch(() => null);
          const task = list?.tasks?.find((item) => item.id === taskId);
          if (!task || task.state !== 'running') {
            if (task?.state === 'failed') {
              showToast(task.error || task.message || t('assistant.quota_refresh_incomplete'), true);
            } else if (task?.message) {
              showToast(task.message);
            }
            break;
          }
        }
      } else {
        await backendRequest({ command: 'quota_refresh_all' });
      }
      await Promise.all([fetchDashboard(true), fetchAccounts(), fetchAutoSwitch()]);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true);
    } finally {
      setQuotaRefreshing(false);
    }
  }, [fetchAccounts, fetchAutoSwitch, fetchDashboard, quotaRefreshing, reachable, showToast, t]);

  const refreshSingleAccountQuota = useCallback(
    async (id: string) => {
      if (!id || !reachable) return;
      setRefreshingAccountIds((prev) => new Set(prev).add(id));
      try {
        const res = await backendRequest<{ message?: string; notice?: string; standbyDeferred?: boolean }>({
          command: 'quota_refresh',
          id,
        });
        const msg = res?.standbyDeferred ? (res.notice || res.message) : res?.message;
        if (msg) showToast(msg);
        await Promise.all([fetchDashboard(true), fetchAccounts()]);
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), true);
      } finally {
        setRefreshingAccountIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [fetchAccounts, fetchDashboard, reachable, showToast],
  );

  const interactiveSwitchAccount = useCallback(
    async (acc: { id: string; email: string; name?: string }) => {
      if (!acc.id || switchingAccount || !reachable) return;
      setSwitchingAccount(true);
      try {
        const preflight = await backendRequest<{
          appRunning?: boolean;
          stableRunning?: boolean;
          insidersRunning?: boolean;
          hasRunningTask?: boolean;
          safe?: boolean;
        }>({ command: 'account_switch_preflight', id: acc.id });

        if (preflight?.insidersRunning) {
          showToast(t('assistant_account.insiders_running'), true);
          return;
        }

        const liveRunning = Boolean(preflight?.appRunning || preflight?.stableRunning || (await getAntigravityRunning()));
        const busy = preflight?.hasRunningTask === true || preflight?.safe === false;
        const display =
          acc.name && acc.name.toLowerCase() !== acc.email.toLowerCase()
            ? locale === 'en'
              ? `${acc.name} (${acc.email})`
              : `${acc.name}（${acc.email}）`
            : acc.email || acc.name || t('assistant_account.target_fallback');

        const confirmed = await askConfirm({
          title: t('assistant_account.switch_prompt_title', { display }),
          body: busy
            ? t('assistant_account.switch_busy_body')
            : liveRunning
            ? t('assistant_account.switch_ready_body')
            : t('assistant_account.switch_stopped_body'),
          confirmLabel: busy ? t('assistant_account.switch_busy_confirm') : t('assistant_account.switch_confirm'),
          danger: busy,
        });
        if (!confirmed) return;

        if (liveRunning) {
          const closed = await quitAntigravityAndWait(18_000);
          if (!closed) {
            showToast(t('assistant_account.quit_first'), true);
            return;
          }
        }

        try {
          const switchRes = await backendRequest<{ message?: string }>({
            command: 'account_switch',
            id: acc.id,
            target: 'all',
            autoRefreshToken: true,
          });
          showToast(switchRes?.message || t('assistant_account.switched_to', { email: acc.email }));
        } finally {
          if (liveRunning) {
            await launchAntigravity().catch((e) => {
              showToast(
                t('assistant.relaunch_failed', { detail: e instanceof Error ? e.message : String(e) }),
                true,
              );
            });
          }
        }

        await refreshAll(true);
      } catch (err) {
        showToast(
          t('assistant_account.switch_failed', {
            error: err instanceof Error ? err.message : String(err),
          }),
          true,
        );
      } finally {
        setSwitchingAccount(false);
      }
    },
    [askConfirm, locale, reachable, refreshAll, showToast, switchingAccount, t],
  );

  const reconnectBackend = useCallback(async () => {
    try {
      await restartBackend();
      await refreshAll(true);
      showToast(t('status.connected'));
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true);
    }
  }, [refreshAll, showToast, t]);

  // Initial load
  useEffect(() => {
    let mounted = true;
    (async () => {
      const [cfg, info] = await Promise.all([loadUiConfig(), getAppInfo()]);
      if (!mounted) return;
      configRef.current = cfg;
      setConfig(cfg);
      setAppInfo(info);
      if (windowRole === 'main' && cfg.lastPage >= 0 && cfg.lastPage < PAGE_INDEX_MAP.length) {
        setActivePageState(PAGE_INDEX_MAP[cfg.lastPage]);
      }
      await refreshAll(false);
      if (mounted) {
        void fetchUsage('today', false);
        void fetchMaintenanceScan(7, false);
      }
    })();

    const unlisteners: Array<Promise<() => void>> = [
      listenEvent<UiConfig>('ui-config-changed', (nextCfg) => {
        configRef.current = nextCfg;
        setConfig(nextCfg);
      }),
      listenEvent<string>('navigate-page', (page) => {
        if (PAGE_INDEX_MAP.includes(page as PageKey)) {
          setActivePageState(page as PageKey);
        }
      }),
      listenEvent<string>('backend-data-changed', () => {
        void refreshAll(false);
      }),
      listenEvent<{ message: string; error?: boolean }>('toast-message', (msg) => {
        showToast(msg.message, Boolean(msg.error));
      }),
      listenEvent<void>('tray-opened', () => {
        if (windowRole === 'tray') {
          void refreshAll(false);
          void fetchUsage('today', false);
        }
      }),
    ];

    return () => {
      mounted = false;
      for (const p of unlisteners) {
        void p.then((fn) => fn());
      }
    };
  }, [fetchMaintenanceScan, fetchUsage, refreshAll, showToast, windowRole]);

  // Periodic background status & data refresh
  useEffect(() => {
    const statusInterval = window.setInterval(() => {
      void fetchStatus();
    }, 4000);
    const dataInterval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void fetchDashboard(false);
        void fetchAccounts();
      }
    }, 20_000);
    return () => {
      window.clearInterval(statusInterval);
      window.clearInterval(dataInterval);
    };
  }, [fetchAccounts, fetchDashboard, fetchStatus]);

  // Scheduled periodic quota refresh per user config
  useEffect(() => {
    const mins = config.quotaRefreshMinutes;
    if (!mins || mins <= 0 || windowRole !== 'main') return;
    const id = window.setInterval(() => {
      void refreshAllQuotas();
    }, mins * 60 * 1000);
    return () => window.clearInterval(id);
  }, [config.quotaRefreshMinutes, refreshAllQuotas, windowRole]);

  const accounts = useMemo(() => accountsPayload?.accounts ?? [], [accountsPayload]);
  const activeAccountId = useMemo(() => {
    const liveEmail = (status.liveAccountEmail ?? '').trim().toLowerCase();
    if (liveEmail) {
      const matched = accounts.find((a) => a.email.toLowerCase() === liveEmail);
      if (matched) return matched.id;
    }
    return accountsPayload?.activeId ?? accountsPayload?.currentAccountId ?? '';
  }, [accounts, accountsPayload, status.liveAccountEmail]);

  const hasPendingSwitch = useMemo(() => {
    const p = accountsPayload?.pendingSwitch;
    if (typeof p === 'boolean') return p;
    return Boolean(p?.isPending);
  }, [accountsPayload]);

  const value: AppContextValue = {
    windowRole,
    config,
    updateConfig,
    locale,
    languageSetting,
    setLanguage,
    themeMode,
    isDark,
    setThemeMode,
    t,
    activePage,
    setActivePage,
    appInfo,
    reachable,
    status,
    dashboard,
    accountsPayload,
    accounts,
    activeAccountId,
    hasPendingSwitch,
    autoSwitchConfig,
    autoSwitchPreview,
    usageByPeriod,
    usageLoading,
    usageErrors,
    maintenanceScan,
    quotaRefreshing,
    refreshingAccountIds,
    relaunching,
    switchingAccount,
    refreshAll,
    fetchDashboard,
    fetchAccounts,
    fetchAutoSwitch,
    fetchUsage,
    fetchMaintenanceScan,
    refreshAllQuotas,
    refreshSingleAccountQuota,
    toggleLocalization,
    toggleHud,
    openAntigravity,
    triggerSafeRelaunch,
    interactiveSwitchAccount,
    reconnectBackend,
    toast,
    showToast,
    clearToast,
    confirmDialog,
    askConfirm,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
