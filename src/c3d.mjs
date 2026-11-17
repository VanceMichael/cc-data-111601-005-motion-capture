// C3D（Intel processor type=84 子集）联合读取：
// 参数段按名称与所属组解释，点帧与模拟子帧按参数声明联合解码。
// 不依赖固定的记录/组顺序与字段偏移；声明与有效载荷不相容时抛出带明细的 C3DError，
// 绝不通过截短数组凑齐两套时序。

export class C3DError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'C3DError';
    this.code = code;
    this.details = details;
  }
}

const HEADER_SIZE = 512;
const PARAM_HEADER_SIZE = 4; // reserved(1) version(1) blockCount(1) processor(1)
const TYPE_NAME = { [-1]: 'char', 1: 'uint8', 2: 'int16', 4: 'float32' };

function fail(code, message, details = {}) {
  throw new C3DError(code, message, details);
}

function requireRange(pos, needed, length, code, details = {}) {
  if (pos < 0 || pos + needed > length) {
    fail(code, `读取超出原件边界：需要 ${needed} 字节，位置 ${pos}，原件长度 ${length}`,
      { position: pos, needed, length, ...details });
  }
}

// ---------- 参数段 ----------
// 记录布局（本交换子集，参数记录用其正组号、组记录用负号标记携带身份）：
//   组记录：  nameLen(1) marker=-groupId(1) name(nameLen) id(u16) descLen(1) desc
//   参数记录：nameLen(1) marker=+groupId(1) name(nameLen) offset(i16) type(i8)
//             dimensionCount(u8) dims(u8)* data... descriptionLen(u8) description
// offset 从 offset 字段自身位置起算，为 0 时终止整条参数链。
export function parseParameterSection(bytes) {
  if (bytes.length < HEADER_SIZE) fail('c3d_header', '原件不足一个 512 字节头块');
  const parameterBlock = bytes[0];
  if (bytes[1] !== 0x50) fail('c3d_header', 'C3D 参数字节（0x50）缺失', { marker: bytes[1] });
  if (!Number.isInteger(parameterBlock) || parameterBlock < 2) {
    fail('c3d_parameter_block', '参数起始块非法', { parameterBlock });
  }
  const start = (parameterBlock - 1) * HEADER_SIZE;
  if (start + PARAM_HEADER_SIZE > bytes.length) {
    fail('c3d_parameter_section', '参数段超出原件边界', { start });
  }
  const processor = bytes[start + 3];
  if (processor !== 84) {
    fail('c3d_processor_unsupported', `不支持的 processor type=${processor}，本服务仅接收 Intel type=84`,
      { processor, supported: 84 });
  }
  const blockCount = bytes[start + 2];
  const sectionEnd = start + PARAM_HEADER_SIZE + blockCount * HEADER_SIZE;
  if (sectionEnd > bytes.length) {
    fail('c3d_parameter_section', '参数段声明的块数超出原件边界', { start, blockCount, sectionEnd });
  }

  const groupNames = new Map(); // groupId -> name
  const rawParams = [];
  let p = start + PARAM_HEADER_SIZE;
  let guard = 0;
  while (p < sectionEnd && guard++ < 1_000_000) {
    requireRange(p, 2, sectionEnd, 'c3d_parameter_record', { recordStart: p });
    const nameLen = bytes[p];
    if (nameLen === 0) break; // 零终止
    if (nameLen < 0 || nameLen > 100) {
      fail('c3d_parameter_record', '参数记录名称长度非法', { position: p, nameLen });
    }
    const marker = bytes.readInt8(p + 1);
    if (marker === 0) fail('c3d_parameter_record', '记录缺少组身份标记', { position: p });

    if (marker < 0) {
      const groupId = -marker;
      requireRange(p + 2 + nameLen + 3, 1, sectionEnd, 'c3d_group_record', { recordStart: p });
      const name = bytes.subarray(p + 2, p + 2 + nameLen).toString('ascii');
      const idPos = p + 2 + nameLen;
      const declaredId = bytes.readUInt16LE(idPos);
      if (declaredId === 0) {
        fail('c3d_group_record', '组记录的组号字段为零', { group: name });
      }
      const descLen = bytes[idPos + 2];
      requireRange(idPos + 3, descLen, sectionEnd, 'c3d_group_record', { group: name });
      if (groupNames.has(groupId) && groupNames.get(groupId) !== name) {
        fail('c3d_group_record', '同一组号出现冲突的组名', { groupId, names: [groupNames.get(groupId), name] });
      }
      groupNames.set(groupId, name);
      p = idPos + 3 + descLen;
      continue;
    }

    const groupId = marker;
    requireRange(p + 2 + nameLen + 4, 1, sectionEnd, 'c3d_parameter_record', { recordStart: p });
    const name = bytes.subarray(p + 2, p + 2 + nameLen).toString('ascii');
    const offPos = p + 2 + nameLen;
    const offset = bytes.readInt16LE(offPos);
    if (offset < 0) fail('c3d_parameter_record', `参数 ${name} 的 offset 为负值`, { position: offPos, offset });
    const type = bytes.readInt8(offPos + 2);
    if (!Object.hasOwn(TYPE_NAME, type)) {
      fail('c3d_parameter_type', `参数 ${name} 使用未支持的数据类型 ${type}`, { parameter: name, type });
    }
    const dimensionCount = bytes[offPos + 3];
    if (dimensionCount < 0 || dimensionCount > 7) {
      fail('c3d_parameter_record', `参数 ${name} 的维数非法`, { parameter: name, dimensionCount });
    }
    const dims = [];
    for (let i = 0; i < dimensionCount; i++) {
      requireRange(offPos + 4 + i, 1, sectionEnd, 'c3d_parameter_record', { parameter: name });
      const dim = bytes[offPos + 4 + i];
      if (dim <= 0) fail('c3d_parameter_record', `参数 ${name} 的维度长度非法`, { parameter: name, dimension: dim });
      dims.push(dim);
    }
    const dataPos = offPos + 4 + dimensionCount;
    const width = Math.abs(type);
    const elementCount = dims.reduce((acc, dim) => acc * dim, 1) || 1;
    const byteCount = elementCount * width;
    requireRange(dataPos, byteCount + 1, sectionEnd, 'c3d_parameter_data', { parameter: name });
    const descLenPos = dataPos + byteCount;
    const descLen = bytes[descLenPos];
    requireRange(descLenPos + 1, descLen, sectionEnd, 'c3d_parameter_data', { parameter: name });
    const description = bytes.subarray(descLenPos + 1, descLenPos + 1 + descLen).toString('ascii');

    let data;
    if (type === -1) data = bytes.subarray(dataPos, dataPos + byteCount).toString('ascii');
    else if (type === 1) data = [...bytes.subarray(dataPos, dataPos + byteCount)];
    else if (type === 2) data = Array.from({ length: elementCount }, (_, i) => bytes.readInt16LE(dataPos + i * 2));
    else data = Array.from({ length: elementCount }, (_, i) => bytes.readFloatLE(dataPos + i * 4));

    rawParams.push({
      groupId, name, type, typeName: TYPE_NAME[type], dims, elementCount,
      recordStart: p, dataPos, byteCount, description, offset, value: data,
    });

    if (offset === 0) break; // 零终止
    const next = offPos + offset;
    if (next <= p || next >= sectionEnd) {
      fail('c3d_parameter_chain', `参数 ${name} 的 offset 链指向参数段之外`,
        { parameter: name, offset, next, sectionEnd });
    }
    p = next;
  }

  const parameters = rawParams.map(param => {
    const group = groupNames.get(param.groupId);
    if (!group) {
      fail('c3d_group_missing', `参数 ${param.name} 引用的组号 ${param.groupId} 没有对应组记录`,
        { parameter: param.name, groupId: param.groupId });
    }
    return { ...param, group };
  });

  return { start, end: p, processor, blockCount, groupNames, parameters };
}

function findParameter(parameters, group, name) {
  const matches = parameters.filter(param => param.group === group && param.name === name);
  if (matches.length > 1) fail('c3d_parameter_duplicate', `${group}:${name} 出现多次`, { group, name });
  return matches[0];
}

function requireParameter(parameters, group, name) {
  const param = findParameter(parameters, group, name);
  if (!param) fail('c3d_parameter_missing', `缺少必需参数 ${group}:${name}`, { group, name });
  return param;
}

function scalarParameter(parameters, group, name) {
  const param = requireParameter(parameters, group, name);
  if (param.elementCount !== 1 || param.type === -1) {
    fail('c3d_parameter_shape', `${group}:${name} 必须是标量`,
      { group, name, dims: param.dims, type: param.typeName });
  }
  return param.value[0];
}

// 字符数组按第一维宽度切分为若干定长标签，返回保留原值与去空格值两种形式。
function labelParameter(parameters, group, name, expectedCount) {
  const param = requireParameter(parameters, group, name);
  if (param.type !== -1) {
    fail('c3d_parameter_shape', `${group}:${name} 必须是字符数组`, { group, name, type: param.typeName });
  }
  const width = param.dims[0] ?? param.elementCount;
  const count = param.dims.length > 1 ? param.dims.slice(1).reduce((acc, dim) => acc * dim, 1) : 1;
  if (count !== expectedCount) {
    fail('c3d_parameter_shape', `${group}:${name} 标签数量与 USED 不相容`,
      { group, name, labelCount: count, used: expectedCount, dims: param.dims });
  }
  const labels = [];
  for (let i = 0; i < count; i++) {
    const raw = param.value.slice(i * width, (i + 1) * width);
    labels.push({ index: i, raw, label: raw.replace(/\s+$/g, '') });
  }
  return labels;
}

// 要求参数为指定数值类型、元素数量等于 expected（标量自动广播）。
function numericParameter(parameters, group, name, expected, allowedTypes) {
  const param = requireParameter(parameters, group, name);
  if (!allowedTypes.includes(param.type)) {
    fail('c3d_parameter_type', `${group}:${name} 的数据类型不在支持范围`,
      { group, name, type: param.typeName, allowed: allowedTypes.map(type => TYPE_NAME[type]) });
  }
  if (param.elementCount !== 1 && param.elementCount !== expected) {
    fail('c3d_parameter_shape', `${group}:${name} 的实参维数与通道数不相容`,
      { group, name, dims: param.dims, elements: param.elementCount, expected });
  }
  const broadcast = param.elementCount === 1 && expected > 1;
  const values = Array.from({ length: expected }, (_, i) => param.value[broadcast ? 0 : i]);
  return { values, broadcast, source: { group, name, type: param.typeName, dims: param.dims, position: param.dataPos } };
}

// ---------- 头 ----------
function parseHeader(bytes) {
  if (bytes.length < HEADER_SIZE) fail('c3d_header', '原件不足一个 512 字节头块');
  if (bytes[1] !== 0x50) fail('c3d_header', 'C3D 参数字节（0x50）缺失', { marker: bytes[1] });
  const header = {
    parameterBlock: bytes[0],
    pointCount: bytes.readUInt16LE(2),
    analogValuesPerFrame: bytes.readUInt16LE(4),
    firstFrame: bytes.readUInt16LE(6),
    lastFrame: bytes.readUInt16LE(8),
    scale: bytes.readFloatLE(12),
    dataStart: bytes.readUInt16LE(16),
    samplesPerFrame: bytes.readUInt16LE(18),
    frameRate: bytes.readFloatLE(20),
  };
  if (header.lastFrame < header.firstFrame) {
    fail('c3d_layout', '头内帧范围非法（last 小于 first）', header);
  }
  if (!Number.isFinite(header.frameRate) || header.frameRate <= 0) {
    fail('c3d_layout', '头内点采样率非法', { rate: header.frameRate });
  }
  if (!Number.isFinite(header.scale) || header.scale === 0) {
    fail('c3d_layout', '头内 SCALE 非法（为零或非有限值）', { scale: header.scale });
  }
  if (header.dataStart <= header.parameterBlock) {
    fail('c3d_layout', 'DATA_START 未位于参数段之后', header);
  }
  header.frameCount = header.lastFrame - header.firstFrame + 1;
  header.storage = header.scale < 0 ? 'float32' : 'int16';
  header.sampleWidth = header.scale < 0 ? 4 : 2;
  return header;
}

// ---------- 联合读取入口 ----------
export function inspect(bytes) {
  const header = parseHeader(bytes);
  const section = parseParameterSection(bytes);
  const { parameters } = section;

  // 点参数身份
  const pointUsed = scalarParameter(parameters, 'POINT', 'USED');
  const pointScale = scalarParameter(parameters, 'POINT', 'SCALE');
  const pointRate = scalarParameter(parameters, 'POINT', 'RATE');
  if (!Number.isInteger(pointUsed) || pointUsed < 0) {
    fail('c3d_parameter_shape', 'POINT:USED 必须是非负整数', { used: pointUsed });
  }
  if (pointUsed !== header.pointCount) {
    fail('c3d_header_mismatch', 'POINT:USED 与头内点数不相容',
      { header: header.pointCount, parameter: pointUsed });
  }
  if (pointScale !== header.scale) {
    fail('c3d_header_mismatch', 'POINT:SCALE 与头内 SCALE 不相容',
      { header: header.scale, parameter: pointScale });
  }
  if (pointRate !== header.frameRate) {
    fail('c3d_header_mismatch', 'POINT:RATE 与头内采样率不相容',
      { header: header.frameRate, parameter: pointRate });
  }
  const pointLabels = pointUsed > 0
    ? labelParameter(parameters, 'POINT', 'LABELS', pointUsed)
    : [];

  // 模拟参数身份
  const analogUsed = scalarParameter(parameters, 'ANALOG', 'USED');
  if (!Number.isInteger(analogUsed) || analogUsed < 0) {
    fail('c3d_parameter_shape', 'ANALOG:USED 必须是非负整数', { used: analogUsed });
  }
  const analogRate = scalarParameter(parameters, 'ANALOG', 'RATE');
  if (!Number.isFinite(analogRate) || analogRate < 0) {
    fail('c3d_parameter_shape', 'ANALOG:RATE 非法', { rate: analogRate });
  }
  let analogChannels = [];
  let samplesPerFrame = 0;
  let analogScales = [];
  let analogOffsets = [];
  let scaleSource = null;
  let offsetSource = null;
  let genScale = 0;
  let genScaleSource = null;

  if (analogUsed > 0) {
    if (!(analogRate > 0)) fail('c3d_parameter_shape', '存在模拟通道时 ANALOG:RATE 必须为正', { rate: analogRate });
    const ratio = analogRate / pointRate;
    if (!Number.isInteger(ratio) || ratio < 1) {
      fail('c3d_rate_relation', 'ANALOG:RATE 与 POINT:RATE 不是相容的整倍数关系',
        { pointRate, analogRate, ratio });
    }
    samplesPerFrame = ratio;
    if (samplesPerFrame !== header.samplesPerFrame) {
      fail('c3d_header_mismatch', '速率比与头内每帧模拟子帧数不相容',
        { rateRatio: samplesPerFrame, header: header.samplesPerFrame });
    }

    // 模拟原始量与点同宽（SCALE 正为 int16，负为 float32）；GEN_SCALE/SCALE/OFFSET 支持标量或逐通道。
    const genScaleParam = numericParameter(parameters, 'ANALOG', 'GEN_SCALE', analogUsed, [4]);
    genScale = genScaleParam.values[0];
    genScaleSource = genScaleParam.source;
    if (!Number.isFinite(genScale) || genScale === 0) {
      fail('c3d_parameter_shape', 'ANALOG:GEN_SCALE 必须是非零有限数', { genScale });
    }
    scaleSource = numericParameter(parameters, 'ANALOG', 'SCALE', analogUsed,
      header.storage === 'float32' ? [4, 2] : [2, 4]);
    offsetSource = numericParameter(parameters, 'ANALOG', 'OFFSET', analogUsed,
      header.storage === 'float32' ? [4, 2] : [2, 4]);
    analogScales = scaleSource.values;
    analogOffsets = offsetSource.values;
    for (const [index, value] of analogScales.entries()) {
      if (!Number.isFinite(value) || value === 0) {
        fail('c3d_parameter_shape', `ANALOG:SCALE 第 ${index} 通道为零或非有限值`, { value, index });
      }
    }
    for (const [index, value] of analogOffsets.entries()) {
      if (!Number.isFinite(value)) {
        fail('c3d_parameter_shape', `ANALOG:OFFSET 第 ${index} 通道非有限值`, { value, index });
      }
    }
    const analogLabels = labelParameter(parameters, 'ANALOG', 'LABELS', analogUsed);
    analogChannels = analogLabels.map(({ index, label, raw }) => ({
      index,
      label,
      rawLabel: raw,
      scale: analogScales[index],
      offset: analogOffsets[index],
      genScale,
      physical: '(raw - OFFSET) * SCALE * GEN_SCALE',
    }));
  } else if (analogRate !== 0) {
    fail('c3d_parameter_shape', 'ANALOG:USED 为 0 时 RATE 必须为 0', { rate: analogRate });
  }

  // 头内每帧模拟值数必须等于 子帧数 × 通道数
  const expectedAnalogPerFrame = samplesPerFrame * analogUsed;
  if (header.analogValuesPerFrame !== expectedAnalogPerFrame) {
    fail('c3d_header_mismatch', '头内每帧模拟值数与参数声明的子帧/通道数不相容',
      { header: header.analogValuesPerFrame, expected: expectedAnalogPerFrame,
        samplesPerFrame, analogUsed });
  }

  // 有效载荷容量校验：不允许靠截短数组凑齐时序
  const pointWordsPerFrame = pointUsed * 4;
  const frameBytes = (pointWordsPerFrame + expectedAnalogPerFrame) * header.sampleWidth;
  const dataOffset = (header.dataStart - 1) * HEADER_SIZE;
  const requiredBytes = header.frameCount * frameBytes;
  if (dataOffset < 0 || dataOffset + requiredBytes > bytes.length) {
    fail('c3d_data_short', '有效载荷容量与参数声明不相容，无法联合接收完整点帧与模拟子帧',
      { dataOffset, frameBytes, frameCount: header.frameCount,
        requiredBytes, availableBytes: Math.max(0, bytes.length - dataOffset),
        pointFrames: header.frameCount, analogSamplesExpected: header.frameCount * samplesPerFrame });
  }

  const readWord = header.storage === 'float32'
    ? position => bytes.readFloatLE(position)
    : position => bytes.readInt16LE(position);

  const frames = [];
  const points = []; // 兼容既有概览契约
  for (let frameIndex = 0; frameIndex < header.frameCount; frameIndex++) {
    const frameNumber = header.firstFrame + frameIndex;
    const frameStart = dataOffset + frameIndex * frameBytes;
    const positions = [];
    for (let pointIndex = 0; pointIndex < pointUsed; pointIndex++) {
      const wordAt = frameStart + pointIndex * 4 * header.sampleWidth;
      const words = Array.from({ length: 4 }, (_, axis) =>
        readWord(wordAt + axis * header.sampleWidth));
      const coordinate = header.storage === 'float32'
        ? words.slice(0, 3)
        : words.slice(0, 3).map(word => word * pointScale);
      // 浮点：残差为负即无效但保留原值；整数：保留打包残差/相机字，不强行解码相机编号。
      const invalid = header.storage === 'float32' ? words[3] < 0 : false;
      positions.push({
        index: pointIndex,
        label: pointLabels[pointIndex]?.label ?? `POINT${pointIndex + 1}`,
        raw: words,
        residualWord: words[3],
        invalid,
        coordinate,
        location: { frame: frameNumber, byteOffset: wordAt },
      });
    }

    const analogArea = frameStart + pointWordsPerFrame * header.sampleWidth;
    const analog = [];
    for (let subframe = 0; subframe < samplesPerFrame; subframe++) {
      const channels = [];
      for (let channel = 0; channel < analogUsed; channel++) {
        const ordinal = subframe * analogUsed + channel;
        const wordAt = analogArea + ordinal * header.sampleWidth;
        const raw = readWord(wordAt);
        channels.push({
          channel,
          label: analogChannels[channel].label,
          subframe,
          raw,
          physical: (raw - analogOffsets[channel]) * analogScales[channel] * genScale,
          location: { frame: frameNumber, subframe, sampleIndex: frameIndex * samplesPerFrame + subframe,
            byteOffset: wordAt },
        });
      }
      analog.push({ subframe, channels });
    }

    frames.push({ frame: frameNumber, frameIndex, positions, analog });
    points.push({ frame: frameNumber, positions });
  }

  return {
    kind: 'c3d-recording',
    storage: header.storage,
    processor: section.processor,
    parameterBlock: header.parameterBlock,
    dataBlock: header.dataStart,
    scale: header.scale,
    rate: pointRate,
    pointRate,
    analogRate,
    samplesPerFrame,
    pointCount: pointUsed,
    analogChannelCount: analogUsed,
    analogValuesPerFrame: header.analogValuesPerFrame,
    frameRange: { first: header.firstFrame, last: header.lastFrame },
    frameCount: header.frameCount,
    pointLabels: pointLabels.map(({ label, raw }) => ({ label, rawLabel: raw })),
    analogChannels,
    calibration: {
      point: { scale: pointScale, coordinate: header.storage === 'float32' ? 'raw float32' : 'int16 * SCALE' },
      analog: {
        genScale,
        scales: analogScales,
        offsets: analogOffsets,
        scaleBroadcast: scaleSource?.broadcast ?? false,
        offsetBroadcast: offsetSource?.broadcast ?? false,
        formula: '(raw - OFFSET) * SCALE * GEN_SCALE',
        sources: [genScaleSource, scaleSource?.source, offsetSource?.source].filter(Boolean),
      },
    },
    parameterSources: parameters.map(param => ({
      group: param.group, name: param.name, type: param.typeName,
      dims: param.dims, byteOffset: param.dataPos,
    })),
    frames,
    points,
  };
}
