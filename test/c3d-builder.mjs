// 测试用 C3D 合成器：按本项目交换子集构造原件，可切换 int16/float32 存储、
// 打乱参数组/记录顺序、制造畸形声明。仅服务测试，不读取任何外部原件。

function recordGroup(name, groupId) {
  const nameBytes = Buffer.from(name, 'ascii');
  const buf = Buffer.alloc(2 + nameBytes.length + 3);
  buf[0] = nameBytes.length;
  buf.writeInt8(-groupId, 1);
  nameBytes.copy(buf, 2);
  buf.writeUInt16LE(groupId, 2 + nameBytes.length);
  buf[2 + nameBytes.length + 2] = 0; // 无描述
  return buf;
}

// 以“到下一记录”的 offset 链组装；调用方按期望的物理记录顺序传入。
function recordParam(name, groupId, type, dims, dataBuffer, offset) {
  const nameBytes = Buffer.from(name, 'ascii');
  const headerLen = 2 + nameBytes.length + 4 + dims.length;
  const buf = Buffer.alloc(headerLen + dataBuffer.length + 1);
  buf[0] = nameBytes.length;
  buf.writeInt8(groupId, 1);
  nameBytes.copy(buf, 2);
  const offPos = 2 + nameBytes.length;
  buf.writeInt16LE(offset, offPos);
  buf.writeInt8(type, offPos + 2);
  buf[offPos + 3] = dims.length;
  dims.forEach((dim, i) => { buf[offPos + 4 + i] = dim; });
  dataBuffer.copy(buf, offPos + 4 + dims.length);
  buf[buf.length - 1] = 0; // 无描述
  return buf;
}

function charData(labels, width) {
  return Buffer.from(labels.map(label => label.padEnd(width, ' ').slice(0, width)).join(''), 'ascii');
}

export function buildC3D(options = {}) {
  const {
    storage = 'float32', // 'float32' | 'int16'
    pointCount = 2,
    analogChannels: channelCount = 2,
    frameCount = 3,
    firstFrame = 1,
    pointRate = 100,
    analogRate = 200,
    pointScale = storage === 'float32' ? -1.0 : 0.025,
    genScale = 0.5,
    analogScales = [2, 4],
    analogOffsets = [10, 20],
    pointLabels = ['HEEL', 'TOE'],
    analogLabels = ['FZ', 'EMG'],
    labelWidth = 4,
    analogLabelWidth = 4,
    scalarAnalogScale = false,
    scalarAnalogOffset = false,
    reorderParameters = false,
    processor = 84,
    frames: suppliedFrames = null,
    headerAnalogPerFrame = null,
    headerSamplesPerFrame = null,
    truncateDataBytes = 0,
    scaleDim = null,
  } = options;

  const width = storage === 'float32' ? 4 : 2;
  const samplesPerFrame = analogRate / pointRate;
  const analogPerFrame = samplesPerFrame * channelCount;
  const dataStart = 3; // 头块 + 一个参数块
  const lastFrame = firstFrame + frameCount - 1;

  // ---- 数据载荷 ----
  const frames = suppliedFrames ?? Array.from({ length: frameCount }, (_, frameIndex) => ({
    points: Array.from({ length: pointCount }, (_, pointIndex) => {
      const base = frameIndex * 10 + pointIndex + 1;
      const residual = pointIndex === 1 && frameIndex === 1 ? (storage === 'float32' ? -0.5 : -3) : 0;
      return [base, base + 0.25, base + 0.5, residual];
    }),
    analog: Array.from({ length: samplesPerFrame }, (_, subframe) =>
      Array.from({ length: channelCount }, (_, channel) => frameIndex * 100 + subframe * 10 + channel + 1)),
  }));

  const frameBytes = (pointCount * 4 + analogPerFrame) * width;
  const payload = Buffer.alloc(frameCount * frameBytes);
  const writeWord = storage === 'float32'
    ? (buf, value, at) => buf.writeFloatLE(value, at)
    : (buf, value, at) => buf.writeInt16LE(value, at);
  frames.forEach((frame, frameIndex) => {
    const frameStart = frameIndex * frameBytes;
    frame.points.forEach((words, pointIndex) => {
      words.forEach((word, axis) => writeWord(payload, word, frameStart + (pointIndex * 4 + axis) * width));
    });
    const analogStart = frameStart + pointCount * 4 * width;
    frame.analog.forEach((row, subframe) => {
      row.forEach((raw, channel) => {
        writeWord(payload, raw, analogStart + (subframe * channelCount + channel) * width);
      });
    });
  });

  // ---- 参数段 ----
  const int16 = value => {
    const b = Buffer.alloc(2); b.writeInt16LE(value); return b;
  };
  const float32 = value => {
    const b = Buffer.alloc(4); b.writeFloatLE(value); return b;
  };
  const pointGroup = recordGroup('POINT', 1);
  const pointUsed = recordParam('USED', 1, 2, [], int16(pointCount), 0);
  const pointScaleRec = recordParam('SCALE', 1, 4, [], float32(pointScale), 0);
  const pointRateRec = recordParam('RATE', 1, 4, [], float32(pointRate), 0);
  const pointLabelsRec = recordParam('LABELS', 1, -1, [labelWidth, pointCount],
    charData(pointLabels, labelWidth), 0);
  const pointRecords = [pointGroup, pointUsed, pointScaleRec, pointRateRec, pointLabelsRec];

  let analogRecords = [];
  if (channelCount > 0) {
    const analogGroup = recordGroup('ANALOG', 2);
    const analogUsed = recordParam('USED', 2, 2, [], int16(channelCount), 0);
    const analogRateRec = recordParam('RATE', 2, 4, [], float32(analogRate), 0);
    const genScaleRec = recordParam('GEN_SCALE', 2, 4, [], float32(genScale), 0);
    const scaleValues = scalarAnalogScale ? [analogScales[0]] : analogScales;
    const offsetValues = scalarAnalogOffset ? [analogOffsets[0]] : analogOffsets;
    const analogScaleRec = recordParam('SCALE', 2, storage === 'float32' ? 4 : 2,
      scaleDim ?? (scalarAnalogScale ? [] : [channelCount]),
      Buffer.concat(scaleValues.map(v => storage === 'float32' ? float32(v) : int16(v))), 0);
    const analogOffsetRec = recordParam('OFFSET', 2, storage === 'float32' ? 4 : 2,
      scalarAnalogOffset ? [] : [channelCount],
      Buffer.concat(offsetValues.map(v => storage === 'float32' ? float32(v) : int16(v))), 0);
    const analogLabelsRec = recordParam('LABELS', 2, -1, [analogLabelWidth, channelCount],
      charData(analogLabels, analogLabelWidth), 0);
    analogRecords = [analogGroup, analogUsed, analogRateRec, genScaleRec,
      analogScaleRec, analogOffsetRec, analogLabelsRec];
  } else {
    const analogGroup = recordGroup('ANALOG', 2);
    const analogUsed = recordParam('USED', 2, 2, [], int16(0), 0);
    const analogRateRec = recordParam('RATE', 2, 4, [], float32(0), 0);
    analogRecords = [analogGroup, analogUsed, analogRateRec];
  }

  // 默认顺序：POINT 组及其记录在前；reorder 时 ANALOG 组在前且交错记录顺序。
  const ordered = reorderParameters
    ? [...analogRecords, ...pointRecords]
    : [...pointRecords, ...analogRecords];

  // 重算 offset 链（offset 从其自身字段起算，末记录为 0，其后补零终止字节）。
  const totalParamBytes = ordered.reduce((acc, rec) => acc + rec.length, 0) + 1;
  if (totalParamBytes > 512 - 4) throw new Error('参数段超出单块，测试构造器需扩展');
  const paramBlock = Buffer.alloc(512);
  paramBlock[0] = 0; // reserved
  paramBlock[1] = 0x50; // version
  paramBlock[2] = 1; // block count
  paramBlock[3] = processor;
  let cursor = 4;
  const positions = [];
  for (const rec of ordered) { positions.push(cursor); rec.copy(paramBlock, cursor); cursor += rec.length; }
  paramBlock[cursor] = 0; // 零终止
  for (let i = 0; i < ordered.length; i++) {
    const rec = ordered[i];
    // offset 字段位于记录内 (nameLen+2) 处
    const offInRec = rec[0] + 2;
    const offPos = positions[i] + offInRec;
    const next = i + 1 < ordered.length ? positions[i + 1] - offPos : 0;
    paramBlock.writeInt16LE(next, offPos);
  }

  // ---- 头 ----
  const header = Buffer.alloc(512);
  header[0] = 2; // 参数起始块
  header[1] = 0x50;
  header.writeUInt16LE(pointCount, 2);
  header.writeUInt16LE(headerAnalogPerFrame ?? analogPerFrame, 4);
  header.writeUInt16LE(firstFrame, 6);
  header.writeUInt16LE(lastFrame, 8);
  header.writeFloatLE(pointScale, 12);
  header.writeUInt16LE(dataStart, 16);
  header.writeUInt16LE(headerSamplesPerFrame ?? samplesPerFrame, 18);
  header.writeFloatLE(pointRate, 20);

  const file = Buffer.concat([header, paramBlock, payload]);
  return truncateDataBytes ? file.subarray(0, file.length - truncateDataBytes) : file;
}
