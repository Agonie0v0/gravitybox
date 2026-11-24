import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ProcessTreeEntry = {
  pid: number;
  ppid: number;
  cpu: number;
  args: string;
};

export type DetachedDaemonKind = 'language_server' | 'sidecar';

export type DetachedDaemonProcess = {
  pid: number;
  ppid: number;
  cpu: number;
  kind: DetachedDaemonKind;
  args: string;
};

export type AntigravityProcessClassification = {
  uiRunning: boolean;
  uiRoles: string[];
  detachedDaemons: DetachedDaemonProcess[];
  detachedDaemonKinds: DetachedDaemonKind[];
  insidersRunning: boolean;
  maxLsCpu: number;
};

export const INSIDERS_CONTENTS_PREFIX = '/Applications/Antigravity - Insiders.app/Contents/';
const CHROMIUM_HELPER_TYPES = [
  '--type=renderer',
  '--type=gpu-process',
  '--type=utility',
  '--type=zygote',
  '--type=broker',
  '--type=ppapi',
];

export function parsePsPidPpidCpuArgs(output: string): ProcessTreeEntry[] {
  const entries: ProcessTreeEntry[] = [];
  for (const rawLine of output.split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+([\d.,]+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const cpu = Number.parseFloat((match[3] || '0').replace(',', '.'));
    const args = (match[4] || '').trim();
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || ppid < 0 || !args) continue;
    entries.push({ pid, ppid, cpu: Number.isFinite(cpu) ? cpu : 0, args });
  }
  return entries;
}

export function isChromiumHelperArgs(args: string): boolean {
  return CHROMIUM_HELPER_TYPES.some(flag => args.includes(flag));
}

export function isCrashpadHandlerArgs(args: string): boolean {
  return args.includes('chrome_crashpad_handler');
}

export function isLanguageServerArgs(args: string, appPath: string): boolean {
  const trimmed = args.trim();
  const lsPath = `${appPath}/Contents/Resources/bin/language_server`;
  return trimmed.startsWith(lsPath);
}

export function isSidecarHostArgs(args: string, appPath: string): boolean {
  const trimmed = args.trim();
  if (!trimmed.startsWith(`${appPath}/Contents/Frameworks/`)) return false;
  if (isChromiumHelperArgs(trimmed) || isCrashpadHandlerArgs(trimmed)) return false;
  return trimmed.includes('sidecar_sdk/register_loader') || trimmed.includes('sidecar_sdk');
}

function classifyUiRole(args: string, appPaths: string[]): string {
  if (appPaths.some(appPath => args.startsWith(`${appPath}/Contents/MacOS/`))) return 'main';
  if (args.includes('--type=renderer')) return 'renderer';
  if (args.includes('--type=gpu-process')) return 'gpu-process';
  if (args.includes('--type=utility')) return 'utility';
  if (isLanguageServerArgsWithPaths(args, appPaths)) return 'language_server';
  return 'helper';
}

function isLanguageServerArgsWithPaths(args: string, appPaths: string[]): boolean {
  return appPaths.some(appPath => isLanguageServerArgs(args, appPath));
}

function isSidecarHostArgsWithPaths(args: string, appPaths: string[]): boolean {
  return appPaths.some(appPath => isSidecarHostArgs(args, appPath));
}

function matchesAnyContentsPrefix(args: string, appPaths: string[]): boolean {
  return appPaths.some(appPath => args.startsWith(`${appPath}/Contents/`));
}

function isMainExecutableWithPaths(args: string, appPaths: string[]): boolean {
  return appPaths.some(appPath => args.startsWith(`${appPath}/Contents/MacOS/`));
}

export function classifyAntigravityProcesses(
  entries: ProcessTreeEntry[],
  options?: { appPath?: string; appPaths?: string[]; checkInsiders?: boolean; insidersPrefix?: string },
): AntigravityProcessClassification {
  const rawPaths = options?.appPaths && options.appPaths.length > 0
    ? options.appPaths
    : [options?.appPath ?? '/Applications/Antigravity.app', '/Applications/Antigravity.app'];
  const appPaths = Array.from(new Set(rawPaths.filter(Boolean)));
  const checkInsiders = options?.checkInsiders !== false;
  const insidersPrefix = options?.insidersPrefix || INSIDERS_CONTENTS_PREFIX;

  let insidersRunning = false;
  let maxLsCpu = 0;

  const childrenByParent = new Map<number, ProcessTreeEntry[]>();
  const daemonKindByPid = new Map<number, DetachedDaemonKind>();
  const queue: number[] = [];

  for (const entry of entries) {
    const args = entry.args.trim();
    const list = childrenByParent.get(entry.ppid);
    if (list) list.push(entry);
    else childrenByParent.set(entry.ppid, [entry]);

    const hitsTargetContents = matchesAnyContentsPrefix(args, appPaths);
    const hitsInsiders = checkInsiders && args.startsWith(insidersPrefix);

    if (hitsInsiders && !isCrashpadHandlerArgs(args)) {
      insidersRunning = true;
    }

    if ((hitsTargetContents || hitsInsiders) && /language_server/i.test(args) && entry.cpu > maxLsCpu) {
      maxLsCpu = entry.cpu;
    }

    if (isLanguageServerArgsWithPaths(args, appPaths)) {
      if (!daemonKindByPid.has(entry.pid)) {
        daemonKindByPid.set(entry.pid, 'language_server');
        queue.push(entry.pid);
      }
    } else if (isSidecarHostArgsWithPaths(args, appPaths)) {
      if (!daemonKindByPid.has(entry.pid)) {
        daemonKindByPid.set(entry.pid, 'sidecar');
        queue.push(entry.pid);
      }
    }
  }

  // BFS collect detached daemon descendants under appPath/Contents/, excluding main UI & Chromium helpers.
  let cursor = 0;
  while (cursor < queue.length) {
    const parentPid = queue[cursor]!;
    cursor += 1;
    const parentKind = daemonKindByPid.get(parentPid) ?? 'language_server';
    for (const child of childrenByParent.get(parentPid) ?? []) {
      if (daemonKindByPid.has(child.pid)) continue;
      const childArgs = child.args.trim();
      if (!matchesAnyContentsPrefix(childArgs, appPaths)) continue;
      if (isMainExecutableWithPaths(childArgs, appPaths)) continue;
      if (isChromiumHelperArgs(childArgs) || isCrashpadHandlerArgs(childArgs)) continue;

      let childKind: DetachedDaemonKind = parentKind;
      if (
        isSidecarHostArgsWithPaths(childArgs, appPaths) ||
        appPaths.some(appPath => childArgs.startsWith(`${appPath}/Contents/Frameworks/Antigravity Helper`))
      ) {
        childKind = 'sidecar';
      }
      daemonKindByPid.set(child.pid, childKind);
      queue.push(child.pid);
    }
  }

  let uiRunning = false;
  const uiRoles: string[] = [];
  const seenUiRoles = new Set<string>();
  const detachedDaemons: DetachedDaemonProcess[] = [];

  for (const entry of entries) {
    const args = entry.args.trim();
    if (!matchesAnyContentsPrefix(args, appPaths) && !isLanguageServerArgsWithPaths(args, appPaths)) {
      continue;
    }
    if (isCrashpadHandlerArgs(args)) {
      continue;
    }
    const daemonKind = daemonKindByPid.get(entry.pid);
    if (daemonKind) {
      detachedDaemons.push({
        pid: entry.pid,
        ppid: entry.ppid,
        cpu: entry.cpu,
        kind: daemonKind,
        args,
      });
      continue;
    }
    uiRunning = true;
    const role = classifyUiRole(args, appPaths);
    if (!seenUiRoles.has(role)) {
      seenUiRoles.add(role);
      uiRoles.push(role);
    }
  }

  const presentKinds = new Set(detachedDaemons.map(d => d.kind));
  const detachedDaemonKinds: DetachedDaemonKind[] = (['language_server', 'sidecar'] as const).filter(kind =>
    presentKinds.has(kind),
  );

  return {
    uiRunning,
    uiRoles,
    detachedDaemons,
    detachedDaemonKinds,
    insidersRunning,
    maxLsCpu,
  };
}

export async function sampleAntigravityProcesses(
  options?: { appPath?: string; appPaths?: string[]; checkInsiders?: boolean; insidersPrefix?: string },
): Promise<AntigravityProcessClassification> {
  if (process.platform === 'win32') {
    throw new Error('sampleAntigravityProcesses is only supported on POSIX platforms');
  }
  const { stdout } = await execFileAsync(
    '/bin/ps',
    ['-ax', '-ww', '-o', 'pid=,ppid=,pcpu=,args='],
    { timeout: 3000, env: { ...process.env, LC_ALL: 'C', LC_NUMERIC: 'C' } },
  );
  const entries = parsePsPidPpidCpuArgs(stdout);
  if (stdout.trim().length > 0 && entries.length === 0) {
    throw new Error('Failed to parse process table output');
  }
  return classifyAntigravityProcesses(entries, options);
}
