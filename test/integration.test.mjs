import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';
import { Store } from '../src/store.mjs';
import { inspect } from '../src/reader.mjs';

test('单件资料可解释，畸形输入被拒绝', async () => {
  const fixture = await readFile(new URL('../fixtures/primary.bin', import.meta.url));
  assert.ok(inspect(fixture));
  assert.throws(() => inspect(Buffer.alloc(0)));
});
test('来源领取、原件持久化、重启查询及无副作用拒收', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'intake-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    const body = JSON.stringify({ path: '/primary' });
    const send = path => fetch(`${service.url}/intakes`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
    const first = await send('/primary');
    assert.equal(first.status, 201);
    const record = await first.json();
    assert.deepEqual(await new Store(directory).list(), [record]);
    assert.deepEqual(Buffer.from(await (await fetch(`${service.url}/objects/${record.digest}`)).arrayBuffer()),
      await readFile(new URL('../fixtures/primary.bin', import.meta.url)));
    const repeated = await send('/primary');
    assert.equal((await repeated.json()).id, record.id);
    assert.equal((await send('/missing')).status, 422);
    assert.equal((await send('https://example.invalid/foreign')).status, 422);
    assert.equal((await new Store(directory).list()).length, 1);
    const range = await fetch(`${provider.url}/primary`, { headers: { range: 'bytes=0-0' } });
    assert.equal(range.status, 206);
    assert.equal((await range.arrayBuffer()).byteLength, 1);
    const reject = await fetch(`${provider.url}/primary`, { headers: { 'if-match': '"old"' } });
    assert.equal(reject.status, 412);
    assert.ok(body.includes('primary'));
  } finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

test('一次采集联合领取点帧与模拟子帧，不相容声明说明拒收部分', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'recording-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    const send = path => fetch(`${service.url}/recordings`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
    const joint = await send('/recordings/with-analog');
    assert.equal(joint.status, 201);
    const record = await joint.json();
    assert.equal(record.parsed.kind, 'c3d-recording');
    assert.deepEqual(record.parsed.analog.channels.map(channel => channel.label), ['FZ', 'EMG']);
    assert.equal(record.parsed.analog.frames[0].samples[0].value, 1);
    assert.equal(record.parsed.points.frames[1].positions[0].valid, false);
    assert.equal(record.parsed.points.frames[1].positions[0].raw[3], -1);
    assert.deepEqual(Buffer.from(await (await fetch(`${service.url}/objects/${record.digest}`)).arrayBuffer()),
      await readFile(new URL('../fixtures/resource-01.bin', import.meta.url)));
    const repeated = await send('/recordings/with-analog');
    assert.equal((await repeated.json()).id, record.id);
    const incompatible = await send('/recordings/incompatible');
    assert.equal(incompatible.status, 422);
    const refused = await incompatible.json();
    assert.equal(refused.error, 'c3d_analog_mismatch');
    assert.match(refused.detail, /模拟/);
    const truncated = await send('/recordings/truncated');
    assert.equal(truncated.status, 422);
    assert.equal((await truncated.json()).error, 'c3d_data_short');
    assert.deepEqual((await (await fetch(`${service.url}/records`)).json()).map(item => item.id), [record.id]);
    const reopened = await new Store(directory).list();
    assert.equal(reopened[0].parsed.analog.channels[1].label, 'EMG');
  } finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

test('同一原件按不同解释方式领取形成各自记录', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'recording-kind-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    const post = (pathname, path) => fetch(`${service.url}${pathname}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
    const overview = await (await post('/intakes', '/primary')).json();
    const joint = await (await post('/recordings', '/primary')).json();
    assert.notEqual(joint.id, overview.id);
    assert.equal(joint.digest, overview.digest);
    assert.equal(joint.parsed.kind, 'c3d-recording');
    assert.equal(joint.parsed.analog.channels.length, 0);
    const again = await (await post('/recordings', '/primary')).json();
    assert.equal(again.id, joint.id);
    assert.equal((await (await fetch(`${service.url}/records`)).json()).length, 2);
  } finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});
