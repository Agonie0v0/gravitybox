import test from 'node:test';
import { NATIVE_TEST_TIMEOUT_MS, nativeTargetTriple } from '../tools/native-target.mjs';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

test('原生 DesignMotion CADisplayLink 取消幂等性、弱代理防泄漏与真实 AppKit/Timer 回退生命周期检查', { timeout: NATIVE_TEST_TIMEOUT_MS }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'gb-native-motion-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const binary = join(temp, 'native-motion-test');
  // 刻意不传 -D NATIVE_UI_TEST，以验证真实构建中 CADisplayLink 与 Timer 生命周期
  await run('/usr/bin/swiftc', [
    '-parse-as-library',
    '-target', nativeTargetTriple(),
    '-framework', 'Cocoa',
    join(root, 'native/DesignMotion.swift'),
    join(root, 'test/native-motion.swift'),
    '-o', binary,
  ], { cwd: root, maxBuffer: 2e6 });
  const result = await run(binary, [], { cwd: root, maxBuffer: 2e6 });
  assert.match(result.stdout, /NATIVE_MOTION_LIFECYCLE_OK/);
});
