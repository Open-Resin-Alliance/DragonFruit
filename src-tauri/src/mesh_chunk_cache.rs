//! Bounded content-addressed mesh chunks and single-flight upload ownership.
//!
//! This module deliberately uses only std so its tests can run with rustc alone.
//! The IPC adapter must verify SHA-256 before calling append_verified.

use std::collections::HashMap;
use std::time::Instant;

pub const CHUNK_BYTES: usize = 4 * 1024 * 1024;
pub const CACHE_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_SAFE_BYTES: u64 = 9_007_199_254_740_991;
pub type ChunkHash = [u8; 32];

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
}

struct CachedChunk {
    bytes: Vec<u8>,
    touched: u64,
}

struct PendingUpload {
    id: String,
    bytes: Vec<u8>,
    stats: UploadStats,
}

struct ReadyUpload {
    id: String,
    bytes: Vec<u8>,
}

/// One pending upload or ready snapshot, plus a byte-bounded LRU chunk cache.
/// Ready snapshots are never evicted: their owner must consume or abort them.
pub struct MeshChunkCache {
    budget: usize,
    cached_bytes: usize,
    chunks: HashMap<ChunkHash, CachedChunk>,
    clock: u64,
    next_id: u64,
    pending: Option<PendingUpload>,
    ready: Option<ReadyUpload>,
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
        }
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
        });
        Ok(id)
    }

    /// A miss does not alter upload bytes, counters, or cache recency.
    pub fn append_cached(
        &mut self,
        upload_id: &str,
        hash: &ChunkHash,
        byte_length: usize,
    ) -> Result<bool, String> {
        let pending = self.pending.as_mut()
            .filter(|upload| upload.id == upload_id)
            .ok_or("Unknown or stale mesh upload ID")?;
        validate_chunk_size(byte_length)?;
        let Some(chunk) = self.chunks.get_mut(hash) else {
            return Ok(false);
        };
        if chunk.bytes.len() != byte_length {
            return Err("Cached mesh chunk byteLength does not match its hash".into());
        }
        pending.append(&chunk.bytes, true)?;
        self.clock = self.clock.saturating_add(1);
        chunk.touched = self.clock;
        Ok(true)
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
        self.clock = self.clock.saturating_add(1);
        if let Some(chunk) = self.chunks.get_mut(&hash) {
            chunk.touched = self.clock;
        } else if let Some(copy) = cached_copy {
            while self.cached_bytes > self.budget - copy.len() {
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

    pub fn finish(&mut self, upload_id: &str, stage: bool) -> Result<FinishedUpload, String> {
        let pending = self.pending.as_ref()
            .filter(|upload| upload.id == upload_id)
            .ok_or("Unknown or stale mesh upload ID")?;
        if pending.bytes.is_empty() || pending.bytes.len() % 36 != 0 {
            return Err("Completed mesh must contain whole triangles (36 bytes each)".into());
        }
        let pending = self.pending.take().expect("pending upload was validated");
        let staged_bytes = if stage {
            Some(pending.bytes)
        } else {
            self.ready = Some(ReadyUpload { id: pending.id, bytes: pending.bytes });
            None
        };
        Ok(FinishedUpload { stats: pending.stats, staged_bytes })
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
}
