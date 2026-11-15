export function inspect(bytes) {
  if (bytes.length < 512 || bytes[1] !== 0x50) throw new Error('c3d_header');
  const parameterBlock = bytes[0];
  if (parameterBlock < 2 || parameterBlock * 512 > bytes.length + 512) throw new Error('c3d_parameter_block');
  const pointCount = bytes.readUInt16LE(2);
  const analogValuesPerFrame = bytes.readUInt16LE(4);
  const first = bytes.readUInt16LE(6); const last = bytes.readUInt16LE(8);
  const scale = bytes.readFloatLE(12); const dataBlock = bytes.readUInt16LE(16);
  const samplesPerFrame = bytes.readUInt16LE(18); const rate = bytes.readFloatLE(20);
  if (last < first || !Number.isFinite(rate) || rate <= 0 || dataBlock <= parameterBlock) throw new Error('c3d_layout');
  const frameCount = last - first + 1;
  const sampleWidth = scale < 0 ? 4 : 2;
  const frameBytes = pointCount * 4 * sampleWidth + analogValuesPerFrame * sampleWidth;
  const offset = (dataBlock - 1) * 512;
  if (offset + frameCount * frameBytes > bytes.length) throw new Error('c3d_data_short');
  const points = [];
  for (let frame = 0; frame < frameCount; frame++) {
    const positions = [];
    for (let point = 0; point < pointCount; point++) {
      const at = offset + frame * frameBytes + point * 4 * sampleWidth;
      const values = Array.from({ length: 4 }, (_, axis) => scale < 0
        ? bytes.readFloatLE(at + axis * 4) : bytes.readInt16LE(at + axis * 2));
      positions.push({ index: point, raw: values, coordinate: values.slice(0, 3).map(value => scale < 0 ? value : value * scale) });
    }
    points.push({ frame: first + frame, positions });
  }
  return { kind: 'c3d-points', pointCount, analogValuesPerFrame, samplesPerFrame, rate, scale, parameterBlock, dataBlock, points };
}
