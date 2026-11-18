import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspect } from '../src/reader.mjs';
import { interpret } from '../src/recording.mjs';
const primary=await readFile(new URL('../fixtures/primary.bin',import.meta.url));
const manifest=JSON.parse(await readFile(new URL('../fixtures/upstream.json',import.meta.url),'utf8'));
async function resource(path) {
  const item=manifest.resources[path];
  return item.file ? readFile(new URL(`../fixtures/${item.file}`,import.meta.url)) : Buffer.from(item.body);
}

function record(name, groupId, body) {
  const nameBytes = Buffer.from(name, 'ascii');
  const result = Buffer.alloc(2 + nameBytes.length + 2 + body.length);
  result.writeInt8(nameBytes.length, 0);
  result.writeInt8(groupId, 1);
  nameBytes.copy(result, 2);
  result.writeInt16LE(2 + body.length, 2 + nameBytes.length);
  body.copy(result, 2 + nameBytes.length + 2);
  return result;
}
function typed(type, dims, data) {
  const body = Buffer.alloc(2 + dims.length + data.length + 1);
  body.writeInt8(type, 0);
  body.writeUInt8(dims.length, 1);
  dims.forEach((dim, index) => body.writeUInt8(dim, 2 + index));
  data.copy(body, 2 + dims.length);
  return body;
}
const int16Data = values => Buffer.concat(values.map(value => { const b = Buffer.alloc(2); b.writeInt16LE(value); return b; }));
const floatData = values => Buffer.concat(values.map(value => { const b = Buffer.alloc(4); b.writeFloatLE(value); return b; }));
const int16Param = value => typed(2, [], int16Data([value]));
const floatParam = value => typed(4, [], floatData([value]));
const scaledParam = (values, integer) => typeof values === 'number'
  ? typed(integer ? 2 : 4, [], (integer ? int16Data : floatData)([values]))
  : typed(integer ? 2 : 4, [values.length], (integer ? int16Data : floatData)(values));
const labelsParam = labels => typed(-1, [4, labels.length],
  Buffer.concat(labels.map(label => { const b = Buffer.alloc(4); b.write(label, 'ascii'); return b; })));

// 按声明布局合成 C3D：参数组顺序、整数/浮点存储、每通道偏移都可变，避免被测代码依赖固定布局
function buildC3D({ pointCount = 1, first = 1, last = 1, scale = -1, rate = 100,
  analogUsed = 0, analogRate = 0, genScale = 1, analogScale = [1], analogOffset = [0],
  analogLabels = [], pointLabels = [], groupOrder = ['POINT', 'ANALOG'], processor = 84,
  omit = [], pointFrames = [], analogFrames = [] }) {
  const sampleWidth = scale < 0 ? 4 : 2;
  const samplesPerFrame = analogUsed > 0 ? Math.round(analogRate / rate) : 0;
  const analogValuesPerFrame = analogUsed * samplesPerFrame;
  const header = Buffer.alloc(512);
  header[0] = 2; header[1] = 0x50;
  header.writeUInt16LE(pointCount, 2);
  header.writeUInt16LE(analogValuesPerFrame, 4);
  header.writeUInt16LE(first, 6);
  header.writeUInt16LE(last, 8);
  header.writeFloatLE(scale, 12);
  header.writeUInt16LE(3, 16);
  header.writeUInt16LE(samplesPerFrame, 18);
  header.writeFloatLE(rate, 20);
  const groups = {
    POINT: [['POINT', record('POINT', -1, Buffer.from([0]))],
      ['POINT:USED', record('USED', 1, int16Param(pointCount))],
      ['POINT:SCALE', record('SCALE', 1, floatParam(scale))],
      ['POINT:RATE', record('RATE', 1, floatParam(rate))],
      ['POINT:LABELS', record('LABELS', 1, labelsParam(pointLabels))]],
    ANALOG: [['ANALOG', record('ANALOG', -2, Buffer.from([0]))],
      ['ANALOG:USED', record('USED', 2, int16Param(analogUsed))],
      ['ANALOG:RATE', record('RATE', 2, floatParam(analogRate))],
      ['ANALOG:GEN_SCALE', record('GEN_SCALE', 2, floatParam(genScale))],
      ...(analogUsed > 0 ? [
        ['ANALOG:SCALE', record('SCALE', 2, scaledParam(analogScale, false))],
        ['ANALOG:OFFSET', record('OFFSET', 2, scaledParam(analogOffset, true))],
        ['ANALOG:LABELS', record('LABELS', 2, labelsParam(analogLabels))]] : [])],
  };
  const records = groupOrder.flatMap(group => groups[group]).filter(([key]) => !omit.includes(key));
  const parameters = Buffer.alloc(512);
  parameters[1] = 0x50; parameters[2] = 1; parameters[3] = processor;
  Buffer.concat(records.map(([, body]) => body)).copy(parameters, 4);
  const frameCount = last - first + 1;
  const frameBytes = (pointCount * 4 + analogValuesPerFrame) * sampleWidth;
  const data = Buffer.alloc(frameCount * frameBytes);
  const writeSample = (at, value) => (scale < 0 ? data.writeFloatLE(value, at) : data.writeInt16LE(value, at));
  for (let frame = 0; frame < frameCount; frame++) {
    const frameAt = frame * frameBytes;
    (pointFrames[frame] ?? []).forEach((raw, point) =>
      raw.forEach((value, axis) => writeSample(frameAt + (point * 4 + axis) * sampleWidth, value)));
    (analogFrames[frame] ?? []).forEach((value, index) =>
      writeSample(frameAt + pointCount * 4 * sampleWidth + index * sampleWidth, value));
  }
  return Buffer.concat([header, parameters, data]);
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

test('联合解释：模拟通道身份、比例、采样关系与无效点标志', async () => {
  const result = interpret(await resource('/recordings/with-analog'));
  assert.equal(result.kind, 'c3d-recording');
  assert.equal(result.storage, 'float32');
  assert.equal(result.frames.first, 1);
  assert.equal(result.frames.count, 2);
  assert.deepEqual(result.points.labels, ['HEEL']);
  assert.deepEqual(result.analog.channels.map(channel => channel.label), ['FZ', 'EMG']);
  assert.deepEqual(result.analog.channels.map(channel => [channel.scale, channel.offset, channel.genScale]),
    [[2, 10, 0.5], [4, 20, 0.5]]);
  assert.equal(result.analog.rate, 200);
  assert.equal(result.analog.samplesPerFrame, 2);
  assert.deepEqual(result.analog.frames.map(frame => frame.frame), [1, 2]);
  // 物理值 = (raw-OFFSET)*SCALE*GEN_SCALE，原始读数与子帧位置保留
  assert.deepEqual(result.analog.frames[0].samples.map(s => [s.subframe, s.channel, s.raw, s.value]),
    [[0, 0, 11, 1], [0, 1, 21, 2], [1, 0, 12, 2], [1, 1, 22, 4]]);
  // 第二帧点 residual=-1：无效标志保留，原始读数不抹除
  const invalid = result.points.frames[1].positions[0];
  assert.equal(invalid.valid, false);
  assert.equal(invalid.raw[3], -1);
  assert.equal(invalid.raw[0], 2);
  assert.equal(result.points.frames[0].positions[0].valid, true);
});

test('无模拟通道的原件联合解释为显式空模拟段', async () => {
  const result = interpret(primary);
  assert.equal(result.analog.channels.length, 0);
  assert.equal(result.analog.frames.length, 0);
  assert.equal(result.points.frames.length, 2);
});

test('参数声明与有效载荷不相容时说明不能联合接收的部分，不截短凑齐', async () => {
  let error;
  try { interpret(await resource('/recordings/incompatible')); } catch (caught) { error = caught; }
  assert.equal(error.message, 'c3d_analog_mismatch');
  assert.match(error.detail, /模拟/);
  assert.match(error.detail, /每帧 3 个模拟值/);
  assert.match(error.detail, /每帧 4 个模拟值/);
});

test('截短原件与非法 processor 明确拒绝', async () => {
  const truncated = await resource('/recordings/truncated');
  assert.throws(() => interpret(truncated), /c3d_data_short/);
  const changed = Buffer.from(await resource('/recordings/with-analog'));
  changed[512 + 3] = 85;
  let error;
  try { interpret(changed); } catch (caught) { error = caught; }
  assert.equal(error.message, 'c3d_processor');
  assert.match(error.detail, /85/);
});

test('POINT:USED 与头部点数不相容时说明点轨迹部分不能联合接收', async () => {
  const changed = Buffer.from(await resource('/recordings/with-analog'));
  changed.writeUInt16LE(5, 536);
  let error;
  try { interpret(changed); } catch (caught) { error = caught; }
  assert.equal(error.message, 'c3d_point_mismatch');
  assert.match(error.detail, /点轨迹/);
});

test('整数存储、参数组顺序与每通道偏移不按固定布局猜测', () => {
  const bytes = buildC3D({
    pointCount: 2, first: 5, last: 6, scale: 0.5, rate: 50,
    analogUsed: 2, analogRate: 100, genScale: 2,
    analogScale: [3, 1.5], analogOffset: [100, 200],
    analogLabels: ['EMG', 'FZ'], pointLabels: ['LANK', 'RANK'],
    groupOrder: ['ANALOG', 'POINT'],
    pointFrames: [
      [[10, -20, 30, 12345], [-10, 20, -30, -1]],
      [[11, -21, 31, 7], [-11, 21, -31, 0]],
    ],
    analogFrames: [[110, 210, 120, 220], [111, 211, 121, 221]],
  });
  const result = interpret(bytes);
  assert.equal(result.storage, 'int16');
  assert.deepEqual(result.points.frames.map(frame => frame.frame), [5, 6]);
  assert.deepEqual(result.points.labels, ['LANK', 'RANK']);
  assert.deepEqual(result.points.frames[0].positions[0].coordinate, [5, -10, 15]);
  // 整数点第 4 字为打包残差/相机字，原值保留不解码
  assert.equal(result.points.frames[0].positions[0].raw[3], 12345);
  assert.equal(result.points.frames[0].positions[1].raw[3], -1);
  assert.deepEqual(result.analog.frames.map(frame => frame.frame), [5, 6]);
  assert.deepEqual(result.analog.frames[0].samples.map(s => [s.subframe, s.channel, s.raw, s.value]),
    [[0, 0, 110, 60], [0, 1, 210, 30], [1, 0, 120, 120], [1, 1, 220, 60]]);
  assert.deepEqual(result.analog.channels.map(channel => channel.label), ['EMG', 'FZ']);
});

test('标量模拟比例按维数广播到各通道，缺少声明明确拒绝', () => {
  const bytes = buildC3D({
    analogUsed: 2, analogRate: 200, rate: 100, genScale: 1,
    analogScale: 2, analogOffset: 50, analogLabels: ['A1', 'A2'],
    pointLabels: ['P1'], pointFrames: [[[1, 2, 3, 0.5]]],
    analogFrames: [[60, 70, 80, 90]],
  });
  const result = interpret(bytes);
  assert.deepEqual(result.analog.channels.map(channel => [channel.scale, channel.offset]), [[2, 50], [2, 50]]);
  assert.equal(result.analog.frames[0].samples[0].value, 20);
  const missing = buildC3D({
    analogUsed: 1, analogRate: 100, analogLabels: ['A1'], analogScale: [1],
    omit: ['ANALOG:OFFSET'], pointLabels: ['P1'], pointFrames: [[[1, 2, 3, 0.5]]],
    analogFrames: [[5]],
  });
  assert.throws(() => interpret(missing), /c3d_parameter_missing/);
});
