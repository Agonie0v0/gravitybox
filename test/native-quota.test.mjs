import test from 'node:test';
import { NATIVE_TEST_TIMEOUT_MS, nativeTargetTriple } from '../tools/native-target.mjs';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const run=promisify(execFile);
test('原生额度、用量折叠与运行态展示契约：权限、未知、陈旧、周期、思考变体折叠、LiveStatus 及菜单一致', { timeout: NATIVE_TEST_TIMEOUT_MS }, async t=>{
  const temporary=await mkdtemp(join(tmpdir(),'gb-native-quota-'));t.after(()=>rm(temporary,{recursive:true,force:true}));
  const binary=join(temporary,'quota');
  await run('/usr/bin/swiftc',['-parse-as-library','-target',nativeTargetTriple(),'-framework','Cocoa','native/L10n.swift','native/LiveStatus.swift','native/Presentation.swift','native/QuotaPresentation.swift','test/native-quota.swift','-o',binary]);
  const result=await run(binary);assert.match(result.stdout,/\d+ native quota assertions passed/);
});
