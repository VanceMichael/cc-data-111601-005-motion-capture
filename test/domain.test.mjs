import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspect, C3DError } from '../src/reader.mjs';
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
test('点概览之外保留无效点标志与原始残差值',()=>{
  const result=inspect(primary);
  const flagged=result.frames[1].positions[0];
  assert.equal(flagged.invalid,true);
  assert.equal(flagged.residualWord,-1);
  assert.deepEqual(flagged.coordinate,result.frames[1].positions[0].coordinate);
  assert.equal(result.pointLabels[0].label,'HEEL');
});
test('带模拟量原件具有实际参数与数据',async()=>{
  const result=inspect(await resource('/recordings/with-analog'));
  assert.equal(result.analogValuesPerFrame,4);assert.equal(result.samplesPerFrame,2);
  assert.equal(result.points[1].positions[0].raw[0],2);
});
test('模拟通道按参数识别身份、比例、偏移与采样关系',async()=>{
  const result=inspect(await resource('/recordings/with-analog'));
  assert.deepEqual(result.analogChannels.map(c=>c.label),['FZ','EMG']);
  assert.equal(result.analogRate,200);assert.equal(result.pointRate,100);
  assert.deepEqual(result.calibration.analog.scales,[2,4]);
  assert.deepEqual(result.calibration.analog.offsets,[10,20]);
  assert.equal(result.calibration.analog.genScale,0.5);
  const first=result.frames[0].analog[0].channels;
  assert.equal(first[0].raw,11);
  assert.equal(first[0].physical,(11-10)*2*0.5);
  assert.equal(first[1].physical,(21-20)*4*0.5);
  // 第二子帧与第二帧均可回溯到原帧、子帧与原始读数
  assert.equal(result.frames[0].analog[1].channels[0].location.subframe,1);
  assert.equal(result.frames[1].frame,2);
  assert.equal(result.frames[1].analog[1].channels[1].raw,22);
});
test('声明与有效载荷不相容时说明无法联合接收的部分',async()=>{
  const incompatible=inspect.bind(null,await resource('/recordings/incompatible'));
  assert.throws(incompatible,error=>error instanceof C3DError
    &&error.code==='c3d_header_mismatch'
    &&error.details.expected===4&&error.details.header===3);
  const truncated=inspect.bind(null,await resource('/recordings/truncated'));
  assert.throws(truncated,error=>error instanceof C3DError
    &&error.code==='c3d_data_short'
    &&error.details.requiredBytes>error.details.availableBytes
    &&error.details.analogSamplesExpected===4);
});
test('缺数据块与非法帧范围拒绝',()=>{
  assert.throws(()=>inspect(primary.subarray(0,1025)));
  const changed=Buffer.from(primary);changed.writeUInt16LE(0,8);assert.throws(()=>inspect(changed));
});
test('非 84 processor 明确拒绝',()=>{
  const changed=Buffer.from(primary);changed[515]=85;
  assert.throws(()=>inspect(changed),error=>error instanceof C3DError
    &&error.code==='c3d_processor_unsupported');
});
