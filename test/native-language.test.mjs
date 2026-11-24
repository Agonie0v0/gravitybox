import test from 'node:test';
import { NATIVE_TEST_TIMEOUT_MS, nativeTargetTriple } from '../tools/native-target.mjs';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import{promisify}from'node:util';
import{mkdtemp,rm}from'node:fs/promises';
import{tmpdir}from'node:os';
import{join}from'node:path';
const run=promisify(execFile);
test('原生语言偏好对独立测试域可精确恢复，不触及 Antigravity 配置', { timeout: NATIVE_TEST_TIMEOUT_MS }, async()=>{
 const temp=await mkdtemp(join(tmpdir(),'gravity-native-test-'));try{const binary=join(temp,'test');await run('/usr/bin/swiftc',['-parse-as-library','-target',nativeTargetTriple(),'-framework','Cocoa','native/L10n.swift','native/MenuLanguage.swift','test/native-language.swift','-o',binary]);const result=await run(binary,[]);assert.match(result.stdout,/通过/);}finally{await rm(temp,{recursive:true,force:true});}
});
