import { createHash } from 'node:crypto';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { posix, resolve, win32 } from 'node:path';
import { bt } from '../i18n.js';
import { isOwnedByCurrentUser } from './fs.js';

const NAMED_PIPE_RE = /^\\\\[.?]\\pipe\\/i;

/**
 * Check whether an IPC endpoint string refers to a Windows Named Pipe.
 */
export function isNamedPipe(endpoint: string): boolean {
  return NAMED_PIPE_RE.test(endpoint);
}

/**
 * Compute the IPC endpoint for a GravityBox `stateDir`.
 * - macOS / POSIX: `<stateDir>/control.sock`
 * - Windows: deterministic Named Pipe `\\.\pipe\gravitybox-<sha256(resolve(stateDir).toLowerCase()).slice(0, 24)>`
 */
export function resolveIpcEndpoint(
  stateDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    let resolved = process.platform === 'win32' ? resolve(stateDir) : win32.resolve(stateDir);
    if (/^\\\\\?\\UNC\\/i.test(resolved)) {
      resolved = '\\\\' + resolved.slice(8);
    } else if (/^\\\\\?\\/.test(resolved)) {
      resolved = resolved.slice(4);
    }
    const digest = createHash('sha256').update(resolved.toLowerCase(), 'utf8').digest('hex').slice(0, 24);
    return `\\\\.\\pipe\\gravitybox-${digest}`;
  }
  return posix.join(stateDir, 'control.sock');
}

function probeIpcServerAlive(endpoint: string, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolveLive, reject) => {
    const client = createConnection(endpoint);
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    client.once('connect', () => {
      done(() => {
        client.destroy();
        resolveLive(true);
      });
    });
    client.once('error', (error: NodeJS.ErrnoException) => {
      done(() => {
        client.destroy();
        const code = error.code ?? '';
        if (code === 'ECONNREFUSED' || code === 'ENOENT') {
          resolveLive(false);
        } else if (isNamedPipe(endpoint) && (code === 'EBUSY' || code === 'EACCES' || code === 'EPIPE')) {
          reject(new Error(bt('main.socket_busy')));
        } else {
          reject(new Error(bt('main.socket_unconfirmed')));
        }
      });
    });
    client.setTimeout(timeoutMs, () => {
      done(() => {
        client.destroy();
        reject(new Error(bt('main.socket_busy')));
      });
    });
  });
}

/**
 * Prepare an IPC endpoint before calling `server.listen(endpoint)`.
 * - Windows Named Pipe: never calls lstat/uid/unlink; probes whether another server is already active.
 * - macOS / POSIX Unix socket: validates socket type & owner, rejects if live, unlinks stale socket safely.
 */
export async function prepareIpcEndpointForListen(
  endpoint: string,
  options: { probeTimeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.probeTimeoutMs ?? 1500;
  if (isNamedPipe(endpoint)) {
    const live = await probeIpcServerAlive(endpoint, timeoutMs);
    if (live) throw new Error(bt('main.assistant_already_running'));
    return;
  }

  try {
    const info = await lstat(endpoint);
    if (!info.isSocket() || !isOwnedByCurrentUser(info)) {
      throw new Error(bt('main.socket_mismatch'));
    }
    const live = await probeIpcServerAlive(endpoint, timeoutMs);
    if (live) throw new Error(bt('main.assistant_already_running'));
    const current = await lstat(endpoint);
    if (current.ino !== info.ino || current.dev !== info.dev) {
      throw new Error(bt('main.socket_changed'));
    }
    await unlink(endpoint);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * Post-listen endpoint hardening (0600 chmod for Unix sockets; no-op for Windows Named Pipes).
 */
export async function finalizeIpcEndpointAfterListen(endpoint: string): Promise<void> {
  if (isNamedPipe(endpoint)) return;
  await chmod(endpoint, 0o600);
}

/**
 * Clean up IPC endpoint on server shutdown.
 * - Windows Named Pipe: no-op (pipes are kernel-managed and disappear once handles close).
 * - macOS / POSIX Unix socket: unlinks the socket file.
 */
export async function cleanupIpcEndpoint(endpoint: string): Promise<void> {
  if (isNamedPipe(endpoint)) return;
  await unlink(endpoint).catch(() => {});
}

/**
 * Validate an IPC endpoint before a client connects.
 * - Windows Named Pipe: no-op (never calls lstat/uid; connection errors surface as not-running).
 * - macOS / POSIX Unix socket: verifies socket exists, is a non-symlink socket, and belongs to current user.
 */
export async function validateIpcEndpointForClient(endpoint: string): Promise<void> {
  if (isNamedPipe(endpoint)) return;
  const sockInfo = await lstat(endpoint).catch((err: NodeJS.ErrnoException) => {
    if (err?.code === 'ENOENT') throw new Error(bt('main.assistant_not_running'));
    throw err;
  });
  if (!sockInfo.isSocket() || sockInfo.isSymbolicLink() || !isOwnedByCurrentUser(sockInfo)) {
    throw new Error(bt('main.socket_mismatch'));
  }
}
