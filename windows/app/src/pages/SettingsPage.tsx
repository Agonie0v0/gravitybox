import { useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  DollarSign,
  Globe,
  HardDrive,
  Languages,
  Network,
  Power,
  Rocket,
  RotateCw,
  Server,
  SunMoon,
} from 'lucide-react';
import { ToggleSwitch } from '../components/ToggleSwitch';
import { useApp } from '../context/AppContext';
import { formatBytes, formatShortDateTime } from '../lib/format';
import {
  normalizeSshEnvironment,
  redactProxyUrl,
  sshStateI18nKey,
  sshStatePillClass,
  sshStateSortOrder,
} from '../lib/ssh';
import { backendRequest, getAutostart, setAutostart } from '../lib/tauri';
import type { LanguageSetting, PricingPayload, ProxyMode, ThemeMode } from '../lib/types';
import { MaintenanceModal } from '../sheets/MaintenanceModal';
import { PricingSyncModal } from '../sheets/PricingSyncModal';

const REFRESH_OPTIONS = [
  { value: 0, key: 'settings.refresh.manual' },
  { value: 5, key: 'settings.refresh.5m' },
  { value: 10, key: 'settings.refresh.10m' },
  { value: 15, key: 'settings.refresh.15m' },
  { value: 30, key: 'settings.refresh.30m' },
  { value: 60, key: 'settings.refresh.60m' },
];

function validateManualProxyInput(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  const candidate = trimmed.includes('://') ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (!parsed.hostname) return false;
    if (parsed.pathname && parsed.pathname !== '/') return false;
    if (parsed.search || parsed.hash) return false;
    const port = Number(parsed.port);
    return Number.isInteger(port) && port >= 1 && port <= 65535;
  } catch {
    return false;
  }
}

export function SettingsPage() {
  const {
    t,
    locale,
    config,
    updateConfig,
    languageSetting,
    setLanguage,
    themeMode,
    setThemeMode,
    reachable,
    status,
    maintenanceScan,
    proxyInfo,
    sshEnvironments,
    remoteSyncing,
    relaunching,
    toggleLocalization,
    toggleHud,
    fetchMaintenanceScan,
    fetchProxy,
    applyProxy,
    refreshRemoteEnvironments,
    triggerSafeRelaunch,
    showToast,
  } = useApp();

  const [autostartOn, setAutostartOn] = useState(false);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [pricingBusy, setPricingBusy] = useState(false);
  const [pricingChecking, setPricingChecking] = useState(false);
  const [pricingPayload, setPricingPayload] = useState<PricingPayload | null>(null);
  const [pricingOpen, setPricingOpen] = useState(false);
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);

  const [proxyModeDraft, setProxyModeDraft] = useState<ProxyMode>(
    proxyInfo?.mode ?? config.antigravityProxyMode ?? 'off',
  );
  const [proxyManualInput, setProxyManualInput] = useState<string>(
    proxyInfo?.manualUrl ?? config.antigravityProxyManualUrl ?? '',
  );
  const [proxyBusy, setProxyBusy] = useState(false);
  const [proxyError, setProxyError] = useState('');
  const [proxyDirtyRelaunch, setProxyDirtyRelaunch] = useState(false);

  useEffect(() => {
    void getAutostart().then(setAutostartOn).catch(() => {});
    if (reachable) {
      void fetchMaintenanceScan(7, false);
      void fetchProxy(false);
    }
  }, [fetchMaintenanceScan, fetchProxy, reachable]);

  useEffect(() => {
    const serverMode = proxyInfo?.mode ?? config.antigravityProxyMode ?? 'off';
    setProxyModeDraft(serverMode);
    if (proxyInfo?.manualUrl !== undefined) {
      setProxyManualInput(proxyInfo.manualUrl);
    } else if (config.antigravityProxyManualUrl) {
      setProxyManualInput(config.antigravityProxyManualUrl);
    }
  }, [proxyInfo?.mode, proxyInfo?.manualUrl, config.antigravityProxyMode, config.antigravityProxyManualUrl]);

  const normalizedSshHosts = useMemo(() => {
    const fallback = t('ssh.remote_fallback');
    return sshEnvironments
      .map((env) => normalizeSshEnvironment(env, fallback))
      .sort((a, b) => sshStateSortOrder(b.state) - sshStateSortOrder(a.state) || a.hostLabel.localeCompare(b.hostLabel));
  }, [sshEnvironments, t]);

  const onlineSshCount = useMemo(
    () => normalizedSshHosts.filter((h) => h.state === 'online' || h.state === 'auth_expired').length,
    [normalizedSshHosts],
  );

  const safeBytes =
    maintenanceScan?.buckets?.runtimeCache?.clearableBytes ?? maintenanceScan?.safeBytes ?? 0;
  const statefulBytes =
    maintenanceScan?.buckets?.historyLogs?.clearableBytes ?? maintenanceScan?.statefulBytes ?? 0;

  const storageBadge =
    safeBytes >= 10 * 1024 * 1024
      ? { label: t('settings.storage.reclaimable', { size: formatBytes(safeBytes) }), cls: 'gb-pill-blue' }
      : statefulBytes >= 50 * 1024 * 1024
      ? { label: t('settings.storage.slimmable', { size: formatBytes(statefulBytes) }), cls: 'gb-pill-neutral' }
      : safeBytes + statefulBytes > 0
      ? { label: t('settings.storage.healthy'), cls: 'gb-pill-neutral' }
      : null;

  const storageSubtitle =
    safeBytes > 0 && statefulBytes > 0
      ? t('settings.storage.detail_subtitle', {
          safe: formatBytes(safeBytes),
          stateful: formatBytes(statefulBytes),
        })
      : t('settings.storage.default_subtitle');

  const antigravityRunning =
    status.mode === 'connected' ||
    status.mode === 'adaptive' ||
    status.mode === 'waiting-window' ||
    status.mode === 'debug-port-missing' ||
    status.mode === 'paused';

  const proxyStatus = useMemo<{ text: string; tone: 'muted' | 'warning' | 'active'; showRelaunch: boolean }>(() => {
    if (proxyError) {
      return { text: proxyError, tone: 'warning', showRelaunch: false };
    }
    if (proxyModeDraft === 'off') {
      return {
        text: t('settings.proxy.status.disabled'),
        tone: 'muted',
        showRelaunch: proxyDirtyRelaunch && antigravityRunning,
      };
    }
    const source = proxyInfo?.source ?? (proxyModeDraft === 'manual' ? 'manual' : 'system');
    const redactedEffective = redactProxyUrl(proxyInfo?.effectiveUrl);

    if (proxyModeDraft === 'manual' && !proxyInfo?.effectiveUrl && !proxyManualInput.trim()) {
      return { text: t('settings.proxy.status.manual_prompt'), tone: 'muted', showRelaunch: false };
    }
    if (source === 'invalid_manual') {
      return { text: t('settings.proxy.status.invalid_manual'), tone: 'warning', showRelaunch: false };
    }
    if (source === 'system_unconfigured') {
      return { text: t('settings.proxy.status.system_not_configured'), tone: 'warning', showRelaunch: false };
    }
    if (source === 'system_pac_unsupported') {
      return { text: t('settings.proxy.status.system_pac'), tone: 'warning', showRelaunch: false };
    }
    if (source === 'system_socks_unsupported') {
      return { text: t('settings.proxy.status.system_socks_only'), tone: 'warning', showRelaunch: false };
    }
    if (redactedEffective) {
      if (antigravityRunning) {
        const key = proxyDirtyRelaunch
          ? proxyModeDraft === 'manual'
            ? 'settings.proxy.status.missing_manual'
            : 'settings.proxy.status.missing_system'
          : 'settings.proxy.status.matched';
        return {
          text: t(key, { url: redactedEffective }),
          tone: proxyDirtyRelaunch ? 'warning' : 'active',
          showRelaunch: true,
        };
      }
      return {
        text: t('settings.proxy.status.not_running', { url: redactedEffective }),
        tone: 'active',
        showRelaunch: false,
      };
    }
    return {
      text: proxyModeDraft === 'manual' ? t('settings.proxy.status.manual_prompt') : t('settings.proxy.status.disabled'),
      tone: 'muted',
      showRelaunch: false,
    };
  }, [antigravityRunning, proxyDirtyRelaunch, proxyError, proxyInfo, proxyManualInput, proxyModeDraft, t]);

  const handleProxyModeChange = async (nextMode: ProxyMode) => {
    setProxyModeDraft(nextMode);
    setProxyError('');
    if (nextMode === 'manual') {
      if (!proxyManualInput.trim()) {
        // Wait for user to type URL and click Apply
        return;
      }
      if (!validateManualProxyInput(proxyManualInput)) {
        setProxyError(t('settings.proxy.status.invalid_manual'));
        return;
      }
    }
    setProxyBusy(true);
    try {
      await applyProxy(nextMode, nextMode === 'manual' ? proxyManualInput.trim() : undefined);
      setProxyDirtyRelaunch(true);
    } catch (err) {
      setProxyError(err instanceof Error ? err.message : String(err));
    } finally {
      setProxyBusy(false);
    }
  };

  const handleApplyManualProxy = async () => {
    const trimmed = proxyManualInput.trim();
    if (!validateManualProxyInput(trimmed)) {
      setProxyError(t('settings.proxy.status.invalid_manual'));
      return;
    }
    setProxyError('');
    setProxyBusy(true);
    try {
      const updated = await applyProxy('manual', trimmed);
      setProxyModeDraft(updated.mode);
      setProxyManualInput(updated.manualUrl || trimmed);
      setProxyDirtyRelaunch(true);
      showToast(
        locale === 'en'
          ? `Proxy applied (${redactProxyUrl(updated.effectiveUrl || trimmed)})`
          : `已应用代理（${redactProxyUrl(updated.effectiveUrl || trimmed)}）`,
      );
    } catch (err) {
      setProxyError(err instanceof Error ? err.message : String(err));
    } finally {
      setProxyBusy(false);
    }
  };

  const handleToggleAutostart = async (next: boolean) => {
    setAutostartBusy(true);
    try {
      await setAutostart(next);
      setAutostartOn(next);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true);
    } finally {
      setAutostartBusy(false);
    }
  };

  const handleTogglePricingSync = async (enabled: boolean) => {
    setPricingBusy(true);
    try {
      await backendRequest({ command: 'pricing_sync_set', enabled });
      await updateConfig({ autoPricingSyncEnabled: enabled });
    } catch {
      showToast(t('settings.pricing_sync.update_failed'), true);
    } finally {
      setPricingBusy(false);
    }
  };

  const handleCheckPricingNow = async () => {
    if (pricingChecking) return;
    setPricingChecking(true);
    try {
      const payload = await backendRequest<PricingPayload>({ command: 'pricing_sync_check' });
      setPricingPayload(payload);
      setPricingOpen(true);
    } catch (err) {
      showToast(
        t('settings.pricing_sync.sync_failed', { error: err instanceof Error ? err.message : String(err) }),
        true,
      );
    } finally {
      setPricingChecking(false);
    }
  };

  const translationOn = status.translationEnabled !== false && status.mode !== 'paused';
  const hudOn = status.hudEnabled ?? config.hudEnabled;

  return (
    <div className="gb-page-inner gb-fade-in">
      <div className="gb-page-header">
        <h1 className="gb-page-title">{t('settings.title')}</h1>
      </div>

      {/* Section 1: Antigravity Enhancements */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)', paddingLeft: 2 }}>
          {t('settings.section.enhance')}
        </div>
        <div className="gb-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 13 }}>
          {/* Display Language */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div
              className="gb-icon-badge"
              style={{ background: 'var(--success-soft)', border: '0.5px solid var(--success-border)', color: 'var(--success)' }}
            >
              <Globe size={14} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{t('settings.language.title')}</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                {t('settings.language.subtitle')}
              </div>
            </div>
            <select
              className="gb-select"
              style={{ minWidth: 128 }}
              value={languageSetting}
              onChange={(e) => void setLanguage(e.target.value as LanguageSetting)}
            >
              <option value="system">{t('language.system')}</option>
              <option value="zh-Hans">简体中文</option>
              <option value="en">English</option>
            </select>
          </div>

          <div className="gb-divider" />

          {/* Interface Bilingual Hot Localization Toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div
              className="gb-icon-badge"
              style={{ background: 'var(--blue-soft)', border: '0.5px solid var(--blue-border)', color: 'var(--blue)' }}
            >
              <Languages size={14} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                {locale === 'en' ? 'Interface Hot-Localization' : '界面热汉化'}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                {locale === 'en'
                  ? 'Non-invasively translate Antigravity UI via isolated CDP world'
                  : '通过 CDP 隔离世界实时汉化 Antigravity 界面，随时可一键撤销'}
              </div>
            </div>
            <ToggleSwitch
              checked={translationOn}
              disabled={!reachable || status.mode === 'unsupported'}
              onChange={(next) => void toggleLocalization(next)}
            />
          </div>

          <div className="gb-divider" />

          {/* Session HUD */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div
              className="gb-icon-badge"
              style={{ background: 'rgba(99, 102, 241, 0.13)', border: '0.5px solid rgba(99, 102, 241, 0.28)', color: '#6366f1' }}
            >
              <BarChart3 size={14} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{t('settings.hud.title')}</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                {t('settings.hud.subtitle')}
              </div>
            </div>
            <ToggleSwitch
              checked={hudOn}
              disabled={!reachable || status.mode === 'unsupported'}
              onChange={(next) => void toggleHud(next)}
              ariaLabel={t('settings.hud.title')}
            />
          </div>

          <div className="gb-divider" />

          {/* Proxy Forwarding (No TUN) - v1.2.0 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div
                className="gb-icon-badge"
                style={{ background: 'var(--blue-soft)', border: '0.5px solid var(--blue-border)', color: 'var(--blue)' }}
              >
                <Network size={14} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{t('settings.proxy.title')}</div>
                <div
                  style={{
                    fontSize: 11,
                    color:
                      proxyStatus.tone === 'warning'
                        ? 'var(--warning)'
                        : proxyStatus.tone === 'active'
                        ? 'var(--blue)'
                        : 'var(--text-secondary)',
                    marginTop: 2,
                    lineHeight: 1.45,
                  }}
                >
                  {proxyStatus.text}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                {proxyStatus.showRelaunch && (
                  <button
                    type="button"
                    className="gb-btn gb-btn-primary gb-btn-sm"
                    disabled={relaunching || proxyBusy}
                    onClick={() => {
                      setProxyDirtyRelaunch(false);
                      void triggerSafeRelaunch();
                    }}
                  >
                    <RotateCw size={11.5} className={relaunching ? 'gb-spin' : undefined} />
                    <span>{t('settings.proxy.relaunch_btn')}</span>
                  </button>
                )}
                <select
                  className="gb-select"
                  style={{ minWidth: 128 }}
                  aria-label={t('settings.proxy.title')}
                  disabled={!reachable || proxyBusy}
                  value={proxyModeDraft}
                  onChange={(e) => void handleProxyModeChange(e.target.value as ProxyMode)}
                >
                  <option value="off">{t('settings.proxy.mode.off')}</option>
                  <option value="system">{t('settings.proxy.mode.system')}</option>
                  <option value="manual">{t('settings.proxy.mode.manual')}</option>
                </select>
              </div>
            </div>

            {proxyModeDraft === 'manual' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 40 }}>
                <input
                  type="text"
                  className="gb-input"
                  style={{ flex: 1 }}
                  aria-label={t('settings.proxy.manual_url_a11y')}
                  placeholder="http://127.0.0.1:7890"
                  disabled={!reachable || proxyBusy}
                  value={proxyManualInput}
                  onChange={(e) => {
                    setProxyManualInput(e.target.value);
                    if (proxyError) setProxyError('');
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleApplyManualProxy();
                  }}
                />
                <button
                  type="button"
                  className="gb-btn gb-btn-sm"
                  disabled={!reachable || proxyBusy || !proxyManualInput.trim()}
                  onClick={() => void handleApplyManualProxy()}
                >
                  {t('settings.proxy.apply_btn')}
                </button>
              </div>
            )}
          </div>

          <div className="gb-divider" />

          {/* Appearance Theme */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div
              className="gb-icon-badge"
              style={{ background: 'rgba(139, 92, 246, 0.13)', border: '0.5px solid rgba(139, 92, 246, 0.28)', color: '#8b5cf6' }}
            >
              <SunMoon size={14} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                {locale === 'en' ? 'Appearance Theme' : '外观主题'}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                {locale === 'en'
                  ? 'Follow Windows 11 system appearance or switch manually'
                  : '跟随 Windows 11 系统深浅色模式或手动切换'}
              </div>
            </div>
            <select
              className="gb-select"
              style={{ minWidth: 128 }}
              value={themeMode}
              onChange={(e) => void setThemeMode(e.target.value as ThemeMode)}
            >
              <option value="system">{locale === 'en' ? 'Follow System' : '跟随系统'}</option>
              <option value="light">{locale === 'en' ? 'Light' : '浅色'}</option>
              <option value="dark">{locale === 'en' ? 'Dark' : '深色'}</option>
            </select>
          </div>
        </div>
      </div>

      {/* Section 2: Quota, Pricing & SSH Remote Sync */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)', paddingLeft: 2 }}>
          {t('settings.section.quota_pricing')}
        </div>
        <div className="gb-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 13 }}>
          {/* Quota Refresh Interval */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div
              className="gb-icon-badge"
              style={{ background: 'var(--blue-soft)', border: '0.5px solid var(--blue-border)', color: 'var(--blue)' }}
            >
              <RotateCw size={14} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{t('settings.refresh.title')}</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                {t('settings.refresh.subtitle')}
              </div>
            </div>
            <select
              className="gb-select"
              style={{ minWidth: 128 }}
              value={config.quotaRefreshMinutes}
              onChange={(e) => void updateConfig({ quotaRefreshMinutes: Number(e.target.value) })}
            >
              {REFRESH_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {t(opt.key)}
                </option>
              ))}
            </select>
          </div>

          <div className="gb-divider" />

          {/* Auto-Sync Pricing Feed */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div
              className="gb-icon-badge"
              style={{ background: 'var(--blue-soft)', border: '0.5px solid var(--blue-border)', color: 'var(--blue)' }}
            >
              <DollarSign size={14} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{t('settings.pricing_sync.title')}</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                {t('settings.pricing_sync.subtitle')}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                type="button"
                className="gb-btn gb-btn-sm"
                disabled={!reachable || pricingChecking}
                onClick={() => void handleCheckPricingNow()}
              >
                <RotateCw size={12} className={pricingChecking ? 'gb-spin' : undefined} />
                <span>{t('settings.pricing_sync.check_now')}</span>
              </button>
              <ToggleSwitch
                checked={config.autoPricingSyncEnabled}
                disabled={!reachable || pricingBusy}
                onChange={(next) => void handleTogglePricingSync(next)}
                ariaLabel={t('settings.pricing_sync.title')}
              />
            </div>
          </div>

          <div className="gb-divider" />

          {/* SSH Remote Environments & Sync - v1.2.0 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div
                className="gb-icon-badge"
                style={{
                  background: onlineSshCount > 0 ? 'var(--success-soft)' : 'var(--subcard)',
                  border: `0.5px solid ${onlineSshCount > 0 ? 'var(--success-border)' : 'var(--border-strong)'}`,
                  color: onlineSshCount > 0 ? 'var(--success)' : 'var(--text-secondary)',
                }}
              >
                <Server size={14} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>
                    {locale === 'en' ? 'SSH Remote Sync' : 'SSH 远端环境与同步'}
                  </span>
                  <span className={`gb-pill ${onlineSshCount > 0 ? 'gb-pill-success' : 'gb-pill-neutral'}`}>
                    {onlineSshCount > 0
                      ? t('ssh.context.all_online_badge', { count: onlineSshCount })
                      : t('ssh.context.local_scope_badge')}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.45 }}>
                  {normalizedSshHosts.length > 0
                    ? t('ssh.context.accounts_local_only_note')
                    : locale === 'en'
                    ? 'Automatically detects Remote-SSH Antigravity windows to aggregate remote quota & usage (read-only).'
                    : '自动发现 Antigravity 的 Remote-SSH 窗口，只读汇总远端配额与 Token 用量。'}
                </div>
              </div>
              <button
                type="button"
                className="gb-btn gb-btn-sm"
                disabled={!reachable || remoteSyncing}
                onClick={() => void refreshRemoteEnvironments()}
              >
                <RotateCw size={12} className={remoteSyncing ? 'gb-spin' : undefined} />
                <span>{locale === 'en' ? 'Sync Now' : '立即同步'}</span>
              </button>
            </div>

            {normalizedSshHosts.length > 0 && (
              <div style={{ paddingLeft: 40, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {normalizedSshHosts.map((host) => (
                  <div
                    key={host.id || host.hostLabel}
                    className="gb-subcard"
                    style={{
                      padding: '8px 11px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 10,
                    }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 12, fontWeight: 600 }}>{host.hostLabel}</span>
                        <span className={`gb-pill ${sshStatePillClass(host.state)}`}>
                          {t(sshStateI18nKey(host.state))}
                        </span>
                        {host.windowCount > 0 && (
                          <span style={{ fontSize: 10.5, color: 'var(--text-secondary)' }}>
                            {t('accounts.ssh.remote_window_count', { count: host.windowCount })}
                          </span>
                        )}
                      </div>
                      <div
                        className="tabular"
                        style={{
                          fontSize: 10.5,
                          color: 'var(--text-secondary)',
                          marginTop: 2,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {[
                          host.email || t('ssh.context.remote_readonly_badge'),
                          host.lastUsageSyncedAt > 0
                            ? t('common.updated_at', { time: formatShortDateTime(host.lastUsageSyncedAt) })
                            : host.quotaLastUpdated > 0
                            ? t('common.updated_at', { time: formatShortDateTime(host.quotaLastUpdated) })
                            : '',
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="gb-btn gb-btn-ghost gb-btn-sm"
                      disabled={!reachable || remoteSyncing}
                      onClick={() => void refreshRemoteEnvironments(host.id)}
                    >
                      <RotateCw size={11} className={remoteSyncing ? 'gb-spin' : undefined} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Section 3: System & Storage */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)', paddingLeft: 2 }}>
          {t('settings.section.system_storage')}
        </div>
        <div className="gb-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 13 }}>
          {/* Launch at Windows Login */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div
              className="gb-icon-badge"
              style={{ background: 'var(--subcard)', border: '0.5px solid var(--border-strong)', color: 'var(--text-secondary)' }}
            >
              <Power size={14} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{t('settings.login.title')}</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                {t('settings.login.subtitle')}
              </div>
            </div>
            <ToggleSwitch
              checked={autostartOn}
              disabled={autostartBusy}
              onChange={(next) => void handleToggleAutostart(next)}
              ariaLabel={t('settings.login.title')}
            />
          </div>

          <div className="gb-divider" />

          {/* Auto-Open Antigravity on Launch - v1.2.0 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div
              className="gb-icon-badge"
              style={{ background: 'rgba(13, 148, 136, 0.12)', border: '0.5px solid rgba(13, 148, 136, 0.25)', color: '#0d9488' }}
            >
              <Rocket size={14} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{t('settings.launch_antigravity.title')}</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                {t('settings.launch_antigravity.subtitle')}
              </div>
            </div>
            <ToggleSwitch
              checked={config.launchAntigravityOnStart}
              onChange={(next) => void updateConfig({ launchAntigravityOnStart: next })}
              ariaLabel={t('settings.launch_antigravity.title')}
            />
          </div>

          <div className="gb-divider" />

          {/* Storage & Maintenance */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div
              className="gb-icon-badge"
              style={{ background: 'var(--warning-soft)', border: '0.5px solid var(--warning-border)', color: 'var(--warning)' }}
            >
              <HardDrive size={14} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{t('settings.storage.title')}</span>
                {storageBadge && <span className={`gb-pill ${storageBadge.cls}`}>{storageBadge.label}</span>}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                {storageSubtitle}
              </div>
            </div>
            <button
              type="button"
              className="gb-btn gb-btn-sm"
              disabled={!reachable}
              onClick={() => setMaintenanceOpen(true)}
            >
              {t('settings.storage.manage_btn')}
            </button>
          </div>
        </div>
      </div>

      <PricingSyncModal
        open={pricingOpen}
        initialPayload={pricingPayload}
        onClose={() => setPricingOpen(false)}
      />
      <MaintenanceModal open={maintenanceOpen} onClose={() => setMaintenanceOpen(false)} />
    </div>
  );
}
