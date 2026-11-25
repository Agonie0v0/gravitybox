import { createWriteStream, existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fileSha256 } from './release-integrity.mjs';
import { chromeArchDir, isSupportedMacArch } from './native-target.mjs';

// Update version and every arch's hashes together after checking Google's Chrome for Testing download.
export const TEST_CHROME_VERSION = '157.0.8103.38';
const CHROME_ARCHIVES = {
  'mac-arm64': {
    archiveHash: 'e6a6b13551aa12f951d0891d79282606b13742837c8fa0505e1272bae116ce82',
    binaryHash: 'ed0e3d67ce3cc2528acb7290ebe86181c144890ff7f610e86268317c6139d518',
  },
  'mac-x64': {
    archiveHash: '79821745d0a72d2ba752d981284ed0a9e6fa320dad133596941a17dba6186de3',
    binaryHash: 'e7abbee846a4e06d6243f74ceb422e405d08d0685caf8f282aac79a121f2a9d1',
  },
};
const root = fileURLToPath(new URL('../', import.meta.url));
const archDir = process.platform === 'darwin' && isSupportedMacArch() ? chromeArchDir() : null;
const destination = archDir ? join(root, '.cache', `test-chrome-${TEST_CHROME_VERSION}-${archDir}`) : null;
const pinnedBinary = destination ? join(destination, 'chrome-headless-shell') : '';
/** 未设置 CHROME_BIN 时的默认固定测试浏览器；设置了 override 时由调用方直接使用 CHROME_BIN。 */
export const TEST_CHROME_PATH = process.env.CHROME_BIN || pinnedBinary;

async function main() {
  if (process.platform !== 'darwin') throw Error('固定测试浏览器目前支持 macOS (arm64 / x64)；其他环境请通过 CHROME_BIN 指定兼容的测试浏览器');
  if (process.env.CHROME_BIN) {
    if (!existsSync(process.env.CHROME_BIN)) throw Error(`CHROME_BIN 指向的文件不存在：${process.env.CHROME_BIN}`);
    console.log(`使用 CHROME_BIN 指定的测试浏览器：${process.env.CHROME_BIN}`);
    return;
  }
  if (!isSupportedMacArch()) throw Error(`不支持的 macOS 架构：${process.arch}（仅支持 arm64 / x64）；可用 CHROME_BIN 指定兼容的测试浏览器`);
  const { archiveHash, binaryHash } = CHROME_ARCHIVES[archDir];
  if (!existsSync(pinnedBinary)) {
    await mkdir(join(root, '.cache'), { recursive: true });
    const stage = await mkdtemp(join(root, '.cache', 'chrome-download-'));
    try {
      const archive = join(stage, 'chrome.zip');
      const url = `https://storage.googleapis.com/chrome-for-testing-public/${TEST_CHROME_VERSION}/${archDir}/chrome-headless-shell-${archDir}.zip`;
      const response = await fetch(url, { signal: AbortSignal.timeout(120000), redirect: 'error' });
      if (!response.ok || !response.body) throw Error(`Chrome for Testing 下载失败 (${response.status})`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
      if (await fileSha256(archive) !== archiveHash) throw Error('测试浏览器压缩包 SHA-256 不符，已拒绝安装');
      await promisify(execFile)('/usr/bin/unzip', ['-q', archive, '-d', stage]);
      if (await fileSha256(join(stage, `chrome-headless-shell-${archDir}/chrome-headless-shell`)) !== binaryHash) throw Error('测试浏览器二进制 SHA-256 不符');
      await rename(join(stage, `chrome-headless-shell-${archDir}`), destination);
    } finally { await rm(stage, { recursive: true, force: true }); }
  }
  if (await fileSha256(pinnedBinary) !== binaryHash) throw Error('缓存的测试浏览器已变化；请核对缓存，不会自动覆盖');
  if (process.env.GITHUB_ENV) await appendFile(process.env.GITHUB_ENV, `CHROME_BIN=${pinnedBinary}\n`);
  console.log(`Chrome Headless Shell ${TEST_CHROME_VERSION} (${archDir}) 已校验：${pinnedBinary}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(`[test-browser] ${error.message}`); process.exitCode = 1; });