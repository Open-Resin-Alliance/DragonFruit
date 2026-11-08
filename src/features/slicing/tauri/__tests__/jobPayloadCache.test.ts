import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { prepareJobPayload, type JobPayloadInvoke } from '../jobPayloadCache';

function nativePayloadFixture(options: { rejectAdmission?: boolean; failAppend?: boolean; onBegin?: () => void } = {}) {
  const entries = new Map<string, Uint8Array>();
  const leases = new Map<string, { field: string; hash: string; byteLen: number }[]>();
  const pending = new Map<string, { chunks: Uint8Array[]; byteLen: number }>();
  const chunks: number[] = [];
  const commands: string[] = [];
  let nextId = 0;
  const invoke: JobPayloadInvoke = async <T>(command: string, args?: Record<string, unknown> | ArrayBuffer | Uint8Array, optionsArg?: { headers: HeadersInit }): Promise<T> => {
    commands.push(command);
    const values = args as Record<string, unknown>;
    if (command === 'job_payload_begin') {
      const fields = values.fields as { field: string; hash: string; byteLen: number }[];
      const accepted = options.rejectAdmission ? [] : fields;
      const leaseId = String(++nextId);
      leases.set(leaseId, accepted);
      options.onBegin?.();
      return { leaseId, acceptedFields: accepted.map((s) => s.field), missingFields: accepted.filter((s) => !entries.has(`${s.field}:${s.hash}`)).map((s) => s.field) } as T;
    }
    if (command === 'job_payload_append') {
      if (options.failAppend) throw new Error('injected append failure');
      const headers = new Headers(optionsArg?.headers);
      const field = headers.get('x-job-payload-field')!;
      const hash = headers.get('x-job-payload-hash')!;
      const lease = headers.get('x-job-payload-lease')!;
      assert.ok(leases.get(lease)?.some((s) => s.field === field && s.hash === hash));
      const key = `${field}:${hash}`;
      const bytes = args as Uint8Array;
      chunks.push(bytes.byteLength);
      const received = pending.get(key) ?? { chunks: [], byteLen: 0 };
      assert.equal(Number(headers.get('x-job-payload-offset')), received.byteLen);
      received.chunks.push(bytes);
      received.byteLen += bytes.byteLength;
      pending.set(key, received);
      return undefined as T;
    }
    if (command === 'job_payload_finish') {
      for (const field of leases.get(String(values.leaseId))!) {
        const key = `${field.field}:${field.hash}`;
        if (entries.has(key)) continue;
        const received = pending.get(key)!;
        const bytes = new Uint8Array(received.byteLen);
        let offset = 0;
        for (const chunk of received.chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        assert.equal(bytes.byteLength, field.byteLen);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), field.hash);
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        entries.set(key, bytes);
        pending.delete(key);
      }
      return undefined as T;
    }
    if (command === 'job_payload_release') {
      leases.delete(String(values.leaseId));
      return undefined as T;
    }
    throw new Error(`Unexpected command ${command}`);
  };
  const restore = (json: string) => {
    const envelope = JSON.parse(json);
    for (const [field, hash] of Object.entries(envelope._payload_refs ?? {})) {
      const bytes = entries.get(`${field}:${hash}`);
      assert.ok(bytes, `missing ${field}`);
      envelope[field] = JSON.parse(new TextDecoder().decode(bytes));
    }
    delete envelope._payload_refs;
    return envelope;
  };
  return { invoke, restore, leases, chunks, commands };
}

// Also usable as the raw-counters UI smoke input: all three real contributors,
// an embedded-scene setting/payload, format settings, and logical streamed mesh.
export function payloadMetricsSmokeFixture() {
  return {
    output_format: 'lumen',
    format_version: '1',
    metadata_json: JSON.stringify({ lumen: { embedVoxlScene: true, voxlSceneBase64: 's'.repeat(20_000), exposure: 2.4 }, models: [{ id: 'synthetic-model' }] }),
    export_thumbnail_png_base64: 't'.repeat(18_000),
    triangle_tank_index: Array.from({ length: 10_000 }, (_, i) => i % 2),
    tank_count: 2,
  };
}

test('cold fields round-trip every semantic value; warm envelope sends only references', async () => {
  const native = nativePayloadFixture();
  const payload = payloadMetricsSmokeFixture();
  const cold = await prepareJobPayload(native.invoke, payload);
  assert.deepEqual(native.restore(cold.jobJson), payload);
  assert.ok(cold.metrics.payloadUploadedBytes > 0);
  assert.equal(cold.metrics.payloadReusedBytes, 0);
  assert.equal(cold.metrics.payloadContributors.metadata_json.chars, JSON.stringify(payload.metadata_json).length);
  assert.deepEqual(Object.keys(cold.metrics.payloadContributors).sort(), Object.keys(payload).sort());
  assert.ok(cold.jobJson.length < 500);
  await cold.release();
  const beforeWarm = native.commands.length;
  const warm = await prepareJobPayload(native.invoke, payload);
  assert.deepEqual(native.commands.slice(beforeWarm), ['job_payload_begin']);
  assert.deepEqual(native.restore(warm.jobJson), payload);
  assert.equal(warm.metrics.payloadUploadedBytes, 0);
  assert.equal(warm.metrics.payloadReusedBytes, cold.metrics.payloadUploadedBytes);
  assert.ok(warm.metrics.payloadCacheMs >= 0);
  await warm.release();
  assert.equal(native.leases.size, 0);
});

test('mutating a tank array changes its exact field reference, not metadata/thumbnail', async () => {
  const native = nativePayloadFixture();
  const payload = payloadMetricsSmokeFixture();
  const first = await prepareJobPayload(native.invoke, payload);
  const refs = JSON.parse(first.jobJson)._payload_refs;
  await first.release();
  payload.triangle_tank_index[0] = 1;
  const second = await prepareJobPayload(native.invoke, payload);
  const updatedRefs = JSON.parse(second.jobJson)._payload_refs;
  assert.notEqual(updatedRefs.triangle_tank_index, refs.triangle_tank_index);
  assert.equal(updatedRefs.metadata_json, refs.metadata_json);
  assert.equal(updatedRefs.export_thumbnail_png_base64, refs.export_thumbnail_png_base64);
  assert.deepEqual(native.restore(second.jobJson), payload);
  await second.release();
});

test('large binary fields are chunked at 4 MiB; over-budget fields remain inline', async () => {
  const native = nativePayloadFixture();
  const payload = { metadata_json: 'm'.repeat(4 * 1024 * 1024 + 19), export_thumbnail_png_base64: 't'.repeat(9 * 1024 * 1024), output_format: 'ctb' };
  const prepared = await prepareJobPayload(native.invoke, payload);
  assert.equal(native.chunks.length, 2);
  assert.equal(native.chunks[0], 4 * 1024 * 1024);
  assert.ok(native.chunks.every((n) => n <= 4 * 1024 * 1024));
  assert.equal(JSON.parse(prepared.jobJson).export_thumbnail_png_base64, payload.export_thumbnail_png_base64);
  assert.deepEqual(native.restore(prepared.jobJson), payload);
  await prepared.release();
});

test('native admission failure preserves exact inline values without retries', async () => {
  const native = nativePayloadFixture({ rejectAdmission: true });
  const payload = payloadMetricsSmokeFixture();
  const prepared = await prepareJobPayload(native.invoke, payload);
  assert.deepEqual(native.restore(prepared.jobJson), payload);
  assert.equal(prepared.metrics.payloadUploadedBytes, 0);
  assert.equal(prepared.metrics.payloadReusedBytes, 0);
  await prepared.release();
  assert.equal(native.leases.size, 0);
});

test('late begin cancellation and append errors release the exact job lease', async () => {
  const controller = new AbortController();
  const canceled = nativePayloadFixture({ onBegin: () => controller.abort() });
  await assert.rejects(prepareJobPayload(canceled.invoke, payloadMetricsSmokeFixture(), controller.signal), { name: 'AbortError' });
  assert.equal(canceled.leases.size, 0);
  const failed = nativePayloadFixture({ failAppend: true });
  await assert.rejects(prepareJobPayload(failed.invoke, payloadMetricsSmokeFixture()), /injected append failure/);
  assert.equal(failed.leases.size, 0);
});

test('consumer failure cleanup is idempotent and does not release another lease', async () => {
  const native = nativePayloadFixture();
  const first = await prepareJobPayload(native.invoke, payloadMetricsSmokeFixture());
  const second = await prepareJobPayload(native.invoke, payloadMetricsSmokeFixture());
  try { throw new Error('consumer invocation rejected'); } catch { await first.release(); }
  await first.release();
  assert.equal(native.leases.size, 1);
  await second.release();
  assert.equal(native.leases.size, 0);
});
