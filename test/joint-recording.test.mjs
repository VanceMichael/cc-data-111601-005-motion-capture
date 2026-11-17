import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect, C3DError, parseParameterSection } from '../src/c3d.mjs';
import { buildC3D } from './c3d-builder.mjs';

test('float32 原件联合解码点帧与模拟子帧，保留原始读数与定位信息', () => {
  const bytes = buildC3D({ storage: 'float32' });
  const result = inspect(bytes);
  assert.equal(result.kind, 'c3d-recording');
  assert.equal(result.storage, 'float32');
  assert.equal(result.pointCount, 2);
  assert.equal(result.analogChannelCount, 2);
  assert.equal(result.samplesPerFrame, 2);
  assert.equal(result.frameCount, 3);
  assert.deepEqual(result.frameRange, { first: 1, last: 3 });
  assert.deepEqual(result.pointLabels.map(p => p.label), ['HEEL', 'TOE']);
  assert.deepEqual(result.analogChannels.map(c => c.label), ['FZ', 'EMG']);

  const frame0 = result.frames[0];
  assert.equal(frame0.frame, 1);
  // 浮点坐标原样保留
  assert.deepEqual(frame0.positions[0].coordinate, [1, 1.25, 1.5]);
  assert.deepEqual(frame0.positions[0].raw, [1, 1.25, 1.5, 0]);
  // 模拟量：(raw-OFFSET)*SCALE*GEN_SCALE，GEN_SCALE=0.5
  const s0 = frame0.analog[0].channels;
  assert.equal(s0[0].raw, 1);
  assert.equal(s0[0].physical, (1 - 10) * 2 * 0.5);
  assert.equal(s0[1].raw, 2);
  assert.equal(s0[1].physical, (2 - 20) * 4 * 0.5);
  const s1 = frame0.analog[1].channels;
  assert.equal(s1[0].subframe, 1);
  assert.equal(s1[0].raw, 11);
  // 原始字节可回溯
  assert.equal(bytes.readFloatLE(s0[0].location.byteOffset), 1);
  assert.equal(s0[0].location.sampleIndex, 0);
  assert.equal(s1[0].location.sampleIndex, 1);
  assert.equal(frame0.positions[0].location.frame, 1);
});

test('浮点残差为负标记无效点但不抹除原始值', () => {
  const result = inspect(buildC3D({ storage: 'float32' }));
  const flagged = result.frames[1].positions[1];
  assert.equal(flagged.invalid, true);
  assert.equal(flagged.residualWord, -0.5);
  assert.deepEqual(flagged.coordinate, [12, 12.25, 12.5]);
  assert.equal(result.frames[0].positions[0].invalid, false);
});

test('int16 存储：坐标按 SCALE 换算，残差/相机字原值保留不强行解码', () => {
  const bytes = buildC3D({ storage: 'int16', pointScale: 0.025 });
  const result = inspect(bytes);
  assert.equal(result.storage, 'int16');
  const p = result.frames[0].positions[0];
  assert.deepEqual(p.raw, [1, 1, 1, 0]);
  assert.equal(p.coordinate.length, 3);
  // SCALE 以 float32 存储，0.025 的表示误差约 1e-10，按浮点精度放宽
  for (const value of p.coordinate) assert.ok(Math.abs(value - 0.025) < 1e-8);
  assert.equal(p.invalid, false);
  // 整数原件不解释相机编号，残差字保持整数原值
  const flagged = result.frames[1].positions[1];
  assert.equal(flagged.residualWord, -3);
  assert.ok(Math.abs(flagged.coordinate[0] - 12 * 0.025) < 1e-8);
  // 模拟量为 int16，公式不变
  const ch = result.frames[0].analog[0].channels[0];
  assert.equal(ch.raw, 1);
  assert.equal(ch.physical, (1 - 10) * 2 * 0.5);
  assert.equal(bytes.readInt16LE(ch.location.byteOffset), 1);
});

test('参数组与记录顺序不承担语义：乱序参数段等价解码', () => {
  const ordered = inspect(buildC3D({ reorderParameters: false }));
  const shuffled = inspect(buildC3D({ reorderParameters: true }));
  assert.deepEqual(shuffled.frames, ordered.frames);
  assert.deepEqual(shuffled.analogChannels, ordered.analogChannels);
  assert.deepEqual(
    shuffled.parameterSources.map(p => `${p.group}:${p.name}`).sort(),
    ordered.parameterSources.map(p => `${p.group}:${p.name}`).sort());
});

test('ANALOG:SCALE/OFFSET 标量自动广播并记录来源', () => {
  const result = inspect(buildC3D({ scalarAnalogScale: true, scalarAnalogOffset: true }));
  assert.equal(result.calibration.analog.scaleBroadcast, true);
  assert.equal(result.calibration.analog.offsetBroadcast, true);
  const ch = result.frames[0].analog[0].channels;
  assert.equal(ch[0].physical, (1 - 10) * 2 * 0.5);
  assert.equal(ch[1].physical, (2 - 10) * 2 * 0.5);
  const sources = result.calibration.analog.sources;
  assert.ok(sources.some(s => s.group === 'ANALOG' && s.name === 'SCALE'));
  assert.ok(sources.some(s => s.group === 'ANALOG' && s.name === 'OFFSET'));
});

test('逐通道比例实参维数必须与通道数相容', () => {
  // 3 通道声明的 SCALE 与 ANALOG:USED=2 不相容：维数校验先于任何数据拼接拒收。
  const bytes = buildC3D({
    analogChannels: 2,
    analogScales: [2, 4, 6],
    scaleDim: [3],
  });
  assert.throws(() => inspect(bytes), error =>
    error instanceof C3DError && error.code === 'c3d_parameter_shape'
    && /SCALE/.test(error.message) && error.details.expected === 2);
});

test('速率不是整倍数时拒绝并说明两套时序关系', () => {
  const bytes = buildC3D({ analogRate: 250, pointRate: 100, headerSamplesPerFrame: 2 });
  assert.throws(() => inspect(bytes), error => {
    return error instanceof C3DError && error.code === 'c3d_rate_relation'
      && error.details.analogRate === 250 && error.details.pointRate === 100;
  });
});

test('头内每帧模拟值数与参数声明不相容时整体拒收', () => {
  const bytes = buildC3D({ headerAnalogPerFrame: 3 });
  assert.throws(() => inspect(bytes), error =>
    error instanceof C3DError && error.code === 'c3d_header_mismatch'
    && error.details.header === 3 && error.details.expected === 4);
});

test('有效载荷被截断时拒绝，不截短数组凑齐时序', () => {
  const bytes = buildC3D({ truncateDataBytes: 8 });
  assert.throws(() => inspect(bytes), error =>
    error instanceof C3DError && error.code === 'c3d_data_short'
    && error.details.requiredBytes > error.details.availableBytes
    && error.details.analogSamplesExpected === 6);
});

test('非 84 processor 明确报告不支持', () => {
  const bytes = buildC3D({ processor: 85 });
  assert.throws(() => inspect(bytes), error =>
    error instanceof C3DError && error.code === 'c3d_processor_unsupported'
    && error.details.processor === 85);
});

test('缺少必需参数时按名称报告', () => {
  // 把 ANALOG:GEN_SCALE 的记录名改坏，验证按名称缺失的报错路径（offset 链保持不变）。
  const bytes = buildC3D({});
  const broken = Buffer.from(bytes);
  const section = parseParameterSection(broken);
  const gen = section.parameters.find(p => p.group === 'ANALOG' && p.name === 'GEN_SCALE');
  const nameAt = gen.recordStart + 2;
  assert.equal(broken.subarray(nameAt, nameAt + 9).toString('ascii'), 'GEN_SCALE');
  broken.write('XXXXXXXXX', nameAt, 'ascii');
  assert.throws(() => inspect(broken), error =>
    error instanceof C3DError && error.code === 'c3d_parameter_missing'
    && error.details.name === 'GEN_SCALE');
});

test('无模拟通道的点采集仍可联合接收，模拟序列为空而非伪造', () => {
  const bytes = buildC3D({ analogChannels: 0, analogRate: 0, analogLabels: [], analogScales: [], analogOffsets: [] });
  const result = inspect(bytes);
  assert.equal(result.analogChannelCount, 0);
  assert.equal(result.samplesPerFrame, 0);
  assert.deepEqual(result.frames[0].analog, []);
  assert.equal(result.frames.length, 3);
});

test('参数来源保留字节偏移，支持定位到原帧与原始读数', () => {
  const result = inspect(buildC3D({}));
  for (const source of result.parameterSources) {
    assert.equal(typeof source.byteOffset, 'number');
    assert.ok(source.byteOffset > 0);
  }
  const anySample = result.frames[0].analog[0].channels[0];
  assert.ok(Number.isInteger(anySample.location.byteOffset));
  assert.equal(anySample.location.frame, 1);
});

test('畸形参数链与未知数据类型被结构化拒收', () => {
  const base = buildC3D({});
  const backward = Buffer.from(base);
  const section = parseParameterSection(backward);
  const used = section.parameters.find(p => p.name === 'USED');
  backward.writeInt16LE(2, used.recordStart + used.name.length + 2);
  assert.throws(() => inspect(backward), error => error instanceof C3DError);

  const badType = Buffer.from(base);
  const rate = section.parameters.find(p => p.group === 'POINT' && p.name === 'RATE');
  badType[rate.recordStart + rate.name.length + 2 + 2] = 3;
  assert.throws(() => inspect(badType), error =>
    error instanceof C3DError && error.code === 'c3d_parameter_type');

  assert.throws(() => inspect(Buffer.alloc(0)), error =>
    error instanceof C3DError && error.code === 'c3d_header');
  const badMagic = Buffer.from(base);
  badMagic[1] = 0;
  assert.throws(() => inspect(badMagic), error =>
    error instanceof C3DError && error.code === 'c3d_header');
});
