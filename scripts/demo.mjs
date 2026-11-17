import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';
const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const provider = await startProvider();
const service = await startService({ source: provider.url, directory });
try {
  console.log(JSON.stringify({ source: provider.url, product: service.url }));
  console.log('来源目录', await (await fetch(`${provider.url}/catalog`)).json());

  // 一次采集联合领取点帧与模拟子帧
  const joint = await fetch(`${service.url}/recordings`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: '/recordings/with-analog' }) });
  if (joint.status !== 201) throw new Error(await joint.text());
  const recording = await joint.json();
  const firstSample = recording.parsed.frames[0].analog[0].channels[0];
  console.log('联合接收', JSON.stringify({
    id: recording.id,
    storage: recording.parsed.storage,
    pointCount: recording.parsed.pointCount,
    analogChannels: recording.parsed.analogChannels.map(c => c.label),
    samplesPerFrame: recording.parsed.samplesPerFrame,
    frameCount: recording.parsed.frameCount,
    firstSample,
  }));

  // 声明与有效载荷不相容时整体拒收，并给出无法联合接收的明细
  for (const path of ['/recordings/incompatible', '/recordings/truncated']) {
    const rejected = await fetch(`${service.url}/recordings`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
    console.log('拒收示例', path, rejected.status, await rejected.json());
  }

  const recordingIndex = await (await fetch(`${service.url}/recordings`)).json();
  console.log('联合接收目录', recordingIndex
    .map(record => ({ id: record.id, source: record.source, digest: record.digest })));
  console.log('单件通用目录保持独立', await (await fetch(`${service.url}/records`)).json());
} finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
