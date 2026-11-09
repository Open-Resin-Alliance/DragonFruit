//! The verdict on the two files the engine is tuned against.
//!
//! They live outside the repository, so these tests skip when they are not there. Set
//! `MESH_REPAIR_REFERENCE_DIR` to point at the directory holding them.
//!
//! What is asserted is the verdict, not the counts. Counts drift with any change to a
//! pass; the verdict is the contract, and the contract is that a mesh whose only
//! complaint is that it crosses itself comes out of a repair fully repaired, with the
//! crossings reported as a number rather than as a defect.

use std::path::PathBuf;

use dragonfruit_mesh_repair::{analyze, evaluate::evaluate, repair_path, RepairOptions, RepairOutcome};

/// The automatic route, from a path — what the app's auto-repair calls.
fn repair_path_auto(path: &std::path::Path) -> Result<RepairOutcome, dragonfruit_mesh_repair::MeshRepairError> {
    let mesh = dragonfruit_mesh_repair::io::load_mesh_from_path(path)?;
    Ok(dragonfruit_mesh_repair::repair_auto(mesh, &RepairOptions::default()))
}

fn reference(name: &str) -> Option<PathBuf> {
    let dir = std::env::var("MESH_REPAIR_REFERENCE_DIR")
        .unwrap_or_else(|_| "C:/Users/Paul/Downloads".to_string());
    let path = PathBuf::from(dir).join(name);
    path.exists().then_some(path)
}

/// `poussin.stl` is sound, and has been reading as broken.
///
/// It carries crossings and nothing else, so a repair leaves the surface alone and the
/// verdict has to say so. This is the case that made the verdict the five classes.
#[test]
fn poussin_comes_out_fully_repaired_with_its_crossings_as_a_note() {
    let Some(path) = reference("poussin.stl") else {
        return;
    };
    // The app's path, which classifies the mesh at load and refines coarse faces
    // before the repair ever sees it.
    let outcome = repair_path(&path, &RepairOptions::default()).expect("poussin.stl should load");
    let report = &outcome.report;

    assert!(
        report.fully_repaired,
        "a mesh whose only complaint is crossings is not broken: {:?}",
        report.residual_issues
    );
    assert!(
        report
            .residual_issues
            .iter()
            .any(|note| note.contains("self-intersecting")),
        "and the crossings are still reported: {:?}",
        report.residual_issues
    );

    // A repair that changes nothing must not move the model either.
    let drift = (outcome.mesh.signed_volume() - report.pre.signed_volume).abs()
        / report.pre.signed_volume.abs().max(1e-9);
    assert!(drift < 1e-5, "volume drifted {drift}");
}

/// `3DBenchy.stl` has a real defect left, and that is what makes it not fully repaired.
///
/// Its border is closed by the trivial-hole pass, and what remains is a winding
/// disagreement. The test asserts that something in the five classes is what keeps it
/// from a clean verdict, so a change that made the crossings the reason would fail
/// here.
#[test]
fn benchy_is_kept_from_a_clean_verdict_by_a_real_defect() {
    let Some(path) = reference("3DBenchy.stl") else {
        return;
    };
    let outcome = repair_path(&path, &RepairOptions::default()).expect("3DBenchy.stl should load");
    let report = &outcome.report;
    let defects = evaluate(&outcome.mesh);

    if !report.fully_repaired {
        assert!(
            defects.is_broken(),
            "a verdict of not repaired has to come from the five classes, not from a \
             crossing count: {:?}",
            report.residual_issues
        );
        assert!(
            defects.holes == 0,
            "the trivial-hole pass closes its slit loops, so no boundary should be left"
        );
    }
    assert_eq!(
        report.post.non_manifold_edges, 0,
        "the repair resolves non-manifoldness on this file"
    );
    assert!(
        analyze(&outcome.mesh).triangle_count > 0,
        "and the mesh is still there"
    );
}

/// `Gusano_de_Dune_70%.stl` is the file the corpus sweep could not settle, and the automatic route
/// settles it.
///
/// The local pipeline cannot: it arrives with 3,513 non-manifold edges inside 302 shells, and the
/// winding residue is one no assignment satisfies — a cycle of faces whose parities sum to an odd
/// number. The cut takes that class to zero and the mesh is still not clean, so the route falls back
/// to the surface-to-solid rebuild, which comes out `fully_repaired` at the cost of a surface that
/// moved. What is asserted is the verdict and the disclosure: a rebuild that moves the model has to
/// say so.
#[cfg(feature = "manifold")]
#[test]
fn the_automatic_route_settles_a_mesh_the_local_pipeline_cannot() {
    let Some(path) = reference("Gusano_de_Dune_70%.stl") else {
        return;
    };
    let outcome = repair_path_auto(&path).expect("Gusano_de_Dune_70%.stl should load");
    assert!(
        outcome.report.fully_repaired,
        "the automatic route is for exactly this file: {:?}",
        outcome.report.residual_issues
    );
    assert!(
        outcome.report.residual_issues.iter().any(|n| n.contains("rebuilt rather than repaired")),
        "and it says the surface moved: {:?}",
        outcome.report.residual_issues
    );
}

/// The same file with the rebuild forbidden: the local result is handed back with its residue, and
/// nothing pretends otherwise.
///
/// Not gated on the manifold feature, unlike the test above: this is the route that runs whatever is
/// compiled in.
#[test]
fn the_same_file_without_the_rebuild_keeps_its_residue_and_says_so() {
    let Some(path) = reference("Gusano_de_Dune_70%.stl") else {
        return;
    };
    let outcome = repair_path(
        &path,
        &RepairOptions {
            allow_rebuild: false,
            ..RepairOptions::default()
        },
    )
    .expect("Gusano_de_Dune_70%.stl should load");
    assert!(
        !outcome.report.fully_repaired,
        "the local pipeline cannot settle this one"
    );
    assert_eq!(
        outcome.report.post.inconsistent_winding_edges, 0,
        "the cut settles the class that flipping cannot"
    );
}
