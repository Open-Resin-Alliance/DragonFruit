//! Sparse narrow-band distance field over a corner lattice.
//!
//! Corners are lattice points keyed `(i, j, k)` in an `AHashMap`; only
//! corners within `halfwidth` voxels of the surface are stored — dense grids
//! are forbidden (1024³ would be a billion voxels). Per corner we keep the
//! *unsigned* distance (f32) and a separate inside flag from the GWN sign
//! pass; hermite data is never stored here (computed per-crossing during
//! contouring and discarded).

use crate::core::bvh::Bvh;
use crate::core::mesh::{IndexedMesh, Vec3};
use crate::volumetric::gwn::WindingTree;
use rayon::prelude::*;

/// Failure modes of the volumetric track. Every variant is a *routing*
/// signal, not a panic: callers fall back down the escalation ladder.
#[derive(Debug, Clone, PartialEq)]
pub enum WrapError {
    /// Active corner count would exceed the memory budget.
    BudgetExceeded { needed: usize, budget: usize },
    /// No sign change found in the band — nothing to contour.
    EmptyExtraction,
    /// Output violated the manifold/watertight invariants.
    InvariantViolation(String),
    /// Output drifted too far from the input surface.
    FidelityRegression { max: f32, allowed: f32 },
}

impl std::fmt::Display for WrapError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WrapError::BudgetExceeded { needed, budget } => {
                write!(f, "band budget exceeded: needed ~{needed} corners, budget {budget}")
            }
            WrapError::EmptyExtraction => write!(f, "no sign change in band"),
            WrapError::InvariantViolation(s) => write!(f, "invariant violation: {s}"),
            WrapError::FidelityRegression { max, allowed } => {
                write!(f, "fidelity regression: max deviation {max} > allowed {allowed}")
            }
        }
    }
}

pub type CornerKey = (i32, i32, i32);

#[derive(Debug)]
pub struct SparseBand {
    /// Voxel edge length (mm).
    pub voxel: f32,
    /// World position of lattice point (0, 0, 0).
    pub origin: Vec3,
    /// Band half-width in voxels.
    pub halfwidth_voxels: f32,
    /// Corner key → index into the parallel arrays below.
    pub index: ahash::AHashMap<CornerKey, u32>,
    pub keys: Vec<CornerKey>,
    /// Unsigned distance to the input surface (always >= 0).
    pub dist: Vec<f32>,
    /// GWN classification (winding > 0.5). Morphological close mutates this;
    /// `dist` magnitudes stay valid because they are unsigned by design.
    pub inside: Vec<bool>,
}

impl SparseBand {
    #[inline]
    pub fn corner_pos(&self, key: CornerKey) -> Vec3 {
        Vec3::new(
            self.origin.x + key.0 as f32 * self.voxel,
            self.origin.y + key.1 as f32 * self.voxel,
            self.origin.z + key.2 as f32 * self.voxel,
        )
    }

    /// Signed field value at a stored corner index: negative inside.
    #[inline]
    pub fn signed_at(&self, idx: u32) -> f32 {
        let d = self.dist[idx as usize];
        if self.inside[idx as usize] {
            -d
        } else {
            d
        }
    }

    /// Signed field value by key, if stored. Missing corners are more than
    /// `halfwidth` voxels from the surface and therefore share the sign of
    /// every stored neighbor (crossings live within ~1 voxel of the surface)
    /// — callers must treat edges with a missing endpoint as non-crossing,
    /// never default the sign.
    #[inline]
    pub fn signed_by_key(&self, key: CornerKey) -> Option<f32> {
        self.index.get(&key).map(|&i| self.signed_at(i))
    }

    pub fn len(&self) -> usize {
        self.keys.len()
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }
}

pub struct BandParams {
    pub voxel: f32,
    pub halfwidth_voxels: f32,
    /// Hard cap on stored corners; exceeding it aborts the build.
    pub max_corners: usize,
}

/// Build the narrow-band unsigned distance field around `mesh`.
/// `bvh` must be built over the same mesh (it is reused for hermite normals,
/// reprojection, and the fidelity gate by later stages).
pub fn build_narrow_band(
    mesh: &IndexedMesh,
    bvh: &Bvh,
    params: &BandParams,
) -> Result<SparseBand, WrapError> {
    let voxel = params.voxel;
    let band_mm = params.halfwidth_voxels * voxel;
    let bbox = mesh.bbox();
    // Fractional offset keeps lattice planes off axis-aligned input faces so
    // corner distances never land exactly on 0 (whose f32 sign bit would be
    // ambiguous for crossing detection).
    let origin = Vec3::new(
        bbox.min.x - band_mm - 0.371_237 * voxel,
        bbox.min.y - band_mm - 0.618_034 * voxel,
        bbox.min.z - band_mm - 0.267_949 * voxel,
    );

    // Cheap pre-estimate so a pathological input aborts before allocating.
    // Model the band as a shell of thickness `2·band_mm` around the surface:
    // stored corners ≈ surface_area / voxel² × (band thickness in layers).
    // (The old per-triangle box-sum over-counted catastrophically for thick
    // bands — each triangle's inflated AABB overlaps its neighbours far more
    // than a fixed slack factor captures — and aborted on bands that easily
    // fit.) A 2× cushion covers curvature / non-uniform tessellation.
    let total_area: f64 = (0..mesh.triangle_count() as u32)
        .into_par_iter()
        .map(|f| mesh.tri_area(f) as f64)
        .sum();
    // This estimates the *final* stored corner count. The transient seeded
    // superset (box corners beyond the band, before distance filtering) is
    // larger and is caught by the `seeded.len() > max_corners` guard below;
    // `wrap_cluster` keeps the estimate to ~half the budget so that superset
    // still fits.
    let band_layers = 2.0 * params.halfwidth_voxels as f64 + 1.0;
    let est_corners = total_area / (voxel as f64 * voxel as f64) * band_layers;
    if est_corners > params.max_corners as f64 {
        return Err(WrapError::BudgetExceeded {
            needed: est_corners as usize,
            budget: params.max_corners,
        });
    }

    // Seed candidate corners: every lattice point inside a triangle's AABB
    // inflated by the band width. Parallel fold into per-thread sets, then
    // union.
    let seeded: ahash::AHashSet<CornerKey> = (0..mesh.triangle_count() as u32)
        .into_par_iter()
        .fold(ahash::AHashSet::new, |mut set, f| {
            let [a, b, c] = mesh.tri_positions(f);
            let bb_min = a.min(b).min(c).sub(Vec3::new(band_mm, band_mm, band_mm));
            let bb_max = a.max(b).max(c).add(Vec3::new(band_mm, band_mm, band_mm));
            let i0 = ((bb_min.x - origin.x) / voxel).floor() as i32;
            let j0 = ((bb_min.y - origin.y) / voxel).floor() as i32;
            let k0 = ((bb_min.z - origin.z) / voxel).floor() as i32;
            let i1 = ((bb_max.x - origin.x) / voxel).ceil() as i32;
            let j1 = ((bb_max.y - origin.y) / voxel).ceil() as i32;
            let k1 = ((bb_max.z - origin.z) / voxel).ceil() as i32;
            for i in i0..=i1 {
                for j in j0..=j1 {
                    for k in k0..=k1 {
                        set.insert((i, j, k));
                    }
                }
            }
            set
        })
        .reduce(ahash::AHashSet::new, |mut a, b| {
            if a.len() < b.len() {
                return reduce_into(b, a);
            }
            a.extend(b);
            a
        });

    if seeded.len() > params.max_corners {
        return Err(WrapError::BudgetExceeded {
            needed: seeded.len(),
            budget: params.max_corners,
        });
    }

    // Parallel distance pass; drop corners beyond the band (AABB inflation
    // seeds a box, so box-corner lattice points routinely exceed it).
    let min_dist = 1e-6 * voxel;
    let seeded: Vec<CornerKey> = seeded.into_iter().collect();
    let mut entries: Vec<(CornerKey, f32)> = seeded
        .into_par_iter()
        .filter_map(|key| {
            let p = Vec3::new(
                origin.x + key.0 as f32 * voxel,
                origin.y + key.1 as f32 * voxel,
                origin.z + key.2 as f32 * voxel,
            );
            let (d2, _, _) = bvh.closest_point(mesh, p);
            let d = d2.sqrt();
            if d <= band_mm {
                Some((key, d.max(min_dist)))
            } else {
                None
            }
        })
        .collect();
    // Deterministic layout regardless of thread scheduling.
    entries.par_sort_unstable_by_key(|(k, _)| *k);

    let mut index = ahash::AHashMap::with_capacity(entries.len());
    let mut keys = Vec::with_capacity(entries.len());
    let mut dist = Vec::with_capacity(entries.len());
    for (i, (key, d)) in entries.iter().enumerate() {
        index.insert(*key, i as u32);
        keys.push(*key);
        dist.push(*d);
    }
    let inside = vec![false; keys.len()];
    Ok(SparseBand {
        voxel,
        origin,
        halfwidth_voxels: params.halfwidth_voxels,
        index,
        keys,
        dist,
        inside,
    })
}

fn reduce_into(
    mut big: ahash::AHashSet<CornerKey>,
    small: ahash::AHashSet<CornerKey>,
) -> ahash::AHashSet<CornerKey> {
    big.extend(small);
    big
}

/// Classify every band corner inside/outside via the winding tree
/// (winding > 0.5 = inside). Parallel over corners.
pub fn apply_sign(band: &mut SparseBand, tree: &WindingTree) {
    let voxel = band.voxel;
    let origin = band.origin;
    let flags: Vec<bool> = band
        .keys
        .par_iter()
        .map(|key| {
            let p = Vec3::new(
                origin.x + key.0 as f32 * voxel,
                origin.y + key.1 as f32 * voxel,
                origin.z + key.2 as f32 * voxel,
            );
            tree.winding(p) > 0.5
        })
        .collect();
    band.inside = flags;
}
