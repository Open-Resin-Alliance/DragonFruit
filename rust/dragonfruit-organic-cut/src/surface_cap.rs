//! Close each piece of a surface cut into a solid, capping it with the membrane.
//!
//! [`crate::surface_split`] leaves the model's skin cut along the seam: still one
//! watertight surface, but with the seam running along edges and the faces labelled
//! by which piece of it they belong to. Pull the pieces apart and each one is an
//! open bowl. This module puts the lid on.
//!
//! The lid is the soap film the user already saw in the preview, spanned across the
//! seam — but spanned across the CUT'S OWN edges, not across the polyline the seam
//! was drawn as. That distinction is the whole module. The two are within a
//! triangle of each other and look identical on screen; sewing to the second one
//! leaves every rim vertex a fraction of a millimetre away from the surface it is
//! supposed to close, which is a rim of cracks. So the cap's boundary ring is the
//! chain of cut edges, vertex for vertex, and [`membrane::build_membrane_on_ring`]
//! exists to promise exactly that.
//!
//! The two solids either side of a seam get the SAME cap triangles with the winding
//! reversed, so they mate exactly by construction rather than by tolerance. Which
//! way round is not assumed: a face of the piece traverses each rim edge one way,
//! and the cap has to traverse it the other, or the closed surface it makes would
//! be inside out. That is read off the mesh, per seam.
//!
//! What counts as a rim is read off the labelling too — an edge whose two faces
//! ended up in DIFFERENT pieces. A seam that failed to separate (a ring round a
//! handle) has both its faces in one piece, needs no cap, and gets none: the piece
//! is already closed, which is what the cut promised.

use ahash::{AHashMap, AHashSet};
use dragonfruit_mesh_core::mesh::{IndexedMesh, Vec3};

use crate::membrane::{build_membrane_on_ring, Membrane};
use crate::surface_split::SplitSurface;

/// Why the cut could not be closed, and WHERE.
///
/// The place is the point of it. A refusal the user cannot go and look at is a
/// refusal they cannot act on, and a coordinate in a sentence is not somewhere you
/// can look — the caller draws these.
#[derive(Debug)]
pub struct CapRefusal {
    pub why: String,
    pub at: Vec<Vec3>,
}

impl CapRefusal {
    fn new(why: impl Into<String>, at: Vec<Vec3>) -> Self {
        CapRefusal { why: why.into(), at }
    }
}

/// The pieces of a surface cut, each closed into its own solid.
pub struct ClosedPieces {
    /// One solid per piece, indexed by the piece number `piece_of_face` gave it.
    pub solids: Vec<IndexedMesh>,
    /// The cap spanning each rim, in the order the rims were met. Kept so the
    /// registration tenon can take its frame from the same surface that closed the
    /// cut, rather than rebuilding a near-enough one.
    pub caps: Vec<Membrane>,
    /// The two pieces each cap sits between, in the same order as `caps`.
    pub cap_between: Vec<(u32, u32)>,
}

/// Close every piece of `split` into a solid.
///
/// `grid_divisions` sets how fine the cap's interior is and `smoothing` how many
/// relaxation passes bow it into the seam's contour — the same two knobs the wafer's
/// membrane uses, so a cap looks like the preview did.
pub fn close_pieces(
    split: &SplitSurface,
    grid_divisions: f64,
    smoothing: f32,
) -> Result<ClosedPieces, CapRefusal> {
    let mesh = &split.mesh;
    let piece_count = split.piece_of_face.iter().copied().max().map_or(0, |m| m as usize + 1);
    if piece_count == 0 {
        return Err(CapRefusal::new("the cut surface has no faces", Vec::new()));
    }

    let rims = rims_between_pieces(mesh, &split.piece_of_face)?;

    // Cap vertices that are not already on the rim live past the end of the cut
    // surface's own, so every piece can go on using the indices it already has.
    let mut positions = mesh.positions.clone();
    let mut extra_faces: Vec<Vec<[u32; 3]>> = vec![Vec::new(); piece_count];
    let mut caps = Vec::with_capacity(rims.len());
    let mut cap_between = Vec::with_capacity(rims.len());

    for rim in &rims {
        let ring: Vec<Vec3> = rim.ring.iter().map(|&v| mesh.positions[v as usize]).collect();
        let cap = build_membrane_on_ring(&ring, grid_divisions, smoothing).ok_or_else(|| {
            CapRefusal::new(
                format!("no cap spans the {}-vertex rim of this cut", ring.len()),
                marks(&ring),
            )
        })?;

        // The cap's boundary is the rim itself, so those vertices are already in the
        // mesh; only its interior is new.
        let base = positions.len() as u32;
        let rim_len = rim.ring.len() as u32;
        positions.extend(cap.vertices.iter().skip(rim_len as usize).copied());
        let global = |v: u32| if v < rim_len { rim.ring[v as usize] } else { base + v - rim_len };
        let cap_tris: Vec<[u32; 3]> =
            cap.triangles.iter().map(|t| [global(t[0]), global(t[1]), global(t[2])]).collect();

        // The cap has to close the rim and nothing else. Checked rather than assumed:
        // the triangulator works on the rim FLATTENED onto its best-fit plane, and a
        // rim that wanders enough to cross itself in that projection comes back with
        // some of its edges missing. Sewing that on leaves the very cracks this
        // module exists to avoid, so refuse and let the caller fall back to the
        // wafer.
        let mut edge_uses: AHashMap<(u32, u32), usize> = AHashMap::new();
        for t in &cap_tris {
            for k in 0..3 {
                *edge_uses.entry(edge_key(t[k], t[(k + 1) % 3])).or_default() += 1;
            }
        }
        let free: AHashSet<(u32, u32)> =
            edge_uses.iter().filter(|(_, n)| **n == 1).map(|(e, _)| *e).collect();
        let wanted: AHashSet<(u32, u32)> = (0..rim.ring.len())
            .map(|k| edge_key(rim.ring[k], rim.ring[(k + 1) % rim.ring.len()]))
            .collect();
        if free != wanted {
            return Err(CapRefusal::new(
                format!(
                    "the cap for a {}-vertex rim does not close it: {} of its edges are \
                     unmatched and {} of the rim's are missing",
                    rim.ring.len(),
                    free.difference(&wanted).count(),
                    wanted.difference(&free).count(),
                ),
                marks(&ring),
            ));
        }

        // Which way the cap runs along the rim, read off the one triangle that owns
        // the rim's first edge.
        let (u, v) = (rim.ring[0], rim.ring[1]);
        let cap_runs_u_to_v = cap_tris.iter().find_map(|t| directed(t, u, v)).ok_or_else(|| {
            CapRefusal::new("the cap does not reach the rim edge it was built on", marks(&ring))
        })?;

        // A piece and its cap must traverse their shared edge in OPPOSITE directions,
        // or the solid comes out inside out. `side_a`'s faces traverse the ring in
        // ring order by construction; `side_b` gets the same triangles reversed, and
        // only when the rim really is the whole border between the two — a rim with
        // several pieces across it closes `side_a` alone, and each of those others
        // closes itself with its own rim.
        let mut sides = vec![(rim.side_a, true)];
        if rim.shared {
            sides.push((rim.side_b, false));
        }
        for &(piece, face_runs_u_to_v) in &sides {
            let flip = cap_runs_u_to_v != !face_runs_u_to_v;
            extra_faces[piece as usize].extend(
                cap_tris.iter().map(|t| if flip { [t[0], t[2], t[1]] } else { *t }),
            );
        }

        caps.push(cap);
        cap_between.push((rim.side_a, rim.side_b));
    }

    let mut solids = Vec::with_capacity(piece_count);
    for piece in 0..piece_count as u32 {
        let mut triangles: Vec<[u32; 3]> = mesh
            .triangles
            .iter()
            .zip(&split.piece_of_face)
            .filter(|(_, &p)| p == piece)
            .map(|(t, _)| *t)
            .collect();
        triangles.extend_from_slice(&extra_faces[piece as usize]);
        solids.push(compact(&positions, &triangles));
    }

    // Post-condition, because all of the above is only worth what the surface it
    // hands back is worth. A cap can close its rim exactly and still leave a solid
    // non-manifold: where the rim doubles back, the soap film's own interior can run
    // along an edge the skin already has, and that edge then belongs to four
    // triangles rather than two. Nothing about the cut is salvageable there, so say
    // so and let the caller fall back to the wafer rather than hand out a solid that
    // will not slice.
    // Only a HOLE is fatal. An edge on four triangles means the cap runs along one the
    // skin already had — it touches where it should only have spanned — and that is
    // untidy, not broken: the solid is still closed, still prints, still slices. It
    // was being refused all the same, and refusing a cut that would have worked is
    // worse for the user than handing them a few non-manifold edges. An edge on ONE
    // triangle is a hole, and that really does not print.
    let holes_before = open_edges(mesh, 1);
    let holes_after: usize = solids.iter().map(|s| open_edges(s, 1)).sum();
    if holes_after > holes_before {
        return Err(CapRefusal::new(
            format!(
                "capping left {} edge(s) with a hole beside them — the cut face does not \
                 close there",
                holes_after - holes_before
            ),
            Vec::new(),
        ));
    }

    Ok(ClosedPieces { solids, caps, cap_between })
}

/// Edges used by exactly `uses` faces. `open_edges(m, 1)` counts holes; anything
/// other than two is untidy, but only a hole stops a solid printing.
fn open_edges(mesh: &IndexedMesh, uses: usize) -> usize {
    let mut counts: AHashMap<(u32, u32), usize> = AHashMap::new();
    for t in &mesh.triangles {
        for k in 0..3 {
            *counts.entry(edge_key(t[k], t[(k + 1) % 3])).or_default() += 1;
        }
    }
    counts.values().filter(|c| **c == uses).count()
}

/// One rim: a closed loop of a piece's boundary, in the order the piece's own faces
/// traverse it.
struct Rim {
    /// The rim's vertices in order round it, each an index into the cut surface.
    /// `side_a`'s faces traverse `ring[k] -> ring[k+1]`; a cap for `side_a` has to
    /// run the other way, and one for `side_b` this way.
    ring: Vec<u32>,
    side_a: u32,
    /// The piece across the rim. When `shared` it is exact — the whole loop lies
    /// between `side_a` and `side_b` — and the cap serves both. When not, it is
    /// only the piece across MOST of the loop, kept so a caller can still ask what
    /// the cap roughly faces, and the cap belongs to `side_a` alone.
    side_b: u32,
    shared: bool,
}

/// The boundary loops of every piece: for each piece, every closed chain of edges
/// where it meets anything else.
///
/// Traced by walking each piece's boundary with the piece on the left, and at a
/// vertex the walk continues by ROTATING through the piece's own faces until it
/// leaves them. That detail is what makes the loops closed by construction — the
/// boundary of any set of faces of a closed surface is a set of closed curves, and
/// the rotation is what keeps two loops that touch at one vertex (a strip of joint
/// clearance pinching where its seams tangle) from being read as one broken one.
/// The old way — collecting the edges between each PAIR of pieces and chaining them
/// by vertex — refused exactly there: the pinch leaves the pair's chain open, and a
/// cut whose pieces were all perfectly separable was thrown away for it.
///
/// A loop lying between the same two pieces for its whole length comes out once,
/// `shared`, so the two solids get the SAME cap triangles reversed and mate exactly.
/// A loop with more than one piece across it belongs to `side_a` alone.
///
/// Edges the model brought with holes (not exactly two faces) count as boundary for
/// the walk, so a seam that runs into a tear still yields a closed ring. Loops made
/// of NOTHING but such edges are the model's own holes and are left alone, as they
/// always were.
fn rims_between_pieces(mesh: &IndexedMesh, piece_of_face: &[u32]) -> Result<Vec<Rim>, CapRefusal> {
    let mut edge_faces: AHashMap<(u32, u32), Vec<u32>> = AHashMap::new();
    for (fi, t) in mesh.triangles.iter().enumerate() {
        for k in 0..3 {
            edge_faces.entry(edge_key(t[k], t[(k + 1) % 3])).or_default().push(fi as u32);
        }
    }
    // The face across `e` from `f`, when the edge is an honest two-sided one.
    let across = |f: u32, e: (u32, u32)| -> Option<u32> {
        match edge_faces.get(&e).map(|v| v.as_slice()) {
            Some(&[a, b]) => Some(if a == f { b } else { a }),
            _ => None,
        }
    };
    // Is the directed edge u->v of face f a boundary of f's piece?
    let is_boundary = |f: u32, u: u32, v: u32| -> bool {
        across(f, edge_key(u, v))
            .map_or(true, |g| piece_of_face[g as usize] != piece_of_face[f as usize])
    };
    // v's successor in f, walking the face's own winding.
    let next_in_face = |f: u32, v: u32| -> u32 {
        let t = &mesh.triangles[f as usize];
        let k = (0..3).find(|&k| t[k] == v).expect("the walk stays on faces that hold its vertex");
        t[(k + 1) % 3]
    };

    // Every directed boundary edge, each owned by the face that traverses it.
    let mut pending: AHashMap<(u32, u32), u32> = AHashMap::new(); // (u -> v) -> face
    for (fi, t) in mesh.triangles.iter().enumerate() {
        for k in 0..3 {
            let (u, v) = (t[k], t[(k + 1) % 3]);
            if is_boundary(fi as u32, u, v) {
                pending.insert((u, v), fi as u32);
            }
        }
    }

    let mut rims: Vec<Rim> = Vec::new();
    let mut seen_loops: AHashMap<Vec<(u32, u32)>, usize> = AHashMap::new();
    let mut starts: Vec<(u32, u32)> = pending.keys().copied().collect();
    starts.sort_unstable();
    for start in starts {
        let Some(&start_face) = pending.get(&start) else { continue };
        let piece = piece_of_face[start_face as usize];

        let mut ring: Vec<u32> = Vec::new();
        let mut edges: Vec<(u32, u32)> = Vec::new();
        let mut others: AHashMap<u32, usize> = AHashMap::new();
        let (mut u, mut v, mut f) = (start.0, start.1, start_face);
        loop {
            ring.push(u);
            edges.push(edge_key(u, v));
            if let Some(g) = across(f, edge_key(u, v)) {
                *others.entry(piece_of_face[g as usize]).or_default() += 1;
            }
            pending.remove(&(u, v));
            // Rotate round `v` through this piece's faces until the walk leaves them:
            // that sector, not the raw count of boundary edges at `v`, is what says
            // which edge continues this loop.
            let mut cur = f;
            loop {
                let w = next_in_face(cur, v);
                if is_boundary(cur, v, w) {
                    (u, v, f) = (v, w, cur);
                    break;
                }
                cur = across(cur, edge_key(v, w))
                    .expect("an interior edge of a piece has a face on both sides");
            }
            if (u, v) == start {
                break;
            }
        }
        // A loop of nothing but the model's own open edges is a hole it arrived
        // with; inventing a lid for it is a change nobody asked for. Asked BEFORE
        // the loop is judged too short, because a torn model's holes are exactly
        // where two-vertex loops live — this model carries one 0.01 mm wide, a
        // hundred and fifty millimetres from any seam, and refusing the whole cut
        // over it turned away every cut on it.
        if others.is_empty() {
            continue;
        }
        if ring.len() < 3 {
            let at: Vec<Vec3> = ring.iter().map(|&v| mesh.positions[v as usize]).collect();
            return Err(CapRefusal::new("a rim of the cut is shorter than a triangle", at));
        }

        let mut key = edges;
        key.sort_unstable();
        match seen_loops.get(&key) {
            // The same loop walked from its other side: one rim, two owners, and the
            // cap they will share mates exactly by construction.
            Some(&i) => {
                rims[i].side_b = piece;
                rims[i].shared = true;
            }
            None => {
                let side_b = *others.iter().max_by_key(|(_, n)| **n).map(|(p, _)| p).unwrap();
                seen_loops.insert(key, rims.len());
                rims.push(Rim { ring, side_a: piece, side_b, shared: false });
            }
        }
    }
    Ok(rims)
}

/// A handful of points spread round a ring, so a refusal about it can be SEEN
/// without burying the model in markers: a rim of four hundred vertices needs a few
/// pins along it, not four hundred.
fn marks(ring: &[Vec3]) -> Vec<Vec3> {
    const HOW_MANY: usize = 6;
    let step = (ring.len() / HOW_MANY).max(1);
    ring.iter().step_by(step).take(HOW_MANY).copied().collect()
}

/// Does `tri` traverse the edge between `u` and `v` from `u` to `v`? `None` if the
/// triangle does not carry that edge at all.
fn directed(tri: &[u32; 3], u: u32, v: u32) -> Option<bool> {
    (0..3).find_map(|k| {
        let (a, b) = (tri[k], tri[(k + 1) % 3]);
        if (a, b) == (u, v) {
            Some(true)
        } else if (a, b) == (v, u) {
            Some(false)
        } else {
            None
        }
    })
}

fn edge_key(a: u32, b: u32) -> (u32, u32) {
    if a < b { (a, b) } else { (b, a) }
}

/// Keep only the vertices `triangles` actually name, renumbered from zero.
fn compact(positions: &[Vec3], triangles: &[[u32; 3]]) -> IndexedMesh {
    let mut moved: AHashMap<u32, u32> = AHashMap::new();
    let mut kept = Vec::new();
    let mut out = Vec::with_capacity(triangles.len());
    for t in triangles {
        let mut n = [0u32; 3];
        for k in 0..3 {
            n[k] = *moved.entry(t[k]).or_insert_with(|| {
                kept.push(positions[t[k] as usize]);
                (kept.len() - 1) as u32
            });
        }
        out.push(n);
    }
    IndexedMesh { positions: kept, triangles: out }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::membrane::DEFAULT_GRID_DIVISIONS;
    use crate::surface_split::{split_along_seam, split_along_seams};

    fn cube(size: f32, n: usize) -> IndexedMesh {
        let mut positions = Vec::new();
        let mut triangles = Vec::new();
        let s = size / n as f32;
        let mut push_quad = |p0: Vec3, du: Vec3, dv: Vec3| {
            let base = positions.len() as u32;
            positions.push(p0);
            positions.push(p0.add(du));
            positions.push(p0.add(du).add(dv));
            positions.push(p0.add(dv));
            triangles.push([base, base + 1, base + 2]);
            triangles.push([base, base + 2, base + 3]);
        };
        for i in 0..n {
            for j in 0..n {
                let (x, y) = (i as f32 * s, j as f32 * s);
                let (dx, dy) = (Vec3::new(s, 0.0, 0.0), Vec3::new(0.0, s, 0.0));
                let dz = Vec3::new(0.0, 0.0, s);
                push_quad(Vec3::new(x, y, 0.0), dy, dx);
                push_quad(Vec3::new(x, y, size), dx, dy);
                push_quad(Vec3::new(x, 0.0, y), dx, dz);
                push_quad(Vec3::new(x, size, y), dz, dx);
                push_quad(Vec3::new(0.0, x, y), dz, dy);
                push_quad(Vec3::new(size, x, y), dy, dz);
            }
        }
        let soup: Vec<f32> = triangles
            .iter()
            .flat_map(|t| {
                t.iter()
                    .flat_map(|&i| {
                        let p = positions[i as usize];
                        [p.x, p.y, p.z]
                    })
                    .collect::<Vec<f32>>()
            })
            .collect();
        IndexedMesh::from_triangle_soup(&soup, 1e-5)
    }

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

    fn tube_ring(major: f32, minor: f32, angle: f32, steps: usize) -> Vec<Vec3> {
        (0..steps)
            .map(|j| {
                let v = j as f32 / steps as f32 * std::f32::consts::TAU;
                let r = major + minor * v.cos();
                Vec3::new(r * angle.cos(), r * angle.sin(), minor * v.sin())
            })
            .collect()
    }

    /// A vertex's exact bits, so "the same point" means the same point and not
    /// "near enough" — which is the property the cap is claiming.
    fn key(p: Vec3) -> [u32; 3] {
        [p.x.to_bits(), p.y.to_bits(), p.z.to_bits()]
    }

    fn cube_ring(z: f32) -> Vec<Vec3> {
        (0..80)
            .map(|k| {
                let t = (k % 20) as f32 * 0.5;
                match k / 20 {
                    0 => Vec3::new(t, 0.0, z),
                    1 => Vec3::new(10.0, t, z),
                    2 => Vec3::new(10.0 - t, 10.0, z),
                    _ => Vec3::new(0.0, 10.0 - t, z),
                }
            })
            .collect()
    }

    #[test]
    fn a_capped_cut_gives_two_closed_solids_that_lose_nothing() {
        let model = cube(10.0, 8);
        let split = split_along_seam(&model, &cube_ring(5.2)).expect("the seam cuts the surface");
        let closed = close_pieces(&split, DEFAULT_GRID_DIVISIONS, 1.0).expect("both sides cap");

        assert_eq!(closed.solids.len(), 2, "one solid per side");
        assert_eq!(closed.caps.len(), 1, "one seam, one cap");
        for (i, solid) in closed.solids.iter().enumerate() {
            assert_eq!(open_edges(solid, 1), 0, "solid {i} is closed");
        }
        // The caps add no volume of their own, so the pieces still add up to the
        // model — and a cap sewn on inside out would show here as a sign flip.
        let whole = model.signed_volume();
        let parts: f64 = closed.solids.iter().map(|s| s.signed_volume()).sum();
        assert!(
            (parts - whole).abs() < whole.abs() * 1e-3,
            "the pieces add up to the model: {parts} vs {whole}",
        );
        assert!(
            closed.solids.iter().all(|s| s.signed_volume() > 0.0),
            "neither piece came out inside out",
        );
    }

    // The point of the module: the cap is sewn to the cut's OWN edges. If it were
    // spanned across the seam polyline instead, its rim would sit a fraction of a
    // millimetre off and the solid would not close — so this is the same assertion
    // as "closed", read the other way round.
    #[test]
    fn the_cap_rim_is_the_cut_s_own_edge_chain() {
        let model = cube(10.0, 8);
        let split = split_along_seam(&model, &cube_ring(5.2)).expect("the seam cuts the surface");
        let closed = close_pieces(&split, DEFAULT_GRID_DIVISIONS, 1.0).expect("both sides cap");

        let cap = &closed.caps[0];
        let on_cut: AHashSet<[u32; 3]> = split
            .mesh
            .positions
            .iter()
            .map(|&p| key(p))
            .collect();
        for &b in &cap.boundary {
            assert!(
                on_cut.contains(&key(cap.vertices[b as usize])),
                "every rim vertex of the cap is a vertex of the cut surface, bit for bit",
            );
        }
    }

    #[test]
    fn the_two_sides_of_a_cap_are_the_same_triangles_reversed() {
        let model = cube(10.0, 8);
        let split = split_along_seam(&model, &cube_ring(5.2)).expect("the seam cuts the surface");
        let closed = close_pieces(&split, DEFAULT_GRID_DIVISIONS, 1.0).expect("both sides cap");

        // Compare by position, since each solid renumbers its own vertices.
        let faces_of = |m: &IndexedMesh| -> AHashSet<[[u32; 3]; 3]> {
            m.triangles
                .iter()
                .map(|t| {
                    [
                        key(m.positions[t[0] as usize]),
                        key(m.positions[t[1] as usize]),
                        key(m.positions[t[2] as usize]),
                    ]
                })
                .collect()
        };
        let (a, b) = (faces_of(&closed.solids[0]), faces_of(&closed.solids[1]));
        let shared: Vec<&[[u32; 3]; 3]> =
            a.iter().filter(|t| b.contains(&[t[0], t[2], t[1]])).collect();
        assert_eq!(
            shared.len(),
            closed.caps[0].triangles.len(),
            "every cap triangle appears in both solids, wound the other way",
        );
        assert!(
            a.iter().all(|t| !b.contains(t)),
            "and none of them appears wound the SAME way in both",
        );
    }

    // A joint clearance is cut, not measured out afterwards: the seam is moved to
    // both sides by half of it and the strip of skin between the two is thrown away.
    // What must come out is a gap of exactly the clearance, and the proof is the
    // volume — the strip weighs the cut face times the clearance, and nothing else
    // moves.
    #[test]
    fn a_clearance_takes_out_a_strip_of_exactly_its_own_thickness() {
        let model = cube(10.0, 8);
        // 0.3 either side of 5.2 lands at 5.05 and 5.35. Not 0.4: that would put an
        // offset on 5.0, which is one of this cube's own grid lines, and a seam lying
        // exactly along existing edges is a known gap in the splitter — it stays
        // watertight but need not separate.
        let clearance = 0.3_f32;
        let ring = cube_ring(5.2);
        let split = split_along_seams(
            &model,
            &[
                crate::surface_split::offset_seam(&model, &ring, -clearance * 0.5),
                crate::surface_split::offset_seam(&model, &ring, clearance * 0.5),
            ],
        )
        .expect("both offset seams cut the surface");
        let closed = close_pieces(&split, DEFAULT_GRID_DIVISIONS, 1.0).expect("all three cap");

        assert_eq!(closed.solids.len(), 3, "above, below, and the strip between");
        for (i, solid) in closed.solids.iter().enumerate() {
            assert_eq!(open_edges(solid, 1), 0, "solid {i} is closed");
        }
        // Nothing is destroyed — the strip is a solid of its own until the cut throws
        // it away, so the three still add up to the cube.
        let whole = model.signed_volume();
        let parts: f64 = closed.solids.iter().map(|s| s.signed_volume()).sum();
        assert!(
            (parts - whole).abs() < whole.abs() * 1e-3,
            "the three pieces add up to the model: {parts} vs {whole}",
        );
        // The strip is the smallest, and it weighs the 10x10 cut face times 0.4.
        let mut volumes: Vec<f64> = closed.solids.iter().map(|s| s.signed_volume()).collect();
        volumes.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let expected = 100.0 * clearance as f64;
        assert!(
            (volumes[0] - expected).abs() < expected * 0.05,
            "the strip is the cut face times the clearance: {} vs {expected}",
            volumes[0],
        );
    }

    // A ring round a handle separates nothing, so there is nothing to cap — and the
    // one piece it leaves is already closed.
    #[test]
    fn a_cut_that_separates_nothing_needs_no_cap() {
        let model = torus(10.0, 3.0, 64, 32);
        let split = split_along_seam(&model, &tube_ring(10.0, 3.0, 0.3, 96)).expect("it cuts");
        let closed = close_pieces(&split, DEFAULT_GRID_DIVISIONS, 1.0).expect("nothing to cap");

        assert!(closed.caps.is_empty(), "no rim, no cap");
        assert_eq!(closed.solids.len(), 1, "the surface stayed in one piece");
        assert_eq!(open_edges(&closed.solids[0], 1), 0, "and it is still closed");
    }

    #[test]
    fn two_seams_round_a_handle_cap_into_two_closed_solids() {
        let model = torus(10.0, 3.0, 64, 32);
        let first = tube_ring(10.0, 3.0, 0.3, 96);
        let second = tube_ring(10.0, 3.0, std::f32::consts::PI + 0.05, 96);
        let split = split_along_seams(&model, &[first, second]).expect("both seams");
        let closed = close_pieces(&split, DEFAULT_GRID_DIVISIONS, 1.0).expect("both rims cap");

        assert_eq!(closed.caps.len(), 2, "two rims round the tube");
        assert_eq!(closed.solids.len(), 2, "the tube and the rest of the ring");
        for (i, solid) in closed.solids.iter().enumerate() {
            assert_eq!(open_edges(solid, 1), 0, "solid {i} is closed");
        }
        // Both caps sit between the same two pieces — they are the two ends of the
        // length of tube that came free.
        assert_eq!(
            closed.cap_between[0].0.min(closed.cap_between[0].1),
            closed.cap_between[1].0.min(closed.cap_between[1].1),
        );
    }
}
