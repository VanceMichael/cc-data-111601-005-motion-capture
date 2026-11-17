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

test('联合领取：点与模拟一次接收、持久化并可重复领取', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'recording-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    const post = path => fetch(`${service.url}/recordings`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
    const response = await post('/recordings/with-analog');
    assert.equal(response.status, 201);
    const record = await response.json();
    assert.equal(record.kind, 'c3d-recording');
    assert.equal(record.parsed.analogChannelCount, 2);
    assert.equal(record.parsed.samplesPerFrame, 2);
    // 原件可经摘要取回，字节与来源一致
    const stored = Buffer.from(await (await fetch(`${service.url}/objects/${record.digest}`)).arrayBuffer());
    assert.deepEqual(stored, await readFile(new URL('../fixtures/resource-01.bin', import.meta.url)));
    // 联合记录进入独立目录，不混入单件 raw 索引
    assert.deepEqual(await new Store(directory).list(), []);
    const recordings = await new Store(directory).listRecordings();
    assert.equal(recordings.length, 1);
    // 同来源同摘要重领返回原 id
    assert.equal((await (await post('/recordings/with-analog')).json()).id, record.id);
    assert.equal((await new Store(directory).listRecordings()).length, 1);
  } finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

test('联合领取遇到不相容声明时整体拒收且无副作用', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reject-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    const post = path => fetch(`${service.url}/recordings`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
    for (const path of ['/recordings/incompatible', '/recordings/truncated']) {
      const response = await post(path);
      assert.equal(response.status, 422, path);
      const body = await response.json();
      assert.equal(body.rejected, 'joint_recording');
      assert.ok(['c3d_header_mismatch', 'c3d_data_short'].includes(body.error));
      assert.ok(body.details && typeof body.details === 'object');
    }
    assert.deepEqual(await new Store(directory).listRecordings(), []);
    assert.deepEqual(await new Store(directory).list(), []);
    // 越界来源仍被传输层拒绝
    const foreign = await post('https://example.invalid/foreign');
    assert.equal(foreign.status, 422);
  } finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

test('GET 接口不被改造为写操作：GET /recordings 仅列目录', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'readonly-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    const response = await fetch(`${service.url}/recordings`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
  } finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});
