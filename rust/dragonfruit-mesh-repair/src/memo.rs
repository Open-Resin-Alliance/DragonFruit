//! A short memory for the questions the pipeline asks about a mesh more than once.
//!
//! `evaluate` and `analyze` are pure functions of a mesh, and the pipeline asks them the same
//! question about the same mesh over and over: every guarded pass weighs the mesh it just changed
//! against the one it started from, the next pass's "before" is that same mesh, and the report's
//! post verdict often describes a mesh that never moved. Measured on `poussin.stl`, structure
//! building is 21 halfedge builds and 934 ms of a 2008 ms run, and 13 of those builds come from
//! `evaluate` alone.
//!
//! What is remembered is the verdict, which is a handful of integers, not the topology it was built
//! from, which is tens of megabytes. The key covers the whole mesh, so a hit is only ever a verdict
//! for exactly this mesh.

use std::hash::{BuildHasher, Hash, Hasher};

use crate::core::mesh::IndexedMesh;

/// A mesh's identity: the shape of its buffers and two independent hashes of their contents.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct MeshKey {
    vertices: usize,
    triangles: usize,
    first: u64,
    second: u64,
}

/// Two hashers fed in one pass over the mesh.
///
/// Two because one is a coin that could land the same way twice, and the second is what makes a
/// verdict for the wrong mesh not worth thinking about. Both are swept in the same pass, so the
/// second costs a little arithmetic and no extra memory traffic.
pub(crate) fn mesh_key(mesh: &IndexedMesh) -> MeshKey {
    let mut first =
        ahash::RandomState::with_seeds(0x9E37_79B9, 0x7F4A_7C15, 0x85EB_CA6B, 0xC2B2_AE35)
            .build_hasher();
    let mut second =
        ahash::RandomState::with_seeds(0x27D4_EB2F, 0x1656_67B1, 0xFD70_4919, 0x8EBC_6AF0)
            .build_hasher();
    for p in &mesh.positions {
        let bits = [p.x.to_bits(), p.y.to_bits(), p.z.to_bits()];
        bits.hash(&mut first);
        bits.hash(&mut second);
    }
    for t in &mesh.triangles {
        t.hash(&mut first);
        t.hash(&mut second);
    }
    MeshKey {
        vertices: mesh.positions.len(),
        triangles: mesh.triangles.len(),
        first: first.finish(),
        second: second.finish(),
    }
}

/// The last few answers, keyed by the mesh they were answers about.
///
/// Three rather than one because the pipeline holds that many states at a time: the mesh a pass
/// started from, the mesh it produced, and now and then a candidate being judged against both.
pub(crate) struct Memo<T> {
    slots: [(Option<MeshKey>, Option<T>); 3],
    next: usize,
}

impl<T: Clone> Memo<T> {
    pub(crate) const fn new() -> Self {
        Memo {
            slots: [(None, None), (None, None), (None, None)],
            next: 0,
        }
    }

    pub(crate) fn get(&self, key: &MeshKey) -> Option<T> {
        self.slots
            .iter()
            .find(|(k, _)| k.as_ref() == Some(key))
            .and_then(|(_, value)| value.clone())
    }

    /// Overwrite the oldest slot. A miss is a slot the caller was about to recompute anyway.
    pub(crate) fn put(&mut self, key: MeshKey, value: T) {
        self.slots[self.next] = (Some(key), Some(value));
        self.next = (self.next + 1) % self.slots.len();
    }
}
