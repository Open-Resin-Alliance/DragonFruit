const SPILL_DIRECTORY = 'dragonfruit-prepared-geometry';
const IO_CHUNK_BYTES = 4 * 1024 * 1024;

export type PreparedGeometryCacheTicket = { modelId: string; valid: boolean };

type Spill = { name: string; handle: FileSystemFileHandle; hashes: string[] };
type Entry = {
  modelId: string;
  byteLength: number;
  positions: Float32Array | null;
  spill: Spill | null;
};

type CacheOptions = {
  ramBytes?: number;
  spillBytes?: number;
  maxEntries?: number;
  getDirectory?: () => Promise<FileSystemDirectoryHandle | null>;
};

async function openDirectory(): Promise<FileSystemDirectoryHandle | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(SPILL_DIRECTORY, { create: true });
  } catch {
    return null;
  }
}

/** SHA-256 also keeps exact modifier inputs out of the bounded metadata keys. */
export async function preparedGeometryDigest(bytes: Uint8Array): Promise<string | null> {
  try {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/** Owns copies only: neither returned geometry nor source attributes share cache storage. */
export class PreparedGeometryCache {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Set<PreparedGeometryCacheTicket>();
  private readonly ramLimit: number;
  private readonly spillLimit: number;
  private readonly entryLimit: number;
  private readonly openDirectory: () => Promise<FileSystemDirectoryHandle | null>;
  private directory: Promise<FileSystemDirectoryHandle | null> | null = null;
  private ramBytes = 0;
  private spillBytes = 0;
  private sequence = 0;
  private deletions: Promise<void> = Promise.resolve();
  private storageHealthy = true;
  private readonly session = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: CacheOptions = {}) {
    this.ramLimit = options.ramBytes ?? 64 * 1024 * 1024;
    this.spillLimit = options.spillBytes ?? 1024 * 1024 * 1024;
    this.entryLimit = options.maxEntries ?? 4096;
    this.openDirectory = options.getDirectory ?? openDirectory;
  }

  begin(modelId: string): PreparedGeometryCacheTicket {
    const ticket = { modelId, valid: true };
    this.pending.add(ticket);
    return ticket;
  }

  end(ticket: PreparedGeometryCacheTicket): void {
    this.pending.delete(ticket);
  }

  clearModel(modelId: string): void {
    for (const ticket of this.pending) {
      if (ticket.modelId === modelId) ticket.valid = false;
    }
    for (const [key, entry] of this.entries) {
      if (entry.modelId === modelId) this.remove(key, entry);
    }
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private getDirectory(): Promise<FileSystemDirectoryHandle | null> {
    if (!this.directory) {
      this.directory = this.openDirectory().then(async (directory) => {
        if (!directory) return null;
        // This directory belongs only to this disposable cache, never to undo.
        try {
          // TypeScript's DOM library omits the standard async directory iterator.
          const iterableDirectory = directory as FileSystemDirectoryHandle & {
            entries(): AsyncIterable<[string, FileSystemHandle]>;
          };
          const entries = iterableDirectory.entries();
          for await (const [name, handle] of entries) {
            if (handle.kind === 'file' && name.startsWith('prepared-') && name.endsWith('.bin')) {
              await directory.removeEntry(name);
            }
          }
        } catch {
          // Failure to prune must not permit unbounded orphaned scratch files.
          return null;
        }
        return directory;
      }).catch(() => null);
    }
    return this.directory;
  }

  private remove(key: string, entry: Entry): void {
    if (this.entries.get(key) !== entry) return;
    this.entries.delete(key);
    if (entry.positions) this.ramBytes -= entry.byteLength;
    if (entry.spill) {
      this.spillBytes -= entry.byteLength;
      const name = entry.spill.name;
      this.deletions = this.deletions.then(async () => {
        const directory = await this.getDirectory();
        if (directory) await directory.removeEntry(name);
      }).catch(() => { this.storageHealthy = false; });
    }
  }

  private touch(key: string, entry: Entry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  get(key: string, ticket: PreparedGeometryCacheTicket): Promise<Float32Array | null> {
    return this.serialize(async () => {
      if (!ticket.valid) return null;
      const entry = this.entries.get(key);
      if (!entry || entry.modelId !== ticket.modelId) return null;
      if (entry.positions) {
        this.touch(key, entry);
        return entry.positions.slice();
      }
      if (!entry.spill) return null;
      try {
        const file = await entry.spill.handle.getFile();
        if (file.size !== entry.byteLength) throw new Error('Incomplete prepared geometry');
        const positions = new Float32Array(entry.byteLength / Float32Array.BYTES_PER_ELEMENT);
        const bytes = new Uint8Array(positions.buffer);
        for (let offset = 0, chunk = 0; offset < bytes.length; offset += IO_CHUNK_BYTES, chunk += 1) {
          const end = Math.min(offset + IO_CHUNK_BYTES, bytes.length);
          const part = new Uint8Array(await file.slice(offset, end).arrayBuffer());
          if (part.length !== end - offset || await preparedGeometryDigest(part) !== entry.spill.hashes[chunk]) {
            throw new Error('Corrupt prepared geometry');
          }
          if (!ticket.valid || this.entries.get(key) !== entry) return null;
          bytes.set(part, offset);
        }
        if (!ticket.valid || this.entries.get(key) !== entry) return null;
        this.touch(key, entry);
        return positions;
      } catch {
        this.remove(key, entry);
        return null;
      }
    });
  }

  private async spill(key: string, entry: Entry, ticket: PreparedGeometryCacheTicket): Promise<boolean> {
    if (!this.storageHealthy || !entry.positions || entry.byteLength > this.spillLimit) return false;
    const directory = await this.getDirectory();
    if (!directory || !ticket.valid || this.entries.get(key) !== entry) return false;
    for (const [oldKey, old] of this.entries) {
      if (this.spillBytes + entry.byteLength <= this.spillLimit) break;
      if (old.spill) this.remove(oldKey, old);
    }
    // Free disk payload before allocating replacement files, not just metadata.
    await this.deletions;
    if (!this.storageHealthy || !ticket.valid || this.entries.get(key) !== entry) return false;
    const name = `prepared-${this.session}-${this.sequence++}.bin`;
    let writable: FileSystemWritableFileStream | null = null;
    try {
      const handle = await directory.getFileHandle(name, { create: true });
      writable = await handle.createWritable();
      const bytes = new Uint8Array(entry.positions.buffer, entry.positions.byteOffset, entry.byteLength);
      const hashes: string[] = [];
      for (let offset = 0; offset < bytes.length; offset += IO_CHUNK_BYTES) {
        const part = bytes.subarray(offset, Math.min(offset + IO_CHUNK_BYTES, bytes.length));
        const hash = await preparedGeometryDigest(part);
        if (!hash || !ticket.valid || this.entries.get(key) !== entry) throw new Error('Cancelled prepared spill');
        hashes.push(hash);
        await writable.write(part as Uint8Array<ArrayBuffer>);
      }
      await writable.close();
      writable = null;
      if (!ticket.valid || this.entries.get(key) !== entry) throw new Error('Cancelled prepared spill');
      entry.spill = { name, handle, hashes };
      entry.positions = null;
      this.ramBytes -= entry.byteLength;
      this.spillBytes += entry.byteLength;
      return true;
    } catch {
      await writable?.abort().catch(() => undefined);
      await directory.removeEntry(name).catch(() => { this.storageHealthy = false; });
      return false;
    }
  }

  put(key: string, positions: Float32Array, ticket: PreparedGeometryCacheTicket): Promise<void> {
    return this.serialize(async () => {
      if (!ticket.valid || this.entryLimit <= 0 || positions.byteLength > Math.max(this.ramLimit, this.spillLimit)) return;
      const previous = this.entries.get(key);
      if (previous) this.remove(key, previous);
      while (this.entries.size >= this.entryLimit) {
        const oldest = this.entries.entries().next().value as [string, Entry] | undefined;
        if (!oldest) break;
        this.remove(...oldest);
      }
      for (const [oldKey, old] of this.entries) {
        if (this.ramBytes + positions.byteLength <= this.ramLimit) break;
        if (old.positions) {
          const spilled = await this.spill(oldKey, old, ticket);
          if (!ticket.valid) return;
          if (!spilled) this.remove(oldKey, old);
        }
      }
      if (!ticket.valid) return;
      // Large outputs are borrowed only until the awaited write completes; the
      // caller cannot see/mutate them yet. RAM retention always takes a copy.
      const inRam = positions.byteLength <= this.ramLimit;
      const entry: Entry = {
        modelId: ticket.modelId,
        byteLength: positions.byteLength,
        positions: inRam ? positions.slice() : positions,
        spill: null,
      };
      this.entries.set(key, entry);
      this.ramBytes += entry.byteLength;
      if (!inRam && !await this.spill(key, entry, ticket)) this.remove(key, entry);
    });
  }
}
