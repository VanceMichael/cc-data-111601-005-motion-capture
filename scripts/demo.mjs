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
  const post = path => fetch(`${service.url}/recordings`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
  const joint = await post('/recordings/with-analog');
  if (joint.status !== 201) throw new Error(await joint.text());
  const record = await joint.json();
  console.log('联合接收结果', JSON.stringify(record.parsed.analog.channels));
  console.log('首帧模拟读数', JSON.stringify(record.parsed.analog.frames[0].samples));
  console.log('无效点标志', JSON.stringify(record.parsed.points.frames[1].positions[0]));
  const refused = await post('/recordings/incompatible');
  console.log('不相容拒收', refused.status, await refused.json());
  console.log('已保存资料', await (await fetch(`${service.url}/records`)).json());
} finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
