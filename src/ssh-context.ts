import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import type { CDP } from './cdp.js';
import { compareLayers } from './dictionary.js';

const execFileRaw = promisify(execFile);

export type WindowSourceKind = 'local' | 'remote';

export interface RemoteWindowIdentity {
  kind: 'remote';
  remoteKey: string;
  hostLabel: string;
  origin: string;
  browserContextId?: string;
  verifiedBy: 'process' | 'process+log';
}

export interface MainWorldSshRemoteProbe {
  ready: boolean;
  kind?: string;
  currentHost?: string;
  connectedCount?: number;
}

export type RemoteWindowVerification =
  | { status: 'verified'; identity: RemoteWindowIdentity }
  | { status: 'pending'; reason: 'bridge_not_ready' }
  | {
      status: 'rejected';
      reason:
        | 'version_too_old'
        | 'shared_local_context'
        | 'not_ssh_kind'
        | 'no_active_ssh_tunnel'
        | 'invalid_url';
    };

export interface SshTunnelProcessInfo {
  pid: number;
  socksPort?: number;
}

export type ExecFileFn = (
  file: string,
  args: string[],
  options: { timeout: number }
) => Promise<{ stdout: string; stderr?: string }>;

const defaultExecFile: ExecFileFn = (file, args, options) => execFileRaw(file, args, options);

/**
 * 清理 Main World 返回的显示标签，防止控制字符、过长字符串或空白异常污染日志与展示态。
 */
export function sanitizeHostLabel(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const cleaned = raw.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  return cleaned.slice(0, 256);
}

/**
 * Antigravity 从 2.33.0 起提供 window.sshRemote 预加载桥。
 */
export function supportsSshRemoteBridge(appVersion: string | undefined): boolean {
  if (typeof appVersion !== 'string') return false;
  const trimmed = appVersion.trim();
  if (!/^\d+\.\d+\.\d+/.test(trimmed)) return false;
  return compareLayers(`${trimmed}.json`, '2.33.0.json') >= 0;
}

/**
 * 仅在 Main World（不传 contextId）执行极简只读探针；Isolated World 中 window.sshRemote 恒为 undefined。
 */
export async function probeMainWorldSshRemote(
  cdp: Pick<CDP, 'evaluate'>,
  timeoutMs = 800
): Promise<MainWorldSshRemoteProbe> {
  const expr = `(async () => {
    try {
      const bridge = window.sshRemote;
      if (!bridge || typeof bridge.kind !== 'string') return { ready: false };
      if (bridge.kind !== 'ssh') {
        return { ready: true, kind: String(bridge.kind), currentHost: '', connectedCount: 0 };
      }
      const st = typeof bridge.getState === 'function' ? await bridge.getState() : null;
      const currentHost = typeof st?.currentHost === 'string' ? st.currentHost : '';
      const connectedCount = Array.isArray(st?.connected) ? st.connected.length : 0;
      return { ready: true, kind: 'ssh', currentHost, connectedCount };
    } catch {
      return { ready: false };
    }
  })()`;

  let timer: NodeJS.Timeout | undefined;
  try {
    const raw = await Promise.race([
      cdp.evaluate(expr),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('ssh_probe_timeout')), timeoutMs);
      }),
    ]);
    if (!raw || typeof raw !== 'object' || (raw as any).ready !== true) {
      return { ready: false };
    }
    return {
      ready: true,
      kind: typeof (raw as any).kind === 'string' ? (raw as any).kind : undefined,
      currentHost: sanitizeHostLabel((raw as any).currentHost),
      connectedCount: Number.isFinite((raw as any).connectedCount) ? Number((raw as any).connectedCount) : 0,
    };
  } catch {
    return { ready: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function splitCommandPrefixTokens(args: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < args.length) {
    while (i < args.length && /\s/.test(args[i]!)) i++;
    if (i >= args.length) break;
    let tok = '';
    const q = args[i];
    if (q === '"' || q === "'") {
      i++;
      while (i < args.length && args[i] !== q) {
        if (args[i] === '\\' && i + 1 < args.length && q === '"') i++;
        tok += args[i++];
      }
      if (i < args.length && args[i] === q) i++;
    } else {
      while (i < args.length && !/\s/.test(args[i]!)) tok += args[i++];
    }
    tokens.push(tok);
    if (tok === '--') break;
  }
  return tokens;
}

function isSshExecutableToken(token: string): boolean {
  if (!token) return false;
  const base = basename(token).toLowerCase();
  return base === 'ssh' || base === 'ssh.exe';
}

function extractSocksPortFromTokens(tokens: string[]): number | undefined {
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok === '--') break;
    let spec: string | undefined;
    if (tok === '-D' && i + 1 < tokens.length) {
      spec = tokens[++i];
    } else if (tok.startsWith('-D') && tok.length > 2) {
      spec = tok.slice(2);
    }
    if (!spec) continue;
    const match = spec.match(/^(?:(?:127\.0\.0\.1|\[::1\]|localhost):)?(\d{1,5})$/i);
    if (match) {
      const port = Number(match[1]);
      if (Number.isInteger(port) && port >= 1 && port <= 65535) return port;
    }
  }
  return undefined;
}

/**
 * 解析 `ps -ax -ww -o pid=,ppid=,args=` 输出，筛选父进程为官方 Antigravity 的活跃 `ssh -D` 隧道。
 */
export function parseSshTunnelProcesses(psStdout: string, antigravityPid: number): SshTunnelProcessInfo[] {
  if (!Number.isSafeInteger(antigravityPid) || antigravityPid <= 0) return [];
  const results: SshTunnelProcessInfo[] = [];
  for (const line of psStdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+([\s\S]+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const args = m[3] ?? '';
    if (ppid !== antigravityPid || !Number.isSafeInteger(pid) || pid <= 0) continue;
    const tokens = splitCommandPrefixTokens(args);
    if (tokens.length === 0 || !isSshExecutableToken(tokens[0]!)) continue;
    const socksPort = extractSocksPortFromTokens(tokens);
    if (socksPort === undefined) continue;
    results.push({ pid, socksPort });
  }
  return results;
}

export async function hasActiveAntigravitySshTunnel(
  antigravityPid: number,
  deps?: { execFile?: ExecFileFn }
): Promise<{ found: boolean; tunnels: SshTunnelProcessInfo[] }> {
  if (!Number.isSafeInteger(antigravityPid) || antigravityPid <= 0) {
    return { found: false, tunnels: [] };
  }
  const exec = deps?.execFile ?? defaultExecFile;
  try {
    const { stdout } = await exec('/bin/ps', ['-ax', '-ww', '-o', 'pid=,ppid=,args='], { timeout: 2500 });
    const tunnels = parseSshTunnelProcesses(stdout, antigravityPid);
    return { found: tunnels.length > 0, tunnels };
  } catch {
    return { found: false, tunnels: [] };
  }
}

const LOG_TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d{3})?)/;

/**
 * 可选只读增强校验：读取 Antigravity main.log 末尾 256KB，确认当前进程周期内的连接端口记录。
 * 日志轮转或延迟刷盘时安全返回 false，不作为硬阻断。
 */
export async function matchMainLogRemotePort(
  originPort: string,
  hostLabel: string,
  options?: { logPath?: string; sinceMs?: number }
): Promise<boolean> {
  if (!originPort || !hostLabel) return false;
  const logPath = options?.logPath ?? join(homedir(), 'Library', 'Logs', 'Antigravity', 'main.log');
  const needle = `[SSH] Connected to ${hostLabel} at https://127.0.0.1:${originPort}/`;
  try {
    const st = await stat(logPath);
    if (!st.isFile() || st.size <= 0) return false;
    const maxBytes = 262_144;
    const readSize = Math.min(st.size, maxBytes);
    const startOffset = Math.max(0, st.size - readSize);
    const fh = await open(logPath, 'r');
    try {
      const buf = Buffer.allocUnsafe(readSize);
      const { bytesRead } = await fh.read(buf, 0, readSize, startOffset);
      const text = buf.subarray(0, bytesRead).toString('utf8');
      const lines = text.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!;
        if (!line.includes(needle)) continue;
        if (options?.sinceMs !== undefined) {
          const tsMatch = line.match(LOG_TIMESTAMP_RE);
          if (tsMatch) {
            const parsedMs = Date.parse(tsMatch[1]!.replace(' ', 'T'));
            if (Number.isFinite(parsedMs) && parsedMs < options.sinceMs - 10_000) {
              continue;
            }
          }
        }
        return true;
      }
      return false;
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

export function buildRemoteWindowKey(hostLabel: string, origin: string): string {
  return createHash('sha256')
    .update(JSON.stringify(['ssh-window', hostLabel, origin]))
    .digest('hex')
    .slice(0, 16);
}

/**
 * 对未在本机监听的 allowedTarget 执行零网络 SSH 窗口准入三联验真：
 * 1) 仅 2.33.0+ 放行；
 * 2) 若存在已知本地浏览器上下文，必须与其隔离；
 * 3) Main World window.sshRemote.kind === 'ssh'（未就绪返回 pending）；
 * 4) 本机 ps 存在父进程为官方 Antigravity 主进程的活跃 ssh -D 隧道。
 */
export async function verifyRemotePageWindow(params: {
  appVersion: string;
  antigravityPid: number;
  url: string;
  cdp: Pick<CDP, 'evaluate'>;
  browserContextId?: string;
  localBrowserContextIds?: ReadonlySet<string>;
  probeTimeoutMs?: number;
  deps?: { execFile?: ExecFileFn; logPath?: string; mainLogSinceMs?: number };
}): Promise<RemoteWindowVerification> {
  if (!supportsSshRemoteBridge(params.appVersion)) {
    return { status: 'rejected', reason: 'version_too_old' };
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(params.url);
    if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== '127.0.0.1' || !parsedUrl.port) {
      return { status: 'rejected', reason: 'invalid_url' };
    }
  } catch {
    return { status: 'rejected', reason: 'invalid_url' };
  }

  if (
    params.browserContextId &&
    params.localBrowserContextIds &&
    params.localBrowserContextIds.size > 0 &&
    params.localBrowserContextIds.has(params.browserContextId)
  ) {
    return { status: 'rejected', reason: 'shared_local_context' };
  }

  const probe = await probeMainWorldSshRemote(params.cdp, params.probeTimeoutMs ?? 800);
  if (!probe.ready) {
    return { status: 'pending', reason: 'bridge_not_ready' };
  }
  if (probe.kind !== 'ssh') {
    return { status: 'rejected', reason: 'not_ssh_kind' };
  }

  const tunnelRes = await hasActiveAntigravitySshTunnel(params.antigravityPid, params.deps);
  if (!tunnelRes.found) {
    return { status: 'rejected', reason: 'no_active_ssh_tunnel' };
  }

  const hostLabel = sanitizeHostLabel(probe.currentHost) || 'SSH Host';
  const origin = parsedUrl.origin;
  const logMatched = await matchMainLogRemotePort(parsedUrl.port, hostLabel, {
    logPath: params.deps?.logPath,
    sinceMs: params.deps?.mainLogSinceMs,
  });

  return {
    status: 'verified',
    identity: {
      kind: 'remote',
      remoteKey: buildRemoteWindowKey(hostLabel, origin),
      hostLabel,
      origin,
      browserContextId: params.browserContextId,
      verifiedBy: logMatched ? 'process+log' : 'process',
    },
  };
}
