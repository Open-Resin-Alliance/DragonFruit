//! Smoke tests for the repair pipeline on synthetic fixtures.

use dragonfruit_mesh_repair::core::mesh::{IndexedMesh, Vec3};
use dragonfruit_mesh_repair::evaluate::evaluate;
use dragonfruit_mesh_repair::{analyze, repair, repair_with_progress, RepairOptions};

/// Build a unit cube with outward-facing winding.
fn unit_cube() -> IndexedMesh {
    let positions = vec![
        Vec3::new(0.0, 0.0, 0.0), // 0
        Vec3::new(1.0, 0.0, 0.0), // 1
        Vec3::new(1.0, 1.0, 0.0), // 2
        Vec3::new(0.0, 1.0, 0.0), // 3
        Vec3::new(0.0, 0.0, 1.0), // 4
        Vec3::new(1.0, 0.0, 1.0), // 5
        Vec3::new(1.0, 1.0, 1.0), // 6
        Vec3::new(0.0, 1.0, 1.0), // 7
    ];
    let triangles = vec![
        // -Z face (normal = -Z, outward for min-z face)
        [0, 2, 1],
        [0, 3, 2],
        // +Z face
        [4, 5, 6],
        [4, 6, 7],
        // -Y face
        [0, 1, 5],
        [0, 5, 4],
        // +Y face
        [3, 7, 6],
        [3, 6, 2],
        // -X face
        [0, 4, 7],
        [0, 7, 3],
        // +X face
        [1, 2, 6],
        [1, 6, 5],
    ];
    IndexedMesh {
        positions,
        triangles,
    }
}

#[test]
fn watertight_cube_is_clean() {
    let mesh = unit_cube();
    let report = analyze(&mesh);
    assert_eq!(report.triangle_count, 12);
    assert_eq!(report.vertex_count, 8);
    assert_eq!(report.boundary_edges, 0, "cube has no boundary");
    assert_eq!(report.non_manifold_edges, 0, "cube is manifold");
    assert_eq!(report.connected_components, 1);
    assert!(report.is_watertight);
    assert!(
        report.signed_volume > 0.0,
        "cube should have positive volume"
    );
}

#[test]
fn duplicated_vertices_are_welded() {
    let mut mesh = unit_cube();
    // Duplicate every vertex so tris reference distinct-but-coincident slots.
    let original_len = mesh.positions.len();
    let dup_positions: Vec<Vec3> = mesh.positions.clone();
    mesh.positions.extend(dup_positions);
    // Rewrite tris to use the duplicates for index 0, originals for 1,2.
    for tri in mesh.triangles.iter_mut() {
        tri[0] += original_len as u32;
    }
    let outcome = repair(mesh, &RepairOptions::default());
    assert_eq!(
        outcome.mesh.vertex_count(),
        8,
        "welding should reduce to 8 unique corners"
    );
    assert!(outcome
        .report
        .steps
        .iter()
        .any(|s| s.name == "stitch" && s.changed > 0));
}

#[test]
fn inverted_cube_gets_flipped() {
    let mut mesh = unit_cube();
    for tri in mesh.triangles.iter_mut() {
        tri.swap(1, 2);
    }
    assert!(mesh.signed_volume() < 0.0);
    let outcome = repair(mesh, &RepairOptions::default());
    assert!(
        outcome.mesh.signed_volume() > 0.0,
        "orientation repair should flip inverted cube to positive volume"
    );
    assert!(outcome.report.post.is_watertight);
}

#[test]
fn hole_is_filled() {
    let mut mesh = unit_cube();
    // Remove the -Z face (2 triangles).
    mesh.triangles.remove(0);
    mesh.triangles.remove(0);
    let pre = analyze(&mesh);
    assert!(
        pre.boundary_edges > 0,
        "cube missing a face should have a boundary"
    );
    let outcome = repair(mesh, &RepairOptions::default());
    assert_eq!(
        outcome.report.post.boundary_edges, 0,
        "small hole should be filled"
    );
    assert!(outcome.report.post.is_watertight);
}

#[test]
fn duplicate_triangles_are_culled() {
    let mut mesh = unit_cube();
    mesh.triangles.push(mesh.triangles[0]);
    mesh.triangles.push(mesh.triangles[1]);
    let outcome = repair(mesh, &RepairOptions::default());
    assert_eq!(outcome.mesh.triangles.len(), 12);
}

#[test]
fn degenerate_triangles_are_culled() {
    let mut mesh = unit_cube();
    // Add a zero-area degenerate (repeated index).
    mesh.triangles.push([0, 0, 1]);
    let outcome = repair(mesh, &RepairOptions::default());
    assert_eq!(outcome.mesh.triangles.len(), 12);
}

/// The stage order is the design, not an accident.
///
/// Orientation, stitch, holes and double faces each disturb what the one before it
/// settled, so they come round more than once. A refactor that "simplifies" this list
/// has changed what the repair does, and this is where that shows up.
///
/// What is *not* in the list is the stages that would provably do nothing on this input, and
/// leaving them out is the point rather than a simplification: `double_faces_after_split` is only
/// worth running when something since the first cull could have made a duplicate — the crossing
/// split, or rounds 5 and 6 — and on a cube all of those are no-ops. Its place in the order when it
/// does run is asserted below.
#[test]
fn the_pipeline_runs_the_stage_order_it_says_it_does() {
    let outcome = repair(unit_cube(), &RepairOptions::default());
    let names: Vec<&str> = outcome
        .report
        .steps
        .iter()
        .map(|step| step.name.as_str())
        .collect();
    assert_eq!(
        names,
        [
            "orient_components",
            "stitch",
            "holes_trivial",
            "double_faces",
            "orient_holes_stitch",
            "orient_holes_all_stitch",
            "remove_inner_faces",
            "noise_shells",
            "settle",
            "repair_rounds",
            "prune_and_classify",
        ]
    );
}

/// Where the second double-face pass goes, on the runs that have one.
///
/// It comes after the round that produces duplicates and before the faces inside are removed, and
/// it is the only stage whose presence depends on what the passes before it did.
#[test]
fn the_second_double_face_pass_sits_between_the_rounds_and_the_inside() {
    // A mesh with a crossing: two unit cubes overlapping along one edge. The split refines it and
    // the second cull therefore has something to judge.
    let mut mesh = unit_cube();
    let offset = 0.5_f32;
    let base = mesh.positions.len() as u32;
    for position in mesh.positions.clone() {
        mesh.positions
            .push(Vec3::new(position.x + offset, position.y, position.z));
    }
    for triangle in mesh.triangles.clone() {
        mesh.triangles
            .push([triangle[0] + base, triangle[1] + base, triangle[2] + base]);
    }
    let options = RepairOptions {
        resolve_self_intersections: true,
        ..RepairOptions::default()
    };
    let outcome = repair(mesh, &options);
    let names: Vec<&str> = outcome
        .report
        .steps
        .iter()
        .map(|step| step.name.as_str())
        .collect();
    let after = names.iter().position(|n| *n == "orient_holes_all_stitch");
    let inside = names.iter().position(|n| *n == "remove_inner_faces");
    if let Some(at) = names.iter().position(|n| *n == "double_faces_after_split") {
        assert!(
            after.expect("rounds ran") < at && at < inside.expect("the inside pass ran"),
            "the second cull must sit between the rounds and the inside pass, got {names:?}"
        );
    }
    assert!(
        names.contains(&"split_self_intersections"),
        "the split was asked for, so its stage has to be reported: {names:?}"
    );
}

/// A patch has to leave the rim along the surface it belongs to, not cut across it.
///
/// This is the acceptance test for the tangent-continuing patch, and it pins the property that
/// distinguishes it from a flat cap: a hole punched out of a *curved* wall. The wall is a closed
/// cylinder, so the hole is the mesh's only boundary and nothing the patch adds can be an end cap; the
/// hole spans half the circumference, so a flat patch has to pass near the axis while the wall it is
/// closing is out at the radius. Both kinds of patch are watertight and both are wound consistently and
/// both are manifold, so the geometry is the only thing that separates them, which is why the
/// assertion is a radius.
#[test]
fn a_hole_in_a_curved_wall_is_patched_tangent_to_it() {
    const SEGMENTS: usize = 16;
    const ROWS: usize = 5;
    const RADIUS: f32 = 10.0;
    const HEIGHT: f32 = 4.0;
    // The block of quads to remove: half the circumference, two rows tall.
    const HOLE_FROM: usize = 4;
    const HOLE_TO: usize = 12;

    let mut positions = Vec::new();
    for row in 0..ROWS {
        for segment in 0..SEGMENTS {
            let theta = std::f32::consts::TAU * segment as f32 / SEGMENTS as f32;
            positions.push(Vec3::new(
                RADIUS * theta.cos(),
                RADIUS * theta.sin(),
                row as f32 * HEIGHT / (ROWS - 1) as f32,
            ));
        }
    }
    // A centre vertex for each end, so the cylinder is a closed solid and its side is the only place a
    // hole can be.
    positions.push(Vec3::new(0.0, 0.0, 0.0));
    positions.push(Vec3::new(0.0, 0.0, HEIGHT));
    let (bottom, top) = ((ROWS * SEGMENTS) as u32, (ROWS * SEGMENTS + 1) as u32);

    let index = |row: usize, segment: usize| (row * SEGMENTS + segment % SEGMENTS) as u32;
    let mut triangles = Vec::new();
    for row in 0..ROWS - 1 {
        for segment in 0..SEGMENTS {
            if (HOLE_FROM..HOLE_TO).contains(&segment) && row == 1 {
                continue;
            }
            let (a, b) = (index(row, segment), index(row, segment + 1));
            let (c, d) = (index(row + 1, segment), index(row + 1, segment + 1));
            triangles.push([a, b, d]);
            triangles.push([a, d, c]);
        }
    }
    for segment in 0..SEGMENTS {
        let (a, b) = (index(0, segment), index(0, segment + 1));
        triangles.push([bottom, b, a]);
        let (c, d) = (index(ROWS - 1, segment), index(ROWS - 1, segment + 1));
        triangles.push([top, c, d]);
    }
    let mut mesh = IndexedMesh { positions, triangles };

    let before = evaluate(&mesh);
    assert_eq!(before.holes, 1, "the removed block must leave exactly one loop");

    let before_triangles = mesh.triangles.len();
    let added = dragonfruit_mesh_repair::holes::holes_all(&mut mesh, usize::MAX);
    assert!(added > 0, "the hole must be filled");

    let after = evaluate(&mesh);
    assert_eq!(after.holes, 0, "the patch must close it");
    assert_eq!(
        after.inconsistent_edges, 0,
        "the patch must be wound with the wall"
    );
    assert_eq!(
        after.non_manifold_edges, 0,
        "the patch must not pinch an edge"
    );

    // The surface, not just the vertices: a patch can put every vertex on the wall and still span the
    // hole between them, which is what a flat cap over a curved rim does. Sampling each face — its
    // three corners and its three edge midpoints — measures the surface.
    let radius = |v: u32| {
        let p = mesh.positions[v as usize];
        (p.x * p.x + p.y * p.y).sqrt()
    };
    let mid = |a: u32, b: u32| {
        let p = mesh.positions[a as usize];
        let q = mesh.positions[b as usize];
        let c = p.add(q).scale(0.5);
        (c.x * c.x + c.y * c.y).sqrt()
    };
    let mut innermost = f32::INFINITY;
    for t in &mesh.triangles[before_triangles..] {
        for sample in [
            radius(t[0]),
            radius(t[1]),
            radius(t[2]),
            mid(t[0], t[1]),
            mid(t[1], t[2]),
            mid(t[2], t[0]),
        ] {
            innermost = innermost.min(sample);
        }
    }
    assert!(
        innermost > RADIUS * 0.9,
        "the patch must follow the wall, not span it: the innermost point of the added surface is at \
         radius {innermost:.2} against a wall at {RADIUS:.1} whose chord passes near the axis"
    );
}

/// The sink hears about each stage before it runs, and stopping it stops the run.
#[test]
fn the_progress_sink_sees_each_stage_and_can_stop_the_run() {
    let mut seen: Vec<String> = Vec::new();
    let outcome = repair_with_progress(
        unit_cube(),
        &RepairOptions::default(),
        Some(&mut |name, index| {
            seen.push(format!("{index}:{name}"));
            true
        }),
    );
    let named: Vec<&str> = seen
        .iter()
        .map(|entry| entry.split(':').nth(1).unwrap())
        .collect();
    let recorded: Vec<&str> = outcome
        .report
        .steps
        .iter()
        .map(|step| step.name.as_str())
        .collect();
    assert_eq!(
        named, recorded,
        "the sink has to name the stage it is announcing, in the order the report records them"
    );
    assert_eq!(seen[0], "1:orient_components");
    assert!(!outcome.report.cancelled);

    // Say no to the third stage and the run stops at the boundary before it.
    let mut asked = 0;
    let stopped = repair_with_progress(
        unit_cube(),
        &RepairOptions::default(),
        Some(&mut |_, _| {
            asked += 1;
            asked < 3
        }),
    );
    assert!(stopped.report.cancelled);
    assert_eq!(stopped.report.steps.len(), 2, "the third stage never ran");
    assert!(
        !stopped.report.fully_repaired || stopped.report.post.is_watertight,
        "a cancelled run still reports the mesh it has"
    );
}

/// A solid with a cavity keeps its cavity.
///
/// The wall of a cavity faces inward, which is what a cavity wall is. A per-component
/// outward vote turns it outward, and that makes the cavity a solid and moves the model's
/// volume: on a real multi-component model it flipped 83,745 faces and the volume moved 17%.
/// The orientation pass propagates winding per patch and guards its component vote with a
/// nesting test, so a component sitting inside another keeps the orientation it has.
#[test]
fn a_cavity_keeps_its_orientation() {
    let mut mesh = unit_cube();
    let outer_faces = mesh.triangles.len();

    // A smaller cube inside it, wound the other way, which is what a cavity looks like.
    let base = mesh.positions.len() as u32;
    for corner in [
        Vec3::new(0.3, 0.3, 0.3),
        Vec3::new(0.7, 0.3, 0.3),
        Vec3::new(0.7, 0.7, 0.3),
        Vec3::new(0.3, 0.7, 0.3),
        Vec3::new(0.3, 0.3, 0.7),
        Vec3::new(0.7, 0.3, 0.7),
        Vec3::new(0.7, 0.7, 0.7),
        Vec3::new(0.3, 0.7, 0.7),
    ] {
        mesh.positions.push(corner);
    }
    let inner = [
        [0u32, 2, 1], [0, 3, 2],
        [4, 5, 6], [4, 6, 7],
        [0, 1, 5], [0, 5, 4],
        [3, 7, 6], [3, 6, 2],
        [0, 4, 7], [0, 7, 3],
        [1, 2, 6], [1, 6, 5],
    ];
    for face in inner {
        mesh.triangles.push([face[0] + base, face[1] + base, face[2] + base]);
    }
    assert_eq!(mesh.triangles.len(), outer_faces * 2);

    let before = mesh.signed_volume();
    assert!(before > 0.9, "the cavity should subtract: {before}");
    assert_eq!(analyze(&mesh).inconsistent_winding_edges, 0);

    let outcome = repair(mesh, &RepairOptions::default());
    let after = outcome.mesh.signed_volume();
    assert!(
        (after - before).abs() / before.abs() < 1e-3,
        "the cavity was turned inside out: {before} -> {after}"
    );
    assert_eq!(
        outcome.report.post.inconsistent_winding_edges, 0,
        "and the winding is still consistent"
    );
}

/// Two surfaces sharing an edge are separated, and the mesh comes out manifold.
///
/// A cube with a third triangle hung off one of its edges. That edge carries three faces,
/// two forward and one backward, which no pairing resolves. The split gives each surface its
/// own copy of the edge's vertices, moved into its own solid, so a re-read of the exported
/// file cannot merge them back. This is the watertight repair of overlapping parts, and it is
/// the one case the pipeline could previously only report.
#[test]
fn a_shared_edge_is_separated() {
    let mut mesh = unit_cube();
    let apex = mesh.positions.len() as u32;
    mesh.positions.push(Vec3::new(0.5, -0.4, 0.6));
    mesh.triangles.push([0, 1, apex]);

    let before = analyze(&mesh);
    assert!(
        before.non_manifold_edges > 0,
        "the fixture has to start with a shared edge: {before:?}"
    );

    let outcome = repair(mesh, &RepairOptions::default());
    let after = &outcome.report.post;
    assert_eq!(
        after.non_manifold_edges, 0,
        "the shared edge should be separated: {:?}",
        outcome.report.residual_issues
    );
    assert!(
        after.boundary_edges <= before.boundary_edges,
        "and it must not open anything: {} -> {}",
        before.boundary_edges,
        after.boundary_edges
    );

    // And the order they run in. The union merges parts that overlap and skips any component that
    // is not already manifold; the split offsets the surfaces it separates, so nothing can merge
    // them afterwards. Running the split first separates surfaces and then leaves the union unable
    // to merge anything, which measured as 240 parts where the other order gives 43.
    let names: Vec<&str> = outcome
        .report
        .steps
        .iter()
        .map(|step| step.name.as_str())
        .collect();
    let union_at = names
        .iter()
        .position(|name| *name == "union_overlapping_parts")
        .expect("the fixture has bad edges, so the union runs");
    let split_at = names
        .iter()
        .position(|name| *name == "split_non_manifold_edges")
        .expect("and a shared edge, so the split runs");
    assert!(
        union_at < split_at,
        "the union has to run before the split or it has nothing it can merge: {names:?}"
    );
}

/// Small shells that are not scraps are kept.
///
/// A model with supports is a model with hundreds of small closed shells. The reference's
/// noise-shell rule also deletes a shell whose area is under a hundredth of the mesh's and whose
/// triangle count is under a twentieth, and every support pillar is one: on `COOKIE_b4.stl` it
/// took 88,912 faces and the repair reported success while the supports were gone.
///
/// The mistakes are not symmetric. Keeping a stray shell costs a shell the user can see and
/// delete; deleting a support costs a print.
#[test]
fn small_shells_that_are_not_scraps_are_kept() {
    let mut mesh = unit_cube();
    for pillar in 0..12 {
        let base = mesh.positions.len() as u32;
        let x = 2.0 + pillar as f32 * 0.5;
        for corner in [
            Vec3::new(x, 0.0, 0.0),
            Vec3::new(x + 0.2, 0.0, 0.0),
            Vec3::new(x + 0.2, 0.2, 0.0),
            Vec3::new(x, 0.2, 0.0),
            Vec3::new(x, 0.0, 0.2),
            Vec3::new(x + 0.2, 0.0, 0.2),
            Vec3::new(x + 0.2, 0.2, 0.2),
            Vec3::new(x, 0.2, 0.2),
        ] {
            mesh.positions.push(corner);
        }
        for face in [
            [0u32, 2, 1], [0, 3, 2],
            [4, 5, 6], [4, 6, 7],
            [0, 1, 5], [0, 5, 4],
            [3, 7, 6], [3, 6, 2],
            [0, 4, 7], [0, 7, 3],
            [1, 2, 6], [1, 6, 5],
        ] {
            mesh.triangles.push([face[0] + base, face[1] + base, face[2] + base]);
        }
    }

    let before = analyze(&mesh);
    assert_eq!(before.connected_components, 13, "the fixture is a model and 12 pillars");

    let outcome = repair(mesh, &RepairOptions::default());
    let after = &outcome.report.post;
    assert_eq!(
        after.connected_components, before.connected_components,
        "no pillar is a scrap: {:?}",
        outcome.report.residual_issues
    );
    assert_eq!(
        after.triangle_count, before.triangle_count,
        "and no pillar lost a face"
    );
}
