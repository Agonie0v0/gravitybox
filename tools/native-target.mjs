/**
 * macOS 原生编译目标与发行包架构后缀的唯一来源。
 *
 * 构建脚本（tools/native-build.mjs、tools/package-mac.mjs）与原生测试夹具
 * （test/native-*.test.mjs）都从这里取目标架构，避免各处重复写死 `arm64-apple-macosx14.0`
 * 导致 Intel 主机上要么编译失败、要么打出架构不符的包。
 */
const TARGETS = {
  arm64: { triple: 'arm64-apple-macosx14.0', suffix: 'arm64', chrome: 'mac-arm64' },
  x64: { triple: 'x86_64-apple-macosx14.0', suffix: 'x86_64', chrome: 'mac-x64' },
};

/** 返回当前（或指定）架构的编译目标信息；不支持的架构直接报错。 */
export function nativeArch(arch = process.arch) {
  const entry = TARGETS[arch];
  if (!entry) throw new Error(`不支持的 macOS 架构：${arch}（仅支持 arm64 / x64）`);
  return entry;
}

/** 原生夹具的单测上限：swiftc 编译 + 运行在 Intel 或门禁并行负载下明显更慢，统一放宽到与 CI 一致。 */
export const NATIVE_TEST_TIMEOUT_MS = 180_000;

/** swiftc 的 `-target` 三元组。 */
export function nativeTargetTriple(arch = process.arch) {
  return nativeArch(arch).triple;
}

/** 发行包文件名里的架构后缀（arm64 / x86_64），与 Mach-O 的架构名一致。 */
export function releaseArchSuffix(arch = process.arch) {
  return nativeArch(arch).suffix;
}

/** Chrome for Testing 的架构目录名（mac-arm64 / mac-x64）。 */
export function chromeArchDir(arch = process.arch) {
  return nativeArch(arch).chrome;
}

/** 成品 DMG 的标准文件名。 */
export function releaseDmgName(version, arch = process.arch) {
  return `GravityBox-${version}-${releaseArchSuffix(arch)}.dmg`;
}

/** 支持的 macOS 架构判定，供需要提前拒绝的地方复用。 */
export function isSupportedMacArch(arch = process.arch) {
  return Object.hasOwn(TARGETS, arch);
}