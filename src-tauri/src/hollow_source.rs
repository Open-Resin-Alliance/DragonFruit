//! A hollowing session's state, held in the native mesh store as `Entry::Session`.
//!
//! Hollowing is previewed many times over one mesh while the user drags a slider. Parsing the
//! mesh and building its voxel grid is the expensive part, and neither changes until the
//! resolution or the rotation does, so a session keeps both between calls. It used to live in
//! process-wide slots that held one session for the whole app; as a store entry, each session is
//! named by its id and two of them never see each other's mesh.
//!
//! No Tauri types here, so `cargo test` drives it directly.

use std::fmt;
use std::sync::{Arc, Mutex};

use dragonfruit_mesh_repair::{HollowSession, IndexedMesh};

/// The source mesh a hollowing session was opened on, and the voxel grid last built from it.
///
/// The session keeps its own parsed copy of the source, so the stored mesh it was opened from
/// can be dropped as soon as it is open.
pub struct HollowSource {
    mesh: IndexedMesh,
    grid: Mutex<Option<Arc<HollowSession>>>,
}

impl HollowSource {
    pub fn new(mesh: IndexedMesh) -> Self {
        Self {
            mesh,
            grid: Mutex::new(None),
        }
    }

    /// What the store counts for this entry: the parsed source. The voxel grid is not counted
    /// yet; it is built on first use and its size depends on the resolution.
    pub fn byte_len(&self) -> usize {
        self.mesh.positions.len() * 12 + self.mesh.triangles.len() * 12
    }

    /// The voxel session for this resolution and rotation, reusing the last one when neither
    /// changed. Building one is slow, so call this off the async runtime. Two calls on the same
    /// source wait for each other rather than build the same grid twice.
    pub fn session_for(
        &self,
        voxel_resolution: u16,
        rotation_quat: [f32; 4],
    ) -> Arc<HollowSession> {
        // A panic while building leaves the slot as it was, so a poisoned lock is still usable.
        let mut grid = self
            .grid
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(session) = grid.as_ref() {
            if session.voxel_resolution() == voxel_resolution
                && session.rotation_quat() == rotation_quat
            {
                return session.clone();
            }
        }
        let session = Arc::new(HollowSession::with_rotation(
            self.mesh.clone(),
            voxel_resolution,
            rotation_quat,
        ));
        *grid = Some(session.clone());
        session
    }
}

impl fmt::Debug for HollowSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HollowSource")
            .field("triangles", &self.mesh.triangles.len())
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dragonfruit_mesh_repair::Vec3;

    fn cube() -> IndexedMesh {
        let positions = [
            [0.0, 0.0, 0.0],
            [10.0, 0.0, 0.0],
            [10.0, 10.0, 0.0],
            [0.0, 10.0, 0.0],
            [0.0, 0.0, 10.0],
            [10.0, 0.0, 10.0],
            [10.0, 10.0, 10.0],
            [0.0, 10.0, 10.0],
        ]
        .into_iter()
        .map(|[x, y, z]| Vec3::new(x, y, z))
        .collect();
        let triangles = vec![
            [0, 2, 1],
            [0, 3, 2],
            [4, 5, 6],
            [4, 6, 7],
            [0, 1, 5],
            [0, 5, 4],
            [1, 2, 6],
            [1, 6, 5],
            [2, 3, 7],
            [2, 7, 6],
            [3, 0, 4],
            [3, 4, 7],
        ];
        IndexedMesh {
            positions,
            triangles,
        }
    }

    const IDENTITY: [f32; 4] = [0.0, 0.0, 0.0, 1.0];

    #[test]
    fn the_grid_is_reused_until_the_resolution_or_rotation_changes() {
        let source = HollowSource::new(cube());
        let first = source.session_for(24, IDENTITY);
        assert!(Arc::ptr_eq(&first, &source.session_for(24, IDENTITY)));

        let finer = source.session_for(32, IDENTITY);
        assert!(!Arc::ptr_eq(&first, &finer));
        assert_eq!(finer.voxel_resolution(), 32);

        let turned = [
            0.0,
            0.0,
            std::f32::consts::FRAC_1_SQRT_2,
            std::f32::consts::FRAC_1_SQRT_2,
        ];
        let rotated = source.session_for(32, turned);
        assert!(!Arc::ptr_eq(&finer, &rotated));
        assert_eq!(rotated.rotation_quat(), turned);
    }

    #[test]
    fn the_store_counts_the_parsed_source() {
        let source = HollowSource::new(cube());
        assert_eq!(source.byte_len(), 8 * 12 + 12 * 12);
    }
}
