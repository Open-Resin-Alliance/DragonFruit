//! Ask the SURFACE whether a cut could ever work.
//!
//! A seam is a curve lying on the skin, and "do these loops enclose a piece" is a
//! question about the surface, not about any cutter: mark the faces the seam runs
//! through, take them away, and see whether what is left falls apart. No boolean,
//! no epsilon, no cutter that has to land exactly on the skin.
//!
//! It answers a question the boolean cannot even ask. A loop drawn round a
//! tentacle that leaves the body and fuses back to it encircles a HANDLE, and a
//! curve round a handle does not separate a surface — so no cutter of any shape
//! can free that piece, and every attempt was doomed before a triangle moved.
//! Telling the user to nudge the waypoints, as the cut used to, is worse than
//! useless there: the seam was never the problem.
//!
//! Only asked once a cut has already failed, to say why. The happy path never
//! pays for it.

use ahash::{AHashMap, AHashSet};
use dragonfruit_mesh_core::bvh::Bvh;
use dragonfruit_mesh_core::mesh::{Aabb, IndexedMesh, Vec3};

use crate::membrane::closest_on_tri;

/// What the surface says about a set of seams.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SeamVerdict {
    /// The seams cut the surface in two: a piece of this many faces is enclosed,
    /// so a cut along them can free it — something else went wrong.
    Enclosed { piece_faces: usize },
    /// Taking the seams away leaves the surface in one piece. Nothing they
    /// encircle can come free, however it is cut.
    NotSeparating,
    /// The mesh is too coarse here for the question to mean anything: the barrier
    /// is one face wide, and on faces this big it swallows the body it was meant
    /// to divide. The caller should say nothing rather than something wrong.
    TooCoarse,
}

/// Faces smaller than this do not count as an enclosed piece: a handful of them
/// is a sliver the band's own width carved off, not something to free.
const MIN_PIECE_FACES: usize = 32;

/// Do `loops`, taken together, enclose a piece of `mesh`?
pub fn seams_enclose_a_piece(mesh: &IndexedMesh, loops: &[Vec<Vec3>]) -> SeamVerdict {
    if mesh.triangles.is_empty() {
        return SeamVerdict::NotSeparating;
    }
    let edge = median_edge_length(mesh);
    let mut band = AHashSet::new();
    for lp in loops.iter().filter(|l| l.len() >= 3) {
        band.extend(seam_band(mesh, lp, edge * 0.3, edge * 0.75));
    }
    if band.is_empty() {
        return SeamVerdict::NotSeparating;
    }
    if band.len() * 2 > mesh.triangles.len() {
        return SeamVerdict::TooCoarse;
    }

    // Only components that TOUCH the band can have been separated by it; anything
    // else is a shell the model already carried.
    let mut pieces: Vec<usize> = components_touching_band(mesh, &band)
        .into_iter()
        .filter(|n| *n >= MIN_PIECE_FACES)
        .collect();
    pieces.sort_unstable();
    match pieces.len() {
        0 | 1 => SeamVerdict::NotSeparating,
        _ => SeamVerdict::Enclosed { piece_faces: pieces[0] },
    }
}

/// A representative edge length, so the seam can be sampled finely enough that
/// consecutive samples never skip a face.
fn median_edge_length(mesh: &IndexedMesh) -> f32 {
    let stride = (mesh.triangles.len() / 2000).max(1);
    let mut lengths: Vec<f32> = mesh
        .triangles
        .iter()
        .step_by(stride)
        .map(|t| mesh.positions[t[1] as usize].sub(mesh.positions[t[0] as usize]).length())
        .filter(|l| *l > 0.0)
        .collect();
    if lengths.is_empty() {
        return 1.0;
    }
    lengths.sort_by(|a, b| a.partial_cmp(b).unwrap());
    lengths[lengths.len() / 2]
}

/// The faces the seam runs through: every face within `reach` of a sample taken
/// every `step` along the polyline.
///
/// Marking only the NEAREST face leaves a porous barrier — wherever the seam
/// brushes past a vertex the nearest face jumps, and the two faces it jumped
/// between share only that vertex, so a walk slips through the gap between them.
/// A barrier has to be at least one face wide to be a barrier.
fn seam_band(mesh: &IndexedMesh, loop_pts: &[Vec3], step: f32, reach: f32) -> AHashSet<u32> {
    let bvh = Bvh::build(mesh);
    let mut band = AHashSet::new();
    let n = loop_pts.len();
    for i in 0..n {
        let (a, b) = (loop_pts[i], loop_pts[(i + 1) % n]);
        let seg = b.sub(a);
        let steps = ((seg.length() / step.max(1e-4)).ceil() as usize).max(1);
        for s in 0..steps {
            let p = a.add(seg.scale(s as f32 / steps as f32));
            faces_within(&bvh, mesh, p, reach, &mut band);
        }
    }
    band
}

/// Every face with a point within `reach` of `p`.
fn faces_within(bvh: &Bvh, mesh: &IndexedMesh, p: Vec3, reach: f32, out: &mut AHashSet<u32>) {
    let query = Aabb {
        min: Vec3::new(p.x - reach, p.y - reach, p.z - reach),
        max: Vec3::new(p.x + reach, p.y + reach, p.z + reach),
    };
    let r2 = reach * reach;
    bvh.query_aabb(&query, |ti| {
        let t = &mesh.triangles[ti as usize];
        let (_, d2) = closest_on_tri(
            p,
            mesh.positions[t[0] as usize],
            mesh.positions[t[1] as usize],
            mesh.positions[t[2] as usize],
        );
        if d2 <= r2 {
            out.insert(ti);
        }
    });
}

/// Sizes of the connected components of the face graph with `band` removed,
/// keeping only those that touch the band — the ones the seams could have cut.
pub fn components_touching_band(mesh: &IndexedMesh, band: &AHashSet<u32>) -> Vec<usize> {
    let mut edge_faces: AHashMap<(u32, u32), Vec<u32>> = AHashMap::new();
    for (fi, t) in mesh.triangles.iter().enumerate() {
        for k in 0..3 {
            let (a, b) = (t[k], t[(k + 1) % 3]);
            let key = if a < b { (a, b) } else { (b, a) };
            edge_faces.entry(key).or_default().push(fi as u32);
        }
    }
    // Face by face, not by iterating the map — see `Topology::build`.
    let mut neighbours: Vec<Vec<u32>> = vec![Vec::new(); mesh.triangles.len()];
    for (fi, t) in mesh.triangles.iter().enumerate() {
        for k in 0..3 {
            let (a, b) = (t[k], t[(k + 1) % 3]);
            let key = if a < b { (a, b) } else { (b, a) };
            for &g in &edge_faces[&key] {
                if g != fi as u32 {
                    neighbours[fi].push(g);
                }
            }
        }
    }

    let mut seen = vec![false; mesh.triangles.len()];
    let mut sizes = Vec::new();
    for start in 0..mesh.triangles.len() as u32 {
        if seen[start as usize] || band.contains(&start) {
            continue;
        }
        let mut size = 0usize;
        let mut touches_band = false;
        let mut queue = std::collections::VecDeque::from([start]);
        seen[start as usize] = true;
        while let Some(f) = queue.pop_front() {
            size += 1;
            for &n in &neighbours[f as usize] {
                if band.contains(&n) {
                    touches_band = true;
                } else if !seen[n as usize] {
                    seen[n as usize] = true;
                    queue.push_back(n);
                }
            }
        }
        if touches_band {
            sizes.push(size);
        }
    }
    sizes
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A cube, two triangles per face.
    fn cube(size: f32) -> IndexedMesh {
        let s = size;
        let positions = vec![
            Vec3::new(0.0, 0.0, 0.0), Vec3::new(s, 0.0, 0.0), Vec3::new(s, s, 0.0), Vec3::new(0.0, s, 0.0),
            Vec3::new(0.0, 0.0, s), Vec3::new(s, 0.0, s), Vec3::new(s, s, s), Vec3::new(0.0, s, s),
        ];
        let triangles = vec![
            [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
            [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
            [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
        ];
        IndexedMesh { positions, triangles }
    }

    /// A torus — the shape a tentacle makes when it leaves the body and fuses
    /// back to it.
    fn torus(major: f32, minor: f32, around: usize, tube: usize) -> IndexedMesh {
        let mut positions = Vec::new();
        for i in 0..around {
            let u = i as f32 / around as f32 * std::f32::consts::TAU;
            for j in 0..tube {
                let v = j as f32 / tube as f32 * std::f32::consts::TAU;
                let r = major + minor * v.cos();
                positions.push(Vec3::new(r * u.cos(), r * u.sin(), minor * v.sin()));
            }
        }
        let idx = |i: usize, j: usize| ((i % around) * tube + (j % tube)) as u32;
        let mut triangles = Vec::new();
        for i in 0..around {
            for j in 0..tube {
                triangles.push([idx(i, j), idx(i + 1, j), idx(i + 1, j + 1)]);
                triangles.push([idx(i, j), idx(i + 1, j + 1), idx(i, j + 1)]);
            }
        }
        IndexedMesh { positions, triangles }
    }

    /// A ring round the torus's tube at `angle` — the loop a user draws to lop a
    /// tentacle off.
    fn tube_ring(major: f32, minor: f32, angle: f32, steps: usize) -> Vec<Vec3> {
        (0..steps)
            .map(|j| {
                let v = j as f32 / steps as f32 * std::f32::consts::TAU;
                let r = major + minor * v.cos();
                Vec3::new(r * angle.cos(), r * angle.sin(), minor * v.sin())
            })
            .collect()
    }

    #[test]
    fn a_loop_on_the_surface_encloses_the_cap_it_draws() {
        // The ordinary case: a small closed loop drawn on the skin bounds a patch,
        // so a cut along it can free that patch.
        let model = torus(10.0, 3.0, 64, 32);
        let centre = 0.0f32;
        let patch: Vec<Vec3> = (0..64)
            .map(|k| {
                let a = k as f32 / 64.0 * std::f32::consts::TAU;
                let (u, v) = (centre + 0.7 * a.cos(), 1.3 * a.sin());
                let r = 10.0 + 3.0 * v.cos();
                Vec3::new(r * u.cos(), r * u.sin(), 3.0 * v.sin())
            })
            .collect();
        assert!(
            matches!(seams_enclose_a_piece(&model, &[patch]), SeamVerdict::Enclosed { .. }),
            "a loop drawn on the skin encloses the patch inside it",
        );
    }

    #[test]
    fn a_mesh_too_coarse_for_the_seam_says_so() {
        // A cube of 12 huge triangles: a barrier one face wide swallows the whole
        // body, so the honest answer is "I cannot tell", not "nothing separates".
        let model = cube(10.0);
        let seam: Vec<Vec3> = (0..40)
            .map(|k| {
                let t = (k % 10) as f32;
                match k / 10 {
                    0 => Vec3::new(t, 0.0, 5.0),
                    1 => Vec3::new(10.0, t, 5.0),
                    2 => Vec3::new(10.0 - t, 10.0, 5.0),
                    _ => Vec3::new(0.0, 10.0 - t, 5.0),
                }
            })
            .collect();
        assert_eq!(seams_enclose_a_piece(&model, &[seam]), SeamVerdict::TooCoarse);
    }

    #[test]
    fn a_loop_round_a_handle_encloses_nothing_but_two_do() {
        // The tentacle case. One ring looks exactly like the cube's loop — closed,
        // on the surface, wrapping the body — but it runs round a HANDLE, so it
        // separates nothing and no cutter can free a piece along it. Only a second
        // ring elsewhere on the tube can.
        let model = torus(10.0, 3.0, 64, 32);
        let one = tube_ring(10.0, 3.0, 0.0, 64);
        let two = tube_ring(10.0, 3.0, std::f32::consts::PI, 64);
        assert_eq!(
            seams_enclose_a_piece(&model, std::slice::from_ref(&one)),
            SeamVerdict::NotSeparating,
            "one loop round a handle can never free anything",
        );
        assert!(
            matches!(seams_enclose_a_piece(&model, &[one, two]), SeamVerdict::Enclosed { .. }),
            "two loops round the same handle do enclose a piece",
        );
    }
}
