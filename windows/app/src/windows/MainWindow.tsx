import {
  BarChart2,
  ExternalLink,
  Info,
  LayoutGrid,
  Moon,
  Settings,
  Sun,
  Users,
} from 'lucide-react';
import { BrandMark } from '../components/BrandMark';
import { Modal } from '../components/Modal';
import { ToastBanner } from '../components/Toast';
import { useApp } from '../context/AppContext';
import type { PageKey } from '../lib/types';
import { AboutPage } from '../pages/AboutPage';
import { AccountsPage } from '../pages/AccountsPage';
import { OverviewPage } from '../pages/OverviewPage';
import { SettingsPage } from '../pages/SettingsPage';
import { UsagePage } from '../pages/UsagePage';

const NAV_ITEMS: Array<{ key: PageKey; labelKey: string; Icon: typeof LayoutGrid }> = [
  { key: 'overview', labelKey: 'nav.overview', Icon: LayoutGrid },
  { key: 'accounts', labelKey: 'nav.accounts', Icon: Users },
  { key: 'usage', labelKey: 'nav.usage', Icon: BarChart2 },
  { key: 'settings', labelKey: 'nav.settings', Icon: Settings },
  { key: 'about', labelKey: 'nav.about', Icon: Info },
];

export function MainWindow() {
  const {
    t,
    locale,
    isDark,
    setThemeMode,
    activePage,
    setActivePage,
    reachable,
    status,
    openAntigravity,
    toast,
    clearToast,
    confirmDialog,
  } = useApp();

  const statusDotColor = !reachable
    ? 'var(--danger)'
    : status.mode === 'connected' || status.mode === 'adaptive'
    ? 'var(--success)'
    : status.mode === 'debug-port-missing' || status.mode === 'unsupported'
    ? 'var(--warning)'
    : 'var(--text-tertiary)';

  return (
    <div className="gb-shell">
      {/* Left Sidebar */}
      <aside className="gb-sidebar" aria-label={t('nav.accessibility')}>
        <div className="gb-sidebar-brand">
          <BrandMark size={22} />
          <span className="gb-sidebar-brand-name">GravityBox</span>
        </div>

        <nav className="gb-nav-list">
          {NAV_ITEMS.map(({ key, labelKey, Icon }) => {
            const active = activePage === key;
            return (
              <button
                key={key}
                type="button"
                className={`gb-nav-item ${active ? 'active' : ''}`}
                onClick={() => setActivePage(key)}
              >
                <Icon size={16} strokeWidth={active ? 2.2 : 1.8} />
                <span>{t(labelKey)}</span>
              </button>
            );
          })}
        </nav>

        <div className="gb-sidebar-footer">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '2px 8px 4px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  background: statusDotColor,
                  flexShrink: 0,
                }}
              />
              <span
                style={{
                  fontSize: 11,
                  color: 'var(--text-secondary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {!reachable
                  ? t('sidebar.waiting_service')
                  : status.mode === 'connected' || status.mode === 'adaptive'
                  ? t('status.connected')
                  : status.mode === 'debug-port-missing'
                  ? t('status.debug_port_missing')
                  : status.mode === 'unsupported'
                  ? t('status.unsupported')
                  : status.mode === 'paused'
                  ? t('status.paused')
                  : t('status.waiting_app')}
              </span>
            </div>
            <button
              type="button"
              className="gb-btn gb-btn-ghost gb-icon-btn"
              style={{ width: 24, height: 24 }}
              title={locale === 'en' ? 'Toggle Light/Dark Theme' : '切换浅色/深色主题'}
              onClick={() => void setThemeMode(isDark ? 'light' : 'dark')}
            >
              {isDark ? <Sun size={13} /> : <Moon size={13} />}
            </button>
          </div>

          <button
            type="button"
            className="gb-nav-item"
            style={{ fontSize: 12.5, height: 32 }}
            onClick={() => void openAntigravity()}
          >
            <ExternalLink size={14} />
            <span>{t('sidebar.open_antigravity')}</span>
          </button>
        </div>
      </aside>

      {/* Main Scrollable Content Pane */}
      <main className="gb-main-area">
        <div className="gb-page-scroll">
          {activePage === 'overview' && <OverviewPage />}
          {activePage === 'accounts' && <AccountsPage />}
          {activePage === 'usage' && <UsagePage />}
          {activePage === 'settings' && <SettingsPage />}
          {activePage === 'about' && <AboutPage />}
        </div>
      </main>

      <ToastBanner toast={toast} onClose={clearToast} />

      {/* Global Confirmation Dialog */}
      <Modal
        open={Boolean(confirmDialog)}
        onClose={() => confirmDialog?.resolve(false)}
        maxWidth={430}
      >
        {confirmDialog && (
          <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <h3 style={{ margin: 0, fontSize: 15.5, fontWeight: 700, lineHeight: 1.35 }}>
              {confirmDialog.title}
            </h3>
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5, whiteSpace: 'pre-line' }}>
              {confirmDialog.body}
            </div>
            <div className="gb-divider" />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                className="gb-btn"
                onClick={() => confirmDialog.resolve(false)}
              >
                {confirmDialog.cancelLabel || t('common.cancel')}
              </button>
              <button
                type="button"
                className={`gb-btn ${confirmDialog.danger ? 'gb-btn-danger' : 'gb-btn-primary'}`}
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
