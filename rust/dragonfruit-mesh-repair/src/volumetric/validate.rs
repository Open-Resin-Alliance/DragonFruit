//! Post-stage validation gates for the volumetric track.
//!
//! Two hard invariants after *every* stage, not just at the end: every edge
//! shared by exactly two faces (manifold, coherently wound) and zero
//! boundary edges (watertight). Plus a two-sided fidelity check against the
//! input: input→output distance catches *missing* geometry, output→input
//! catches *hallucinated* geometry. A failed gate never ships — callers fall
//! back down the escalation ladder.

use crate::core::bvh::Bvh;
use crate::core::halfedge::Topology;
use crate::core::mesh::{IndexedMesh, Vec3};
use crate::volumetric::band::WrapError;
use crate::volumetric::gwn::WindingTree;
use rayon::prelude::*;

/// Manifold + watertight + coherent outward orientation.
pub fn validate_invariants(mesh: &IndexedMesh) -> Result<(), WrapError> {
    if mesh.triangle_count() < 4 {
        return Err(WrapError::InvariantViolation(format!(
            "degenerate output: {} triangles",
            mesh.triangle_count()
        )));
    }
    let topo = Topology::build(mesh);
    let boundary = topo.boundary_edges().len();
    if boundary != 0 {
        return Err(WrapError::InvariantViolation(format!(
            "{boundary} boundary edges"
        )));
    }
    let nme = topo.non_manifold_edges().len();
    if nme != 0 {
        return Err(WrapError::InvariantViolation(format!(
            "{nme} non-manifold edges"
        )));
    }
    let flipped = topo.inconsistent_edges();
    if flipped != 0 {
        return Err(WrapError::InvariantViolation(format!(
            "{flipped} inconsistently wound edges"
        )));
    }
    if mesh.signed_volume() <= 0.0 {
        return Err(WrapError::InvariantViolation(
            "non-positive signed volume (inverted orientation)".into(),
        ));
    }
    Ok(())
}

/// Deterministic area-weighted surface samples (LCG; no rand dependency).
pub fn area_weighted_samples(mesh: &IndexedMesh, n: usize, seed: u64) -> Vec<(Vec3, u32)> {
    let mut cumulative: Vec<f64> = Vec::with_capacity(mesh.triangle_count());
    let mut total = 0.0f64;
    for f in 0..mesh.triangle_count() as u32 {
        total += mesh.tri_area(f) as f64;
        cumulative.push(total);
    }
    if total <= 0.0 {
        return Vec::new();
    }
    let mut state = seed.max(1);
    let mut next = || {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (state >> 11) as f64 / (1u64 << 53) as f64
    };
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let target = next() * total;
        let fi = cumulative.partition_point(|&c| c < target).min(cumulative.len() - 1) as u32;
        let [a, b, c] = mesh.tri_positions(fi);
        // Uniform barycentric.
        let (mut r1, r2) = (next() as f32, next() as f32);
        r1 = r1.sqrt();
        let (w0, w1, w2) = (1.0 - r1, r1 * (1.0 - r2), r1 * r2);
        out.push((
            Vec3::new(
                a.x * w0 + b.x * w1 + c.x * w2,
                a.y * w0 + b.y * w1 + c.y * w2,
                a.z * w0 + b.z * w1 + c.z * w2,
            ),
            fi,
        ));
    }
    out
}

pub struct FidelityReport {
    pub in_to_out_max: f32,
    pub in_to_out_mean: f32,
    pub out_to_in_max: f32,
    pub samples_used: usize,
}

/// Two-sided fidelity gate.
///
/// * input→output (`max <= in_to_out_limit`): every *exterior* input surface
///   point must have output nearby, or geometry went missing. A sample is
///   "exterior" when the winding field flips across it (one side inside, one
///   outside, probed at `probe_eps` along the face normal — robust to the
///   triangle's own winding). Buried overlap walls and enclosed debris have
///   both sides inside; those surfaces are *supposed* to disappear.
/// * output→input (`max <= out_to_in_limit`): output must stay within the
///   band of real input geometry. Extraction only happens in stored band
///   cells, so anything farther is a solver bug (escaped vertex, QEF
///   blow-up). Sealed holes pass: the soap-film patch still lies within the
///   band of the hole rim.
pub fn fidelity_check(
    input: &IndexedMesh,
    input_bvh: &Bvh,
    input_tree: &WindingTree,
    output: &IndexedMesh,
    probe_eps: f32,
    in_to_out_limit: f32,
    out_to_in_limit: f32,
) -> Result<FidelityReport, WrapError> {
    let output_bvh = Bvh::build(output);
    let samples = area_weighted_samples(input, 2000, 0x5EED_CAFE);

    let dists: Vec<f32> = samples
        .par_iter()
        .filter_map(|&(p, f)| {
            let n = input.tri_normal(f);
            if n == Vec3::ZERO {
                return None;
            }
            let w_plus = input_tree.winding(p.add(n.scale(probe_eps)));
            let w_minus = input_tree.winding(p.sub(n.scale(probe_eps)));
            if (w_plus > 0.5) == (w_minus > 0.5) {
                return None; // buried wall or enclosed debris
            }
            let (d2, _, _) = output_bvh.closest_point(output, p);
            Some(d2.sqrt())
        })
        .collect();
    let samples_used = dists.len();
    let (mut max_in, mut sum_in) = (0.0f32, 0.0f64);
    for d in &dists {
        max_in = max_in.max(*d);
        sum_in += *d as f64;
    }
    let mean_in = if samples_used > 0 {
        (sum_in / samples_used as f64) as f32
    } else {
        0.0
    };

    let max_out = output
        .positions
        .par_iter()
        .map(|&p| input_bvh.closest_point(input, p).0.sqrt())
        .reduce(|| 0.0f32, f32::max);

    let report = FidelityReport {
        in_to_out_max: max_in,
        in_to_out_mean: mean_in,
        out_to_in_max: max_out,
        samples_used,
    };
    if max_in > in_to_out_limit {
        return Err(WrapError::FidelityRegression {
            max: max_in,
            allowed: in_to_out_limit,
        });
    }
    if max_out > out_to_in_limit {
        return Err(WrapError::FidelityRegression {
            max: max_out,
            allowed: out_to_in_limit,
        });
    }
    Ok(report)
}

/// Resolve residual geometric self-intersections by relaxing only the
/// involved vertices toward their one-ring centroid. Position-only, so
/// watertightness/manifoldness are untouched; moves are voxel-scale and the
/// fidelity gate still runs after. DC placement is not provably
/// intersection-free — isolated folded quads (a handful per hundred thousand
/// triangles) are a known artifact, and this converges in a round or two.
/// Returns true when no intersections remain.
pub fn relax_self_intersections(mesh: &mut IndexedMesh, max_rounds: usize) -> bool {
    for _ in 0..max_rounds {
        let pairs = crate::analysis::self_intersection_pairs(mesh);
        if pairs.is_empty() {
            return true;
        }
        // One-ring adjacency, built lazily only when needed.
        let mut neighbors: Vec<smallvec::SmallVec<[u32; 8]>> =
            vec![smallvec::SmallVec::new(); mesh.positions.len()];
        for t in &mesh.triangles {
            for &(a, b) in &[(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
                if !neighbors[a as usize].contains(&b) {
                    neighbors[a as usize].push(b);
                }
                if !neighbors[b as usize].contains(&a) {
                    neighbors[b as usize].push(a);
                }
            }
        }
        let mut affected: Vec<u32> = Vec::new();
        for (f, g) in &pairs {
            affected.extend_from_slice(&mesh.triangles[*f as usize]);
            affected.extend_from_slice(&mesh.triangles[*g as usize]);
        }
        affected.sort_unstable();
        affected.dedup();
        let moved: Vec<(u32, Vec3)> = affected
            .iter()
            .filter_map(|&v| {
                let nbrs = &neighbors[v as usize];
                if nbrs.len() < 3 {
                    return None;
                }
                let mut c = Vec3::ZERO;
                for &w in nbrs {
                    c = c.add(mesh.positions[w as usize]);
                }
                c = c.scale(1.0 / nbrs.len() as f32);
                let p = mesh.positions[v as usize];
                Some((v, p.add(c.sub(p).scale(0.6))))
            })
            .collect();
        for (v, p) in moved {
            mesh.positions[v as usize] = p;
        }
    }
    crate::analysis::self_intersection_pairs(mesh).is_empty()
}

/// Fraction of the surface thinner than `min_thickness` (wall-thickness
/// probe). Samples area-weighted points, orients the local normal outward
/// via the winding field, and marches inward until the winding drops back
/// below 0.5 (exited through the far wall).
pub fn thin_wall_fraction(
    mesh: &IndexedMesh,
    tree: &WindingTree,
    min_thickness: f32,
    probe_step: f32,
) -> f32 {
    let samples = area_weighted_samples(mesh, 200, 0x7411_3A11);
    if samples.is_empty() {
        return 0.0;
    }
    let thin = samples
        .par_iter()
        .filter(|&&(p, f)| {
            let n = mesh.tri_normal(f);
            if n == Vec3::ZERO {
                return false;
            }
            // Orient outward: winding drops along the outward normal.
            let eps = probe_step * 0.5;
            let w_plus = tree.winding(p.add(n.scale(eps)));
            let w_minus = tree.winding(p.sub(n.scale(eps)));
            let inward = if w_plus < w_minus { n.scale(-1.0) } else { n };
            // March inward: still inside at min_thickness ⇒ thick enough.
            let steps = (min_thickness / probe_step).ceil() as usize;
            for s in 1..=steps {
                let q = p.add(inward.scale(probe_step * s as f32));
                if tree.winding(q) < 0.5 {
                    return true; // exited before reaching min thickness
                }
            }
            false
        })
        .count();
    thin as f32 / samples.len() as f32
}
