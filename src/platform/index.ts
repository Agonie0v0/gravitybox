export {
  isWindows,
  isMacOS,
  defaultAppSupportDir,
  defaultGravityBoxStateDir,
  defaultGravityBoxCacheDir,
  defaultAntigravityProfileDir,
  defaultTrashDir,
  defaultAntigravityInstallDirs,
  defaultAntigravityAppPath,
  antigravityLayout,
  normalizePathForCompare,
  pathsEqual,
  isPathUnder,
  type AntigravityLayout,
} from './paths.js';

export {
  isNamedPipe,
  resolveIpcEndpoint,
  prepareIpcEndpointForListen,
  finalizeIpcEndpointAfterListen,
  cleanupIpcEndpoint,
  validateIpcEndpointForClient,
} from './ipc.js';

export {
  isOwnedByCurrentUser,
  safeOpenFlagsNoFollow,
  atomicRenameWithRetry,
  moveToSystemTrash,
  type AtomicRenameRetryOptions,
} from './fs.js';

export {
  Win32HelperError,
  resolveWin32HelperCandidates,
  resolveWin32HelperPath,
  credRead,
  credWrite,
  credDelete,
  lsInspect,
  portOwner,
  appProcesses,
  appGracefulClose,
  trashMove,
  peVersion,
  type Win32HelperOptions,
  type Win32LsProcess,
  type Win32PortOwner,
  type Win32AppProcess,
  type Win32GracefulCloseReason,
  type Win32GracefulCloseOptions,
  type Win32GracefulCloseResult,
  type Win32PeVersion,
} from './win32-helper.js';
