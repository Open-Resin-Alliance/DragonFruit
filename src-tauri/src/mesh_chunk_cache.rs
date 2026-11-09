//! Bounded content-addressed mesh chunks and single-flight upload ownership.
//!
//! This module deliberately uses only std so its tests can run with rustc alone.
//! The IPC adapter verifies incoming SHA-256 and supplies the same verifier for
//! disk reads. Only committed slice uploads replace the one retained snapshot.

use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::time::Instant;

pub const CHUNK_BYTES: usize = 4 * 1024 * 1024;
pub const CACHE_BYTES: usize = 64 * 1024 * 1024;
pub const CACHE_ENTRIES: usize = 4096;
pub const SLICE_BACKING_BYTES: usize = 2 * 1024 * 1024 * 1024;
pub const SLICE_MANIFEST_ENTRIES: usize = 65536;
pub const MAX_SAFE_BYTES: u64 = 9_007_199_254_740_991;
pub type ChunkHash = [u8; 32];
pub type ChunkVerifier = fn(&[u8]) -> ChunkHash;

#[derive(Clone, Debug)]
pub struct UploadStats {
    pub chunk_bytes: usize,
    pub total_bytes: usize,
    pub capacity_bytes: usize,
    pub reserve_grew: bool,
    pub chunks_received: u64,
    pub append_ns: u64,
    pub append_ns_total: u64,
    pub uploaded_bytes: usize,
    pub reused_bytes: usize,
}

pub struct FinishedUpload {
    pub stats: UploadStats,
    /// Present only for stage=true; stage=false retains a named ready snapshot.
    pub staged_bytes: Option<Vec<u8>>,
    pub slice_snapshot_id: Option<String>,
}

struct CachedChunk {
    bytes: Vec<u8>,
    touched: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SliceChunk {
    hash: ChunkHash,
    offset: usize,
    byte_length: usize,
}

struct RetainedSlice {
    id: String,
    chunks: Vec<SliceChunk>,
    by_hash: HashMap<ChunkHash, usize>,
    total_bytes: usize,
}

struct PendingUpload {
    id: String,
    bytes: Vec<u8>,
    stats: UploadStats,
    // None also represents an exceeded metadata/payload budget or failed backing.
    slice_chunks: Option<Vec<SliceChunk>>,
}

struct ReadyUpload {
    id: String,
    bytes: Vec<u8>,
}

/// One pending upload or ready snapshot, a bounded hot LRU, and one last slice.
/// Backing is anonymous/delete-on-close; the adapter owns its platform creation.
/// Pending uploads never write backing, so abort cannot damage the last slice.
pub struct MeshChunkCache {
    budget: usize,
    cached_bytes: usize,
    chunks: HashMap<ChunkHash, CachedChunk>,
    clock: u64,
    next_id: u64,
    pending: Option<PendingUpload>,
    ready: Option<ReadyUpload>,
    verifier: Option<ChunkVerifier>,
    backing: Option<File>,
    retained: Option<RetainedSlice>,
    #[cfg(test)]
    last_backing_write_bytes: usize,
}

impl MeshChunkCache {
    pub fn new(cache_budget: usize) -> Self {
        Self {
            budget: cache_budget,
            cached_bytes: 0,
            chunks: HashMap::new(),
            clock: 0,
            next_id: 0,
            pending: None,
            ready: None,
            verifier: None,
            backing: None,
            retained: None,
            #[cfg(test)]
            last_backing_write_bytes: 0,
        }
    }

    pub fn with_verifier(cache_budget: usize, verifier: ChunkVerifier) -> Self {
        let mut cache = Self::new(cache_budget);
        cache.verifier = Some(verifier);
        cache
    }

    pub fn begin(&mut self, reserve_bytes: usize) -> Result<String, String> {
        if self.pending.is_some() || self.ready.is_some() {
            return Err("A mesh upload is still pending or awaiting consumption".into());
        }
        validate_size(reserve_bytes)?;
        let next_id = self.next_id.checked_add(1).ok_or("Mesh upload IDs exhausted")?;
        let mut bytes = Vec::new();
        bytes.try_reserve_exact(reserve_bytes)
            .map_err(|e| format!("Cannot reserve mesh upload buffer: {e}"))?;
        let id = format!("mesh-upload-{next_id}");
        let capacity_bytes = bytes.capacity();
        self.next_id = next_id;
        self.pending = Some(PendingUpload {
            id: id.clone(),
            bytes,
            stats: UploadStats {
                chunk_bytes: 0,
                total_bytes: 0,
                capacity_bytes,
                reserve_grew: false,
                chunks_received: 0,
                append_ns: 0,
                append_ns_total: 0,
                uploaded_bytes: 0,
                reused_bytes: 0,
            },
            slice_chunks: None,
        });
        Ok(id)
    }

    /// A failed/unavailable disk cache is RAM-only fallback, not an upload error.
    /// The opener is lazy: modifier uploads and reuse of existing backing skip it.
    pub fn begin_for_slice(
        &mut self,
        reserve_bytes: usize,
        open_backing: impl FnOnce() -> io::Result<File>,
    ) -> Result<String, String> {
        let id = self.begin(reserve_bytes)?;
        if reserve_bytes <= SLICE_BACKING_BYTES && self.verifier.is_some() {
            if self.backing.is_none() {
                self.backing = open_backing().ok();
            }
            if self.backing.is_some() {
                self.pending.as_mut().expect("upload was created").slice_chunks = Some(Vec::new());
            }
        }
        Ok(id)
    }

    /// A miss does not alter upload bytes, counters, or hot-cache recency.
    /// Disk failures invalidate retention and are ordinary misses, never geometry.
    pub fn append_cached(
        &mut self,
        upload_id: &str,
        hash: &ChunkHash,
        byte_length: usize,
    ) -> Result<bool, String> {
        self.pending.as_ref()
            .filter(|upload| upload.id == upload_id)
            .ok_or("Unknown or stale mesh upload ID")?;
        validate_chunk_size(byte_length)?;
        if let Some(chunk) = self.chunks.get_mut(hash) {
            if chunk.bytes.len() != byte_length {
                return Err("Cached mesh chunk byteLength does not match its hash".into());
            }
            let pending = self.pending.as_mut().expect("pending upload was validated");
            pending.append(&chunk.bytes, true)?;
            pending.remember(*hash, byte_length);
            self.clock = self.clock.saturating_add(1);
            chunk.touched = self.clock;
            return Ok(true);
        }
        let location = self.retained.as_ref().and_then(|slice| {
            slice.by_hash.get(hash).map(|index| slice.chunks[*index].clone())
        });
        let Some(location) = location else { return Ok(false); };
        if location.byte_length != byte_length {
            return Err("Cached mesh chunk byteLength does not match its hash".into());
        }
        let mut bytes = Vec::new();
        if bytes.try_reserve_exact(byte_length).is_err() {
            return Ok(false);
        }
        let read = self.backing.as_mut().ok_or_else(|| io::Error::other("Missing slice backing"))
            .and_then(|file| {
                file.seek(SeekFrom::Start(location.offset as u64))?;
                let read = file.take(byte_length as u64).read_to_end(&mut bytes)?;
                if read != byte_length {
                    return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "Truncated slice backing"));
                }
                Ok(())
            });
        if read.is_err() || self.verifier.map(|verify| verify(&bytes)) != Some(*hash) {
            self.invalidate_retention();
            return Ok(false);
        }
        let pending = self.pending.as_mut().expect("pending upload was validated");
        pending.append(&bytes, true)?;
        pending.remember(*hash, byte_length);
        Ok(true)
    }

    /// Append the leading run of chunks that already exist, and stop at the
    /// first miss. Returns how many were appended. One call replaces one IPC
    /// round trip per chunk; the caller uploads the rest in order.
    pub fn append_cached_batch(
        &mut self,
        upload_id: &str,
        chunks: &[(ChunkHash, usize)],
    ) -> Result<usize, String> {
        self.pending.as_ref()
            .filter(|upload| upload.id == upload_id)
            .ok_or("Unknown or stale mesh upload ID")?;
        for (index, (hash, byte_length)) in chunks.iter().enumerate() {
            if !self.append_cached(upload_id, hash, *byte_length)? {
                return Ok(index);
            }
        }
        Ok(chunks.len())
    }

    /// The caller MUST have verified that hash is the SHA-256 of bytes.
    /// Upload output owns its bytes independently of cache residency.
    pub fn append_verified(
        &mut self,
        upload_id: &str,
        hash: ChunkHash,
        bytes: &[u8],
    ) -> Result<(), String> {
        let pending = self.pending.as_mut()
            .filter(|upload| upload.id == upload_id)
            .ok_or("Unknown or stale mesh upload ID")?;
        validate_chunk_size(bytes.len())?;
        let exists = match self.chunks.get(&hash) {
            Some(chunk) => {
                if chunk.bytes != bytes {
                    return Err("Mesh chunk hash already names different immutable bytes".into());
                }
                true
            }
            None => false,
        };
        // Allocate before changing the upload, so allocation failures leave it intact.
        let cached_copy = if !exists && bytes.len() <= self.budget {
            let mut copy = Vec::new();
            copy.try_reserve_exact(bytes.len())
                .map_err(|e| format!("Cannot reserve mesh chunk cache entry: {e}"))?;
            copy.extend_from_slice(bytes);
            Some(copy)
        } else {
            None
        };
        pending.append(bytes, false)?;
        pending.remember(hash, bytes.len());
        self.clock = self.clock.saturating_add(1);
        if let Some(chunk) = self.chunks.get_mut(&hash) {
            chunk.touched = self.clock;
        } else if let Some(copy) = cached_copy {
            while self.cached_bytes > self.budget - copy.len() || self.chunks.len() >= CACHE_ENTRIES {
                let oldest = self.chunks.iter()
                    .min_by_key(|(_, chunk)| chunk.touched)
                    .map(|(key, _)| *key)
                    .expect("nonzero cached byte count has an entry");
                let removed = self.chunks.remove(&oldest).expect("oldest entry exists");
                self.cached_bytes -= removed.bytes.len();
            }
            self.cached_bytes += copy.len();
            self.chunks.insert(hash, CachedChunk { bytes: copy, touched: self.clock });
        }
        Ok(())
    }

    /// Reserve the existing output buffer before streaming a retained source.
    /// No world-space copy is allocated. Stale IDs never reserve another upload.
    pub fn prepare_reused_append(&mut self, upload_id: &str, byte_length: usize) -> Result<(), String> {
        let pending = self.pending.as_mut().filter(|upload| upload.id == upload_id)
            .ok_or("Unknown or stale mesh upload ID")?;
        if byte_length == 0 || byte_length % 36 != 0 || pending.bytes.len() % 36 != 0 {
            return Err("Retained source appends must start and end on whole triangles".into());
        }
        let total = pending.bytes.len().checked_add(byte_length).ok_or("Mesh upload size overflow")?;
        validate_size(total)?;
        let before = pending.bytes.capacity();
        pending.bytes.try_reserve_exact(byte_length)
            .map_err(|e| format!("Cannot grow mesh upload buffer: {e}"))?;
        pending.stats.reserve_grew |= pending.bytes.capacity() > before;
        pending.stats.capacity_bytes = pending.bytes.capacity();
        Ok(())
    }

    /// Native-generated immutable bytes count as reuse, not IPC uploads. They
    /// still contribute verified hashes to the retained last-slice manifest.
    pub fn append_reused_verified(&mut self, upload_id: &str, hash: ChunkHash, bytes: &[u8]) -> Result<(), String> {
        let pending = self.pending.as_mut().filter(|upload| upload.id == upload_id)
            .ok_or("Unknown or stale mesh upload ID")?;
        validate_chunk_size(bytes.len())?;
        pending.append(bytes, true)?;
        pending.remember(hash, bytes.len());
        Ok(())
    }

    pub fn finish(&mut self, upload_id: &str, stage: bool) -> Result<FinishedUpload, String> {
        let pending = self.pending.as_ref()
            .filter(|upload| upload.id == upload_id)
            .ok_or("Unknown or stale mesh upload ID")?;
        if pending.bytes.is_empty() || pending.bytes.len() % 36 != 0 {
            return Err("Completed mesh must contain whole triangles (36 bytes each)".into());
        }
        let mut pending = self.pending.take().expect("pending upload was validated");
        let slice_snapshot_id = if stage {
            pending.slice_chunks.take().and_then(|chunks| self.retain(&pending, chunks))
        } else {
            None
        };
        let staged_bytes = if stage {
            Some(pending.bytes)
        } else {
            self.ready = Some(ReadyUpload { id: pending.id, bytes: pending.bytes });
            None
        };
        Ok(FinishedUpload { stats: pending.stats, staged_bytes, slice_snapshot_id })
    }

    fn retain(&mut self, pending: &PendingUpload, chunks: Vec<SliceChunk>) -> Option<String> {
        #[cfg(test)]
        { self.last_backing_write_bytes = 0; }
        if let Some(previous) = &mut self.retained {
            if previous.total_bytes == pending.bytes.len() && previous.chunks == chunks {
                let id = pending.id.clone();
                previous.id = id.clone();
                return Some(id);
            }
        }
        #[cfg(test)]
        let mut written_bytes = 0;
        let mut by_hash = HashMap::new();
        if by_hash.try_reserve(chunks.len()).is_err() {
            return None;
        }
        for (index, chunk) in chunks.iter().enumerate() {
            by_hash.entry(chunk.hash).or_insert(index);
        }
        let file = self.backing.as_mut()?;
        let previous = self.retained.as_ref();
        // Once writes start an IO failure may have damaged the previous snapshot.
        // Only publish the new immutable manifest after every write succeeds.
        let result = (|| -> io::Result<()> {
            for chunk in &chunks {
                let unchanged = previous.and_then(|slice| {
                    slice.chunks.binary_search_by_key(&chunk.offset, |old| old.offset)
                        .ok().map(|index| &slice.chunks[index])
                }) == Some(chunk);
                if !unchanged {
                    file.seek(SeekFrom::Start(chunk.offset as u64))?;
                    file.write_all(&pending.bytes[chunk.offset..chunk.offset + chunk.byte_length])?;
                    #[cfg(test)]
                    { written_bytes += chunk.byte_length; }
                }
            }
            if previous.map(|slice| slice.total_bytes) != Some(pending.bytes.len()) {
                file.set_len(pending.bytes.len() as u64)?;
            }
            Ok(())
        })();
        #[cfg(test)]
        { self.last_backing_write_bytes = written_bytes; }
        if result.is_err() {
            self.invalidate_retention();
            return None;
        }
        let id = pending.id.clone();
        self.retained = Some(RetainedSlice { id: id.clone(), chunks, by_hash, total_bytes: pending.bytes.len() });
        Some(id)
    }

    fn invalidate_retention(&mut self) {
        self.retained = None;
        self.backing = None;
        if let Some(pending) = &mut self.pending {
            pending.slice_chunks = None;
        }
    }

    /// Restore only the exact last committed ID. Missing/corrupt backing is a miss;
    /// the adapter must publish returned bytes only after this fully succeeds.
    pub fn restore_slice(&mut self, snapshot_id: &str) -> Result<Option<FinishedUpload>, String> {
        let Some(slice) = self.retained.as_ref().filter(|slice| slice.id == snapshot_id) else {
            return Ok(None);
        };
        if self.pending.is_some() || self.ready.is_some() {
            return Err("A mesh upload is still pending or awaiting consumption".into());
        }
        let mut bytes = Vec::new();
        bytes.try_reserve_exact(slice.total_bytes)
            .map_err(|e| format!("Cannot reserve restored mesh buffer: {e}"))?;
        let started = Instant::now();
        let read = (|| -> io::Result<()> {
            for chunk in &slice.chunks {
                // Hot chunks were verified before insertion and are immutable.
                // A normal small warm slice needs neither disk IO nor SHA again.
                if let Some(cached) = self.chunks.get_mut(&chunk.hash) {
                    if cached.bytes.len() != chunk.byte_length {
                        return Err(io::Error::new(io::ErrorKind::InvalidData, "Cached slice chunk length mismatch"));
                    }
                    bytes.extend_from_slice(&cached.bytes);
                    self.clock = self.clock.saturating_add(1);
                    cached.touched = self.clock;
                    continue;
                }
                let file = self.backing.as_mut().ok_or_else(|| io::Error::other("Missing slice backing"))?;
                let verify = self.verifier.ok_or_else(|| io::Error::other("Missing slice verifier"))?;
                file.seek(SeekFrom::Start(chunk.offset as u64))?;
                let read = (&mut *file).take(chunk.byte_length as u64).read_to_end(&mut bytes)?;
                if read != chunk.byte_length {
                    return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "Truncated slice backing"));
                }
                if verify(&bytes[chunk.offset..chunk.offset + chunk.byte_length]) != chunk.hash {
                    return Err(io::Error::new(io::ErrorKind::InvalidData, "Slice backing SHA-256 mismatch"));
                }
            }
            Ok(())
        })();
        if read.is_err() {
            self.invalidate_retention();
            return Ok(None);
        }
        let elapsed_ns = started.elapsed().as_nanos().min(u64::MAX as u128) as u64;
        let stats = UploadStats {
            chunk_bytes: slice.chunks.last().map_or(0, |chunk| chunk.byte_length),
            total_bytes: bytes.len(),
            capacity_bytes: bytes.capacity(),
            reserve_grew: false,
            chunks_received: slice.chunks.len() as u64,
            append_ns: elapsed_ns,
            append_ns_total: elapsed_ns,
            uploaded_bytes: 0,
            reused_bytes: bytes.len(),
        };
        Ok(Some(FinishedUpload { stats, staged_bytes: Some(bytes), slice_snapshot_id: Some(slice.id.clone()) }))
    }

    /// Length mismatches do not consume the snapshot; its owner can still abort it.
    pub fn take_ready(&mut self, upload_id: &str, expected_bytes: usize) -> Result<Vec<u8>, String> {
        validate_size(expected_bytes)?;
        let ready = self.ready.as_ref()
            .filter(|upload| upload.id == upload_id)
            .ok_or("Unknown, stale, or already consumed mesh upload ID")?;
        if ready.bytes.len() != expected_bytes {
            return Err(format!(
                "Mesh upload length mismatch: expected {expected_bytes}, received {}",
                ready.bytes.len()
            ));
        }
        Ok(self.ready.take().expect("ready upload was validated").bytes)
    }

    /// Idempotent cancellation never clears a different upload or the staged mesh.
    pub fn abort(&mut self, upload_id: &str) {
        if self.pending.as_ref().map_or(false, |upload| upload.id == upload_id) {
            self.pending = None;
        }
        if self.ready.as_ref().map_or(false, |upload| upload.id == upload_id) {
            self.ready = None;
        }
    }
}

impl PendingUpload {
    fn remember(&mut self, hash: ChunkHash, byte_length: usize) {
        if let Some(chunks) = &mut self.slice_chunks {
            if retention_fits(self.bytes.len(), chunks.len())
                && chunks.try_reserve(1).is_ok()
            {
                chunks.push(SliceChunk { hash, offset: self.bytes.len() - byte_length, byte_length });
                return;
            }
            self.slice_chunks = None;
        }
    }

    fn append(&mut self, bytes: &[u8], reused: bool) -> Result<(), String> {
        let total_bytes = self.bytes.len().checked_add(bytes.len())
            .ok_or("Mesh upload size overflow")?;
        validate_size(total_bytes)?;
        let capacity_before = self.bytes.capacity();
        self.bytes.try_reserve(bytes.len())
            .map_err(|e| format!("Cannot grow mesh upload buffer: {e}"))?;
        let started = Instant::now();
        self.bytes.extend_from_slice(bytes);
        let append_ns = started.elapsed().as_nanos().min(u64::MAX as u128) as u64;
        self.stats.chunk_bytes = bytes.len();
        self.stats.total_bytes = total_bytes;
        self.stats.capacity_bytes = self.bytes.capacity();
        self.stats.reserve_grew |= self.bytes.capacity() > capacity_before;
        self.stats.chunks_received += 1;
        self.stats.append_ns = append_ns;
        self.stats.append_ns_total = self.stats.append_ns_total.saturating_add(append_ns);
        if reused {
            self.stats.reused_bytes += bytes.len();
        } else {
            self.stats.uploaded_bytes += bytes.len();
        }
        Ok(())
    }
}

fn retention_fits(total_bytes: usize, entries: usize) -> bool {
    total_bytes <= SLICE_BACKING_BYTES && entries < SLICE_MANIFEST_ENTRIES
}

fn validate_size(bytes: usize) -> Result<(), String> {
    if bytes > isize::MAX as usize || bytes as u128 > MAX_SAFE_BYTES as u128 {
        return Err("Mesh byte size exceeds the native/JavaScript safe range".into());
    }
    Ok(())
}

fn validate_chunk_size(bytes: usize) -> Result<(), String> {
    if bytes == 0 || bytes > CHUNK_BYTES || bytes % 4 != 0 {
        return Err("Mesh chunks must be nonempty, 4-byte aligned, and at most 4 MiB".into());
    }
    Ok(())
}

#[cfg(test)]
#[path = "mesh_slice_backing.rs"]
mod test_backing;

#[cfg(test)]
mod tests {
    use super::*;

    fn hash(value: u8) -> ChunkHash { [value; 32] }
    fn triangle(value: u8) -> Vec<u8> { vec![value; 36] }

    fn stage(cache: &mut MeshChunkCache, parts: &[(u8, Vec<u8>)]) -> Vec<u8> {
        let id = cache.begin(0).unwrap();
        for (key, bytes) in parts {
            cache.append_verified(&id, hash(*key), bytes).unwrap();
        }
        cache.finish(&id, true).unwrap().staged_bytes.unwrap()
    }

    #[test]
    fn native_source_chunks_are_reused_and_stale_ids_cannot_damage_replacement() {
        let mut cache = MeshChunkCache::new(72);
        let old = cache.begin(0).unwrap();
        assert!(cache.prepare_reused_append(&old, 35).is_err());
        cache.prepare_reused_append(&old, 72).unwrap();
        cache.append_reused_verified(&old, hash(1), &triangle(1)).unwrap();
        cache.abort(&old);
        let current = cache.begin(0).unwrap();
        assert!(cache.prepare_reused_append(&old, 36).is_err());
        assert!(cache.append_reused_verified(&old, hash(2), &triangle(2)).is_err());
        cache.prepare_reused_append(&current, 72).unwrap();
        cache.append_reused_verified(&current, hash(2), &triangle(2)).unwrap();
        cache.append_reused_verified(&current, hash(1), &triangle(1)).unwrap();
        let done = cache.finish(&current, true).unwrap();
        assert_eq!(done.stats.uploaded_bytes, 0);
        assert_eq!(done.stats.reused_bytes, 72);
        assert_eq!(done.stats.chunks_received, 2);
        assert_eq!(done.staged_bytes.unwrap(), [triangle(2), triangle(1)].concat());
    }

    #[test]
    fn unchanged_chunks_are_reused_and_only_changed_chunks_are_uploaded() {
        let mut cache = MeshChunkCache::new(108);
        stage(&mut cache, &[(1, triangle(1)), (2, triangle(2))]);
        let id = cache.begin(73).unwrap();
        assert!(cache.append_cached(&id, &hash(1), 36).unwrap());
        assert!(!cache.append_cached(&id, &hash(3), 36).unwrap());
        cache.append_verified(&id, hash(3), &triangle(3)).unwrap();
        let done = cache.finish(&id, true).unwrap();
        assert_eq!(done.staged_bytes.unwrap(), [triangle(1), triangle(3)].concat());
        assert_eq!(done.stats.uploaded_bytes, 36);
        assert_eq!(done.stats.reused_bytes, 36);
        assert_eq!(done.stats.chunks_received, 2);
        assert_eq!(done.stats.total_bytes, 72);
        assert_eq!(done.stats.chunk_bytes, 36);
        assert!(!done.stats.reserve_grew);
    }

    #[test]
    fn batched_lookup_stops_at_the_first_miss_and_keeps_requested_order() {
        let mut cache = MeshChunkCache::new(108);
        stage(&mut cache, &[(1, triangle(1)), (2, triangle(2))]);
        let id = cache.begin(108).unwrap();
        // 1 and 2 are resident, 3 is not: only the leading run is appended.
        assert_eq!(cache.append_cached_batch(&id, &[(hash(1), 36), (hash(2), 36), (hash(3), 36)]).unwrap(), 2);
        assert_eq!(cache.append_cached_batch(&id, &[(hash(2), 36)]).unwrap(), 1);
        cache.append_verified(&id, hash(3), &triangle(3)).unwrap();
        let done = cache.finish(&id, true).unwrap();
        assert_eq!(done.staged_bytes.unwrap(), [triangle(1), triangle(2), triangle(2), triangle(3)].concat());
        assert_eq!(done.stats.reused_bytes, 108);
        assert_eq!(done.stats.uploaded_bytes, 36);
        assert_eq!(done.stats.chunks_received, 4);
    }

    #[test]
    fn lru_eviction_respects_hits_and_never_discards_in_progress_output() {
        let mut cache = MeshChunkCache::new(72);
        stage(&mut cache, &[(1, triangle(1)), (2, triangle(2))]);
        let id = cache.begin(0).unwrap();
        assert!(cache.append_cached(&id, &hash(1), 36).unwrap());
        cache.append_verified(&id, hash(3), &triangle(3)).unwrap();
        assert!(!cache.append_cached(&id, &hash(2), 36).unwrap());
        cache.append_verified(&id, hash(4), &triangle(4)).unwrap();
        assert!(!cache.chunks.contains_key(&hash(1)));
        assert_eq!(cache.cached_bytes, 72);
        let done = cache.finish(&id, true).unwrap();
        assert_eq!(done.staged_bytes.unwrap(), [triangle(1), triangle(3), triangle(4)].concat());
        assert_eq!(done.stats.total_bytes, 108);
        assert!(done.stats.reserve_grew);
    }

    #[test]
    fn cache_hits_preserve_requested_order_and_duplicate_chunks() {
        let mut cache = MeshChunkCache::new(72);
        stage(&mut cache, &[(1, triangle(1)), (2, triangle(2))]);
        let id = cache.begin(108).unwrap();
        for key in [2, 1, 2] {
            assert!(cache.append_cached(&id, &hash(key), 36).unwrap());
        }
        cache.finish(&id, false).unwrap();
        assert_eq!(cache.take_ready(&id, 108).unwrap(), [triangle(2), triangle(1), triangle(2)].concat());
    }

    #[test]
    fn oversized_cache_entry_does_not_limit_upload_size() {
        let mut cache = MeshChunkCache::new(4);
        let expected = stage(&mut cache, &[(1, triangle(1)), (2, triangle(2))]);
        assert_eq!(expected, [triangle(1), triangle(2)].concat());
        assert_eq!(cache.cached_bytes, 0);
        assert!(cache.chunks.is_empty());
    }

    #[test]
    fn cancellation_and_stale_abort_are_session_scoped() {
        let mut cache = MeshChunkCache::new(72);
        let old = cache.begin(0).unwrap();
        cache.append_verified(&old, hash(1), &triangle(1)).unwrap();
        cache.abort(&old);
        cache.abort(&old);
        assert!(cache.append_cached(&old, &hash(1), 36).is_err());
        assert!(cache.finish(&old, true).is_err());
        let current = cache.begin(0).unwrap();
        assert_ne!(old, current);
        cache.abort(&old);
        assert!(cache.append_cached(&current, &hash(1), 36).unwrap());
        cache.finish(&current, false).unwrap();
        cache.abort(&old);
        assert_eq!(cache.take_ready(&current, 36).unwrap(), triangle(1));
        assert!(cache.take_ready(&current, 36).is_err());
    }

    #[test]
    fn ready_snapshot_blocks_begin_and_requires_exact_identity_and_length() {
        let mut cache = MeshChunkCache::new(72);
        let id = cache.begin(36).unwrap();
        assert!(cache.begin(0).is_err());
        cache.append_verified(&id, hash(1), &triangle(1)).unwrap();
        assert!(cache.finish("mesh-upload-other", false).is_err());
        assert!(cache.finish(&id, false).unwrap().staged_bytes.is_none());
        assert!(cache.begin(0).is_err());
        assert!(cache.append_cached(&id, &hash(1), 36).is_err());
        assert!(cache.take_ready("mesh-upload-other", 36).is_err());
        assert!(cache.take_ready(&id, 72).is_err());
        cache.abort("mesh-upload-other");
        assert_eq!(cache.take_ready(&id, 36).unwrap(), triangle(1));
        let next = cache.begin(0).unwrap();
        cache.abort(&id);
        cache.append_verified(&next, hash(2), &triangle(2)).unwrap();
        cache.finish(&next, false).unwrap();
        cache.abort(&next);
        assert!(cache.take_ready(&next, 36).is_err());
        assert!(cache.begin(0).is_ok());
    }

    #[test]
    fn malformed_chunks_and_sizes_leave_the_session_unchanged() {
        let mut cache = MeshChunkCache::new(72);
        assert!(cache.begin(usize::MAX).is_err());
        let id = cache.begin(0).unwrap();
        assert!(cache.finish(&id, true).is_err());
        for bytes in [&[][..], &[1, 2, 3][..]] {
            assert!(cache.append_verified(&id, hash(1), bytes).is_err());
        }
        assert!(cache.append_cached(&id, &hash(1), CHUNK_BYTES + 4).is_err());
        cache.append_verified(&id, hash(1), &triangle(1)).unwrap();
        assert!(cache.append_cached(&id, &hash(1), 32).is_err());
        assert!(cache.append_verified(&id, hash(1), &triangle(2)).is_err());
        let done = cache.finish(&id, true).unwrap();
        assert_eq!(done.staged_bytes.unwrap(), triangle(1));
        assert_eq!(done.stats.chunks_received, 1);
    }

    #[test]
    fn chunks_need_float_alignment_not_triangle_alignment() {
        let mut cache = MeshChunkCache::new(36);
        let id = cache.begin(36).unwrap();
        cache.append_verified(&id, hash(1), &[1; 16]).unwrap();
        assert!(cache.finish(&id, true).is_err());
        cache.append_verified(&id, hash(2), &[2; 20]).unwrap();
        assert_eq!(cache.finish(&id, true).unwrap().staged_bytes.unwrap(), [vec![1; 16], vec![2; 20]].concat());
    }

    // Deliberately simple deterministic verifier keeps this module's test binary
    // std-only. Production supplies SHA-256 from the transport adapter.
    fn verify(bytes: &[u8]) -> ChunkHash {
        let mut state = 0xcbf29ce484222325u64;
        for byte in bytes {
            state = (state ^ u64::from(*byte)).wrapping_mul(0x100000001b3);
        }
        let mut hash = [0u8; 32];
        for lane in hash.chunks_exact_mut(8) { lane.copy_from_slice(&state.to_le_bytes()); }
        hash
    }

    fn disk_cache(budget: usize) -> MeshChunkCache {
        MeshChunkCache::with_verifier(budget, verify)
    }

    fn begin_slice(cache: &mut MeshChunkCache) -> String {
        cache.begin_for_slice(0, || test_backing::open(&std::env::current_dir()?)).unwrap()
    }

    fn retain_parts(cache: &mut MeshChunkCache, parts: &[Vec<u8>]) -> String {
        let id = begin_slice(cache);
        for bytes in parts {
            cache.append_verified(&id, verify(bytes), bytes).unwrap();
        }
        let done = cache.finish(&id, true).unwrap();
        assert_eq!(done.slice_snapshot_id.as_deref(), Some(id.as_str()));
        assert_eq!(done.staged_bytes.unwrap(), parts.concat());
        id
    }

    #[test]
    fn baking_never_replaces_last_slice_and_warm_restore_reuses_all_bytes() {
        let mut cache = disk_cache(36);
        let expected = vec![triangle(1), triangle(2), triangle(3)];
        let id = retain_parts(&mut cache, &expected);
        // A modifier's immutable input and staged result evict hot entries only.
        let bake = cache.begin(0).unwrap();
        cache.append_verified(&bake, verify(&triangle(4)), &triangle(4)).unwrap();
        assert!(cache.finish(&bake, false).unwrap().slice_snapshot_id.is_none());
        assert!(cache.restore_slice(&id).is_err());
        assert_eq!(cache.take_ready(&bake, 36).unwrap(), triangle(4));
        stage(&mut cache, &[(9, triangle(9))]);
        let done = cache.restore_slice(&id).unwrap().unwrap();
        assert_eq!(done.staged_bytes.unwrap(), expected.concat());
        assert_eq!(done.stats.uploaded_bytes, 0);
        assert_eq!(done.stats.reused_bytes, 108);
        assert_eq!(done.stats.chunks_received, 3);
        assert_eq!(done.slice_snapshot_id.as_deref(), Some(id.as_str()));
    }

    #[test]
    fn native_source_bytes_retain_a_snapshot_without_ipc_transfer_or_hot_cache_copy() {
        let mut cache = disk_cache(72);
        let id = begin_slice(&mut cache);
        cache.prepare_reused_append(&id, 72).unwrap();
        for value in [2, 1] {
            let bytes = triangle(value);
            cache.append_reused_verified(&id, verify(&bytes), &bytes).unwrap();
        }
        let done = cache.finish(&id, true).unwrap();
        assert_eq!(done.stats.uploaded_bytes, 0);
        assert_eq!(done.stats.reused_bytes, 72);
        assert_eq!(done.slice_snapshot_id.as_deref(), Some(id.as_str()));
        assert_eq!(cache.cached_bytes, 0);
        assert_eq!(cache.restore_slice(&id).unwrap().unwrap().staged_bytes.unwrap(),
            [triangle(2), triangle(1)].concat());
    }

    #[test]
    fn disk_hits_survive_hot_eviction_and_preserve_order_and_duplicates() {
        let mut cache = disk_cache(36);
        let first = triangle(1);
        let second = triangle(2);
        retain_parts(&mut cache, &[first.clone(), second.clone()]);
        assert!(!cache.chunks.contains_key(&verify(&first)));
        let next = begin_slice(&mut cache);
        for bytes in [&second, &first, &second] {
            assert!(cache.append_cached(&next, &verify(bytes), bytes.len()).unwrap());
        }
        let done = cache.finish(&next, true).unwrap();
        assert_eq!(done.stats.uploaded_bytes, 0);
        assert_eq!(done.stats.reused_bytes, 108);
        assert_eq!(cache.restore_slice(&next).unwrap().unwrap().staged_bytes.unwrap(),
            [second.clone(), first, second].concat());
    }

    #[test]
    fn default_hot_budget_does_not_limit_retained_working_set() {
        let mut cache = disk_cache(CACHE_BYTES);
        let id = begin_slice(&mut cache);
        let mut expected = Vec::new();
        // 17 full chunks exceed the real 64 MiB cache; add a triangle-aligned tail.
        for value in 1..=17u8 {
            let bytes = vec![value; CHUNK_BYTES];
            cache.append_verified(&id, verify(&bytes), &bytes).unwrap();
            expected.extend_from_slice(&bytes);
        }
        let tail = vec![18; (36 - expected.len() % 36) % 36];
        if !tail.is_empty() {
            cache.append_verified(&id, verify(&tail), &tail).unwrap();
            expected.extend_from_slice(&tail);
        }
        let done = cache.finish(&id, true).unwrap();
        assert_eq!(done.staged_bytes.unwrap(), expected);
        assert!(cache.cached_bytes <= CACHE_BYTES);
        assert_eq!(cache.backing.as_ref().unwrap().metadata().unwrap().len(), expected.len() as u64);
        let again = cache.begin(0).unwrap();
        let first = vec![1; CHUNK_BYTES];
        assert!(cache.append_cached(&again, &verify(&first), first.len()).unwrap());
        cache.abort(&again);
        assert_eq!(cache.restore_slice(&id).unwrap().unwrap().staged_bytes.unwrap(), expected);
    }

    #[test]
    fn unchanged_snapshots_write_nothing_and_changed_chunks_write_only_dirty_ranges() {
        let mut cache = disk_cache(72);
        let first = retain_parts(&mut cache, &[triangle(1), triangle(2)]);
        assert_eq!(cache.last_backing_write_bytes, 72);
        let second = retain_parts(&mut cache, &[triangle(1), triangle(2)]);
        assert_ne!(first, second);
        assert_eq!(cache.last_backing_write_bytes, 0);
        assert!(cache.restore_slice(&first).unwrap().is_none());
        let third = retain_parts(&mut cache, &[triangle(1), triangle(3)]);
        assert_eq!(cache.last_backing_write_bytes, 36);
        assert!(cache.restore_slice(&second).unwrap().is_none());
        assert_eq!(cache.restore_slice(&third).unwrap().unwrap().staged_bytes.unwrap(),
            [triangle(1), triangle(3)].concat());
        let fourth = retain_parts(&mut cache, &[triangle(1)]);
        assert_eq!(cache.last_backing_write_bytes, 0);
        assert_eq!(cache.backing.as_ref().unwrap().metadata().unwrap().len(), 36);
        assert!(cache.restore_slice(&third).unwrap().is_none());
        assert!(cache.restore_slice(&fourth).unwrap().is_some());
    }

    #[test]
    fn aborted_retention_and_stale_operations_preserve_last_committed_snapshot() {
        let mut cache = disk_cache(0);
        let good = retain_parts(&mut cache, &[triangle(1)]);
        let abandoned = begin_slice(&mut cache);
        cache.append_verified(&abandoned, verify(&triangle(2)), &triangle(2)).unwrap();
        assert!(cache.finish(&good, true).is_err());
        assert!(cache.append_cached(&good, &verify(&triangle(1)), 36).is_err());
        assert!(cache.restore_slice(&abandoned).unwrap().is_none());
        assert!(cache.restore_slice(&good).is_err());
        cache.abort(&abandoned);
        assert_eq!(cache.restore_slice(&good).unwrap().unwrap().staged_bytes.unwrap(), triangle(1));
        cache.abort(&good);
        assert!(cache.restore_slice(&good).unwrap().is_some());
    }

    #[test]
    fn corrupt_disk_reads_are_misses_and_never_partially_append() {
        let mut cache = disk_cache(0);
        let good = retain_parts(&mut cache, &[triangle(1), triangle(2)]);
        let file = cache.backing.as_mut().unwrap();
        file.seek(SeekFrom::Start(0)).unwrap();
        file.write_all(&[99]).unwrap();
        let next = cache.begin(0).unwrap();
        assert!(!cache.append_cached(&next, &verify(&triangle(1)), 36).unwrap());
        assert_eq!(cache.pending.as_ref().unwrap().stats.total_bytes, 0);
        assert!(cache.retained.is_none());
        assert!(cache.backing.is_none());
        cache.append_verified(&next, verify(&triangle(3)), &triangle(3)).unwrap();
        assert_eq!(cache.finish(&next, true).unwrap().staged_bytes.unwrap(), triangle(3));
        assert!(cache.restore_slice(&good).unwrap().is_none());
    }

    #[test]
    fn truncated_or_corrupt_restore_discards_no_staged_geometry() {
        for truncate in [true, false] {
            let mut cache = disk_cache(0);
            let good = retain_parts(&mut cache, &[triangle(1), triangle(2)]);
            if truncate {
                cache.backing.as_mut().unwrap().set_len(40).unwrap();
            } else {
                let file = cache.backing.as_mut().unwrap();
                file.seek(SeekFrom::Start(36)).unwrap();
                file.write_all(&[99]).unwrap();
            }
            // No partial restored result can be published by the transport.
            assert!(cache.restore_slice(&good).unwrap().is_none());
            assert!(cache.retained.is_none());
            assert!(cache.backing.is_none());
        }
    }

    #[test]
    fn backing_open_and_write_failures_leave_uploads_valid() {
        let mut cache = disk_cache(0);
        let id = cache.begin_for_slice(0, || Err(io::Error::other("unavailable"))).unwrap();
        cache.append_verified(&id, verify(&triangle(1)), &triangle(1)).unwrap();
        let done = cache.finish(&id, true).unwrap();
        assert!(done.slice_snapshot_id.is_none());
        assert_eq!(done.staged_bytes.unwrap(), triangle(1));
        let good = retain_parts(&mut cache, &[triangle(2)]);
        // A read-only file makes the first dirty-range write fail without mocks.
        cache.backing = Some(File::open(std::env::current_exe().unwrap()).unwrap());
        let next = begin_slice(&mut cache);
        cache.append_verified(&next, verify(&triangle(3)), &triangle(3)).unwrap();
        let done = cache.finish(&next, true).unwrap();
        assert!(done.slice_snapshot_id.is_none());
        assert_eq!(done.staged_bytes.unwrap(), triangle(3));
        assert!(cache.restore_slice(&good).unwrap().is_none());
    }

    #[test]
    fn hot_and_pending_manifest_metadata_are_bounded() {
        let mut cache = disk_cache(CACHE_ENTRIES * 4 + 4);
        let id = cache.begin(0).unwrap();
        for value in 0..=CACHE_ENTRIES {
            let bytes = (value as u32).to_le_bytes();
            let mut hash = [0; 32];
            hash[..4].copy_from_slice(&bytes);
            cache.append_verified(&id, hash, &bytes).unwrap();
        }
        assert_eq!(cache.chunks.len(), CACHE_ENTRIES);
        assert_eq!(cache.cached_bytes, CACHE_ENTRIES * 4);
        cache.abort(&id);
        let id = begin_slice(&mut cache);
        for _ in 0..=SLICE_MANIFEST_ENTRIES {
            cache.append_verified(&id, verify(&[0; 4]), &[0; 4]).unwrap();
        }
        assert!(cache.pending.as_ref().unwrap().slice_chunks.is_none());
        while cache.pending.as_ref().unwrap().bytes.len() % 36 != 0 {
            cache.append_verified(&id, verify(&[0; 4]), &[0; 4]).unwrap();
        }
        assert!(cache.finish(&id, true).unwrap().slice_snapshot_id.is_none());
    }

    #[test]
    fn payload_limit_disables_only_retention_without_allocating_two_gibibytes() {
        let mut pending = PendingUpload {
            id: "bounded".into(), bytes: triangle(1),
            stats: UploadStats { chunk_bytes: 0, total_bytes: 0, capacity_bytes: 0,
                reserve_grew: false, chunks_received: 0, append_ns: 0, append_ns_total: 0,
                uploaded_bytes: 0, reused_bytes: 0 },
            slice_chunks: Some(Vec::new()),
        };
        assert!(retention_fits(SLICE_BACKING_BYTES, SLICE_MANIFEST_ENTRIES - 1));
        assert!(!retention_fits(SLICE_BACKING_BYTES + 4, 0));
        assert!(!retention_fits(36, SLICE_MANIFEST_ENTRIES));
        pending.remember(verify(&triangle(1)), 36);
        assert_eq!(pending.slice_chunks.as_ref().unwrap().len(), 1);
    }

    #[test]
    fn unchanged_offsets_are_not_rewritten_when_append_boundaries_change() {
        let mut cache = disk_cache(0);
        retain_parts(&mut cache, &[vec![1; 16], vec![2; 20]]);
        retain_parts(&mut cache, &[vec![3; 4], vec![4; 12], vec![2; 20]]);
        assert_eq!(cache.last_backing_write_bytes, 16);
    }

    #[test]
    fn fully_resident_warm_restore_never_reads_or_rehashes_backing() {
        let mut cache = disk_cache(72);
        let id = retain_parts(&mut cache, &[triangle(1), triangle(2)]);
        // If restore touched disk this would be a miss; if it rehashed hot data
        // the verifier would panic. Existing verified immutable RAM is enough.
        cache.backing.as_ref().unwrap().set_len(0).unwrap();
        cache.verifier = Some(|_| panic!("resident chunks must not be rehashed"));
        let done = cache.restore_slice(&id).unwrap().unwrap();
        assert_eq!(done.staged_bytes.unwrap(), [triangle(1), triangle(2)].concat());
        assert_eq!(done.stats.uploaded_bytes, 0);
        assert_eq!(done.stats.reused_bytes, 72);
        // Once RAM is evicted, the damaged backing must still be rejected.
        cache.chunks.clear();
        cache.cached_bytes = 0;
        assert!(cache.restore_slice(&id).unwrap().is_none());
    }

    #[test]
    fn partially_resident_restore_verifies_only_the_chunks_read_from_disk() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static DISK_HASHES: AtomicUsize = AtomicUsize::new(0);
        fn count_disk_hash(bytes: &[u8]) -> ChunkHash {
            DISK_HASHES.fetch_add(1, Ordering::Relaxed);
            verify(bytes)
        }
        let mut cache = MeshChunkCache::with_verifier(36, count_disk_hash);
        let id = retain_parts(&mut cache, &[triangle(1), triangle(2)]);
        assert!(!cache.chunks.contains_key(&verify(&triangle(1))));
        assert!(cache.chunks.contains_key(&verify(&triangle(2))));
        DISK_HASHES.store(0, Ordering::Relaxed);
        let done = cache.restore_slice(&id).unwrap().unwrap();
        assert_eq!(done.staged_bytes.unwrap(), [triangle(1), triangle(2)].concat());
        assert_eq!(DISK_HASHES.load(Ordering::Relaxed), 1);
    }
}
