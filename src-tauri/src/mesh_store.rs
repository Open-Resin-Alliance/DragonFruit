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

use crate::hollow_source::HollowSource;

/// What an entry holds. A closed set: a reader asks for the kind it needs, and an id that
/// holds another kind fails with `wrong_kind`.
///
/// Indexed meshes and files are added with the operation family that first stores one.
#[derive(Clone, Debug)]
pub enum Entry {
    /// A triangle soup: little-endian `f32`, nine per triangle, the staging buffer's layout.
    Soup(Vec<u8>),
    /// An operation's output that is not a mesh, as raw little-endian bytes: voxel centres
    /// (`f32`, three per voxel) or voxel indices (`u32`). The command that returns its id says
    /// which.
    Buffer(Vec<u8>),
    /// What a long-lived operation keeps between calls, so each call does not rebuild it.
    Session(Session),
}

/// A session entry's state, one variant per operation family that keeps one.
#[derive(Clone, Debug)]
pub enum Session {
    /// A hollowing source: the parsed mesh and the voxel grid last built from it.
    Hollow(Arc<HollowSource>),
}

/// An entry's kind, for `wrong_kind` errors and for readers that accept more than one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryKind {
    Soup,
    Buffer,
    HollowSession,
}

impl EntryKind {
    pub fn as_str(self) -> &'static str {
        match self {
            EntryKind::Soup => "triangle soup",
            EntryKind::Buffer => "buffer",
            EntryKind::HollowSession => "hollow session",
        }
    }
}

impl Entry {
    pub fn kind(&self) -> EntryKind {
        match self {
            Entry::Soup(_) => EntryKind::Soup,
            Entry::Buffer(_) => EntryKind::Buffer,
            Entry::Session(Session::Hollow(_)) => EntryKind::HollowSession,
        }
    }

    fn byte_len(&self) -> usize {
        match self {
            Entry::Soup(bytes) | Entry::Buffer(bytes) => bytes.len(),
            Entry::Session(Session::Hollow(source)) => source.byte_len(),
        }
    }

    /// The soup's bytes, or `None` for another kind.
    pub fn soup_bytes(&self) -> Option<&[u8]> {
        match self {
            Entry::Soup(bytes) => Some(bytes),
            _ => None,
        }
    }

    /// The bytes of an entry that is plain bytes (a soup or a buffer), or `None` for a session.
    pub fn bytes(&self) -> Option<&[u8]> {
        match self {
            Entry::Soup(bytes) | Entry::Buffer(bytes) => Some(bytes),
            Entry::Session(_) => None,
        }
    }

    fn into_bytes(self) -> Option<Vec<u8>> {
        match self {
            Entry::Soup(bytes) | Entry::Buffer(bytes) => Some(bytes),
            Entry::Session(_) => None,
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
    /// The id holds another kind of entry than the reader asked for.
    WrongKind {
        id: String,
        expected: &'static str,
        found: EntryKind,
    },
}

impl StoreError {
    pub fn code(&self) -> &'static str {
        match self {
            StoreError::Expired(_) => "expired",
            StoreError::Unknown(_) => "unknown",
            StoreError::WrongKind { .. } => "wrong_kind",
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
            StoreError::WrongKind {
                id,
                expected,
                found,
            } => write!(
                f,
                "mesh-store/wrong_kind: '{id}' holds a {}, not a {expected}",
                found.as_str()
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

    /// The triangle soup under `id`, shared; `wrong_kind` when the id holds something else.
    /// A caller that got `Ok` can rely on `soup_bytes()` being `Some`.
    pub fn get_soup(&self, id: &str) -> Result<Arc<Entry>, StoreError> {
        let entry = self.get(id)?;
        match entry.kind() {
            EntryKind::Soup => Ok(entry),
            found => Err(wrong_kind(id, EntryKind::Soup.as_str(), found)),
        }
    }

    /// A copy of the bytes under `id`, which must be a soup or a buffer.
    pub fn read_bytes(&self, id: &str) -> Result<Vec<u8>, StoreError> {
        let entry = self.get(id)?;
        entry
            .bytes()
            .map(<[u8]>::to_vec)
            .ok_or_else(|| wrong_kind(id, BYTES_KINDS, entry.kind()))
    }

    /// Removes `id`, which must be a soup or a buffer, and returns its bytes as `take` does. An
    /// id of another kind is left where it is.
    pub fn take_bytes(&self, id: &str) -> Result<Vec<u8>, StoreError> {
        {
            let mut inner = self.lock();
            match inner.slots.get(id) {
                Some(slot) if slot.entry.bytes().is_none() => {
                    return Err(wrong_kind(id, BYTES_KINDS, slot.entry.kind()));
                }
                Some(_) => {}
                None => return Err(inner.miss(id)),
            }
        }
        let entry = self.take(id)?;
        let kind = entry.kind();
        entry
            .into_bytes()
            .ok_or_else(|| wrong_kind(id, BYTES_KINDS, kind))
    }

    /// The hollowing session under `id`.
    pub fn hollow_source(&self, id: &str) -> Result<Arc<HollowSource>, StoreError> {
        let entry = self.get(id)?;
        match &*entry {
            Entry::Session(Session::Hollow(source)) => Ok(source.clone()),
            other => Err(wrong_kind(
                id,
                EntryKind::HollowSession.as_str(),
                other.kind(),
            )),
        }
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

/// What `read_bytes` and `take_bytes` accept, as a `wrong_kind` error names it.
const BYTES_KINDS: &str = "triangle soup or buffer";

fn wrong_kind(id: &str, expected: &'static str, found: EntryKind) -> StoreError {
    StoreError::WrongKind {
        id: id.to_string(),
        expected,
        found,
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
        assert_eq!(store.get(&a).unwrap().soup_bytes(), Some(&[1u8; 36][..]));
        assert_eq!(store.get(&b).unwrap().soup_bytes(), Some(&[2u8; 72][..]));
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
        assert_eq!(
            store.get(&big).unwrap().soup_bytes().map(<[u8]>::len),
            Some(36)
        );
    }

    #[test]
    fn an_operation_holding_an_entry_keeps_it_through_an_eviction() {
        let store = MeshStore::new(50);
        let a = store.put(client("c"), soup(40, 7));
        let held = store.get(&a).unwrap();
        store.put(client("c"), soup(40, 8));
        assert_eq!(store.get(&a).unwrap_err().code(), "expired");
        assert_eq!(held.soup_bytes(), Some(&[7u8; 40][..]));
    }

    #[test]
    fn take_moves_the_bytes_out_when_nothing_else_holds_them() {
        let store = MeshStore::new(1 << 20);
        let a = store.put(client("c"), soup(36, 4));
        let ptr = store.get(&a).unwrap().soup_bytes().unwrap().as_ptr();
        let taken = store.take_bytes(&a).unwrap();
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
        let taken = store.take_bytes(&a).unwrap();
        assert_eq!(taken, vec![5u8; 36]);
        assert_eq!(held.soup_bytes(), Some(&[5u8; 36][..]));
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
    fn hollow_session() -> Entry {
        use dragonfruit_mesh_repair::{IndexedMesh, Vec3};
        let mesh = IndexedMesh {
            positions: vec![
                Vec3::new(0.0, 0.0, 0.0),
                Vec3::new(1.0, 0.0, 0.0),
                Vec3::new(0.0, 1.0, 0.0),
            ],
            triangles: vec![[0, 1, 2]],
        };
        Entry::Session(Session::Hollow(Arc::new(HollowSource::new(mesh))))
    }

    #[test]
    fn a_buffer_reads_back_as_bytes_but_is_not_a_soup() {
        let store = MeshStore::new(1 << 20);
        let id = store.put(client("c"), Entry::Buffer(vec![9u8; 12]));
        assert_eq!(store.read_bytes(&id).unwrap(), vec![9u8; 12]);
        let err = store.get_soup(&id).unwrap_err();
        assert_eq!(err.code(), "wrong_kind");
        assert!(
            err.to_string().starts_with("mesh-store/wrong_kind: '")
                && err.to_string().contains("holds a buffer"),
            "{err}"
        );
        assert_eq!(store.take_bytes(&id).unwrap(), vec![9u8; 12]);
        assert_eq!(store.stats().bytes, 0);
    }

    #[test]
    fn a_session_is_not_bytes_and_a_failed_take_leaves_it_in_place() {
        let store = MeshStore::new(1 << 20);
        let id = store.put(client("c"), hollow_session());
        assert_eq!(store.stats().bytes, 3 * 12 + 12);
        assert_eq!(store.read_bytes(&id).unwrap_err().code(), "wrong_kind");
        assert_eq!(store.take_bytes(&id).unwrap_err().code(), "wrong_kind");
        assert!(store.hollow_source(&id).is_ok());
    }

    #[test]
    fn a_soup_is_not_a_session() {
        let store = MeshStore::new(1 << 20);
        let id = store.put(client("c"), soup(36, 1));
        let err = store.hollow_source(&id).unwrap_err();
        assert_eq!(err.code(), "wrong_kind");
        assert!(err.to_string().contains("not a hollow session"), "{err}");
    }
}
