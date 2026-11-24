import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  DollarSign,
  ExternalLink,
  Globe,
  Languages,
  Moon,
  MoreHorizontal,
  Power,
  RotateCw,
  Send,
  Server,
  Settings,
  Sparkles,
  Sun,
  Zap,
} from 'lucide-react';
import { BrandMark } from '../components/BrandMark';
import { DebugPortBanner } from '../components/DebugPortBanner';
import { Modal } from '../components/Modal';
import { BrandIcons } from '../components/ModelIcon';
import { QuotaMeterRow } from '../components/QuotaBar';
import { TierBadge } from '../components/TierBadge';
import { ToastBanner } from '../components/Toast';
import { TrendChart, type TrendBarPoint } from '../components/TrendChart';
import { useApp } from '../context/AppContext';
import {
  accountDisplayName,
  foldThinkingVariants,
  formatCompactTokens,
  formatInteger,
  formatShortTime,
  formatUsd,
  localizedModelLabel,
  normalizeTier,
  parseHourIndex,
  sortModelsByUsage,
} from '../lib/format';
import { formatBarTitle, parseQuotaContract } from '../lib/quota';
import { normalizeSshEnvironment, sshStateSortOrder } from '../lib/ssh';
import { hideTrayWindow, quitApp, showMainWindow } from '../lib/tauri';
import type { LanguageSetting, UsagePeriodKey, UsageSummaryReply } from '../lib/types';

const PERIODS: UsagePeriodKey[] = ['today', '7d', '30d', 'all'];

export function TrayWindow() {
  const {
    t,
    locale,
    languageSetting,
    setLanguage,
    isDark,
    setThemeMode,
    config,
    updateConfig,
    reachable,
    status,
    dashboard,
    accounts,
    activeAccountId,
    usageByPeriod,
    usageLoading,
    sshEnvironments,
    quotaRefreshing,
    relaunching,
    switchingAccount,
    fetchUsage,
    refreshAllQuotas,
    refreshSingleAccountQuota,
    toggleLocalization,
    openAntigravity,
    triggerSafeRelaunch,
    interactiveSwitchAccount,
    toast,
    clearToast,
    confirmDialog,
  } = useApp();

  const [tab, setTab] = useState<number>(config.menuSelectedTab ?? 0);
  const [periodIdx, setPeriodIdx] = useState<number>(config.menuUsagePeriod ?? 0);
  const [environmentId, setEnvironmentId] = useState<string>(config.menuUsageEnvironmentId || 'all');
  const [scopedUsage, setScopedUsage] = useState<UsageSummaryReply | null>(null);
  const [metric, setMetric] = useState<'tokens' | 'requests'>(config.menuTrendMetric ?? 'tokens');
  const [showAllModels, setShowAllModels] = useState(false);
  const [expandedAccountIds, setExpandedAccountIds] = useState<Set<string>>(() => new Set());
  const [moreOpen, setMoreOpen] = useState(false);
  const [hoveredPt, setHoveredPt] = useState<TrendBarPoint | null>(null);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const initializedExpandedRef = useRef(false);

  const period = PERIODS[Math.max(0, Math.min(3, periodIdx))];

  const normalizedSshHosts = useMemo(() => {
    const fallback = t('ssh.remote_fallback');
    return sshEnvironments
      .map((env) => normalizeSshEnvironment(env, fallback))
      .sort((a, b) => sshStateSortOrder(b.state) - sshStateSortOrder(a.state) || a.hostLabel.localeCompare(b.hostLabel));
  }, [sshEnvironments, t]);
  const onlineSshHosts = useMemo(
    () => normalizedSshHosts.filter((h) => h.state === 'online' || h.state === 'auth_expired'),
    [normalizedSshHosts],
  );

  useEffect(() => {
    setTab(config.menuSelectedTab ?? 0);
    setPeriodIdx(config.menuUsagePeriod ?? 0);
    setEnvironmentId(config.menuUsageEnvironmentId || 'all');
    setMetric(config.menuTrendMetric ?? 'tokens');
  }, [config.menuSelectedTab, config.menuUsagePeriod, config.menuUsageEnvironmentId, config.menuTrendMetric]);

  useEffect(() => {
    if (!initializedExpandedRef.current && accounts.length > 0) {
      initializedExpandedRef.current = true;
      const firstId = activeAccountId || accounts[0].id;
      if (firstId) setExpandedAccountIds(new Set([firstId]));
    }
  }, [accounts, activeAccountId]);

  useEffect(() => {
    if (tab !== 0 || !reachable) return;
    if (!environmentId || environmentId === 'all') {
      setScopedUsage(null);
      void fetchUsage(period, false);
    } else {
      let active = true;
      void fetchUsage(period, false, environmentId).then((res) => {
        if (active && res) setScopedUsage(res);
      });
      return () => {
        active = false;
      };
    }
  }, [tab, period, environmentId, reachable, fetchUsage]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const selectTab = (idx: number) => {
    setTab(idx);
    setHoveredPt(null);
    void updateConfig({ menuSelectedTab: idx });
  };

  const selectPeriod = (idx: number) => {
    setPeriodIdx(idx);
    setHoveredPt(null);
    void updateConfig({ menuUsagePeriod: idx });
    if (!environmentId || environmentId === 'all') {
      void fetchUsage(PERIODS[idx], false);
    } else {
      void fetchUsage(PERIODS[idx], false, environmentId).then((res) => {
        if (res) setScopedUsage(res);
      });
    }
  };

  const selectEnvironment = (nextEnv: string) => {
    setEnvironmentId(nextEnv);
    setHoveredPt(null);
    void updateConfig({ menuUsageEnvironmentId: nextEnv });
  };

  const selectMetric = (next: 'tokens' | 'requests') => {
    setMetric(next);
    void updateConfig({ menuTrendMetric: next });
  };

  const handleRefresh = () => {
    if (tab === 0) {
      if (!environmentId || environmentId === 'all') {
        void fetchUsage(period, true);
      } else {
        void fetchUsage(period, true, environmentId).then((res) => {
          if (res) setScopedUsage(res);
        });
      }
    } else if (tab === 1 && activeAccountId) {
      void refreshSingleAccountQuota(activeAccountId);
    } else {
      void refreshAllQuotas();
    }
  };

  const isRefreshing = tab === 0 ? Boolean(usageLoading[period]) : quotaRefreshing;

  // Usage tab data
  const usageReport =
    !environmentId || environmentId === 'all' ? usageByPeriod[period] : (scopedUsage ?? usageByPeriod[period]);
  const usageSummary = usageReport?.summary ?? {};
  const totalTokens = usageSummary.totalTokens ?? 0;
  const reqCount = usageSummary.requestCount ?? 0;
  const estUsd = usageSummary.estimatedUsd ?? 0;
  const cacheHit = usageSummary.cacheHitRate ?? 0;
  const lastScannedAt = usageSummary.lastScannedAt ?? 0;

  const modelRows = useMemo(() => {
    const raw = usageReport?.byModel ?? usageReport?.models ?? [];
    return sortModelsByUsage(foldThinkingVariants(raw)).filter((m) => m.totalTokens > 0 || m.requestCount > 0);
  }, [usageReport]);
  const maxModelTokens = modelRows[0]?.totalTokens ?? 1;
  const visibleModels = showAllModels ? modelRows : modelRows.slice(0, 3);

  const trendPoints = useMemo<TrendBarPoint[]>(() => {
    if (period === 'today') {
      const hourly = usageReport?.todayHourly ?? dashboard?.usage?.todayHourly ?? [];
      const map = new Map<number, { tokens: number; requests: number }>();
      for (const item of hourly) {
        const h = parseHourIndex(item);
        if (h !== null) {
          const prev = map.get(h) ?? { tokens: 0, requests: 0 };
          map.set(h, {
            tokens: prev.tokens + (Number(item.totalTokens ?? item.total_tokens ?? 0) || 0),
            requests: prev.requests + (Number(item.requestCount ?? item.request_count ?? 0) || 0),
          });
        }
      }
      const nowHour = new Date().getHours();
      return Array.from({ length: 24 }, (_, hour) => {
        const hh = String(hour).padStart(2, '0');
        const row = map.get(hour);
        const val = metric === 'requests' ? row?.requests ?? 0 : row?.tokens ?? 0;
        return {
          label: locale === 'en' ? `${hh}h` : `${hh}时`,
          tooltipLabel: t('menu_panel.trend.today_key', { time: `${hh}:00` }),
          value: val,
          isFuture: val === 0 && hour > nowHour,
        };
      });
    }
    const daily = usageReport?.dailyTrends ?? [];
    const limit = period === '7d' ? 7 : period === '30d' ? 30 : Math.max(30, daily.length);
    return daily.slice(-limit).map((d) => ({
      label: d.date.length >= 10 ? d.date.slice(5) : d.date,
      tooltipLabel: d.date,
      value:
        metric === 'requests'
          ? Number(d.requestCount ?? d.request_count ?? 0) || 0
          : Number(d.totalTokens ?? d.total_tokens ?? 0) || 0,
    }));
  }, [period, usageReport, dashboard, metric, locale, t]);

  // Quota tab data
  const activeAccount = useMemo(() => {
    if (activeAccountId) {
      const m = accounts.find((a) => a.id === activeAccountId);
      if (m) return m;
    }
    return accounts[0] ?? null;
  }, [accounts, activeAccountId]);

  const quotaSource = (activeAccount ?? dashboard?.accounts) as Record<string, unknown> | null;
  const quotaContract = useMemo(
    () => parseQuotaContract(quotaSource, locale, { compact: true }),
    [quotaSource, locale],
  );
  const quotaUpdatedTs = Number(
    activeAccount?.quota_last_updated ??
      activeAccount?.quotaLastUpdated ??
      dashboard?.accounts?.quotaLastUpdated ??
      0,
  );

  const translationOn = status.translationEnabled !== false && status.mode !== 'paused';

  const footerMainTarget: { page: string; label: string } =
    tab === 0
      ? { page: 'usage', label: t('menu_panel.footer.open_usage') }
      : tab === 1
      ? { page: 'overview', label: t('menu_panel.footer.open_overview') }
      : { page: 'accounts', label: t('menu_panel.footer.open_accounts') };

  const cycleLanguage = () => {
    const order: LanguageSetting[] = ['system', 'zh-Hans', 'en'];
    const next = order[(order.indexOf(languageSetting) + 1) % order.length];
    void setLanguage(next);
  };

  return (
    <div className="gb-tray-shell">
      {/* Top Chrome */}
      <header className="gb-tray-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
            <BrandMark size={18} />
            <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.01em' }}>GravityBox</span>
            {onlineSshHosts.length > 0 && (
              <span
                className="gb-pill gb-pill-success"
                style={{ fontSize: 10, padding: '1px 6px', maxWidth: 108, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {onlineSshHosts.length === 1
                  ? t('menu_panel.ssh.header_badge_one', { host: onlineSshHosts[0].hostLabel })
                  : t('menu_panel.ssh.header_badge_many', { count: onlineSshHosts.length })}
              </span>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, position: 'relative' }} ref={moreRef}>
            <button
              type="button"
              className="gb-btn gb-btn-sm gb-btn-pill"
              style={{ minWidth: 68 }}
              disabled={!reachable || isRefreshing}
              onClick={handleRefresh}
            >
              {isRefreshing && <RotateCw size={11} className="gb-spin" />}
              <span>{t('common.refresh')}</span>
            </button>
            <button
              type="button"
              className="gb-btn gb-btn-sm gb-btn-pill"
              style={{ width: 30, padding: 0 }}
              aria-label={t('menu.more_actions')}
              onClick={() => setMoreOpen((v) => !v)}
            >
              <MoreHorizontal size={14} />
            </button>

            {moreOpen && (
              <div className="gb-dropdown" style={{ minWidth: 186 }}>
                <button
                  type="button"
                  className="gb-dropdown-item"
                  disabled={!reachable}
                  onClick={() => {
                    setMoreOpen(false);
                    void toggleLocalization(!translationOn);
                  }}
                >
                  <Languages size={13} />
                  <span>
                    {locale === 'en'
                      ? translationOn
                        ? 'Pause Localization'
                        : 'Resume Localization'
                      : translationOn
                      ? '暂停界面汉化'
                      : '恢复界面汉化'}
                  </span>
                </button>
                <button
                  type="button"
                  className="gb-dropdown-item"
                  onClick={() => {
                    setMoreOpen(false);
                    cycleLanguage();
                  }}
                >
                  <Globe size={13} />
                  <span>
                    {t('menu.language')}:{' '}
                    {languageSetting === 'system'
                      ? t('language.system')
                      : languageSetting === 'en'
                      ? 'EN'
                      : '中文'}
                  </span>
                </button>
                <button
                  type="button"
                  className="gb-dropdown-item"
                  onClick={() => {
                    setMoreOpen(false);
                    void setThemeMode(isDark ? 'light' : 'dark');
                  }}
                >
                  {isDark ? <Sun size={13} /> : <Moon size={13} />}
                  <span>
                    {locale === 'en'
                      ? isDark
                        ? 'Light Theme'
                        : 'Dark Theme'
                      : isDark
                      ? '切换浅色模式'
                      : '切换深色模式'}
                  </span>
                </button>
                <div className="gb-dropdown-sep" />
                <button
                  type="button"
                  className="gb-dropdown-item"
                  onClick={() => {
                    setMoreOpen(false);
                    void showMainWindow('settings');
                  }}
                >
                  <Settings size={13} />
                  <span>{t('menu.settings')}</span>
                </button>
                <div className="gb-dropdown-sep" />
                <button
                  type="button"
                  className="gb-dropdown-item danger"
                  onClick={() => {
                    setMoreOpen(false);
                    void quitApp();
                  }}
                >
                  <Power size={13} />
                  <span>{t('menu.quit')}</span>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* 3 Primary Tabs */}
        <div className="gb-segmented gb-segmented-full">
          {[
            t('menu_panel.tab.usage'),
            t('menu_panel.tab.quota'),
            t('menu_panel.tab.accounts'),
          ].map((label, idx) => (
            <button
              key={label}
              type="button"
              className={`gb-segmented-btn ${tab === idx ? 'active' : ''}`}
              onClick={() => selectTab(idx)}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      {/* Scrollable Tab Body */}
      <div className="gb-tray-content">
        {status.mode === 'debug-port-missing' && (
          <DebugPortBanner
            title={t('status.debug_port_missing')}
            body={t('debug_port_missing.banner_body')}
            buttonLabel={t('assistant.safe_relaunch_btn')}
            busy={relaunching}
            compact
            onRelaunch={() => void triggerSafeRelaunch()}
          />
        )}

        {/* TAB 0: USAGE */}
        {tab === 0 && (
          <div className="gb-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {/* Period Selector */}
            <div className="gb-segmented gb-segmented-full">
              {PERIODS.map((p, idx) => (
                <button
                  key={p}
                  type="button"
                  className={`gb-segmented-btn ${periodIdx === idx ? 'active' : ''}`}
                  style={
                    periodIdx === idx
                      ? { background: 'var(--blue-soft)', color: 'var(--blue)', boxShadow: 'none' }
                      : undefined
                  }
                  onClick={() => selectPeriod(idx)}
                >
                  {t(`menu_panel.period.${p}`)}
                </button>
              ))}
            </div>

            {/* Optional SSH Environment Filter (v1.2.0) */}
            {normalizedSshHosts.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, overflowX: 'auto' }}>
                <Server size={11} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
                <div className="gb-segmented" role="tablist" aria-label={t('menu_panel.env.a11y')}>
                  <button
                    type="button"
                    className={`gb-segmented-btn ${environmentId === 'all' ? 'active' : ''}`}
                    style={{ height: 21, padding: '0 7px', fontSize: 10.5 }}
                    onClick={() => selectEnvironment('all')}
                  >
                    {t('menu_panel.env.all')}
                  </button>
                  <button
                    type="button"
                    className={`gb-segmented-btn ${environmentId === 'local' ? 'active' : ''}`}
                    style={{ height: 21, padding: '0 7px', fontSize: 10.5 }}
                    onClick={() => selectEnvironment('local')}
                  >
                    {t('menu_panel.ssh.scope_local')}
                  </button>
                  {normalizedSshHosts.slice(0, 2).map((host) => (
                    <button
                      key={host.id}
                      type="button"
                      className={`gb-segmented-btn ${environmentId === host.id ? 'active' : ''}`}
                      style={{ height: 21, padding: '0 7px', fontSize: 10.5 }}
                      onClick={() => selectEnvironment(host.id)}
                    >
                      {host.hostLabel}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* 4 Metric Tiles (2x2) */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 7 }}>
              <div className="gb-tray-card" style={{ padding: '9px 11px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-secondary)', fontWeight: 500 }}>
                  <Sparkles size={11.5} />
                  <span>{t('menu_panel.tile.tokens')}</span>
                </div>
                <div className="tabular" style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.2, marginTop: 4 }}>
                  {formatCompactTokens(totalTokens, locale, true)}
                </div>
              </div>

              <div className="gb-tray-card" style={{ padding: '9px 11px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-secondary)', fontWeight: 500 }}>
                  <Send size={11} />
                  <span>{t('menu_panel.tile.requests')}</span>
                </div>
                <div className="tabular" style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.2, marginTop: 4 }}>
                  {formatInteger(reqCount, locale)}
                </div>
              </div>

              <div className="gb-tray-card" style={{ padding: '9px 11px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-secondary)', fontWeight: 500 }}>
                  <DollarSign size={11.5} />
                  <span>{t('menu_panel.tile.cost')}</span>
                </div>
                <div className="tabular" style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.2, marginTop: 4 }}>
                  {formatUsd(estUsd)}
                </div>
              </div>

              <div className="gb-tray-card" style={{ padding: '9px 11px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-secondary)', fontWeight: 500 }}>
                  <Zap size={11.5} />
                  <span>{t('menu_panel.tile.cache')}</span>
                </div>
                <div className="tabular" style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.2, marginTop: 4 }}>
                  {cacheHit.toFixed(1)}%
                </div>
              </div>
            </div>

            {/* Trend Card */}
            <div className="gb-tray-card" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>
                    {period === 'today'
                      ? t('menu_panel.trend.today')
                      : period === 'all'
                      ? t('menu_panel.trend.all')
                      : t('menu_panel.trend.period', { period: t(`menu_panel.period.${period}`) })}
                  </div>
                  {hoveredPt && (
                    <div className="tabular" style={{ fontSize: 10.5, color: 'var(--text-secondary)' }}>
                      {hoveredPt.isFuture
                        ? t('menu_panel.hover.future', { label: hoveredPt.tooltipLabel })
                        : metric === 'tokens'
                        ? t('menu_panel.hover.tokens', {
                            label: hoveredPt.tooltipLabel,
                            tokens: formatCompactTokens(hoveredPt.value, locale, true),
                          })
                        : t('menu_panel.hover.requests', {
                            label: hoveredPt.tooltipLabel,
                            count: formatInteger(hoveredPt.value, locale),
                          })}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 2 }}>
                  <button
                    type="button"
                    className="gb-segmented-btn"
                    style={{
                      height: 22,
                      padding: '0 9px',
                      fontSize: 11,
                      borderRadius: 6,
                      background: metric === 'tokens' ? 'var(--blue-soft)' : 'transparent',
                      color: metric === 'tokens' ? 'var(--blue)' : 'var(--text-secondary)',
                      fontWeight: metric === 'tokens' ? 600 : 500,
                    }}
                    onClick={() => selectMetric('tokens')}
                  >
                    {t('menu_panel.dim.tokens')}
                  </button>
                  <button
                    type="button"
                    className="gb-segmented-btn"
                    style={{
                      height: 22,
                      padding: '0 9px',
                      fontSize: 11,
                      borderRadius: 6,
                      background: metric === 'requests' ? 'var(--blue-soft)' : 'transparent',
                      color: metric === 'requests' ? 'var(--blue)' : 'var(--text-secondary)',
                      fontWeight: metric === 'requests' ? 600 : 500,
                    }}
                    onClick={() => selectMetric('requests')}
                  >
                    {t('menu_panel.dim.requests')}
                  </button>
                </div>
              </div>

              <TrendChart
                points={trendPoints}
                metric={metric}
                locale={locale}
                height={84}
                onHover={setHoveredPt}
              />
            </div>

            {/* Model Usage List Card */}
            <div className="gb-tray-card" style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>{t('menu_panel.models_header')}</span>
                <span className="tabular" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                  {modelRows.length > 0
                    ? t('menu_panel.models_count', { count: modelRows.length })
                    : t('menu_panel.models_none')}
                </span>
              </div>

              <div className="gb-divider" />

              {modelRows.length === 0 ? (
                <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', padding: '6px 0' }}>
                  {t('menu_panel.models_empty')}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {visibleModels.map((item) => {
                    const ratio = maxModelTokens > 0 ? Math.max(4, (item.totalTokens / maxModelTokens) * 100) : 0;
                    const name = localizedModelLabel(item.model, locale);
                    return (
                      <div key={item.model} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                            <BrandIcons fallbackName={name} size={14} isDark={isDark} />
                            <span
                              style={{
                                fontSize: 12,
                                fontWeight: 600,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {name}
                            </span>
                          </div>
                          <span className="tabular" style={{ fontSize: 12, fontWeight: 600, flexShrink: 0 }}>
                            {formatCompactTokens(item.totalTokens, locale)}
                          </span>
                        </div>
                        <div style={{ height: 4.5, borderRadius: 999, background: 'var(--track)', overflow: 'hidden' }}>
                          <div
                            style={{
                              width: `${ratio}%`,
                              height: '100%',
                              borderRadius: 999,
                              background: 'var(--blue-bright)',
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}

                  {modelRows.length > 3 && (
                    <button
                      type="button"
                      className="gb-btn gb-btn-sm"
                      style={{ alignSelf: 'flex-start', marginTop: 2 }}
                      onClick={() => setShowAllModels((v) => !v)}
                    >
                      {showAllModels
                        ? t('menu_panel.collapse_other_models')
                        : t('menu_panel.expand_n_models', { count: modelRows.length - 3 })}
                    </button>
                  )}
                </div>
              )}
            </div>

            {lastScannedAt > 0 && (
              <div className="tabular" style={{ fontSize: 10.5, color: 'var(--text-secondary)', textAlign: 'right' }}>
                {t('common.updated_at', { time: formatShortTime(lastScannedAt) })}
              </div>
            )}
          </div>
        )}

        {/* TAB 1: QUOTA */}
        {tab === 1 && (
          <div className="gb-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            {activeAccount || dashboard?.accounts?.activeEmail ? (
              <>
                <div className="gb-tray-card" style={{ padding: '11px 12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <span style={{ fontSize: 15, fontWeight: 700 }}>
                      {accountDisplayName(
                        activeAccount?.name ?? dashboard?.accounts?.activeName,
                        activeAccount?.email ?? dashboard?.accounts?.activeEmail,
                        locale,
                      )}
                    </span>
                    <TierBadge
                      tier={normalizeTier(
                        activeAccount?.subscription_tier ?? dashboard?.accounts?.activeTier,
                        locale,
                      )}
                    />
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>
                    {activeAccount?.email ?? dashboard?.accounts?.activeEmail}
                  </div>
                </div>

                <div className="gb-tray-card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 11 }}>
                  {quotaContract.displayGroups.length === 0 ? (
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                      {t('menu_panel.quota.no_record')}
                    </div>
                  ) : (
                    quotaContract.displayGroups.map((group, idx) => (
                      <div key={group.key} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {idx > 0 && <div className="gb-divider" />}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <BrandIcons brands={group.brands} fallbackName={group.displayName} size={14} isDark={isDark} />
                          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
                            {group.displayName}
                          </span>
                        </div>
                        {group.windows.map((win) => (
                          <QuotaMeterRow
                            key={`${group.key}-${win.id}`}
                            title={win.label}
                            showBrands={false}
                            window={win}
                            isDark={isDark}
                            compact
                          />
                        ))}
                      </div>
                    ))
                  )}
                </div>

                {quotaUpdatedTs > 0 && (
                  <div className="tabular" style={{ fontSize: 10.5, color: 'var(--text-secondary)', textAlign: 'right' }}>
                    {t('common.updated_at', { time: formatShortTime(quotaUpdatedTs) })}
                  </div>
                )}
              </>
            ) : (
              <div className="gb-tray-card" style={{ padding: 18, textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{t('menu_panel.quota.no_saved')}</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                  {t('menu_panel.quota.empty_hint')}
                </div>
                <button
                  type="button"
                  className="gb-btn gb-btn-primary gb-btn-sm"
                  onClick={() => void showMainWindow('accounts')}
                >
                  {t('menu_panel.quota.go_add_account')}
                </button>
              </div>
            )}
          </div>
        )}

        {/* TAB 2: ACCOUNTS */}
        {tab === 2 && (
          <div className="gb-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 2px' }}>
              <span style={{ fontSize: 12.5, fontWeight: 600 }}>{t('menu_panel.accounts.section_title')}</span>
              <span className="tabular" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                {t('menu_panel.accounts.count', { count: accounts.length })}
              </span>
            </div>

            {accounts.length === 0 ? (
              <div className="gb-tray-card" style={{ padding: 18, textAlign: 'center', fontSize: 12, color: 'var(--text-secondary)' }}>
                {reachable ? t('menu_panel.accounts.empty') : t('menu_panel.accounts.waiting_list')}
              </div>
            ) : (
              accounts.map((acc) => {
                const isActive = acc.id === activeAccountId;
                const expanded = expandedAccountIds.has(acc.id);
                const contract = parseQuotaContract(acc as Record<string, unknown>, locale, { compact: true });
                const tier = normalizeTier(acc.subscription_tier, locale);
                const updatedTs = Number(acc.quota_last_updated ?? acc.quotaLastUpdated ?? 0);

                return (
                  <div
                    key={acc.id}
                    className="gb-tray-card"
                    style={{
                      padding: '10px 11px',
                      border: isActive ? '1.25px solid var(--blue-border)' : undefined,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                    }}
                  >
                    <div
                      style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
                      onClick={() =>
                        setExpandedAccountIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(acc.id)) next.delete(acc.id);
                          else next.add(acc.id);
                          return next;
                        })
                      }
                    >
                      {isActive ? (
                        <CheckCircle2 size={16} style={{ color: 'var(--blue)', flexShrink: 0 }} />
                      ) : (
                        <Circle size={16} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                      )}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontSize: 13.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {accountDisplayName(acc.name, acc.email, locale)}
                          </span>
                          <TierBadge tier={tier} />
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {acc.email}
                        </div>
                      </div>
                      {expanded ? (
                        <ChevronUp size={14} style={{ color: 'var(--text-secondary)' }} />
                      ) : (
                        <ChevronDown size={14} style={{ color: 'var(--text-secondary)' }} />
                      )}
                    </div>

                    {expanded && (
                      <>
                        <div className="gb-divider" />
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                          {contract.displayGroups.map((group) =>
                            group.windows.map((win) => (
                              <QuotaMeterRow
                                key={`${group.key}-${win.id}`}
                                title={formatBarTitle(group, win, locale)}
                                showBrands={false}
                                window={win}
                                isDark={isDark}
                                compact
                              />
                            )),
                          )}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: 2 }}>
                          <span className="tabular" style={{ fontSize: 10.5, color: 'var(--text-secondary)' }}>
                            {updatedTs > 0 ? t('common.updated_at', { time: formatShortTime(updatedTs) }) : ''}
                          </span>
                          {isActive ? (
                            <button
                              type="button"
                              className="gb-btn gb-btn-sm"
                              disabled={!reachable || quotaRefreshing}
                              onClick={() => void refreshSingleAccountQuota(acc.id)}
                            >
                              {t('common.refresh_quota')}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="gb-btn gb-btn-primary gb-btn-sm"
                              disabled={!reachable || switchingAccount}
                              onClick={() => {
                                void interactiveSwitchAccount(acc);
                              }}
                            >
                              {t('menu_panel.account_card.switch_btn')}
                            </button>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* Footer Bar */}
      <footer className="gb-tray-footer">
        <button
          type="button"
          className="gb-btn gb-btn-sm gb-btn-pill"
          onClick={() => {
            void hideTrayWindow();
            void openAntigravity();
          }}
        >
          <ExternalLink size={12} />
          <span>{t('sidebar.open_antigravity')}</span>
        </button>

        <button
          type="button"
          className="gb-btn gb-btn-sm gb-btn-pill"
          onClick={() => void showMainWindow(footerMainTarget.page)}
        >
          <span>{footerMainTarget.label.replace(/\s*↗\s*$/, '')}</span>
          <ArrowUpRight size={12} />
        </button>
      </footer>

      <ToastBanner toast={toast} onClose={clearToast} />

      <Modal
        open={Boolean(confirmDialog)}
        onClose={() => confirmDialog?.resolve(false)}
        maxWidth={370}
      >
        {confirmDialog && (
          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <h4 style={{ margin: 0, fontSize: 14.5, fontWeight: 700 }}>{confirmDialog.title}</h4>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
              {confirmDialog.body}
            </div>
            <div className="gb-divider" />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="gb-btn gb-btn-sm" onClick={() => confirmDialog.resolve(false)}>
                {confirmDialog.cancelLabel || t('common.cancel')}
              </button>
              <button
                type="button"
                className={`gb-btn gb-btn-sm ${confirmDialog.danger ? 'gb-btn-danger' : 'gb-btn-primary'}`}
                onClick={() => confirmDialog.resolve(true)}
              >
                {confirmDialog.confirmLabel}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
