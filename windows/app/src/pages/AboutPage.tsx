import { Box, Copy, Cpu, ExternalLink, Folder, ShieldCheck } from 'lucide-react';
import { BrandMark } from '../components/BrandMark';
import { ToggleSwitch } from '../components/ToggleSwitch';
import { useApp } from '../context/AppContext';
import { openExternalUrl, openFolder } from '../lib/tauri';

const RELEASES_URL = 'https://github.com/Enzoo404/gravitybox/releases';

export function AboutPage() {
  const { t, locale, config, updateConfig, appInfo, status, showToast } = useApp();

  const version = appInfo?.version ?? '1.1.3';
  const agVersion = appInfo?.antigravity?.version || (status.appVersion && status.appVersion !== 'fixture' ? status.appVersion : '');
  const targetAppDisplay = agVersion ? `Antigravity ${agVersion}` : t('about.antigravity_stable');
  const stateDir = appInfo?.stateDir ?? '';

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(locale === 'en' ? 'Copied to clipboard' : '已复制到剪贴板');
    } catch {
      // Ignore clipboard error
    }
  };

  return (
    <div className="gb-page-inner gb-fade-in">
      <div className="gb-page-header">
        <h1 className="gb-page-title">{t('about.title')}</h1>
      </div>

      {/* Hero Card */}
      <div className="gb-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: 12,
                background: 'var(--pill-neutral-bg)',
                border: '0.75px solid var(--pill-neutral-border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <BrandMark size={30} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 18, fontWeight: 700 }}>GravityBox</span>
                <span className="gb-pill gb-pill-blue">v{version}</span>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 3 }}>
                {locale === 'en'
                  ? 'Native Windows Companion for Antigravity · Localization, Quota, Accounts & Usage'
                  : 'Antigravity Windows 原生伴侣 · 双语热汉化、配额监控、多账号切换与用量统计'}
              </div>
            </div>
          </div>
          <button
            type="button"
            className="gb-btn gb-btn-sm"
            onClick={() => void openExternalUrl(RELEASES_URL)}
          >
            <span>{t('about.check_update')}</span>
            <ExternalLink size={11} />
          </button>
        </div>

        <div className="gb-divider" />

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{t('about.auto_update')}</span>
          <ToggleSwitch
            checked={config.autoUpdateEnabled}
            onChange={(next) => void updateConfig({ autoUpdateEnabled: next })}
            ariaLabel={t('about.auto_update')}
          />
        </div>
      </div>

      {/* Runtime Info Card */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)', paddingLeft: 2 }}>
          {t('about.section.runtime')}
        </div>
        <div className="gb-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
              <div
                className="gb-icon-badge"
                style={{ background: 'rgba(99, 102, 241, 0.13)', border: '0.5px solid rgba(99, 102, 241, 0.28)', color: '#6366f1' }}
              >
                <Cpu size={14} />
              </div>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{t('about.target_app')}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="tabular selectable" style={{ fontSize: 12.5, fontWeight: 500 }}>
                {targetAppDisplay}
              </span>
              <button
                type="button"
                className="gb-btn gb-btn-ghost gb-icon-btn"
                title={t('about.copy_version_info')}
                onClick={() =>
                  void copyText(
                    `GravityBox v${version} · ${targetAppDisplay} · ${appInfo?.osLabel ?? 'Windows'}`,
                  )
                }
              >
                <Copy size={12} />
              </button>
            </div>
          </div>

          <div className="gb-divider" />

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 11, flexShrink: 0 }}>
              <div
                className="gb-icon-badge"
                style={{ background: 'var(--warning-soft)', border: '0.5px solid var(--warning-border)', color: 'var(--warning)' }}
              >
                <Folder size={14} />
              </div>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{t('about.data_dir')}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <span
                className="selectable"
                style={{
                  fontSize: 12,
                  color: 'var(--text-secondary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={stateDir}
              >
                {stateDir}
              </span>
              <button
                type="button"
                className="gb-btn gb-btn-sm"
                disabled={!stateDir}
                onClick={() => stateDir && void openFolder(stateDir).catch((e) => showToast(String(e), true))}
              >
                {t('about.reveal_data')}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Open Source & Privacy Card */}
      <div className="gb-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
            <div
              className="gb-icon-badge"
              style={{ background: 'var(--blue-soft)', border: '0.5px solid var(--blue-border)', color: 'var(--blue)' }}
            >
              <Box size={14} />
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>GitHub Releases</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                MIT License · github.com/Enzoo404/gravitybox
              </div>
            </div>
          </div>
          <button
            type="button"
            className="gb-btn gb-btn-sm"
            onClick={() => void openExternalUrl(RELEASES_URL)}
          >
            <span>GitHub ↗</span>
          </button>
        </div>

        <div className="gb-divider" />

        <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
          <div
            className="gb-icon-badge"
            style={{ background: 'var(--success-soft)', border: '0.5px solid var(--success-border)', color: 'var(--success)' }}
          >
            <ShieldCheck size={14} />
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
            {locale === 'en'
              ? 'Zero third-party telemetry. Antigravity binaries and app.asar are never modified; credentials remain stored locally in Windows Credential Manager.'
              : '零第三方遥测外联。绝不修改官方 Antigravity.exe 与 app.asar，所有账号凭据均仅安全存储于本机 Windows Credential Manager。'}
          </div>
        </div>
      </div>
    </div>
  );
}
