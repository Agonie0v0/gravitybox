import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open as dialogOpen, save as dialogSave } from '@tauri-apps/plugin-dialog';
import type { AppInfo, GracefulCloseOutcome, SafeRelaunchResult, UiConfig } from './types';

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function backendRequest<T = Record<string, unknown>>(
  payload: Record<string, unknown>,
): Promise<T> {
  if (!isTauriRuntime()) {
    throw new Error('Not running inside GravityBox desktop runtime');
  }
  return invoke<T>('backend_request', { payload });
}

export async function restartBackend(): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke('restart_backend');
}

export async function getAppInfo(): Promise<AppInfo> {
  if (!isTauriRuntime()) {
    return {
      version: '1.2.0',
      stateDir: 'C:\\Users\\demo\\AppData\\Roaming\\GravityBox',
      pipeName: '\\\\.\\pipe\\gravitybox-dev',
      osLabel: 'Windows x86_64',
      antigravity: {
        installDir: 'C:\\Users\\demo\\AppData\\Local\\Programs\\Antigravity',
        exePath: 'C:\\Users\\demo\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe',
        installed: true,
        version: '2.34.0',
        running: false,
        debugPortReady: false,
      },
    };
  }
  return invoke<AppInfo>('get_app_info');
}

export async function launchAntigravity(): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke('launch_antigravity_cmd');
}

export async function safeRelaunchAntigravity(confirmBackgroundExit = false): Promise<SafeRelaunchResult> {
  if (!isTauriRuntime()) {
    return {
      ok: true,
      debugPortReady: true,
      needsBackgroundExitConfirmation: false,
      reason: 'ready',
      message: 'Preview mode',
    };
  }
  return invoke<SafeRelaunchResult>('safe_relaunch_antigravity_cmd', { confirmBackgroundExit });
}

export async function quitAntigravityAndWait(
  timeoutMs = 18_000,
  confirmBackgroundExit = false,
): Promise<GracefulCloseOutcome> {
  if (!isTauriRuntime()) return { closed: true, reason: 'clean_exit' };
  return invoke<GracefulCloseOutcome>('quit_antigravity_and_wait_cmd', {
    timeoutMs,
    confirmBackgroundExit,
  });
}

export async function getAntigravityRunning(): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  return invoke<boolean>('get_antigravity_running');
}

const ALLOWED_EXTERNAL_HOSTS = new Set([
  'github.com',
  'raw.githubusercontent.com',
  'cdn.jsdelivr.net',
  'accounts.google.com',
]);

export async function openExternalUrl(url: string): Promise<void> {
  const trimmed = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Invalid external URL');
  }
  if (
    parsed.protocol !== 'https:' ||
    Boolean(parsed.username) ||
    Boolean(parsed.password) ||
    Boolean(parsed.port) ||
    !ALLOWED_EXTERNAL_HOSTS.has(parsed.hostname.toLowerCase())
  ) {
    throw new Error('Only allowlisted https:// URLs are allowed');
  }
  if (!isTauriRuntime()) {
    window.open(trimmed, '_blank', 'noopener,noreferrer');
    return;
  }
  await invoke('open_external_url', { url: trimmed });
}

export async function openFolder(path: string): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke('open_folder', { path });
}

export async function revealInExplorer(path: string): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke('reveal_in_explorer', { path });
}

export async function getAutostart(): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  return invoke<boolean>('get_autostart');
}

export async function setAutostart(enabled: boolean): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke('set_autostart', { enabled });
}

export async function loadUiConfig(): Promise<UiConfig> {
  if (!isTauriRuntime()) {
    return {
      schema: 2,
      lastPage: 0,
      quotaRefreshMinutes: 0,
      hudEnabled: true,
      autoPricingSyncEnabled: false,
      launchAntigravityOnStart: false,
      syncAntigravityLifecycle: false,
      autoUpdateEnabled: false,
      accountsCollapsed: false,
      menuSelectedTab: 0,
      menuUsagePeriod: 0,
      menuUsageEnvironmentId: 'all',
      menuTrendMetric: 'tokens',
      applicationChannel: 'stable',
      appLanguage: 'system',
      themeMode: 'system',
      antigravityProxyMode: 'off',
      antigravityProxyManualUrl: '',
    };
  }
  return invoke<UiConfig>('load_ui_config');
}

export async function saveUiConfig(config: UiConfig): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke('save_ui_config', { config });
}

export async function showMainWindow(page?: string): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke('show_main_window', { page: page ?? null });
}

export async function hideTrayWindow(): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke('hide_tray_window_cmd');
}

export async function syncTrayLanguage(isEnglish: boolean): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke('sync_tray_language', { isEnglish });
}

export async function setWindowDarkMode(isDark: boolean): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke('set_window_dark_mode', { isDark });
}

export async function saveJsonFile(path: string, content: unknown): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke('save_json_file', { path, content });
}

export async function quitApp(): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke('quit_app');
}

export async function pickImportJsonFiles(title: string, directory = false): Promise<string[]> {
  if (!isTauriRuntime()) return [];
  const selected = await dialogOpen({
    title,
    multiple: !directory,
    directory,
    filters: directory ? undefined : [{ name: 'JSON', extensions: ['json'] }],
  });
  if (!selected) return [];
  return Array.isArray(selected) ? selected : [selected];
}

export async function pickSaveJsonPath(title: string, defaultPath: string): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const result = await dialogSave({
    title,
    defaultPath,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  return result ?? null;
}

export async function listenEvent<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  if (!isTauriRuntime()) return () => {};
  return listen<T>(event, (e) => handler(e.payload));
}
