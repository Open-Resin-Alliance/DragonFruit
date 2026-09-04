//! Cut the model's SURFACE along the seam, so the seam becomes mesh edges.
//!
//! This is the piece the contour cut is missing. Once the seam runs along edges
//! rather than across faces, "which side is this triangle on" is a walk over the
//! face graph — no cutter, no kerf, no epsilon, nothing to classify afterwards —
//! and the two sides can be capped with the membrane they already share a boundary
//! with. See `docs/adr/0002-cut-the-surface-not-a-volume.md` for the decision and
//! `docs/dev/organic-cut-surface-redesign.md` for the measurements behind it.
//!
//! The shape of it:
//!
//! - Walk the seam face by face, recording where it CROSSES each mesh edge. Both
//!   faces either side of an edge get the very same crossing point, which is what
//!   keeps the result watertight.
//! - Inside a face, the seam is taken as the straight chord between where it came
//!   in and where it went out. The error is bounded by one face (sub-millimetre on
//!   any mesh worth cutting) and it removes a whole class of special cases.
//! - Retriangulate only the faces the seam crosses, with the chords as constraints,
//!   so every other triangle of the model is left exactly as it was.
//!
//! Both halves of the retriangulation turn on ONE rule, which is worth stating
//! plainly because getting it wrong is what leaked on the real model for a whole
//! session: **an edge the rebuild adds — a seam chord, or the base of an ear — may
//! never run along an edge of the face it is added to.** Such an edge has no
//! interior. It is either a needle of no area or, worse, a span from one end of an
//! edge the NEIGHBOUR has already split to the other, and a span like that is a
//! T-junction. Both faces either side do it at once, so the edge comes out used by
//! four triangles: the surface is closed but not manifold, and the flood fill walks
//! straight through what was meant to be a wall. That was 8 of the 32 captured
//! seams; with the rule in place, all 32 keep every edge on exactly two faces.
//!
//! The rule is asked structurally — does one edge of the face carry both ends? — and
//! never by measuring how straight three points are. Measured and ruled out, so they
//! are not tried again: dropping needle triangles by relative area (a needle is
//! still part of the tiling, and what is left leans on an edge that no longer exists
//! — that is a hole), cutting a chord only once across faces, and dropping repeated
//! triangles. All three treat the symptom.
//!
//! Known gap: a seam that lies exactly ALONG existing edges — a ring at precisely a
//! mesh's own grid line, which a hand-drawn seam never is, but a machine-made one
//! could be — walks from vertex to vertex rather than crossing anything, and the
//! wall it leaves has gaps the side walk slips through. Cutting stays watertight
//! there; it just may not separate.

use ahash::{AHashMap, AHashSet};
use dragonfruit_mesh_core::bvh::Bvh;
use dragonfruit_mesh_core::mesh::{Aabb, IndexedMesh, Vec3};

use crate::membrane::closest_on_tri;

/// The model's surface, cut along the seam.
pub struct SplitSurface {
    /// The mesh, with the seam running along edges. Every face untouched by the
    /// seam is unchanged, and unchanged faces keep their vertices.
    pub mesh: IndexedMesh,
    /// Which piece of the cut surface each face belongs to. Pieces are numbered in
    /// the order they are met; two seams round a handle give two, a seam that
    /// separates nothing gives one, and a shell the model already carried is a
    /// piece of its own.
    pub piece_of_face: Vec<u32>,
    /// The seam as vertices of `mesh`, in order round the loop.
    pub seam_vertices: Vec<u32>,
    /// Which face of the INPUT mesh each face of `mesh` came from. A face the seam
    /// never touched maps to itself.
    pub source_face: Vec<u32>,
    /// The wall: the edges of `mesh` the flood fill is not allowed to cross.
    ///
    /// A wall that separates anything is a set of CLOSED curves. Where a vertex of it
    /// has only one wall edge the wall has a loose end, and the fill simply walks
    /// round it — which is the difference between a cut that separates and one that
    /// does not. [`SplitSurface::loose_wall_ends`] finds them.
    pub seam_edges: Vec<(u32, u32)>,
    /// Which of the seams given to the cut each wall edge belongs to, in step with
    /// `seam_edges`.
    pub seam_of_edge: Vec<usize>,
}

impl SplitSurface {
    /// Vertices where the wall stops dead, as positions — the places a cut that
    /// should have separated leaks through.
    /// Counted PER PAIR OF PIECES, which is the only count that means anything. Three
    /// wall edges at a vertex is not a loose end — it is three pieces meeting, and the
    /// wall there is closed. Taken all together that vertex looks fine while the wall
    /// between two of those pieces stops dead, which is the leak that matters and the
    /// one a global count cannot see.
    pub fn loose_wall_ends(&self) -> Vec<Vec3> {
        self.loose_wall_ends_by_vertex().into_iter().map(|v| self.positions_of(v)).collect()
    }

    fn positions_of(&self, v: u32) -> Vec3 {
        self.mesh.positions[v as usize]
    }

    /// Fold the debris a joint clearance leaves behind back into its neighbour.
    ///
    /// `pairs` names the seams that are the two sides of one clearance. Where two of
    /// those pass within a triangle of each other the retriangulation can leave
    /// islands of one and three and sixteen faces, walled off from everything. They
    /// are not pieces of the model: they are shavings of the strip the clearance is
    /// made of, and the wall around them does not close, so a single one of them
    /// refuses the whole cut.
    ///
    /// Three things have to be true before a piece is folded away, and asking for all
    /// three is what keeps this from ever swallowing a piece the user meant to free:
    /// its border must carry BOTH sides of one clearance — only the strip and its
    /// shavings do — the wall around it must be broken, and it must be smaller than
    /// every piece it touches. The last one is what matters most: without it, a body
    /// that picks up a few edges of the far offset where the two tangle qualifies on
    /// the first two counts, and folding THAT away hands the user a sliver of two
    /// thousand triangles back from a model of half a million. A seam that goes round
    /// a handle also touches both sides, but its wall is closed, so it is left alone
    /// and still refused later, by name.
    ///
    /// Nothing is deleted; the faces are relabelled, and the caller decides what to
    /// bin as it did before.
    pub fn dissolve_clearance_debris(&mut self, pairs: &[(usize, usize)]) {
        let broken: AHashSet<u32> =
            self.loose_wall_ends_by_vertex().into_iter().collect();
        if broken.is_empty() {
            return;
        }
        let sides_of_piece = self.sides_of_piece();
        let mut border: AHashMap<(u32, u32), usize> = AHashMap::new();
        let mut touches_break: AHashSet<u32> = AHashSet::new();
        let faces_of = self.faces_of_edge();
        for e in &self.seam_edges {
            let Some(faces) = faces_of.get(e) else { continue };
            if faces.len() != 2 {
                continue;
            }
            let (p, q) = (
                self.piece_of_face[faces[0] as usize],
                self.piece_of_face[faces[1] as usize],
            );
            *border.entry((p.min(q), p.max(q))).or_default() += 1;
            if broken.contains(&e.0) || broken.contains(&e.1) {
                touches_break.insert(p);
                touches_break.insert(q);
            }
        }

        let mut faces: AHashMap<u32, usize> = AHashMap::new();
        for &p in &self.piece_of_face {
            *faces.entry(p).or_default() += 1;
        }
        let neighbours = |piece: u32| -> Vec<(u32, usize)> {
            border
                .iter()
                .filter(|((p, q), _)| *p == piece || *q == piece)
                .map(|((p, q), n)| (if *p == piece { *q } else { *p }, *n))
                .collect()
        };

        // Strip material itself qualifies on every count below — it is what the
        // shavings are shavings OF — so name it first and leave it alone. Folding
        // strip into the body was how a cut came back with the strip as the freed
        // piece and the model as the body; the strip is BINNED later, not merged.
        let strips: AHashSet<u32> =
            pairs.iter().flat_map(|&(a, b)| self.strips_between(a, b)).collect();

        let mut relabel: AHashMap<u32, u32> = AHashMap::new();
        for (&piece, sides) in &sides_of_piece {
            if strips.contains(&piece) || !touches_break.contains(&piece) {
                continue;
            }
            if !pairs.iter().any(|(a, b)| sides.contains(a) && sides.contains(b)) {
                continue;
            }
            let mine = faces.get(&piece).copied().unwrap_or(0);
            let around = neighbours(piece);
            if around.iter().any(|(q, _)| faces.get(q).copied().unwrap_or(0) <= mine) {
                continue;
            }
            // Into whichever neighbour holds most of its border.
            if let Some((into, _)) = around.into_iter().max_by_key(|(_, n)| *n) {
                relabel.insert(piece, into);
            }
        }
        for p in self.piece_of_face.iter_mut() {
            if let Some(&into) = relabel.get(p) {
                *p = into;
            }
        }
    }

    /// The strip of skin held between seams `a` and `b` — what a joint clearance
    /// throws away.
    ///
    /// Read off the wall rather than measured: the strip can sit further from the
    /// drawn seam than its own width, so distance is no use, and counting rims held
    /// only while a seam had exactly two of them.
    ///
    /// The strip is what runs ALONG both offsets, and where the two offsets touch it
    /// is severed into several pieces — all of them still strip, all of them still
    /// to be thrown away. So the test is per piece and it is about BALANCE: a piece
    /// of the strip has one offset down one flank and the other down the other, near
    /// enough half and half, while a body has thousands of edges of its own offset
    /// and picks up at most a handful of the far one where the two tangle. Half-and-
    /// half against thousands-to-a-handful is not a tuned threshold; anything in
    /// between would be a piece that runs along one seam and only ever touches the
    /// other, and the geometry has no such piece to offer.
    ///
    /// Balance alone is not enough, and the way it fails is the worst outcome there
    /// is: it binned 500 022 of a model's 500 186 triangles and handed back the
    /// crumbs. When the two offsets sever nothing, every face stays in ONE piece —
    /// and then a seam edge has that same piece on both of its sides, so counting per
    /// face credited it twice, the body came out perfectly balanced, and the body was
    /// named the strip.
    ///
    /// So a seam edge only counts for a piece when it BOUNDS it: the two faces across
    /// it in different pieces. That is what "runs along" has to mean. The strip is
    /// bounded by the two offsets and nothing else; a body the seams failed to cut is
    /// not bounded by them at all, it merely contains them. Structural, no threshold
    /// — and not by size either: on a coarse mesh the band round a cube carries more
    /// faces than the lid it frees, and there is a test that says so.
    pub fn strips_between(&self, a: usize, b: usize) -> Vec<u32> {
        let mut along: AHashMap<(u32, usize), usize> = AHashMap::new();
        let faces_of = self.faces_of_edge();
        for (i, e) in self.seam_edges.iter().enumerate() {
            let Some(faces) = faces_of.get(e) else { continue };
            if faces.len() != 2 {
                continue;
            }
            let side = self.seam_of_edge[i];
            if side != a && side != b {
                continue;
            }
            let (pa, pb) = (
                self.piece_of_face[faces[0] as usize],
                self.piece_of_face[faces[1] as usize],
            );
            if pa == pb {
                continue; // the seam runs THROUGH this piece; it does not bound it
            }
            *along.entry((pa, side)).or_default() += 1;
            *along.entry((pb, side)).or_default() += 1;
        }
        let pieces: AHashSet<u32> = along.keys().map(|(p, _)| *p).collect();
        let mut out: Vec<u32> = pieces
            .into_iter()
            .filter(|&p| {
                let ea = along.get(&(p, a)).copied().unwrap_or(0);
                let eb = along.get(&(p, b)).copied().unwrap_or(0);
                ea > 0 && eb > 0 && ea.min(eb) * 4 >= ea.max(eb)
            })
            .collect();
        out.sort_unstable();
        out
    }

    /// Which seams run along each piece's border.
    fn sides_of_piece(&self) -> AHashMap<u32, AHashSet<usize>> {
        let faces_of = self.faces_of_edge();
        let mut sides: AHashMap<u32, AHashSet<usize>> = AHashMap::new();
        for (i, e) in self.seam_edges.iter().enumerate() {
            let Some(faces) = faces_of.get(e) else { continue };
            if faces.len() != 2 {
                continue;
            }
            for &f in faces {
                sides
                    .entry(self.piece_of_face[f as usize])
                    .or_default()
                    .insert(self.seam_of_edge[i]);
            }
        }
        sides
    }

    fn faces_of_edge(&self) -> AHashMap<(u32, u32), Vec<u32>> {
        let mut faces_of: AHashMap<(u32, u32), Vec<u32>> = AHashMap::new();
        for (fi, t) in self.mesh.triangles.iter().enumerate() {
            for k in 0..3 {
                faces_of.entry(edge_key(t[k], t[(k + 1) % 3])).or_default().push(fi as u32);
            }
        }
        faces_of
    }

    fn loose_wall_ends_by_vertex(&self) -> Vec<u32> {
        let faces_of = self.faces_of_edge();
        let mut degree: AHashMap<((u32, u32), u32), usize> = AHashMap::new();
        for e in &self.seam_edges {
            let Some(faces) = faces_of.get(e) else { continue };
            if faces.len() != 2 {
                continue;
            }
            let (p, q) = (
                self.piece_of_face[faces[0] as usize],
                self.piece_of_face[faces[1] as usize],
            );
            let pair = (p.min(q), p.max(q));
            *degree.entry((pair, e.0)).or_default() += 1;
            *degree.entry((pair, e.1)).or_default() += 1;
        }
        let mut ends: Vec<u32> =
            degree.into_iter().filter(|(_, n)| *n < 2).map(|((_, v), _)| v).collect();
        ends.sort_unstable();
        ends.dedup();
        ends
    }
}

/// The seam moved `by` mm to one side of itself, still lying on the surface.
///
/// Sideways means perpendicular to the seam and IN the surface — the surface normal
/// crossed with the seam's own direction. Not the membrane's normal, which points
/// across the cut, and not any fixed axis, which means a different thing at every
/// point of a bent seam.
///
/// This is how a cut gets a GAP. The surface cut's two halves share their cut face,
/// so there is nothing between them to widen; cutting along the seam moved both ways
/// instead, and throwing away the strip of skin between, takes out a band of exactly
/// `2 × by` — which is the clearance a glued joint needs if it is not to come out
/// fatter than the model. The offset has to be far finer than a triangle, which is
/// why it moves the CURVE and lets the exact splitter do the rest, rather than
/// dropping faces near the rim: at a tenth of a millimetre on a mesh whose triangles
/// are a third of one, face-level erosion cannot resolve the gap at all.
///
/// Each moved point is put back onto the skin, because the walk that follows assumes
/// it lies there.
pub fn offset_seam(mesh: &IndexedMesh, seam: &[Vec3], by: f32) -> Vec<Vec3> {
    if seam.len() < 3 || by == 0.0 {
        return seam.to_vec();
    }
    let bvh = Bvh::build(mesh);
    // The seam is offset point for point, WITHOUT resampling it first. Resampling
    // looks like the safe thing to do — a geodesic crossing a flat face puts no
    // points in between, and the model's base makes one run of 6 to 8 mm steps where
    // the rest of the seam steps half a millimetre — but the points it invents go in
    // along the straight chord, and where the seam turns into a crevice that chord
    // passes THROUGH the model. Offsetting from inside the solid and dropping the
    // result on the nearest face lands it on whatever happens to be nearest: a spike,
    // one point most of a millimetre from both its neighbours and back again, which
    // crosses its own seam and breaks the cut into crumbs of one and three and five
    // triangles. The long steps are the walk's business, and it handles them.
    let n = seam.len();
    (0..n)
        .map(|i| {
            let p = seam[i];
            let along = seam[(i + 1) % n].sub(seam[(i + n - 1) % n]);
            // The normal of the ONE nearest face is not good enough where the seam
            // runs along a sharp edge of the model — the base sitting on the plate is
            // the everyday case. Right on that edge, "nearest" flips between the flat
            // bottom and the wall as the point wobbles, the sideways direction turns
            // ninety degrees with it, and the two offsets end up on different faces of
            // the corner: one along the floor, one up the wall. The strip between them
            // is then nonsense and the wall it leaves has a gap. Averaging the faces
            // that meet near the point gives the bisector instead, which is the same
            // direction on both sides of the edge and turns smoothly along it.
            let Some(normal) = normal_around(&bvh, mesh, p, by.abs() * 4.0) else {
                return p;
            };
            let sideways = normal.cross(along);
            let len = sideways.length();
            if len < 1e-9 {
                return p;
            }
            project_onto(&bvh, mesh, p.add(sideways.scale(by / len)))
        })
        .collect()
}

/// `p` dropped onto the nearest face of the mesh.
fn project_onto(bvh: &Bvh, mesh: &IndexedMesh, p: Vec3) -> Vec3 {
    match nearest_face(bvh, mesh, p) {
        Some(g) => {
            let t = &mesh.triangles[g as usize];
            closest_on_tri(
                p,
                mesh.positions[t[0] as usize],
                mesh.positions[t[1] as usize],
                mesh.positions[t[2] as usize],
            )
            .0
        }
        None => p,
    }
}

/// Cut `mesh`'s surface along one seam (a closed polyline lying on it).
pub fn split_along_seam(mesh: &IndexedMesh, seam: &[Vec3]) -> Result<SplitSurface, String> {
    split_along_seams(mesh, std::slice::from_ref(&seam.to_vec()))
}

/// Cut `mesh`'s surface along every seam, and say which side of them each face is
/// on.
///
/// The seams are cut one after another and the sides are decided once, at the end,
/// with all of them standing: a piece held by two seams — a tentacle that leaves
/// the body and fuses back — only comes away when both are walls at the same time.
/// Cutting only ever ADDS vertices, so a seam cut earlier keeps its edges valid
/// while the later ones are cut.
pub fn split_along_seams(mesh: &IndexedMesh, seams: &[Vec<Vec3>]) -> Result<SplitSurface, String> {
    if seams.iter().all(|s| s.len() < 3) {
        return Err("a seam needs at least 3 points".to_string());
    }
    let mut current = mesh.clone();
    let apart = seam_separation(seams);
    let snap_mm = snap_distance(mesh, apart);
    // Which seam each wall edge came from, kept through every later cut. Two seams
    // 0.1 mm apart are the two sides of one joint clearance, and telling their edges
    // apart is what lets the debris where they tangle be recognised for what it is.
    let mut seam_edges: AHashMap<(u32, u32), usize> = AHashMap::new();
    let mut seam_vertices: Vec<u32> = Vec::new();
    let mut source_face: Vec<u32> = (0..mesh.triangles.len() as u32).collect();

    for (si, seam) in seams.iter().enumerate().filter(|(_, s)| s.len() >= 3) {
        let step = median_edge_length(&current) * 0.25;
        let step = apart.map_or(step, |a| step.min(a * 0.5));
        let dense = densify(seam, step);
        let bvh = Bvh::build(&current);
        let topo = Topology::build(&current);
        let crossings = walk(&current, &bvh, &topo, &dense)?;
        if crossings.is_empty() {
            return Err("the seam never crosses a triangle edge — it fits inside one face".to_string());
        }
        let cut = retriangulate(&current, crossings, snap_mm)?;
        current = cut.mesh;
        // Rename the walls this seam cut through before adding its own. Skipping this
        // leaves the earlier seam's wall naming edges that no longer exist: the fill
        // walks through the gap, the cut does not separate, and nothing anywhere
        // reports a problem.
        seam_edges = seam_edges
            .into_iter()
            .flat_map(|(e, owner)| match cut.split_edges.get(&e) {
                None => vec![(e, owner)],
                Some(made) => {
                    let mut chain = Vec::with_capacity(made.len() + 2);
                    chain.push(e.0);
                    chain.extend(made.iter().copied());
                    chain.push(e.1);
                    chain.windows(2).map(|w| (edge_key(w[0], w[1]), owner)).collect()
                }
            })
            .collect();
        seam_edges.extend(cut.seam_edges.into_iter().map(|e| (e, si)));
        seam_vertices.extend(cut.seam_vertices);
        source_face = cut.source_face.iter().map(|&f| source_face[f as usize]).collect();
    }

    let walls: AHashSet<(u32, u32)> = seam_edges.keys().copied().collect();
    let piece_of_face = pieces(&current, &walls);
    let (seam_edges, seam_of_edge): (Vec<(u32, u32)>, Vec<usize>) = seam_edges.into_iter().unzip();
    Ok(SplitSurface {
        mesh: current,
        piece_of_face,
        seam_vertices,
        source_face,
        seam_edges,
        seam_of_edge,
    })
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/// One place the seam leaves a face for its neighbour, through their shared edge.
#[derive(Debug, Clone, Copy)]
struct Crossing {
    /// The mesh edge crossed, as its two vertex indices, low first.
    edge: (u32, u32),
    /// Where along that edge, 0..1 from the low vertex.
    t: f32,
    /// The face the seam was in before the crossing, and the one it moves into.
    from: u32,
    to: u32,
}

/// Follow the seam across the surface, recording every edge it crosses in order.
///
/// Each sample is located among the faces AROUND the one before it, not by nearest
/// face over the whole mesh and not by projecting into the current face's plane.
/// Both of those looked simpler and both are wrong: a point on an edge or a vertex
/// belongs to several faces equally, so a global nearest flips between faces that
/// are not neighbours; and a projection into the current plane puts a point that
/// really sits on the perpendicular face — a cube's corner, a shingle's lip —
/// comfortably INSIDE the current one, so the walk sticks there and sails past
/// every edge it should have crossed.
fn walk(mesh: &IndexedMesh, bvh: &Bvh, topo: &Topology, seam: &[Vec3]) -> Result<Vec<Crossing>, String> {
    /// A step should cross a handful of faces at most; more means the sampling and
    /// the mesh disagree wildly and the caller is better off with the old cut.
    const MAX_HOPS_PER_STEP: usize = 8;

    // The ring has to close, and where it closes is the face the walk ENDS in — not
    // the one a global nearest-face lookup picks for the first sample. On an edge or
    // a vertex several faces are equally nearest, so those two differ, and then the
    // wall is left open exactly where the seam closes on itself. That does not look
    // like much: the surface is still watertight and still cut, and the flood fill
    // simply walks round the loose end and calls the model one piece. One crossing in
    // 280 was enough to refuse a whole cut.
    //
    // So walk it twice. The first pass is thrown away and only says where the walk
    // comes to rest; the second starts there, and its two ends meet by construction.
    let mut crossings: Vec<Crossing> = Vec::new();
    let mut start_face = nearest_face(bvh, mesh, seam[0])
        .ok_or_else(|| "the seam starts nowhere near the surface".to_string())?;
    for _ in 0..2 {
        crossings.clear();
        start_face = walk_once(mesh, bvh, topo, seam, start_face, &mut crossings)?;
    }

    // A drift the second pass could not settle: bridge it if the two ends are close
    // enough to join honestly, and otherwise leave the ring open rather than invent a
    // path across the model. `SplitSurface::loose_wall_ends` then names the spot.
    let face = start_face;
    let start_face = walk_start(mesh, bvh, seam)?;
    if face != start_face {
        if let Some(path) = topo.path_between(face, start_face, MAX_HOPS_PER_STEP) {
            let (a, b) = (seam[seam.len() - 1], seam[0]);
            for pair in path.windows(2) {
                let Some(edge) = topo.shared_edge(pair[0], pair[1]) else {
                    return Err("two faces the walk stepped between share no edge".to_string());
                };
                let t = crossing_t(mesh, edge, a, b);
                crossings.push(Crossing { edge, t, from: pair[0], to: pair[1] });
            }
        }
    }
    Ok(crossings)
}

/// The face a global lookup puts the seam's first sample in.
fn walk_start(mesh: &IndexedMesh, bvh: &Bvh, seam: &[Vec3]) -> Result<u32, String> {
    nearest_face(bvh, mesh, seam[0])
        .ok_or_else(|| "the seam starts nowhere near the surface".to_string())
}

/// One lap of the seam from `from`, recording every edge crossed. Returns the face it
/// came to rest in.
fn walk_once(
    mesh: &IndexedMesh,
    bvh: &Bvh,
    topo: &Topology,
    seam: &[Vec3],
    from: u32,
    crossings: &mut Vec<Crossing>,
) -> Result<u32, String> {
    /// How far the walk will look for the sample's face before giving up and asking
    /// the whole mesh. Dense sampling keeps this at 1 almost always.
    const NEARBY_HOPS: usize = 3;
    const MAX_HOPS_PER_STEP: usize = 8;
    let mut face = from;

    for i in 0..seam.len() {
        let (a, b) = (seam[i], seam[(i + 1) % seam.len()]);
        let next = topo
            .nearest_around(mesh, face, b, NEARBY_HOPS)
            .or_else(|| nearest_face(bvh, mesh, b))
            .ok_or_else(|| "the seam leaves the surface".to_string())?;
        if next == face {
            continue;
        }
        let Some(path) = topo.path_between(face, next, MAX_HOPS_PER_STEP) else {
            return Err(format!(
                "the seam steps between faces {face} and {next}, which are not within \
                 {MAX_HOPS_PER_STEP} of each other — the mesh may be torn here"
            ));
        };
        for pair in path.windows(2) {
            let Some(edge) = topo.shared_edge(pair[0], pair[1]) else {
                return Err("two faces the walk stepped between share no edge".to_string());
            };
            let t = crossing_t(mesh, edge, a, b);
            crossings.push(Crossing { edge, t, from: pair[0], to: pair[1] });
        }
        face = next;
    }
    Ok(face)
}

/// Where on `edge` the step from `a` to `b` crosses it, as a fraction of the edge.
///
/// Snapping the crossing ONTO the edge is what makes the two faces either side of
/// it share the vertex exactly, and so what keeps the cut surface watertight.
/// Intersecting two lines in space instead has to cope with them not quite
/// meeting, and the leftovers are cracks.
fn crossing_t(mesh: &IndexedMesh, edge: (u32, u32), a: Vec3, b: Vec3) -> f32 {
    let (p, q) = (mesh.positions[edge.0 as usize], mesh.positions[edge.1 as usize]);
    let e = q.sub(p);
    let ee = e.dot(e);
    if ee < 1e-18 {
        return 0.5;
    }
    // Closest approach between the step [a,b] and the edge [p,q].
    let d = b.sub(a);
    // From the edge's start to the step's start: get this the wrong way round and
    // every crossing comes out negative and snaps to the end of its edge.
    let r = a.sub(p);
    let (dd, de, dr, er) = (d.dot(d), d.dot(e), d.dot(r), e.dot(r));
    let denom = dd * ee - de * de;
    let t = if denom.abs() > 1e-12 {
        (dd * er - de * dr) / denom
    } else {
        a.add(d.scale(0.5)).sub(p).dot(e) / ee
    };
    t.clamp(0.0, 1.0)
}

/// The surface's direction at `p`, averaged over every face within `reach`.
///
/// On a smooth patch this is just the local normal. On an edge it is the bisector of
/// the faces that meet there, which is what makes it usable: it is the same answer
/// from either side, so anything derived from it stops jumping as the point crosses.
/// Falls back to the single nearest face when nothing is in reach.
fn normal_around(bvh: &Bvh, mesh: &IndexedMesh, p: Vec3, reach: f32) -> Option<Vec3> {
    let query = Aabb {
        min: Vec3::new(p.x - reach, p.y - reach, p.z - reach),
        max: Vec3::new(p.x + reach, p.y + reach, p.z + reach),
    };
    let r2 = reach * reach;
    let mut sum = Vec3::new(0.0, 0.0, 0.0);
    bvh.query_aabb(&query, |ti| {
        let t = &mesh.triangles[ti as usize];
        let (_, d2) = closest_on_tri(
            p,
            mesh.positions[t[0] as usize],
            mesh.positions[t[1] as usize],
            mesh.positions[t[2] as usize],
        );
        if d2 <= r2 {
            sum = sum.add(mesh.tri_normal(ti));
        }
    });
    if sum.length() > 1e-6 {
        return Some(sum.scale(1.0 / sum.length()));
    }
    nearest_face(bvh, mesh, p).map(|f| mesh.tri_normal(f))
}

/// The face of `mesh` nearest `p`, searching a box that widens until it finds one.
fn nearest_face(bvh: &Bvh, mesh: &IndexedMesh, p: Vec3) -> Option<u32> {
    let mut r = 0.5f32;
    for _ in 0..6 {
        let query = Aabb {
            min: Vec3::new(p.x - r, p.y - r, p.z - r),
            max: Vec3::new(p.x + r, p.y + r, p.z + r),
        };
        let mut best = (f32::INFINITY, u32::MAX);
        bvh.query_aabb(&query, |ti| {
            let t = &mesh.triangles[ti as usize];
            let (_, d2) = closest_on_tri(
                p,
                mesh.positions[t[0] as usize],
                mesh.positions[t[1] as usize],
                mesh.positions[t[2] as usize],
            );
            if d2 < best.0 {
                best = (d2, ti);
            }
        });
        if best.1 != u32::MAX {
            return Some(best.1);
        }
        r *= 4.0;
    }
    None
}

/// Resample the seam so consecutive points are never further apart than `step`,
/// which keeps the walk stepping between neighbouring faces.
fn densify(seam: &[Vec3], step: f32) -> Vec<Vec3> {
    let step = step.max(1e-4);
    let mut out = Vec::with_capacity(seam.len() * 2);
    for i in 0..seam.len() {
        let (a, b) = (seam[i], seam[(i + 1) % seam.len()]);
        let n = ((b.sub(a).length() / step).ceil() as usize).max(1);
        for k in 0..n {
            out.push(a.add(b.sub(a).scale(k as f32 / n as f32)));
        }
    }
    out
}

/// How close two things have to be before the cut treats them as one, in mm.
///
/// It is set by the mesh's own resolution — a crossing landing a fiftieth of a
/// typical edge from a corner is that corner, and making a second vertex there only
/// buys a sliver of no area. Where two seams are cut in the same operation it is
/// held below the gap they keep from each other as well, because merging across
/// that gap welds the two seams together and the strip between them disappears.
fn snap_distance(mesh: &IndexedMesh, apart: Option<f32>) -> f32 {
    let from_mesh = median_edge_length(mesh) * 0.02;
    match apart {
        None => from_mesh,
        Some(a) => from_mesh.min(a * 0.25),
    }
}

/// The closest two of these seams ever come to each other, or `None` for one seam.
///
/// A cut with a joint clearance sends down two seams a tenth of a millimetre apart,
/// and that gap is then the finest thing anywhere near the cut. Both the snapping
/// distance and the sampling step are held under it: merge across it and the seams
/// weld together, step over it and the walk loses the trail among the slivers the
/// first seam left.
fn seam_separation(seams: &[Vec<Vec3>]) -> Option<f32> {
    let mut apart = f32::MAX;
    for (i, s) in seams.iter().enumerate() {
        for other in seams.iter().skip(i + 1) {
            for &p in s {
                for w in other.windows(2) {
                    apart = apart.min(distance_to_segment(p, w[0], w[1]));
                }
            }
        }
    }
    (apart != f32::MAX).then_some(apart)
}

/// Distance from `p` to the segment `a`–`b`.
fn distance_to_segment(p: Vec3, a: Vec3, b: Vec3) -> f32 {
    let ab = b.sub(a);
    let len2 = ab.dot(ab);
    let t = if len2 < 1e-12 { 0.0 } else { (p.sub(a).dot(ab) / len2).clamp(0.0, 1.0) };
    p.sub(a.add(ab.scale(t))).length()
}

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

// ---------------------------------------------------------------------------
// Topology
// ---------------------------------------------------------------------------

/// The face graph: which faces meet along each edge, and which faces touch each
/// face.
struct Topology {
    edge_faces: AHashMap<(u32, u32), Vec<u32>>,
    neighbours: Vec<Vec<u32>>,
}

impl Topology {
    fn build(mesh: &IndexedMesh) -> Self {
        let mut edge_faces: AHashMap<(u32, u32), Vec<u32>> = AHashMap::new();
        for (fi, t) in mesh.triangles.iter().enumerate() {
            for k in 0..3 {
                edge_faces.entry(edge_key(t[k], t[(k + 1) % 3])).or_default().push(fi as u32);
            }
        }
        // Walked face by face, NOT by iterating the map: a hash map hands its entries
        // back in a different order every run, and both readers of this list break
        // ties by which neighbour they met first — `nearest_around` keeps the first
        // face at the winning distance, `path_between` keeps the first shortest path.
        // With a random order the seam walked a different way through the same model
        // on every cut, and the same cut came out one or two triangles apart each time.
        let mut neighbours: Vec<Vec<u32>> = vec![Vec::new(); mesh.triangles.len()];
        for (fi, t) in mesh.triangles.iter().enumerate() {
            for k in 0..3 {
                for &g in &edge_faces[&edge_key(t[k], t[(k + 1) % 3])] {
                    if g != fi as u32 {
                        neighbours[fi].push(g);
                    }
                }
            }
        }
        Self { edge_faces, neighbours }
    }

    /// The edge two faces share, if they are neighbours.
    fn shared_edge(&self, a: u32, b: u32) -> Option<(u32, u32)> {
        let tri_edges = |f: u32| -> Vec<(u32, u32)> {
            self.edge_faces
                .iter()
                .filter(|(_, faces)| faces.contains(&f))
                .map(|(e, _)| *e)
                .collect()
        };
        tri_edges(a).into_iter().find(|e| self.edge_faces[e].contains(&b))
    }

    /// The face nearest `p` among those within `hops` of `from`.
    fn nearest_around(&self, mesh: &IndexedMesh, from: u32, p: Vec3, hops: usize) -> Option<u32> {
        let mut seen: AHashSet<u32> = AHashSet::from_iter([from]);
        let mut frontier = vec![from];
        let mut best = (f32::INFINITY, from);
        for _ in 0..=hops {
            let mut next = Vec::new();
            for &f in &frontier {
                let t = &mesh.triangles[f as usize];
                let (_, d2) = closest_on_tri(
                    p,
                    mesh.positions[t[0] as usize],
                    mesh.positions[t[1] as usize],
                    mesh.positions[t[2] as usize],
                );
                if d2 < best.0 {
                    best = (d2, f);
                }
                for &n in &self.neighbours[f as usize] {
                    if seen.insert(n) {
                        next.push(n);
                    }
                }
            }
            frontier = next;
        }
        Some(best.1)
    }

    /// The shortest chain of faces from `a` to `b`, each next to the one before.
    fn path_between(&self, a: u32, b: u32, max_hops: usize) -> Option<Vec<u32>> {
        if a == b {
            return Some(vec![a]);
        }
        let mut came_from: AHashMap<u32, u32> = AHashMap::new();
        let mut frontier = vec![a];
        came_from.insert(a, a);
        for _ in 0..max_hops {
            let mut next = Vec::new();
            for &f in &frontier {
                for &n in &self.neighbours[f as usize] {
                    if came_from.contains_key(&n) {
                        continue;
                    }
                    came_from.insert(n, f);
                    if n == b {
                        let mut path = vec![b];
                        let mut cur = b;
                        while cur != a {
                            cur = came_from[&cur];
                            path.push(cur);
                        }
                        path.reverse();
                        return Some(path);
                    }
                    next.push(n);
                }
            }
            frontier = next;
        }
        None
    }
}

fn edge_key(a: u32, b: u32) -> (u32, u32) {
    if a < b { (a, b) } else { (b, a) }
}

// ---------------------------------------------------------------------------
// Retriangulation
// ---------------------------------------------------------------------------

/// Rebuild the crossed faces so the seam runs along their edges.
struct CutFaces {
    mesh: IndexedMesh,
    seam_edges: AHashSet<(u32, u32)>,
    seam_vertices: Vec<u32>,
    source_face: Vec<u32>,
    /// Every edge this seam SPLIT, and the vertices it put along it, in order. A wall
    /// an earlier seam left behind is a pair of vertex indices, and once this seam
    /// crosses that wall the edge it names stops existing — so the earlier wall has
    /// to be renamed in terms of the pieces it fell into, or it silently stops being
    /// a wall.
    split_edges: AHashMap<(u32, u32), Vec<u32>>,
}

fn retriangulate(
    mesh: &IndexedMesh,
    crossings: Vec<Crossing>,
    snap_mm: f32,
) -> Result<CutFaces, String> {
    // A vertex per crossing, shared by the two faces that meet at it — unless the
    // crossing lands on an end of the edge, which is what happens every time the
    // seam passes near a vertex of the mesh. Making a new vertex there would put
    // two of them in the same place and leave the face around it with slivers of no
    // area; the existing vertex is used instead, and the seam simply runs through
    // it. Crossings that land on top of each other on one edge are shared too.
    // How close is "on top of": the SMALLER of two per cent of the edge being
    // crossed and a distance fixed for the whole cut. Either one alone is wrong. A
    // percentage alone is enormous on a big triangle — a model sitting on the plate
    // has a flat base of triangles centimetres across next to a skin of
    // half-millimetre ones, and two per cent of a seven-millimetre edge is 0.14 mm,
    // wider than any joint clearance anyone would ask for, so two seams 0.1 mm apart
    // crossing that edge merged into ONE vertex, the strip between them pinched out,
    // and the wall was left hanging at the pinch. A distance alone is enormous on the
    // slivers the FIRST seam leaves behind, where edges are shorter than the distance
    // itself, and the second seam welds itself to the first all over again.
    let mut positions = mesh.positions.clone();
    let mut vertex_of: Vec<u32> = Vec::with_capacity(crossings.len());
    let mut made_on_edge: AHashMap<(u32, u32), Vec<(f32, u32)>> = AHashMap::new();
    for c in &crossings {
        let (p, q) = (positions[c.edge.0 as usize], positions[c.edge.1 as usize]);
        let len = q.sub(p).length();
        let snap = if len > 1e-9 { (snap_mm / len).min(0.02) } else { 0.5 };
        if c.t <= snap {
            vertex_of.push(c.edge.0);
            continue;
        }
        if c.t >= 1.0 - snap {
            vertex_of.push(c.edge.1);
            continue;
        }
        let made = made_on_edge.entry(c.edge).or_default();
        if let Some(&(_, vi)) = made.iter().find(|(t, _)| (t - c.t).abs() <= snap) {
            vertex_of.push(vi);
            continue;
        }
        positions.push(p.add(q.sub(p).scale(c.t)));
        let vi = (positions.len() - 1) as u32;
        made.push((c.t, vi));
        vertex_of.push(vi);
    }

    // Only the vertices we MADE split an edge; the ones snapped to a corner were
    // already there and must not be inserted into a face's boundary twice. Kept in
    // order along their edge, which is the order the wall runs in where the seam
    // grazes along that edge instead of crossing the face.
    for made in made_on_edge.values_mut() {
        made.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    }
    let on_edge: AHashMap<(u32, u32), Vec<u32>> = made_on_edge
        .iter()
        .map(|(e, made)| (*e, made.iter().map(|(_, vi)| *vi).collect()))
        .collect();

    // Each face collects the chords the seam draws across it: the seam comes in at
    // one crossing and leaves at the next, so consecutive crossings that share a
    // face are the two ends of one chord.
    let mut chords: AHashMap<u32, Vec<(u32, u32)>> = AHashMap::new();
    let mut grazed: Vec<((u32, u32), u32, u32)> = Vec::new();
    let (mut broke_chain, mut same_vertex) = (0usize, 0usize);
    for (i, c) in crossings.iter().enumerate() {
        let j = (i + 1) % crossings.len();
        if c.to != crossings[j].from {
            broke_chain += 1;
            continue;
        }
        if vertex_of[i] == vertex_of[j] {
            same_vertex += 1;
            continue;
        }
        // Both ends on ONE edge of the face: the seam grazed the face instead of
        // crossing it, and the straight "chord" between those two ends runs ALONG
        // that edge, so it has no interior. Cutting the boundary polygon with it
        // splits off a needle of no area — the same needle in EACH of the two faces
        // that share the edge, which is exactly how an edge ends up used four
        // times and the flood fill walks through the wall. The wall the seam needs
        // there is that stretch of the edge, and the crossings have already split
        // it.
        if let Some(e) = shared_face_edge(&mesh.triangles[c.to as usize], &[vertex_of[i], vertex_of[j]], &on_edge) {
            grazed.push((e, vertex_of[i], vertex_of[j]));
            continue;
        }
        chords.entry(c.to).or_default().push((vertex_of[i], vertex_of[j]));
    }

    if std::env::var_os("DF_SPLIT_DEBUG").is_some() {
        eprintln!(
            "[muro] {} cruces: {broke_chain} sin cadena (el paseo saltó), \
             {same_vertex} en el mismo vértice",
            crossings.len()
        );
    }

    // Faces the seam crosses are rebuilt; every other face is kept as it is, so the
    // model away from the cut is untouched, vertex for vertex.
    let touched: AHashSet<u32> = chords.keys().copied().collect();
    let mut triangles: Vec<[u32; 3]> = Vec::with_capacity(mesh.triangles.len() + crossings.len() * 2);
    let mut source_face: Vec<u32> = Vec::with_capacity(triangles.capacity());
    let mut seam_edges: AHashSet<(u32, u32)> = AHashSet::new();
    // Where the seam grazed an edge, the wall is the stretch of that edge between
    // the two ends, sub-segment by sub-segment: the crossings have split the edge,
    // so the whole edge is not there any more to name as one.
    for (e, x, y) in grazed {
        let mut chain = Vec::with_capacity(4);
        chain.push(e.0);
        chain.extend(made_on_edge.get(&e).into_iter().flatten().map(|(_, vi)| *vi));
        chain.push(e.1);
        let (Some(ix), Some(iy)) = (
            chain.iter().position(|v| *v == x),
            chain.iter().position(|v| *v == y),
        ) else {
            continue;
        };
        let (lo, hi) = if ix < iy { (ix, iy) } else { (iy, ix) };
        for pair in chain[lo..=hi].windows(2) {
            seam_edges.insert(edge_key(pair[0], pair[1]));
        }
    }

    for (fi, tri) in mesh.triangles.iter().enumerate() {
        let fi = fi as u32;
        if !touched.contains(&fi) {
            // A face with crossings but no chord still needs its edges split, or the
            // neighbour that WAS rebuilt leaves a T-junction against it.
            if face_has_split_edge(tri, &on_edge) {
                let out = retriangulate_face(&positions, tri, &[], &on_edge)?;
                source_face.extend(std::iter::repeat_n(fi, out.len()));
                triangles.extend(out);
            } else {
                source_face.push(fi);
                triangles.push(*tri);
            }
            continue;
        }
        let face_chords = &chords[&fi];
        for &(a, b) in face_chords {
            seam_edges.insert(edge_key(a, b));
        }
        let out = retriangulate_face(&positions, tri, face_chords, &on_edge)?;
        source_face.extend(std::iter::repeat_n(fi, out.len()));
        triangles.extend(out);
    }

    let split_edges = made_on_edge
        .into_iter()
        .map(|(e, made)| (e, made.into_iter().map(|(_, vi)| vi).collect()))
        .collect();
    Ok(CutFaces {
        mesh: IndexedMesh { positions, triangles },
        seam_edges,
        seam_vertices: vertex_of,
        source_face,
        split_edges,
    })
}

/// Does this face have a crossing on any of its edges?
fn face_has_split_edge(tri: &[u32; 3], on_edge: &AHashMap<(u32, u32), Vec<u32>>) -> bool {
    (0..3).any(|k| on_edge.contains_key(&edge_key(tri[k], tri[(k + 1) % 3])))
}

/// The one edge of `tri` that every vertex of `vs` sits on, if there is one — which
/// is the same as saying they are all in a straight line along the face's boundary.
///
/// A vertex sits on a face's edge when it is one of its ends — every crossing that
/// snapped to a corner is — or when the seam made it there. Asked structurally
/// rather than by measuring how straight the points are: the edge either carries
/// them all or it does not, and the module keeps its epsilons out of the topology.
fn shared_face_edge(
    tri: &[u32; 3],
    vs: &[u32],
    on_edge: &AHashMap<(u32, u32), Vec<u32>>,
) -> Option<(u32, u32)> {
    let carries = |e: &(u32, u32), v: u32| {
        v == e.0 || v == e.1 || on_edge.get(e).is_some_and(|made| made.contains(&v))
    };
    (0..3)
        .map(|k| edge_key(tri[k], tri[(k + 1) % 3]))
        .find(|e| vs.iter().all(|&v| carries(e, v)))
}

/// Triangulate one convex piece of a face by clipping ears off it.
///
/// A fan from a fixed vertex is the obvious thing and it is the leak the module docs
/// open with. This face's boundary carries the crossings its NEIGHBOURS made on the
/// edges they share with it, so three of its vertices are often in a straight line,
/// and a fan anchored at one end of that line spans the whole original edge — which
/// the neighbour has already split.
///
/// The test is on the ear's BASE, the one new edge it adds: it may not run along an
/// edge of the original face. That covers the degenerate ear for free, since three
/// points in a line all sit on one face edge. Clipping an ear off a convex polygon
/// leaves a convex polygon, so no solver is needed.
fn clip_convex_ears(
    positions: &[Vec3],
    poly: &[u32],
    normal: Vec3,
    tri: &[u32; 3],
    on_edge: &AHashMap<(u32, u32), Vec<u32>>,
    out: &mut Vec<[u32; 3]>,
) {
    let mut poly: Vec<u32> = poly.to_vec();
    let mut emit = |x: u32, y: u32, z: u32| {
        let (p, q, r) = (positions[x as usize], positions[y as usize], positions[z as usize]);
        let cross = q.sub(p).cross(r.sub(p));
        if cross.length() > 1e-20 {
            // Wind it the way the face pointed.
            out.push(if cross.dot(normal) >= 0.0 { [x, y, z] } else { [x, z, y] });
        }
    };
    while poly.len() > 3 {
        let n = poly.len();
        let ear = (0..n).find(|&k| {
            shared_face_edge(tri, &[poly[(k + n - 1) % n], poly[(k + 1) % n]], on_edge).is_none()
        });
        // No ear left means every remaining vertex is on one edge of the face, so
        // what is left has no area and nothing to add.
        let Some(k) = ear else { return };
        emit(poly[(k + n - 1) % n], poly[k], poly[(k + 1) % n]);
        poly.remove(k);
    }
    // The last three are the piece itself, base and all — unless they are in a line.
    if poly.len() == 3 && shared_face_edge(tri, &poly, on_edge).is_none() {
        emit(poly[0], poly[1], poly[2]);
    }
}

/// Rebuild one face: its corners, the crossings sitting on its edges, and the
/// seam's chords across it.
///
/// A triangle is convex, and a chord between two points of its boundary cuts it
/// into two convex polygons — which stays true however many chords are added, so
/// each piece triangulates without a solver. (A constrained Delaunay pass looked
/// like the obvious tool and is the wrong one: given a chord it treats it as the
/// boundary of a region and hands back only the side it decides is inside, quietly
/// dropping the rest of the face.)
fn retriangulate_face(
    positions: &[Vec3],
    tri: &[u32; 3],
    chords: &[(u32, u32)],
    on_edge: &AHashMap<(u32, u32), Vec<u32>>,
) -> Result<Vec<[u32; 3]>, String> {
    let (a, b, c) = (positions[tri[0] as usize], positions[tri[1] as usize], positions[tri[2] as usize]);
    let normal = b.sub(a).cross(c.sub(a));
    if normal.length() < 1e-18 {
        return Ok(vec![*tri]); // degenerate face: leave it be
    }


    // The face's boundary, walked corner to corner, with every crossing that sits
    // on each edge inserted in order along it. The neighbour across an edge walks
    // that same edge the other way and meets the same points, so the two agree.
    let mut cycle: Vec<u32> = Vec::with_capacity(3 + chords.len() * 2);
    for k in 0..3 {
        let (s, e) = (tri[k], tri[(k + 1) % 3]);
        cycle.push(s);
        let mut on_this: Vec<u32> = on_edge.get(&edge_key(s, e)).cloned().unwrap_or_default();
        on_this.sort_unstable();
        on_this.dedup();
        let sp = positions[s as usize];
        let dir = positions[e as usize].sub(sp);
        on_this.sort_by(|x, y| {
            let dx = positions[*x as usize].sub(sp).dot(dir);
            let dy = positions[*y as usize].sub(sp).dot(dir);
            dx.partial_cmp(&dy).unwrap_or(std::cmp::Ordering::Equal)
        });
        cycle.extend(on_this);
    }
    if cycle.len() == 3 && chords.is_empty() {
        return Ok(vec![*tri]);
    }

    // Cut the boundary polygon with each chord in turn.
    let mut polygons: Vec<Vec<u32>> = vec![cycle];
    for &(x, y) in chords {
        if x == y {
            continue;
        }
        // A chord whose ends are already next to each other round the boundary IS a
        // boundary edge — the seam is running along an edge the mesh already has,
        // which happens the moment a second seam meets the first one's work. There
        // is nothing to cut, and cutting anyway lays a second copy of the face's own
        // triangles on top of the first.
        if polygons.iter().any(|p| {
            let (ix, iy) = (p.iter().position(|v| *v == x), p.iter().position(|v| *v == y));
            match (ix, iy) {
                (Some(i), Some(j)) => (i + 1) % p.len() == j || (j + 1) % p.len() == i,
                _ => false,
            }
        }) {
            continue;
        }
        let Some(pi) = polygons.iter().position(|p| p.contains(&x) && p.contains(&y)) else {
            continue; // the chord's ends are not on one piece: nothing to cut
        };
        let poly = polygons.swap_remove(pi);
        let (ix, iy) = (
            poly.iter().position(|v| *v == x).expect("x on polygon"),
            poly.iter().position(|v| *v == y).expect("y on polygon"),
        );
        let (lo, hi) = if ix < iy { (ix, iy) } else { (iy, ix) };
        let first: Vec<u32> = poly[lo..=hi].to_vec();
        let second: Vec<u32> = poly[hi..].iter().chain(poly[..=lo].iter()).copied().collect();
        // A "piece" of two points is the chord lying along the boundary: no area.
        for piece in [first, second] {
            if piece.len() >= 3 {
                polygons.push(piece);
            }
        }
    }

    let mut out = Vec::with_capacity(polygons.len() * 2);
    for poly in polygons {
        clip_convex_ears(positions, &poly, normal, tri, on_edge, &mut out);
    }
    if std::env::var_os("DF_SPLIT_DEBUG").is_some() {
        let area = |x: u32, y: u32, z: u32| {
            let (p, q, r) = (positions[x as usize], positions[y as usize], positions[z as usize]);
            q.sub(p).cross(r.sub(p)).length() * 0.5
        };
        let whole = area(tri[0], tri[1], tri[2]);
        let sum: f32 = out.iter().map(|t| area(t[0], t[1], t[2])).sum();
        if (sum - whole).abs() > whole * 0.01 {
            eprintln!(
                "[trozos] cara {tri:?} área {whole:.5} -> {sum:.5} con {} cuerdas {:?}",
                chords.len(), chords
            );
        }
    }
    Ok(out)
}

/// Which piece each face belongs to, by walking the face graph without ever
/// stepping over a seam edge.
fn pieces(mesh: &IndexedMesh, seam_edges: &AHashSet<(u32, u32)>) -> Vec<u32> {
    let mut edge_faces: AHashMap<(u32, u32), Vec<u32>> = AHashMap::new();
    for (fi, t) in mesh.triangles.iter().enumerate() {
        for k in 0..3 {
            edge_faces.entry(edge_key(t[k], t[(k + 1) % 3])).or_default().push(fi as u32);
        }
    }
    let mut neighbours: Vec<Vec<u32>> = vec![Vec::new(); mesh.triangles.len()];
    for (e, faces) in &edge_faces {
        if seam_edges.contains(e) {
            continue; // the seam is a wall
        }
        for (i, &f) in faces.iter().enumerate() {
            for &g in faces.iter().skip(i + 1) {
                neighbours[f as usize].push(g);
                neighbours[g as usize].push(f);
            }
        }
    }

    let mut piece: Vec<u32> = vec![u32::MAX; mesh.triangles.len()];
    let mut label = 0u32;
    for start in 0..mesh.triangles.len() {
        if piece[start] != u32::MAX {
            continue;
        }
        let mut queue = std::collections::VecDeque::from([start as u32]);
        piece[start] = label;
        while let Some(f) = queue.pop_front() {
            for &n in &neighbours[f as usize] {
                if piece[n as usize] == u32::MAX {
                    piece[n as usize] = label;
                    queue.push_back(n);
                }
            }
        }
        label += 1;
    }
    piece
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A cube, subdivided so its faces are smaller than the seam's steps.
    fn cube(size: f32, n: usize) -> IndexedMesh {
        let mut positions = Vec::new();
        let mut triangles = Vec::new();
        let s = size / n as f32;
        // Six faces, each an n×n grid; vertices are welded afterwards by position.
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
                push_quad(Vec3::new(x, y, 0.0), dy, dx); // bottom
                push_quad(Vec3::new(x, y, size), dx, dy); // top
                push_quad(Vec3::new(x, 0.0, y), dx, dz); // front
                push_quad(Vec3::new(x, size, y), dz, dx); // back
                push_quad(Vec3::new(0.0, x, y), dz, dy); // left
                push_quad(Vec3::new(size, x, y), dy, dz); // right
            }
        }
        let soup: Vec<f32> = triangles
            .iter()
            .flat_map(|t| t.iter().flat_map(|&i| { let p = positions[i as usize]; [p.x, p.y, p.z] }).collect::<Vec<f32>>())
            .collect();
        IndexedMesh::from_triangle_soup(&soup, 1e-5)
    }

    /// The face graph has to come out the same on every run. Both of its readers
    /// break ties by whichever neighbour they met first, so an order that comes from
    /// a hash map makes the seam walk a different way through the same model each
    /// time, and the same cut lands one or two triangles apart between runs.
    #[test]
    fn face_neighbours_follow_the_mesh_not_a_hash_map() {
        let mesh = cube(10.0, 3);
        let topo = Topology::build(&mesh);
        for (fi, t) in mesh.triangles.iter().enumerate() {
            let expected: Vec<u32> = (0..3)
                .flat_map(|k| topo.edge_faces[&edge_key(t[k], t[(k + 1) % 3])].iter().copied())
                .filter(|g| *g != fi as u32)
                .collect();
            assert_eq!(topo.neighbours[fi], expected, "face {fi}");
        }
    }

    fn open_edges(mesh: &IndexedMesh) -> usize {
        let mut counts: AHashMap<(u32, u32), usize> = AHashMap::new();
        for t in &mesh.triangles {
            for k in 0..3 {
                *counts.entry(edge_key(t[k], t[(k + 1) % 3])).or_default() += 1;
            }
        }
        counts.values().filter(|c| **c != 2).count()
    }

    /// A torus — a tentacle that leaves the body and fuses back to it.
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

    // The cut still has to be watertight where it cannot separate: one ring round
    // a tentacle encircles a handle, so the surface stays in ONE piece — but it is
    // cut all the same, and must not be left open.
    #[test]
    fn a_seam_round_a_handle_cuts_cleanly_without_separating() {
        let model = torus(10.0, 3.0, 64, 32);
        let one = tube_ring(10.0, 3.0, 0.3, 96);
        let split = split_along_seam(&model, &one).expect("the seam should cut the surface");
        assert_eq!(open_edges(&split.mesh), 0, "cutting the surface must not open it");
        let pieces: AHashSet<u32> = split.piece_of_face.iter().copied().collect();
        assert_eq!(pieces.len(), 1, "a ring round a handle leaves one piece: {pieces:?}");
    }

    #[test]
    fn two_seams_round_a_handle_cut_the_tentacle_free() {
        let model = torus(10.0, 3.0, 64, 32);
        let first = tube_ring(10.0, 3.0, 0.3, 96);
        // Off the mesh's own ring lines: a seam landing exactly ON existing edges is
        // its own problem (see the module docs), and no hand-drawn one does.
        let second = tube_ring(10.0, 3.0, std::f32::consts::PI + 0.05, 96);
        let split = split_along_seams(&model, &[first, second]).expect("both seams");
        assert_eq!(open_edges(&split.mesh), 0, "still watertight after two cuts");
        let pieces: AHashSet<u32> = split.piece_of_face.iter().copied().collect();
        assert_eq!(pieces.len(), 2, "two rings free the length of tube between them: {pieces:?}");
    }

    // A seam that wanders instead of running straight crosses some faces more than
    // once, which is where a face gets several chords and the rebuild has to keep
    // its pieces from overlapping.
    #[test]
    fn a_wandering_seam_still_leaves_the_surface_closed() {
        let model = torus(10.0, 3.0, 64, 32);
        let seam: Vec<Vec3> = (0..240)
            .map(|k| {
                let f = k as f32 / 240.0;
                let v = f * std::f32::consts::TAU;
                // Wobble round the torus as it goes round the tube.
                let u = 0.3 + 0.25 * (v * 5.0).sin();
                let r = 10.0 + 3.0 * v.cos();
                Vec3::new(r * u.cos(), r * u.sin(), 3.0 * v.sin())
            })
            .collect();
        let split = split_along_seam(&model, &seam).expect("a wandering seam still cuts");
        assert_eq!(open_edges(&split.mesh), 0, "cutting the surface must not open it");
    }

    // The seam grazing the mesh's own vertices is the case that leaked on the real
    // model: a crossing that lands within the snapping distance of a corner uses the
    // corner, so a
    // face ends up split on one edge and nothing else, and a triangulation anchored
    // at a fixed vertex then spans that split edge. Both faces sharing it do the
    // same, and the edge comes out used four times — closed, but not manifold, and
    // the flood fill goes straight through the wall. The cube's grid line is at
    // z = 5 and its faces are 1.25 across, so a ring 0.025 above it crosses at
    // exactly the snapping distance.
    #[test]
    fn a_seam_grazing_the_mesh_s_own_vertices_still_tiles() {
        let model = cube(10.0, 8);
        let z = 5.025;
        let ring: Vec<Vec3> = (0..80)
            .map(|k| {
                let t = (k % 20) as f32 * 0.5;
                match k / 20 {
                    0 => Vec3::new(t, 0.0, z),
                    1 => Vec3::new(10.0, t, z),
                    2 => Vec3::new(10.0 - t, 10.0, z),
                    _ => Vec3::new(0.0, 10.0 - t, z),
                }
            })
            .collect();
        let split = split_along_seam(&model, &ring).expect("the seam should cut the surface");
        // `open_edges` counts every edge NOT used by exactly two faces, so this is
        // the four-times case as much as the hole.
        assert_eq!(open_edges(&split.mesh), 0, "every edge belongs to exactly two faces");
        let labels: AHashSet<u32> = split.piece_of_face.iter().copied().collect();
        assert_eq!(labels.len(), 2, "the surface still falls in exactly two: {labels:?}");
    }

    #[test]
    fn a_seam_round_a_cube_cuts_its_surface_in_two() {
        let model = cube(10.0, 8);
        assert_eq!(open_edges(&model), 0, "the test cube starts closed");
        // A ring round the cube at z = 5.2, off the grid lines on purpose so the
        // seam crosses faces rather than following them.
        let z = 5.2;
        let ring: Vec<Vec3> = (0..80)
            .map(|k| {
                let t = (k % 20) as f32 * 0.5;
                match k / 20 {
                    0 => Vec3::new(t, 0.0, z),
                    1 => Vec3::new(10.0, t, z),
                    2 => Vec3::new(10.0 - t, 10.0, z),
                    _ => Vec3::new(0.0, 10.0 - t, z),
                }
            })
            .collect();

        let split = split_along_seam(&model, &ring).expect("the seam should cut the surface");
        assert_eq!(open_edges(&split.mesh), 0, "cutting the surface must not open it");

        let labels: AHashSet<u32> = split.piece_of_face.iter().copied().collect();
        assert_eq!(labels.len(), 2, "the surface falls in exactly two: {labels:?}");
        let above = split.piece_of_face.iter().filter(|p| **p == 0).count();
        assert!(above > 0 && above < split.mesh.triangles.len(), "both sides carry faces");
    }

    /// Two seams a tenth of a millimetre apart on a mesh of hundred-millimetre
    /// triangles — a joint clearance on the flat base a model stands on. The snapping
    /// distance used to be two per cent of the crossed edge, which is 1 mm here: both seams
    /// crossed the same edge, both were snapped to the SAME vertex, the strip between
    /// them pinched out at that vertex, and the wall between a body and the strip
    /// stopped dead there. Nothing was reported: the surface stayed closed, the fill
    /// walked round the pinch, and the cut simply did nothing.
    #[test]
    fn two_seams_closer_together_than_the_triangles_they_cross_stay_apart() {
        let model = cube(100.0, 1);
        let ring_at = |z: f32| -> Vec<Vec3> {
            (0..80)
                .map(|k| {
                    let t = (k % 20) as f32 * 5.0;
                    match k / 20 {
                        0 => Vec3::new(t, 0.0, z),
                        1 => Vec3::new(100.0, t, z),
                        2 => Vec3::new(100.0 - t, 100.0, z),
                        _ => Vec3::new(0.0, 100.0 - t, z),
                    }
                })
                .collect()
        };
        let seams = vec![ring_at(52.0), ring_at(52.1)];
        let split = split_along_seams(&model, &seams).expect("two close seams should cut");
        assert_eq!(open_edges(&split.mesh), 0, "cutting the surface must not open it");
        assert!(
            split.loose_wall_ends().is_empty(),
            "the wall must not stop dead: {:?}",
            split.loose_wall_ends()
        );
        let labels: AHashSet<u32> = split.piece_of_face.iter().copied().collect();
        assert_eq!(labels.len(), 3, "top, bottom and the strip between: {labels:?}");

        // And the strip is named for what it is. It is the band the clearance is made
        // of — the piece that runs along both seams — and binning the wrong one hands
        // the user the shaving and bins the model.
        // Not by size — on a mesh this coarse the band round the cube carries more
        // faces than the lid it separates — but by where it is: every face of the
        // strip lies inside the tenth of a millimetre between the two seams.
        let strips = split.strips_between(0, 1);
        assert_eq!(strips.len(), 1, "one unbroken band round the cube: {strips:?}");
        for (fi, t) in split.mesh.triangles.iter().enumerate() {
            if split.piece_of_face[fi] != strips[0] {
                continue;
            }
            for &v in t {
                let z = split.mesh.positions[v as usize].z;
                assert!(
                    (51.99..=52.11).contains(&z),
                    "a face of the strip sits at z = {z}, outside the seams at 52.0 and 52.1",
                );
            }
        }

        // THE DISASTER, in one line. When the two offsets sever nothing, everything
        // is one piece — and that one piece has both seams along its border, in full
        // and perfectly balanced, so a test made only of balance calls it the strip
        // and bins the model. (In the real report it was 500 022 of 500 186
        // triangles, thrown away, with the crumbs handed back as the cut.) What saves
        // it is that a strip is THIN: this piece is the whole cube, and almost none
        // of it lies on the seams.
        let mut nothing_separated = split;
        nothing_separated.piece_of_face.iter_mut().for_each(|p| *p = 0);
        assert!(
            nothing_separated.strips_between(0, 1).is_empty(),
            "a piece that is the whole model is not the strip of a 0.1 mm clearance",
        );
    }
}
