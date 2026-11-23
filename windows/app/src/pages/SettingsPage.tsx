import { useEffect, useState } from 'react';
import {
  BarChart3,
  DollarSign,
  Globe,
  HardDrive,
  Languages,
  Link2,
  Power,
  RotateCw,
  SunMoon,
} from 'lucide-react';
import { ToggleSwitch } from '../components/ToggleSwitch';
import { useApp } from '../context/AppContext';
import { formatBytes } from '../lib/format';
import { backendRequest, getAutostart, setAutostart } from '../lib/tauri';
import type { LanguageSetting, PricingPayload, ThemeMode } from '../lib/types';
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
    toggleLocalization,
    toggleHud,
    fetchMaintenanceScan,
    showToast,
  } = useApp();

  const [autostartOn, setAutostartOn] = useState(false);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [pricingBusy, setPricingBusy] = useState(false);
  const [pricingChecking, setPricingChecking] = useState(false);
  const [pricingPayload, setPricingPayload] = useState<PricingPayload | null>(null);
  const [pricingOpen, setPricingOpen] = useState(false);
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);

  useEffect(() => {
    void getAutostart().then(setAutostartOn).catch(() => {});
    if (reachable) {
      void fetchMaintenanceScan(7, false);
    }
  }, [fetchMaintenanceScan, reachable]);

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
              style={{ minWidth: 120 }}
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
              style={{ minWidth: 120 }}
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

      {/* Section 2: Quota & Pricing */}
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
              style={{ minWidth: 120 }}
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

          {/* Sync Antigravity Lifecycle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div
              className="gb-icon-badge"
              style={{ background: 'rgba(13, 148, 136, 0.12)', border: '0.5px solid rgba(13, 148, 136, 0.25)', color: '#0d9488' }}
            >
              <Link2 size={14} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{t('settings.sync_lifecycle.title')}</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                {t('settings.sync_lifecycle.subtitle')}
              </div>
            </div>
            <ToggleSwitch
              checked={config.syncAntigravityLifecycle}
              onChange={(next) => void updateConfig({ syncAntigravityLifecycle: next })}
              ariaLabel={t('settings.sync_lifecycle.title')}
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
