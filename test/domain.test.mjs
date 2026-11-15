import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspect } from '../src/reader.mjs';
const primary=await readFile(new URL('../fixtures/primary.bin',import.meta.url));
const manifest=JSON.parse(await readFile(new URL('../fixtures/upstream.json',import.meta.url),'utf8'));
async function resource(path) {
  const item=manifest.resources[path];
  return item.file ? readFile(new URL(`../fixtures/${item.file}`,import.meta.url)) : Buffer.from(item.body);
}

test('原点帧含残差并保留帧号',()=>{
  const result=inspect(primary);assert.equal(result.points.length,2);
  assert.equal(result.points[0].frame,1);assert.equal(result.points[1].positions[0].raw[3],-1);
});
test('带模拟量原件具有实际参数与数据',async()=>{
  const result=inspect(await resource('/recordings/with-analog'));
  assert.equal(result.analogValuesPerFrame,4);assert.equal(result.samplesPerFrame,2);
  assert.equal(result.points[1].positions[0].raw[0],2);
});
test('缺数据块与非法帧范围拒绝',()=>{
  assert.throws(()=>inspect(primary.subarray(0,1025)));
  const changed=Buffer.from(primary);changed.writeUInt16LE(0,8);assert.throws(()=>inspect(changed));
});
