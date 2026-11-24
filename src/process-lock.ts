import { open, lstat, readFile, unlink, link, rename } from 'node:fs/promises';
import { readFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { bt } from './i18n.js';
import { atomicRenameWithRetry, isOwnedByCurrentUser, isWindows, unlinkWithRetry } from './platform/index.js';

const context = new AsyncLocalStorage<Map<string, string>>();
const active = new Map<string, string>();
const WINDOWS_LOCK_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
export type ProcessLease = { release(): Promise<void>; releaseSync(): void };

const statLockFile = (lockPath: string) => (isWindows() ? lstat(lockPath, { bigint: true }) : lstat(lockPath));

/** Same-user exclusive lease. Only a provably dead owner may be reclaimed. */
export async function acquireProcessLease(path: string, timeoutMs = 15000, busyMessage = bt('lock.busy')): Promise<ProcessLease> {
  const deadline = Date.now() + timeoutMs, nonce = randomUUID();
  while (true) {
    try {
      if (isWindows()) {
        const file = await open(path, 'wx', 0o600);
        try {
          await file.writeFile(JSON.stringify({ pid: process.pid, nonce }));
          await file.sync();
        } finally {
          await file.close().catch(() => {});
        }
      } else {
        const temporary=path+'.'+nonce+'.tmp',file=await open(temporary,'wx',0o600);
        try {await file.writeFile(JSON.stringify({pid:process.pid,nonce}));await file.sync();await file.close();await link(temporary,path);}
        finally {await file.close().catch(()=>{});await unlink(temporary).catch(()=>{});}
      }
      const owns = (text: string) => { try { return JSON.parse(text).nonce === nonce; } catch { return false; } };
      return {
        async release() {
          try {
            if (!owns(await readFile(path, 'utf8'))) return;
            if (isWindows()) {
              const releasedPath = `${path}.rel-${nonce}`;
              try {
                await atomicRenameWithRetry(path, releasedPath, { maxRetries: 3, baseDelayMs: 15 });
                await unlinkWithRetry(releasedPath).catch(() => {});
                return;
              } catch {
                await unlinkWithRetry(path);
                return;
              }
            }
            await unlink(path);
          } catch {}
        },
        releaseSync() {
          try {
            if (!owns(readFileSync(path, 'utf8'))) return;
            if (isWindows()) {
              const releasedPath = `${path}.rel-${nonce}`;
              try {
                renameSync(path, releasedPath);
                try { unlinkSync(releasedPath); } catch {}
                return;
              } catch {}
            }
            unlinkSync(path);
          } catch {}
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (code !== 'EEXIST') {
        if (isWindows() && WINDOWS_LOCK_RETRY_CODES.has(code)) {
          if (Date.now() >= deadline) throw new Error(busyMessage);
          await delay(30);
          continue;
        }
        throw error;
      }
      const info = await statLockFile(path).catch(() => null);
      if (!info) continue;
      if (!info.isFile() || info.isSymbolicLink() || !isOwnedByCurrentUser({ uid: Number(info.uid) })) throw new Error(bt('lock.identity_mismatch'));
      const text = await readFile(path, 'utf8').catch(() => '');
      let pid = 0;
      try { pid = JSON.parse(text).pid; } catch {
        const legacyPid = Number(text.trim());
        if (Number.isSafeInteger(legacyPid) && legacyPid > 0) pid = legacyPid;
      }
      if ((!Number.isSafeInteger(pid)||pid<=0) && Date.now()-Number(info.mtimeMs)>15000) {
        if (isWindows()) {
          // Windows 下不使用 /usr/sbin/lsof：对超过宽限期且无有效 PID 的残损锁直接尝试原子移走；
          // 若仍有句柄占用，Windows 会以 EBUSY/EPERM 拒绝重命名，自然保护活跃锁。
          const check = await statLockFile(path).catch(() => null);
          if (check?.ino === info.ino && check.dev === info.dev && await readFile(path, 'utf8').catch(() => null) === text) {
            try {
              await atomicRenameWithRetry(path, path + '.orphan-' + Date.now() + '-' + nonce, { maxRetries: 1, baseDelayMs: 15 });
              continue;
            } catch {
              // 仍被占用或已被其它进程回收，按正常退避重试
            }
          }
        } else {
          // Legacy half-created locks cannot have an owner after their descriptor is closed.
          let closed=false;
          try {await promisify(execFile)('/usr/sbin/lsof',['-t','--',path],{timeout:1500});}
          catch(error) {closed=(error as any).code===1 && !(error as any).stdout && !(error as any).stderr;}
          const check=await statLockFile(path).catch(()=>null);
          if(closed&&check?.ino===info.ino&&check.dev===info.dev&&await readFile(path,'utf8').catch(()=>null)===text) {await rename(path,path+'.orphan-'+Date.now()+'-'+nonce);continue;}
        }
      }
      if (Number.isSafeInteger(pid) && pid > 0) {
        let dead = false;
        try { process.kill(pid, 0); } catch (failure) {
          const killCode = (failure as NodeJS.ErrnoException).code;
          dead = killCode === 'ESRCH' || (isWindows() && killCode === 'EPERM' && Date.now() - Number(info.mtimeMs) > 60_000);
        }
        if (dead) {
          const reclaimPath=path+'.reclaim';
          let reclaim;
          try { reclaim=await open(reclaimPath,'wx',0o600);await reclaim.writeFile(JSON.stringify({pid:process.pid,nonce}));await reclaim.sync(); } catch(failure) {
            if((failure as NodeJS.ErrnoException).code!=='EEXIST')throw failure;
            // Acquire/release the recovery lease through the same stale-owner protocol.
            const cleanup=await acquireProcessLease(reclaimPath,Math.max(1,deadline-Date.now()));await cleanup.release();continue;
          }
          if(reclaim) {
            try {
              const check = await statLockFile(path).catch(() => null);
              if (check?.ino === info.ino && check.dev === info.dev && await readFile(path, 'utf8').catch(() => '') === text) {
                await unlinkWithRetry(path).catch(() => {});
              }
            } finally { await reclaim.close(); await unlinkWithRetry(reclaimPath).catch(()=>{}); }
            continue;
          }
        }
      }
      if (Date.now() >= deadline) throw new Error(busyMessage);
      await delay(30);
    }
  }
}

export async function withProcessLease<T>(
  path: string,
  action: () => Promise<T>,
  options?: { timeoutMs?: number; busyMessage?: string }
): Promise<T> {
  const inherited = context.getStore()?.get(path);
  if (inherited && active.get(path) === inherited) return action();
  const lease = await acquireProcessLease(path, options?.timeoutMs, options?.busyMessage), id = randomUUID();
  active.set(path, id);
  const next = new Map(context.getStore()); next.set(path, id);
  try { return await context.run(next, action); }
  finally { active.delete(path); await lease.release(); }
}
