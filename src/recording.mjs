// C3D 点帧与模拟子帧的联合解释。布局依据见 docs/upstream.md：
// Intel processor type=84 子集，参数按名称和所属组解释，组顺序与记录顺序不承担语义。
const TYPE_SIZES = new Map([[-1, 1], [1, 1], [2, 2], [4, 4]]);

function fail(code, detail) {
  const error = new Error(code);
  error.detail = detail;
  return error;
}

function cleanString(text) {
  return text.replace(/ +$/g, '').replace(/\0.*$/s, '');
}

function readValue(bytes, at, limit) {
  if (at + 2 > limit) throw fail('c3d_parameter_block', '参数记录的类型/维数字段越过参数区边界');
  const type = bytes.readInt8(at);
  const size = TYPE_SIZES.get(type);
  if (size === undefined) throw fail('c3d_parameter_type', `参数数据类型 ${type} 不在支持范围`);
  const dimensions = bytes[at + 1];
  if (at + 2 + dimensions > limit) throw fail('c3d_parameter_block', '参数维数声明越过记录边界');
  const dims = Array.from({ length: dimensions }, (_, index) => bytes[at + 2 + index]);
  const count = dims.reduce((total, dim) => total * dim, 1);
  const dataAt = at + 2 + dimensions;
  const dataEnd = dataAt + count * size;
  if (dataEnd > limit) throw fail('c3d_parameter_block', '参数数据越过下一条记录，参数声明与参数区有效载荷不相容');
  if (type === -1) {
    if (dimensions >= 2) {
      const width = dims[0];
      if (width <= 0) {
        if (count === 0) return [];
        throw fail('c3d_parameter_block', '字符参数的串长维数为 0 但声明了数据');
      }
      return Array.from({ length: count / width }, (_, index) =>
        cleanString(bytes.toString('ascii', dataAt + index * width, dataAt + (index + 1) * width)));
    }
    return cleanString(bytes.toString('ascii', dataAt, dataEnd));
  }
  const read = type === 1 ? offset => bytes.readUInt8(offset)
    : type === 2 ? offset => bytes.readInt16LE(offset)
    : offset => bytes.readFloatLE(offset);
  const values = Array.from({ length: count }, (_, index) => read(dataAt + index * size));
  return dimensions === 0 ? values[0] : values;
}

function readParameters(bytes, parameterBlock, dataBlock) {
  const start = (parameterBlock - 1) * 512;
  const bound = Math.min((dataBlock - 1) * 512, bytes.length);
  if (start + 4 > bound) throw fail('c3d_parameter_block', '参数区不足四字节头，不能联合接收');
  const processor = bytes[start + 3];
  if (processor !== 84) {
    throw fail('c3d_processor', `参数区声明 processor type=${processor}，仅支持 Intel processor type=84，不能联合接收该原件`);
  }
  const groups = new Map();
  const records = [];
  let position = start + 4;
  while (true) {
    if (position + 2 > bound) throw fail('c3d_parameter_block', '参数记录越过参数区边界');
    const nameLength = bytes.readInt8(position);
    if (nameLength === 0) break;
    const groupId = bytes.readInt8(position + 1);
    const nameAt = position + 2;
    const offsetAt = nameAt + Math.abs(nameLength);
    if (offsetAt + 2 > bound) throw fail('c3d_parameter_block', '参数记录的 offset 字段越过参数区边界');
    const name = bytes.toString('ascii', nameAt, offsetAt).toUpperCase();
    const next = bytes.readInt16LE(offsetAt);
    const nextPosition = offsetAt + next;
    if (next !== 0 && (nextPosition <= position || nextPosition > bound)) {
      throw fail('c3d_parameter_block', 'offset-to-next 未指向参数区内的下一条记录');
    }
    if (groupId < 0) groups.set(-groupId, name);
    else if (groupId > 0) records.push({ groupId, name, value: readValue(bytes, offsetAt + 2, next === 0 ? bound : nextPosition) });
    else throw fail('c3d_parameter_block', '组号为 0 的记录无法归属');
    if (next === 0) break;
    position = nextPosition;
  }
  const values = new Map();
  for (const record of records) {
    const group = groups.get(record.groupId);
    if (!group) throw fail('c3d_parameter_group', `参数 ${record.name} 引用了未声明的组 ${record.groupId}`);
    values.set(`${group}:${record.name}`, record.value);
  }
  return values;
}

function scalar(value, key) {
  const result = Array.isArray(value) ? (value.length === 1 ? value[0] : undefined) : value;
  if (typeof result !== 'number' || !Number.isFinite(result)) {
    throw fail('c3d_parameter_dimension', `参数 ${key} 应为标量，实参维数与声明不相容`);
  }
  return result;
}

function perChannel(value, count, key) {
  const list = Array.isArray(value) ? value : [value];
  if (list.length === count) return list;
  if (list.length === 1) return Array.from({ length: count }, () => list[0]);
  throw fail('c3d_parameter_dimension', `参数 ${key} 声明 ${list.length} 个值，既不是标量也不等于通道数 ${count}，不能联合接收`);
}

function channelLabels(value, count, key) {
  const list = Array.isArray(value) ? value : [value];
  if (list.length < count || !list.every(item => typeof item === 'string')) {
    throw fail('c3d_parameter_dimension', `参数 ${key}:LABELS 的声明与 ${count} 个通道不相容，不能说明通道身份`);
  }
  return list.slice(0, count);
}

export function interpret(bytes) {
  if (bytes.length < 512 || bytes[1] !== 0x50) throw fail('c3d_header', '缺少 C3D 头或魔数，不能联合接收');
  const parameterBlock = bytes[0];
  if (parameterBlock < 2 || parameterBlock * 512 > bytes.length + 512) {
    throw fail('c3d_parameter_block', '头部参数块指针超出原件范围');
  }
  const pointCount = bytes.readUInt16LE(2);
  const analogValuesPerFrame = bytes.readUInt16LE(4);
  const first = bytes.readUInt16LE(6); const last = bytes.readUInt16LE(8);
  const scale = bytes.readFloatLE(12); const dataBlock = bytes.readUInt16LE(16);
  const headerSamplesPerFrame = bytes.readUInt16LE(18); const rate = bytes.readFloatLE(20);
  if (last < first || !Number.isFinite(rate) || rate <= 0 || dataBlock <= parameterBlock) {
    throw fail('c3d_layout', '头部帧范围、采样率或数据块布局不合法');
  }
  if (!Number.isFinite(scale) || scale === 0) throw fail('c3d_layout', '头部比例因子为零或非有限值，无法确定存储宽度');
  const frameCount = last - first + 1;
  const storage = scale < 0 ? 'float32' : 'int16';
  const sampleWidth = scale < 0 ? 4 : 2;
  const parameters = readParameters(bytes, parameterBlock, dataBlock);
  const need = key => {
    if (!parameters.has(key)) throw fail('c3d_parameter_missing', `缺少参数 ${key}，无法依据文件参数说明通道身份、比例或采样关系`);
    return parameters.get(key);
  };
  const pointUsed = scalar(need('POINT:USED'), 'POINT:USED');
  if (!Number.isInteger(pointUsed) || pointUsed !== pointCount) {
    throw fail('c3d_point_mismatch', `POINT:USED=${pointUsed} 与头部每帧点数 ${pointCount} 不相容，不能联合接收点轨迹部分`);
  }
  const pointScale = scalar(need('POINT:SCALE'), 'POINT:SCALE');
  if (pointScale !== scale) {
    throw fail('c3d_point_mismatch', `POINT:SCALE=${pointScale} 与头部比例因子 ${scale} 不相容，不能联合接收点轨迹部分`);
  }
  const pointRate = scalar(need('POINT:RATE'), 'POINT:RATE');
  if (pointRate !== rate) {
    throw fail('c3d_point_mismatch', `POINT:RATE=${pointRate} 与头部采样率 ${rate} 不相容，不能联合接收点轨迹部分`);
  }
  const pointLabels = pointCount > 0 ? channelLabels(need('POINT:LABELS'), pointCount, 'POINT') : [];
  const analogUsed = scalar(need('ANALOG:USED'), 'ANALOG:USED');
  if (!Number.isInteger(analogUsed) || analogUsed < 0) {
    throw fail('c3d_analog_mismatch', `ANALOG:USED=${analogUsed} 不是非负整数，不能联合接收模拟部分`);
  }
  let analog = { rate: 0, samplesPerFrame: 0, valuesPerFrame: 0, channels: [], frames: [] };
  if (analogUsed === 0) {
    if (analogValuesPerFrame !== 0) {
      throw fail('c3d_analog_mismatch', `ANALOG:USED=0 但头部声明每帧 ${analogValuesPerFrame} 个模拟值，有效载荷缺少通道声明，不能联合接收模拟部分`);
    }
  } else {
    const analogRate = scalar(need('ANALOG:RATE'), 'ANALOG:RATE');
    const ratio = analogRate / rate;
    const samplesPerFrame = Math.round(ratio);
    if (!(analogRate > 0) || samplesPerFrame < 1 || Math.abs(ratio - samplesPerFrame) > 1e-9) {
      throw fail('c3d_analog_mismatch', `ANALOG:RATE=${analogRate} 与 POINT:RATE=${rate} 不成正整倍数，不能联合接收模拟部分`);
    }
    if (headerSamplesPerFrame !== samplesPerFrame) {
      throw fail('c3d_analog_mismatch', `头部声明每帧 ${headerSamplesPerFrame} 个模拟子帧，与 ANALOG:RATE/POINT:RATE=${samplesPerFrame} 不相容，不能联合接收模拟部分`);
    }
    const expected = analogUsed * samplesPerFrame;
    if (analogValuesPerFrame !== expected) {
      throw fail('c3d_analog_mismatch',
        `参数声明 ${analogUsed} 个模拟通道 × 每帧 ${samplesPerFrame} 个子帧 = 每帧 ${expected} 个模拟值，与头部每帧 ${analogValuesPerFrame} 个模拟值的有效载荷不相容；不能联合接收模拟部分，不按截短数组凑齐两套时序`);
    }
    const genScale = scalar(need('ANALOG:GEN_SCALE'), 'ANALOG:GEN_SCALE');
    const scales = perChannel(need('ANALOG:SCALE'), analogUsed, 'ANALOG:SCALE');
    const offsets = perChannel(need('ANALOG:OFFSET'), analogUsed, 'ANALOG:OFFSET');
    const labels = channelLabels(need('ANALOG:LABELS'), analogUsed, 'ANALOG');
    analog = {
      rate: analogRate, samplesPerFrame, valuesPerFrame: analogValuesPerFrame,
      channels: labels.map((label, index) => ({ index, label, scale: scales[index], offset: offsets[index], genScale })),
      frames: [],
    };
  }
  const frameBytes = (pointCount * 4 + analogValuesPerFrame) * sampleWidth;
  const offset = (dataBlock - 1) * 512;
  if (offset + frameCount * frameBytes > bytes.length) {
    throw fail('c3d_data_short', `数据区按声明需要 ${frameCount * frameBytes} 字节，原件自数据块起只有 ${bytes.length - offset} 字节，不能联合接收`);
  }
  const readSample = scale < 0 ? at => bytes.readFloatLE(at) : at => bytes.readInt16LE(at);
  const pointFrames = [];
  for (let frame = 0; frame < frameCount; frame++) {
    const frameAt = offset + frame * frameBytes;
    const positions = [];
    for (let point = 0; point < pointCount; point++) {
      const at = frameAt + point * 4 * sampleWidth;
      const raw = Array.from({ length: 4 }, (_, axis) => readSample(at + axis * sampleWidth));
      const position = { index: point, label: pointLabels[point], raw,
        coordinate: raw.slice(0, 3).map(value => (scale < 0 ? value : value * scale)) };
      // 浮点点 residual<0 标记无效但不抹除原始值；整数点第 4 字为打包残差/相机字，原值保留在 raw[3]
      if (scale < 0) position.valid = raw[3] >= 0;
      positions.push(position);
    }
    pointFrames.push({ frame: first + frame, positions });
  }
  if (analogUsed > 0) {
    for (let frame = 0; frame < frameCount; frame++) {
      const frameAt = offset + frame * frameBytes + pointCount * 4 * sampleWidth;
      const samples = [];
      for (let subframe = 0; subframe < analog.samplesPerFrame; subframe++) {
        for (let channel = 0; channel < analogUsed; channel++) {
          const raw = readSample(frameAt + (subframe * analogUsed + channel) * sampleWidth);
          const declared = analog.channels[channel];
          samples.push({ subframe, channel, raw, value: (raw - declared.offset) * declared.scale * declared.genScale });
        }
      }
      analog.frames.push({ frame: first + frame, samples });
    }
  }
  return {
    kind: 'c3d-recording', storage, processor: 84, parameterBlock, dataBlock,
    frames: { first, last, count: frameCount, rate },
    points: { count: pointCount, scale, rate, labels: pointLabels, frames: pointFrames },
    analog,
  };
}
