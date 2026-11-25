//! Native mesh store: meshes held on the Rust side under ids the caller passes back.
//!
//! The staging register in `main.rs` holds one mesh for the whole process, and every command
//! that reads it gets whatever the last caller staged. Two requests in flight on different meshes
//! read each other's mesh, and the frontend has to queue every pass to stop it. The store holds
//! any number of meshes: a caller puts one, gets an id, names that id in each command, and each
//! command returns the id of its result.
//!
//! This module has no Tauri types, so `cargo test` drives it directly; the commands live in
//! `mesh_store_ipc.rs`. ADR-0048 has the decision and `docs/dev/native-mesh-store.md` the
//! contract.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;

/// What an entry holds. A closed set: a reader asks for the variant it needs.
///
/// Only the triangle soup exists so far. Indexed meshes, files, auxiliary buffers and sessions
/// are added with the operation family that first stores one.
#[derive(Clone, Debug, PartialEq)]
pub enum Entry {
    /// A triangle soup: little-endian `f32`, nine per triangle, the staging buffer's layout.
    Soup(Vec<u8>),
}

impl Entry {
    fn byte_len(&self) -> usize {
        match self {
            Entry::Soup(bytes) => bytes.len(),
        }
    }

    /// The soup's bytes.
    pub fn soup_bytes(&self) -> &[u8] {
        match self {
            Entry::Soup(bytes) => bytes,
        }
    }

    /// The soup's bytes, by value.
    pub fn into_soup_bytes(self) -> Vec<u8> {
        match self {
            Entry::Soup(bytes) => bytes,
        }
    }
}

/// Who an entry belongs to. Dropping an owner drops its entries.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Owner {
    /// One page load of the frontend. A reload is a new client, and the old one's entries go.
    Frontend(String),
}

/// Why an id did not resolve. The `Display` form starts with `mesh-store/<code>:` so a caller on
/// the far side of IPC can tell the codes apart without matching on prose.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StoreError {
    /// The store let the entry go to stay inside its budget.
    Expired(String),
    /// The id was never handed out, or its owner dropped it.
    Unknown(String),
}

impl StoreError {
    pub fn code(&self) -> &'static str {
        match self {
            StoreError::Expired(_) => "expired",
            StoreError::Unknown(_) => "unknown",
        }
    }
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::Expired(id) => write!(
                f,
                "mesh-store/expired: mesh '{id}' was released to stay inside the store's budget"
            ),
            StoreError::Unknown(id) => write!(
                f,
                "mesh-store/unknown: no mesh '{id}' (never stored, or already dropped)"
            ),
        }
    }
}

impl From<StoreError> for String {
    fn from(err: StoreError) -> Self {
        err.to_string()
    }
}

/// Counters for sizing the budget and for the debug panel.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreStats {
    pub entries: usize,
    pub bytes: usize,
    pub peak_bytes: usize,
    pub budget_bytes: usize,
    pub evictions: u64,
    pub expired_reads: u64,
}

/// Provisional. Explicit drops are what keep the store small; the budget is the net under a
/// caller that forgets. It gets its real value once `StoreStats::peak_bytes` has been measured
/// on a dense multi-plate scene.
pub const DEFAULT_BUDGET_BYTES: usize = 2 * 1024 * 1024 * 1024;

/// How many evicted ids are remembered, so a late read says `expired` rather than `unknown`.
const REMEMBERED_EVICTIONS: usize = 4096;

struct Slot {
    entry: Arc<Entry>,
    owner: Owner,
    bytes: usize,
    last_used: u64,
}

struct Inner {
    slots: HashMap<String, Slot>,
    next_id: u64,
    clock: u64,
    bytes: usize,
    evicted: HashSet<String>,
    evicted_order: VecDeque<String>,
    stats: StoreStats,
}

pub struct MeshStore {
    inner: Mutex<Inner>,
}

impl MeshStore {
    pub fn new(budget_bytes: usize) -> Self {
        Self {
            inner: Mutex::new(Inner {
                slots: HashMap::new(),
                next_id: 1,
                clock: 0,
                bytes: 0,
                evicted: HashSet::new(),
                evicted_order: VecDeque::new(),
                stats: StoreStats {
                    budget_bytes,
                    ..StoreStats::default()
                },
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        // A panic while holding the lock leaves the map consistent: every mutation below is a
        // single insert or remove, so a poisoned guard is still safe to use.
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Stores an entry and returns its id. Ids are opaque and never reused.
    pub fn put(&self, owner: Owner, entry: Entry) -> String {
        let mut inner = self.lock();
        let id = format!("m{}", inner.next_id);
        inner.next_id += 1;
        inner.clock += 1;
        let bytes = entry.byte_len();
        let last_used = inner.clock;
        inner.slots.insert(
            id.clone(),
            Slot {
                entry: Arc::new(entry),
                owner,
                bytes,
                last_used,
            },
        );
        inner.bytes += bytes;
        inner.stats.peak_bytes = inner.stats.peak_bytes.max(inner.bytes);
        inner.evict_over_budget(&id);
        id
    }

    /// The entry under `id`, shared. An operation holds the `Arc` while it runs, so an eviction
    /// or a drop meanwhile only releases the store's reference.
    pub fn get(&self, id: &str) -> Result<Arc<Entry>, StoreError> {
        let mut inner = self.lock();
        inner.clock += 1;
        let clock = inner.clock;
        match inner.slots.get_mut(id) {
            Some(slot) => {
                slot.last_used = clock;
                Ok(slot.entry.clone())
            }
            None => Err(inner.miss(id)),
        }
    }

    /// Who owns `id`. A result belongs to whoever owned its input.
    pub fn owner_of(&self, id: &str) -> Result<Owner, StoreError> {
        let mut inner = self.lock();
        match inner.slots.get(id) {
            Some(slot) => Ok(slot.owner.clone()),
            None => Err(inner.miss(id)),
        }
    }

    /// Removes `id` and returns its contents: without a copy when nothing else holds the entry,
    /// as a copy when an operation still does.
    pub fn take(&self, id: &str) -> Result<Entry, StoreError> {
        let shared = {
            let mut inner = self.lock();
            match inner.slots.remove(id) {
                Some(slot) => {
                    inner.bytes -= slot.bytes;
                    slot.entry
                }
                None => return Err(inner.miss(id)),
            }
        };
        Ok(Arc::try_unwrap(shared).unwrap_or_else(|still_shared| (*still_shared).clone()))
    }

    /// Drops these ids and returns how many were present. An id already gone is not an error:
    /// a drop in a `finally` must not fail because an eviction got there first.
    pub fn drop_ids<S: AsRef<str>>(&self, ids: &[S]) -> usize {
        let mut inner = self.lock();
        let mut dropped = 0;
        for id in ids {
            if let Some(slot) = inner.slots.remove(id.as_ref()) {
                inner.bytes -= slot.bytes;
                dropped += 1;
            }
        }
        dropped
    }

    /// Drops every entry of a frontend client other than `current`, and returns how many went.
    ///
    /// The frontend calls this once per page load: whatever an earlier load left behind (a
    /// reload mid-operation, a crash, a forgotten drop) has no one left to read it.
    pub fn drop_other_frontend_clients(&self, current: &str) -> usize {
        let mut inner = self.lock();
        let stale: Vec<String> = inner
            .slots
            .iter()
            .filter(|(_, slot)| match &slot.owner {
                Owner::Frontend(client) => client != current,
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in &stale {
            if let Some(slot) = inner.slots.remove(id) {
                inner.bytes -= slot.bytes;
            }
        }
        stale.len()
    }

    pub fn stats(&self) -> StoreStats {
        let inner = self.lock();
        StoreStats {
            entries: inner.slots.len(),
            bytes: inner.bytes,
            ..inner.stats.clone()
        }
    }
}

impl Inner {
    /// The error for an id that is not in the map, counting it when it was evicted.
    fn miss(&mut self, id: &str) -> StoreError {
        if self.evicted.contains(id) {
            self.stats.expired_reads += 1;
            StoreError::Expired(id.to_string())
        } else {
            StoreError::Unknown(id.to_string())
        }
    }

    /// Releases least-recently-used entries until the store fits its budget. The entry just put
    /// is never the one released, so a single mesh larger than the budget still goes through.
    fn evict_over_budget(&mut self, keep: &str) {
        while self.bytes > self.stats.budget_bytes {
            let victim = self
                .slots
                .iter()
                .filter(|(id, _)| id.as_str() != keep)
                .min_by_key(|(_, slot)| slot.last_used)
                .map(|(id, _)| id.clone());
            let Some(victim) = victim else { break };
            if let Some(slot) = self.slots.remove(&victim) {
                self.bytes -= slot.bytes;
            }
            self.stats.evictions += 1;
            log::warn!("[mesh_store] evicted {victim} to stay inside the budget");
            self.evicted.insert(victim.clone());
            self.evicted_order.push_back(victim);
            if self.evicted_order.len() > REMEMBERED_EVICTIONS {
                if let Some(oldest) = self.evicted_order.pop_front() {
                    self.evicted.remove(&oldest);
                }
            }
        }
    }
}

/// The process's store.
pub fn global() -> &'static MeshStore {
    static STORE: OnceLock<MeshStore> = OnceLock::new();
    STORE.get_or_init(|| MeshStore::new(DEFAULT_BUDGET_BYTES))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client(name: &str) -> Owner {
        Owner::Frontend(name.to_string())
    }

    fn soup(len: usize, fill: u8) -> Entry {
        Entry::Soup(vec![fill; len])
    }

    #[test]
    fn each_put_gets_its_own_id_and_reads_back_its_own_bytes() {
        let store = MeshStore::new(1 << 20);
        let a = store.put(client("c"), soup(36, 1));
        let b = store.put(client("c"), soup(72, 2));
        assert_ne!(a, b);
        assert_eq!(store.get(&a).unwrap().soup_bytes(), &[1u8; 36][..]);
        assert_eq!(store.get(&b).unwrap().soup_bytes(), &[2u8; 72][..]);
        assert_eq!(store.stats().entries, 2);
        assert_eq!(store.stats().bytes, 108);
    }

    #[test]
    fn a_dropped_id_is_unknown_and_a_second_drop_is_not_an_error() {
        let store = MeshStore::new(1 << 20);
        let a = store.put(client("c"), soup(36, 1));
        assert_eq!(store.drop_ids(&[a.clone()]), 1);
        assert_eq!(store.drop_ids(&[a.clone()]), 0);
        let err = store.get(&a).unwrap_err();
        assert_eq!(err.code(), "unknown");
        assert!(err.to_string().starts_with("mesh-store/unknown:"), "{err}");
        assert_eq!(store.stats().bytes, 0);
    }

    #[test]
    fn going_over_budget_releases_the_least_recently_used_entry_and_says_expired() {
        let store = MeshStore::new(100);
        let old = store.put(client("c"), soup(40, 1));
        let used = store.put(client("c"), soup(40, 2));
        // Reading `old` makes `used` the least recently used one.
        store.get(&old).unwrap();
        let new = store.put(client("c"), soup(40, 3));

        assert_eq!(store.get(&used).unwrap_err().code(), "expired");
        assert!(store.get(&old).is_ok());
        assert!(store.get(&new).is_ok());
        let stats = store.stats();
        assert_eq!(stats.evictions, 1);
        assert_eq!(stats.expired_reads, 1);
        assert_eq!(stats.bytes, 80);
        assert_eq!(stats.peak_bytes, 120);
    }

    #[test]
    fn a_mesh_larger_than_the_budget_is_still_stored() {
        let store = MeshStore::new(10);
        let big = store.put(client("c"), soup(36, 1));
        assert_eq!(store.get(&big).unwrap().soup_bytes().len(), 36);
    }

    #[test]
    fn an_operation_holding_an_entry_keeps_it_through_an_eviction() {
        let store = MeshStore::new(50);
        let a = store.put(client("c"), soup(40, 7));
        let held = store.get(&a).unwrap();
        store.put(client("c"), soup(40, 8));
        assert_eq!(store.get(&a).unwrap_err().code(), "expired");
        assert_eq!(held.soup_bytes(), &[7u8; 40][..]);
    }

    #[test]
    fn take_moves_the_bytes_out_when_nothing_else_holds_them() {
        let store = MeshStore::new(1 << 20);
        let a = store.put(client("c"), soup(36, 4));
        let ptr = store.get(&a).unwrap().soup_bytes().as_ptr();
        let taken = store.take(&a).unwrap().into_soup_bytes();
        assert_eq!(
            taken.as_ptr(),
            ptr,
            "take copied an entry nothing else held"
        );
        assert_eq!(store.get(&a).unwrap_err().code(), "unknown");
        assert_eq!(store.stats().bytes, 0);
    }

    #[test]
    fn take_copies_when_an_operation_still_holds_the_entry() {
        let store = MeshStore::new(1 << 20);
        let a = store.put(client("c"), soup(36, 5));
        let held = store.get(&a).unwrap();
        let taken = store.take(&a).unwrap().into_soup_bytes();
        assert_eq!(taken, vec![5u8; 36]);
        assert_eq!(held.soup_bytes(), &[5u8; 36][..]);
    }

    #[test]
    fn opening_a_frontend_client_drops_the_entries_of_earlier_ones() {
        let store = MeshStore::new(1 << 20);
        let stale = store.put(client("before-reload"), soup(36, 1));
        let current = store.put(client("now"), soup(36, 2));
        assert_eq!(store.drop_other_frontend_clients("now"), 1);
        assert_eq!(store.get(&stale).unwrap_err().code(), "unknown");
        assert!(store.get(&current).is_ok());
        assert_eq!(store.owner_of(&current).unwrap(), client("now"));
    }
}
