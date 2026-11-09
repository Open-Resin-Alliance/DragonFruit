//! Bounded fetch arena for bulk readbacks.
//!
//! Std only, and every operation takes the clock, so its tests are
//! deterministic and run with `rustc --test` alone. The transport
//! (`mesh_readback.rs`) owns the process-wide instance and the HTTP handler.

use std::time::{Duration, Instant};

pub struct Published {
    pub id: String,
    pub byte_length: u64,
}

struct Entry {
    id: String,
    bytes: Vec<u8>,
    created: Instant,
}

pub struct ReadbackArena {
    entries: Vec<Entry>,
    bytes: usize,
    next_id: u64,
    budget: usize,
    entry_limit: usize,
    ttl: Duration,
}

impl ReadbackArena {
    pub fn new(budget: usize, entry_limit: usize, ttl: Duration) -> Self {
        Self { entries: Vec::new(), bytes: 0, next_id: 0, budget, entry_limit, ttl }
    }

    fn evict_expired(&mut self, now: Instant) {
        let ttl = self.ttl;
        let mut kept = Vec::with_capacity(self.entries.len());
        let mut bytes = 0;
        for entry in self.entries.drain(..) {
            if now.saturating_duration_since(entry.created) < ttl {
                bytes += entry.bytes.len();
                kept.push(entry);
            }
        }
        self.entries = kept;
        self.bytes = bytes;
    }

    /// Publish one body. Oldest entries make room; a single oversized body is
    /// still published alone rather than failing the read.
    pub fn publish(&mut self, bytes: Vec<u8>, now: Instant) -> Published {
        self.evict_expired(now);
        let size = bytes.len();
        while !self.entries.is_empty()
            && (self.bytes + size > self.budget || self.entries.len() >= self.entry_limit)
        {
            let removed = self.entries.remove(0);
            self.bytes -= removed.bytes.len();
        }
        let id = format!("readback-{}", self.next_id);
        self.next_id += 1;
        self.bytes += size;
        self.entries.push(Entry { id: id.clone(), bytes, created: now });
        Published { id, byte_length: size as u64 }
    }

    /// Move one published body out. The id is consumed.
    pub fn take(&mut self, id: &str, now: Instant) -> Option<Vec<u8>> {
        self.evict_expired(now);
        let index = self.entries.iter().position(|entry| entry.id == id)?;
        let entry = self.entries.remove(index);
        self.bytes -= entry.bytes.len();
        Some(entry.bytes)
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    #[cfg(test)]
    pub fn bytes(&self) -> usize {
        self.bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn arena() -> ReadbackArena {
        ReadbackArena::new(64, 4, Duration::from_secs(30))
    }

    #[test]
    fn a_published_body_is_taken_once() {
        let mut arena = arena();
        let now = Instant::now();
        let published = arena.publish(vec![1, 2, 3, 4], now);
        assert_eq!(published.byte_length, 4);
        assert_eq!(arena.take(&published.id, now), Some(vec![1, 2, 3, 4]));
        assert_eq!(arena.take(&published.id, now), None);
        assert_eq!(arena.bytes(), 0);
    }

    #[test]
    fn ids_never_address_another_body() {
        let mut arena = arena();
        let now = Instant::now();
        let first = arena.publish(vec![9; 8], now);
        let second = arena.publish(vec![7; 8], now);
        assert_eq!(arena.take(&first.id, now), Some(vec![9; 8]));
        assert_eq!(arena.take("readback-missing", now), None);
        assert_eq!(arena.take(&second.id, now), Some(vec![7; 8]));
    }

    #[test]
    fn the_entry_limit_evicts_oldest_first() {
        let mut arena = arena();
        let now = Instant::now();
        let ids: Vec<String> = (0..6).map(|_| arena.publish(vec![0; 4], now).id).collect();
        assert_eq!(arena.len(), 4);
        assert!(arena.take(&ids[0], now).is_none(), "oldest entries are evicted first");
        assert!(arena.take(&ids[1], now).is_none());
        assert!(arena.take(ids.last().unwrap(), now).is_some());
    }

    #[test]
    fn the_byte_budget_evicts_until_the_new_body_fits() {
        let mut arena = ReadbackArena::new(16, 8, Duration::from_secs(30));
        let now = Instant::now();
        let first = arena.publish(vec![0; 12], now);
        let second = arena.publish(vec![0; 12], now);
        assert_eq!(arena.bytes(), 12);
        assert!(arena.take(&first.id, now).is_none());
        assert!(arena.take(&second.id, now).is_some());
    }

    #[test]
    fn an_oversized_body_is_published_alone() {
        let mut arena = ReadbackArena::new(8, 8, Duration::from_secs(30));
        let now = Instant::now();
        let small = arena.publish(vec![0; 4], now);
        let large = arena.publish(vec![0; 32], now);
        assert_eq!(arena.len(), 1);
        assert_eq!(arena.bytes(), 32);
        assert!(arena.take(&small.id, now).is_none());
        assert!(arena.take(&large.id, now).is_some());
    }

    #[test]
    fn expired_bodies_are_evicted_without_a_fetch() {
        let mut arena = arena();
        let start = Instant::now();
        let old = arena.publish(vec![0; 4], start);
        let later = start + Duration::from_secs(31);
        assert!(arena.take(&old.id, later).is_none());
        assert_eq!(arena.bytes(), 0);
        let fresh = arena.publish(vec![1; 4], later);
        assert!(arena.take(&fresh.id, later).is_some());
    }
}
