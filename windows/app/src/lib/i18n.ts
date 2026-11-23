import zhHansPack from '@root-assets/i18n/zh-Hans.json';
import enPack from '@root-assets/i18n/en.json';
import type { LanguageSetting } from './types';

export type ResolvedLocale = 'zh-Hans' | 'en';

interface I18nPack {
  meta: { code: string; nativeName: string };
  app: Record<string, string>;
  backend: Record<string, string>;
}

const PACKS: Record<ResolvedLocale, I18nPack> = {
  'zh-Hans': zhHansPack as I18nPack,
  en: enPack as I18nPack,
};

// Windows-specific phrasing polish for macOS-only OS names ("Finder" -> "资源管理器"/"Explorer", "macOS" -> "Windows")
const WINDOWS_OVERRIDES: Record<ResolvedLocale, Record<string, string>> = {
  'zh-Hans': {
    'settings.login.subtitle': '登录 Windows 时自动在系统托盘驻留',
    'settings.launch_antigravity.subtitle': '打开 GravityBox 时静默驻留系统托盘，并自动拉起带调试端口的 Antigravity',
    'settings.proxy.status.system_not_configured': '当前未检测到 Windows HTTP/HTTPS 系统代理，请先在代理工具开启系统代理或改用「手动指定」',
    'oauth.err.missing_client': '未配置 Google OAuth 凭据，无法使用浏览器授权登录。请改用「保存当前账号」，或在本机 %APPDATA%\\GravityBox\\.env 中配置 GRAVITYBOX_GOOGLE_CLIENT_ID 与 GRAVITYBOX_GOOGLE_CLIENT_SECRET',
    'about.reveal_data': '在资源管理器中显示',
    'maintenance.simple.btn_show_finder': '在资源管理器中查看',
    'menu_panel.quota.empty_footer': '保存账号后即可在系统托盘实时查看各模型周期配额',
  },
  en: {
    'settings.login.subtitle': 'Automatically stay in the system tray when signing into Windows',
    'settings.launch_antigravity.subtitle': 'Stay in the system tray and automatically launch Antigravity with debugging enabled',
    'settings.proxy.status.system_not_configured': 'No Windows HTTP/HTTPS system proxy detected. Enable System Proxy in your proxy app or use Manual Proxy.',
    'oauth.err.missing_client': 'Google OAuth credentials are not configured. Use "Save Current Account" instead, or configure GRAVITYBOX_GOOGLE_CLIENT_ID and GRAVITYBOX_GOOGLE_CLIENT_SECRET in %APPDATA%\\GravityBox\\.env',
    'about.reveal_data': 'Show in Explorer',
    'maintenance.simple.btn_show_finder': 'Show in Explorer',
    'menu_panel.quota.empty_footer': 'Save an account to monitor model quotas in the system tray',
  },
};

export function resolveLocale(setting: string | null | undefined): ResolvedLocale {
  const raw = (setting ?? 'system').trim().toLowerCase();
  if (raw === 'en' || raw.startsWith('en-')) return 'en';
  if (raw === 'zh' || raw.startsWith('zh-')) return 'zh-Hans';
  const navLangs = typeof navigator !== 'undefined'
    ? [navigator.language, ...(navigator.languages ?? [])].filter(Boolean)
    : ['zh-CN'];
  for (const lang of navLangs) {
    const l = lang.toLowerCase();
    if (l.startsWith('zh')) return 'zh-Hans';
    if (l.startsWith('en')) return 'en';
  }
  return 'zh-Hans';
}

export function normalizeLanguageSetting(setting: string | null | undefined): LanguageSetting {
  const raw = (setting ?? 'system').trim().toLowerCase();
  if (raw === 'en' || raw.startsWith('en-')) return 'en';
  if (raw === 'zh' || raw.startsWith('zh-')) return 'zh-Hans';
  return 'system';
}

export function translate(
  locale: ResolvedLocale,
  key: string,
  params?: Record<string, string | number>,
  fallback?: string,
): string {
  const pack = PACKS[locale] ?? PACKS['zh-Hans'];
  const enFallback = PACKS.en;
  let template =
    WINDOWS_OVERRIDES[locale]?.[key] ??
    pack.app[key] ??
    pack.backend[key] ??
    WINDOWS_OVERRIDES.en?.[key] ??
    enFallback.app[key] ??
    enFallback.backend[key] ??
    fallback ??
    key;

  if (params) {
    for (const [k, v] of Object.entries(params)) {
      template = template.split(`{${k}}`).join(String(v));
    }
  }
  return template;
}

export function getSystemLocales(): string[] {
  if (typeof navigator === 'undefined') return ['zh-CN'];
  const list = [...(navigator.languages ?? []), navigator.language].filter(Boolean);
  return list.length > 0 ? Array.from(new Set(list)) : ['zh-CN'];
}
