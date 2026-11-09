export type JobPayloadInvoke = <T>(command: string, args?: Record<string, unknown> | ArrayBuffer | Uint8Array, options?: { headers: HeadersInit }) => Promise<T>;

export type PayloadContributor = { chars: number; bytes: number };
export type JobPayloadMetrics = {
  payloadContributors: Record<string, PayloadContributor>;
  payloadUploadedBytes: number;
  payloadReusedBytes: number;
  payloadCacheMs: number;
};

type LeaseAck = { leaseId: string; acceptedFields: string[]; missingFields: string[] };
type EncodedField = { field: string; hash: string; bytes: Uint8Array; chars: number };
const BUDGET = 8 * 1024 * 1024;
const CHUNK_BYTES = 4 * 1024 * 1024;
const MIN_FIELD_BYTES = 16 * 1024;
const FIELDS = ['metadata_json', 'export_thumbnail_png_base64', 'triangle_tank_index'] as const;
// At most three latest values, payload + retained UTF-16 source charged together.
const hot = new Map<string, { source: string; encoded: EncodedField; charge: number }>();
let hotBytes = 0;

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Slicing canceled by user.', 'AbortError');
}

type EncodedFieldResult = { encoded: EncodedField; reused: boolean };

async function encodeField(field: string, value: unknown, json: string, bytes: Uint8Array): Promise<EncodedFieldResult> {
  const previous = hot.get(field);
  const source = typeof value === 'string' ? value : json;
  if (previous?.source === source) return { encoded: previous.encoded, reused: true };
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  const encoded = { field, hash: Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(''), bytes, chars: json.length };
  // Another preparation may have populated/replaced this field while hashing.
  const current = hot.get(field);
  if (current?.source === source) return { encoded: current.encoded, reused: true };
  if (current) { hotBytes -= current.charge; hot.delete(field); }
  const charge = bytes.byteLength + source.length * 2;
  if (charge <= BUDGET) {
    while (hotBytes + charge > BUDGET && hot.size) {
      const first = hot.keys().next().value!;
      hotBytes -= hot.get(first)!.charge;
      hot.delete(first);
    }
    hot.set(field, { source, encoded, charge });
    hotBytes += charge;
  }
  return { encoded, reused: false };
}

/** A field manifest the consumer may pin itself instead of calling `job_payload_begin`. */
export type JobPayloadFieldSpec = { field: string; hash: string; byteLen: number };

export type PreparedJobPayload = {
  jobJson: string;
  leaseId?: string;
  /** Present only when `deferPin` skipped `job_payload_begin`. */
  fieldSpecs?: JobPayloadFieldSpec[];
  metrics: JobPayloadMetrics;
  release: (consumed?: boolean) => Promise<void>;
};

export type PrepareJobPayloadOptions = {
  /**
   * Skip `job_payload_begin` when every field is already in the JS hot cache, and
   * return `fieldSpecs` for the consumer to pin inside its own command. A native
   * miss is reported back, so the caller can retry through the normal path.
   */
  deferPin?: boolean;
};

/** Each eligible top-level semantic JSON value has its own immutable hash.
 * Scene attachments remain inside metadata_json, unchanged, including strings
 * containing JSON; native expansion restores the value, not its encoded text.
 */
export async function prepareJobPayload(
  invoke: JobPayloadInvoke,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
  options: PrepareJobPayloadOptions = {},
): Promise<PreparedJobPayload> {
  const start = performance.now();
  checkAbort(signal);
  const encoder = new TextEncoder();
  const payloadContributors: Record<string, PayloadContributor> = {};
  const candidates = new Map<string, { value: unknown; json: string; bytes: Uint8Array }>();
  for (const [field, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    const previous = hot.get(field);
    // Primitive strings are immutable, so the common metadata/thumbnail hit
    // avoids both JSON escaping and UTF-8 encoding. Mutable arrays are encoded.
    if (typeof value === 'string' && previous?.source === value) {
      payloadContributors[field] = { chars: previous.encoded.chars, bytes: previous.encoded.bytes.byteLength };
      candidates.set(field, { value, json: '', bytes: previous.encoded.bytes });
      continue;
    }
    const json = JSON.stringify(value);
    const bytes = encoder.encode(json);
    payloadContributors[field] = { chars: json.length, bytes: bytes.byteLength };
    if ((FIELDS as readonly string[]).includes(field) && bytes.byteLength >= MIN_FIELD_BYTES && bytes.byteLength <= BUDGET) {
      candidates.set(field, { value, json, bytes });
    }
  }
  const fields: EncodedField[] = [];
  const reusedFields = new Set<string>();
  let admittedBytes = 0;
  // Fixed priority and total budget: oversize values retain the original inline path.
  for (const field of FIELDS) {
    const candidate = candidates.get(field);
    if (!candidate || admittedBytes + candidate.bytes.byteLength > BUDGET) continue;
    const encoded = await encodeField(field, candidate.value, candidate.json, candidate.bytes);
    fields.push(encoded.encoded);
    if (encoded.reused) reusedFields.add(field);
    admittedBytes += candidate.bytes.byteLength;
    checkAbort(signal);
  }
  let leaseId: string | undefined;
  const release = async (consumed = false) => {
    if (!leaseId) return;
    const id = leaseId;
    leaseId = undefined;
    if (!consumed) await invoke('job_payload_release', { leaseId: id });
  };
  try {
    let payloadUploadedBytes = 0;
    let payloadReusedBytes = 0;
    const envelope = { ...payload };
    // Every field is already encoded and was accepted before: let the consumer
    // pin it inside its own command instead of paying a begin round trip here.
    if (options.deferPin && fields.length > 0 && fields.every((field) => reusedFields.has(field.field))) {
      const refs: Record<string, string> = {};
      for (const field of fields) {
        refs[field.field] = field.hash;
        delete envelope[field.field];
        payloadReusedBytes += field.bytes.byteLength;
      }
      envelope._payload_refs = refs;
      checkAbort(signal);
      const jobJson = JSON.stringify(envelope);
      return {
        jobJson,
        fieldSpecs: fields.map(({ field, hash, bytes }) => ({ field, hash, byteLen: bytes.byteLength })),
        release: async () => {},
        metrics: { payloadContributors, payloadUploadedBytes, payloadReusedBytes,
          payloadCacheMs: performance.now() - start },
      };
    }
    if (fields.length) {
      const ack = await invoke<LeaseAck>('job_payload_begin', {
        fields: fields.map(({ field, hash, bytes }) => ({ field, hash, byteLen: bytes.byteLength })),
      });
      leaseId = ack.leaseId;
      checkAbort(signal);
      const refs: Record<string, string> = {};
      for (const field of fields) {
        if (!ack.acceptedFields.includes(field.field)) continue;
        if (ack.missingFields.includes(field.field)) {
          for (let offset = 0; offset < field.bytes.byteLength; offset += CHUNK_BYTES) {
            checkAbort(signal);
            const bytes = field.bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, field.bytes.byteLength));
            await invoke('job_payload_append', bytes, { headers: {
              'x-job-payload-lease': leaseId,
              'x-job-payload-field': field.field,
              'x-job-payload-hash': field.hash,
              'x-job-payload-offset': String(offset),
            } });
            payloadUploadedBytes += bytes.byteLength;
          }
        } else {
          payloadReusedBytes += field.bytes.byteLength;
        }
        refs[field.field] = field.hash;
        delete envelope[field.field];
      }
      checkAbort(signal);
      if (ack.missingFields.length) await invoke('job_payload_finish', { leaseId });
      envelope._payload_refs = refs;
    }
    checkAbort(signal);
    const jobJson = JSON.stringify(envelope);
    return { jobJson, leaseId, release, metrics: { payloadContributors, payloadUploadedBytes,
      payloadReusedBytes, payloadCacheMs: performance.now() - start } };
  } catch (error) {
    // Await a late begin before releasing its exact ID. Never leave a lease behind
    // when cancellation wins, a chunk fails, or the consumer cannot be invoked.
    try { await release(); } catch { /* preserve the original failure */ }
    throw error;
  }
}
