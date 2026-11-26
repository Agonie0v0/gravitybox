import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chromeArchDir,
  isSupportedMacArch,
  nativeArch,
  nativeTargetTriple,
  releaseArchSuffix,
  releaseDmgName,
} from '../tools/native-target.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

test('macOS 架构映射到 swiftc 目标三元组', () => {
  assert.equal(nativeTargetTriple('arm64'), 'arm64-apple-macosx14.0');
  assert.equal(nativeTargetTriple('x64'), 'x86_64-apple-macosx14.0');
  assert.throws(() => nativeTargetTriple('ia32'), /不支持的 macOS 架构/);
  assert.equal(nativeArch('x64').suffix, 'x86_64');
});

test('发行包文件名带架构后缀，且与 Mach-O 架构名一致', () => {
  assert.equal(releaseDmgName('1.2.0', 'arm64'), 'GravityBox-1.2.0-arm64.dmg');
  assert.equal(releaseDmgName('1.2.0', 'x64'), 'GravityBox-1.2.0-x86_64.dmg');
  assert.equal(releaseArchSuffix('x64'), 'x86_64');
  assert.equal(chromeArchDir('x64'), 'mac-x64');
  assert.equal(chromeArchDir('arm64'), 'mac-arm64');
});

test('当前宿主架构受支持', () => {
  assert.equal(isSupportedMacArch(process.arch), true, `未支持的宿主架构：${process.arch}`);
  assert.equal(isSupportedMacArch('armv7'), false);
});

test('构建脚本与原生测试夹具复用统一的架构来源，不再写死目标三元组', async () => {
  const fixtures = (await readdir(join(root, 'test')))
    .filter(name => name.startsWith('native-') && name.endsWith('.test.mjs'))
    .sort();
  const files = ['tools/native-build.mjs', ...fixtures.map(name => join('test', name))];
  for (const file of files) {
    const text = await readFile(join(root, file), 'utf8');
    assert.doesNotMatch(text, /['"`](?:arm64|x86_64)-apple-macosx/, `${file} 仍写死了 swiftc 目标三元组`);
    assert.match(text, /nativeTargetTriple\(\)/, `${file} 未使用 native-target.mjs 的目标三元组`);
  }
});