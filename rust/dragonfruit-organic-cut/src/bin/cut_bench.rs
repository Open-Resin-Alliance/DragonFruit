//! EXPERIMENT bench: cut strategies measured against captured dumps.
//!
//! Runs each strategy on the same inputs and prints one line per loop, so a new
//! idea is judged on the cuts that already work as much as on the ones that fail.
//! Multi-loop dumps are measured loop by loop: what matters first is whether a
//! single seam separates at all.
//!
//!     cargo run --release --features manifold --bin cut_bench -- <dir with cut-*.bin/json>

use std::path::Path;
use std::time::Instant;

use dragonfruit_mesh_core::mesh::{IndexedMesh, Vec3};
use dragonfruit_organic_cut::surface_cut::{seams_enclose_a_piece, SeamVerdict};
use dragonfruit_organic_cut::surface_split::split_along_seams;
use dragonfruit_organic_cut::membrane::{contour_split, DEFAULT_CUTTER_THICKNESS_MM, DEFAULT_GRID_DIVISIONS};
use dragonfruit_organic_cut::surface_cap::close_pieces;
use dragonfruit_organic_cut::OrganicCutOptions;

/// Matches the app's staged loader (`dragonfruit_mesh_repair::io::DEFAULT_MERGE_EPSILON`).
const MERGE_EPSILON: f32 = 1e-5;

fn load_mesh(path: &Path) -> Result<IndexedMesh, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let floats: &[f32] = bytemuck::try_cast_slice(&bytes).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(IndexedMesh::from_triangle_soup(floats, MERGE_EPSILON))
}

/// Distance from `p` to the nearest point of `mesh`, for deciding which captured
/// mesh a seam belongs to.
fn distance_to_surface(bvh: &dragonfruit_mesh_core::bvh::Bvh, mesh: &IndexedMesh, p: Vec3) -> f32 {
    use dragonfruit_mesh_core::mesh::Aabb;
    for r in [0.5f32, 4.0, 32.0, 256.0] {
        let query = Aabb {
            min: Vec3::new(p.x - r, p.y - r, p.z - r),
            max: Vec3::new(p.x + r, p.y + r, p.z + r),
        };
        let mut best = f32::INFINITY;
        bvh.query_aabb(&query, |ti| {
            let t = &mesh.triangles[ti as usize];
            let (_, d2) = dragonfruit_organic_cut::membrane::closest_on_tri(
                p,
                mesh.positions[t[0] as usize],
                mesh.positions[t[1] as usize],
                mesh.positions[t[2] as usize],
            );
            best = best.min(d2);
        });
        if best.is_finite() {
            return best.sqrt();
        }
    }
    f32::INFINITY
}

/// Edges used by anything other than two faces — a mesh with none is closed.
fn open_edges_of(mesh: &IndexedMesh) -> std::collections::HashSet<(u32, u32)> {
    let mut counts: std::collections::HashMap<(u32, u32), usize> = std::collections::HashMap::new();
    for t in &mesh.triangles {
        for k in 0..3 {
            let (a, b) = (t[k], t[(k + 1) % 3]);
            *counts.entry(if a < b { (a, b) } else { (b, a) }).or_default() += 1;
        }
    }
    counts.into_iter().filter(|(_, c)| *c != 2).map(|(e, _)| e).collect()
}

/// A point's exact bits, for matching the same vertex across two renumbered meshes.
fn key(p: Vec3) -> [u32; 3] {
    [p.x.to_bits(), p.y.to_bits(), p.z.to_bits()]
}

fn open_edge_count(mesh: &IndexedMesh) -> usize {
    let mut counts: std::collections::HashMap<(u32, u32), usize> = std::collections::HashMap::new();
    for t in &mesh.triangles {
        for k in 0..3 {
            let (a, b) = (t[k], t[(k + 1) % 3]);
            *counts.entry(if a < b { (a, b) } else { (b, a) }).or_default() += 1;
        }
    }
    counts.values().filter(|c| **c != 2).count()
}

fn main() -> Result<(), String> {
    let dir = std::env::args().nth(1).ok_or("usage: crown_bench <dump dir>")?;
    let dir = Path::new(&dir);

    let mut names: Vec<String> = std::fs::read_dir(dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n.ends_with(".json"))
        .collect();
    names.sort_by_key(|n| n.trim_start_matches("cut-").trim_end_matches(".json").parse::<u32>().unwrap_or(0));
    // Chasing one dump costs a minute otherwise: `DF_BENCH_ONLY=cut-20,cut-21`.
    if let Some(only) = std::env::var_os("DF_BENCH_ONLY") {
        let only = only.to_string_lossy().to_string();
        let wanted: Vec<&str> = only.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
        names.retain(|n| wanted.contains(&n.trim_end_matches(".json")));
    }

    println!(
        "{:<10} {:<5} {:>6}  {:<24}  {:>5}  {:<62}",
        "dump", "loop", "pts", "wafer piece + rest", "", "surface verdict | exact split"
    );
    let (mut wafer_ok, mut surface_ok, mut split_ok, mut cap_ok, mut total) = (0, 0, 0, 0, 0);

    for name in names {
        let json = dir.join(&name);
        let stem = name.trim_end_matches(".json").to_string();
        // Dumps share meshes, and the same model appears in more than one
        // orientation across a session, so the seam decides which mesh it belongs
        // to: the one it actually lies on.
        let bin = dir.join(format!("{stem}.bin"));

        let options: OrganicCutOptions = serde_json::from_str(&std::fs::read_to_string(&json).map_err(|e| e.to_string())?)
            .map_err(|e| format!("{}: {e}", json.display()))?;
        let spec = &options.cut;
        let thickness = if spec.joint_clearance_mm > 0.0 { spec.joint_clearance_mm } else { DEFAULT_CUTTER_THICKNESS_MM };

        let mut loops: Vec<Vec<Vec3>> = Vec::new();
        let to_v = |pts: &[dragonfruit_organic_cut::OrganicCutLoopPoint]| -> Vec<Vec3> {
            pts.iter().map(|p| Vec3::new(p.position[0], p.position[1], p.position[2])).collect()
        };
        loops.push(to_v(&spec.loop_points));
        for extra in &spec.extra_loops {
            loops.push(to_v(extra));
        }

        let candidates: Vec<std::path::PathBuf> = if bin.exists() {
            vec![bin]
        } else {
            let mut v: Vec<std::path::PathBuf> = std::fs::read_dir(dir)
                .map_err(|e| e.to_string())?
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.extension().map(|x| x == "bin").unwrap_or(false))
                .collect();
            v.sort();
            v
        };
        let probe_pts: Vec<Vec3> = loops.first().map(|l| l.iter().step_by((l.len() / 12).max(1)).copied().collect()).unwrap_or_default();
        let mut best: Option<(f32, IndexedMesh)> = None;
        for cand in &candidates {
            let m = load_mesh(cand)?;
            let bvh = dragonfruit_mesh_core::bvh::Bvh::build(&m);
            let mut sum = 0.0f32;
            for &p in &probe_pts {
                sum += distance_to_surface(&bvh, &m, p);
            }
            let score = sum / probe_pts.len().max(1) as f32;
            if best.as_ref().is_none_or(|(b, _)| score < *b) {
                best = Some((score, m));
            }
        }
        let Some((fit, mesh)) = best else { continue };
        if fit > 1.0 {
            eprintln!("{stem}: no mesh in the directory carries this seam (nearest {fit:.2} mm) — skipped");
            continue;
        }

        for (i, lp) in loops.iter().enumerate() {
            if lp.len() < 3 {
                continue;
            }
            total += 1;
            let t0 = Instant::now();
            let wafer = contour_split(&mesh, lp, thickness, spec.membrane_smoothing, spec.density);
            let wafer_ms = t0.elapsed().as_millis();
            // How well does the seam lie ON the skin? Both strategies assume it
            // does: the wafer pins its rim there, the walk uses it as a barrier.
            let bvh = dragonfruit_mesh_core::bvh::Bvh::build(&mesh);
            let mut off_max = 0.0f32;
            for w in lp.windows(2) {
                for k in 0..4 {
                    let p = w[0].add(w[1].sub(w[0]).scale(k as f32 / 4.0));
                    off_max = off_max.max(distance_to_surface(&bvh, &mesh, p));
                }
            }
            let t1 = Instant::now();
            let verdict = seams_enclose_a_piece(&mesh, std::slice::from_ref(lp));
            let surface_ms = t1.elapsed().as_millis();
            // The exact cut: does the seam become mesh edges, watertight, two sides?
            let t2 = Instant::now();
            let cut = split_along_seams(&mesh, std::slice::from_ref(lp));
            let cut_ms = t2.elapsed().as_millis();
            let mut cap_txt = String::from("—");
            let cut_txt = match &cut {
                Ok(s) => {
                    let open = open_edge_count(&s.mesh);
                    let before = open_edge_count(&mesh);
                    if std::env::var_os("DF_SPLIT_DEBUG").is_some() && open > before {
                        let was: std::collections::HashSet<(u32, u32)> = open_edges_of(&mesh);
                        for e in open_edges_of(&s.mesh).difference(&was) {
                            let p = s.mesh.positions[e.0 as usize];
                            let users: Vec<u32> = s.mesh.triangles.iter().enumerate()
                                .filter(|(_, t)| (0..3).any(|k| {
                                    let (a, b) = (t[k], t[(k + 1) % 3]);
                                    (if a < b { (a, b) } else { (b, a) }) == *e
                                }))
                                .map(|(ti, _)| s.source_face[ti])
                                .collect();
                            let uses = users.len();
                            eprintln!(
                                "[leak] {stem}/{i} edge {e:?} used x{uses} by faces {users:?} at ({:.3},{:.3},{:.3})",
                                p.x, p.y, p.z
                            );
                            // Who spans the gap: a triangle whose own edge contains
                            // both ends of the open one is the T-junction's other
                            // half.
                            let (pa, pb) = (s.mesh.positions[e.0 as usize], s.mesh.positions[e.1 as usize]);
                            let on_seg = |u: Vec3, v: Vec3, p: Vec3| {
                                let d = v.sub(u);
                                let dd = d.dot(d);
                                if dd < 1e-18 { return false; }
                                let t = p.sub(u).dot(d) / dd;
                                (-0.001..=1.001).contains(&t)
                                    && p.sub(u.add(d.scale(t))).length() < 1e-4
                            };
                            for (ti, ot) in s.mesh.triangles.iter().enumerate() {
                                for k in 0..3 {
                                    let (u, v) = (ot[k], ot[(k + 1) % 3]);
                                    if (u, v) == (e.0, e.1) || (v, u) == (e.0, e.1) {
                                        continue;
                                    }
                                    let (pu, pv) = (s.mesh.positions[u as usize], s.mesh.positions[v as usize]);
                                    if on_seg(pu, pv, pa) && on_seg(pu, pv, pb) {
                                        eprintln!(
                                            "[leak]   spanned by tri {ot:?} edge ({u},{v}) from source face {}",
                                            s.source_face[ti]
                                        );
                                    }
                                }
                            }
                            let mut seen: Vec<u32> = users.clone();
                            seen.sort_unstable();
                            seen.dedup();
                            for f in seen {
                                eprintln!("[leak]   source face {f} = {:?}", mesh.triangles[f as usize]);
                            }
                        }
                    }
                    let sides: std::collections::BTreeSet<u32> =
                        s.piece_of_face.iter().copied().collect();
                    // Against what the INPUT already carried, not against zero: the
                    // user's STL ships 3 edges that are not on two faces, and a cut
                    // is only asked not to add any.
                    if open <= before {
                        split_ok += 1;
                    }
                    // Capping is the other half of the exact cut: pieces only mean
                    // something once each one closes into a solid.
                    let t3 = Instant::now();
                    // Same density knob the wafer's membrane takes, so the cap comes
                    // out as fine as the cutter the user previewed.
                    let cap_grid = DEFAULT_GRID_DIVISIONS * spec.density.clamp(1.0, 4.0) as f64;
                    let capped = close_pieces(s, cap_grid, spec.membrane_smoothing);
                    let cap_ms = t3.elapsed().as_millis();
                    cap_txt = match &capped {
                        Ok(c) => {
                            // Again against what the input carried: its 3 open edges
                            // travel with whichever piece holds them, and a cap is
                            // only asked not to add any of its own.
                            let leaked: usize =
                                c.solids.iter().map(open_edge_count).sum::<usize>().saturating_sub(before);
                            if leaked == 0 {
                                cap_ok += 1;
                            } else if std::env::var_os("DF_SPLIT_DEBUG").is_some() {
                                let was: std::collections::HashSet<[[u32; 3]; 2]> = open_edges_of(&s.mesh)
                                    .iter()
                                    .map(|e| [key(s.mesh.positions[e.0 as usize]), key(s.mesh.positions[e.1 as usize])])
                                    .collect();
                                for (si, solid) in c.solids.iter().enumerate() {
                                    for e in open_edges_of(solid) {
                                        let (pa, pb) = (solid.positions[e.0 as usize], solid.positions[e.1 as usize]);
                                        let k = [key(pa), key(pb)];
                                        if was.contains(&k) || was.contains(&[k[1], k[0]]) {
                                            continue;
                                        }
                                        let uses = solid.triangles.iter().filter(|t| (0..3).any(|j| {
                                            let (x, y) = (t[j], t[(j + 1) % 3]);
                                            (x.min(y), x.max(y)) == (e.0.min(e.1), e.0.max(e.1))
                                        })).count();
                                        eprintln!(
                                            "[tapa] {stem}/{i} sólido {si}: arista nueva abierta x{uses} \
                                             ({:.3},{:.3},{:.3})-({:.3},{:.3},{:.3})",
                                            pa.x, pa.y, pa.z, pb.x, pb.y, pb.z
                                        );
                                    }
                                }
                                eprintln!(
                                    "[tapa] {stem}/{i}: {} tapas, aros de {:?}, entre {:?}",
                                    c.caps.len(),
                                    c.caps.iter().map(|m| m.boundary.len()).collect::<Vec<_>>(),
                                    c.cap_between
                                );
                            }
                            format!(
                                "{} tapas, {} sólidos, +{leaked} abiertas ({cap_ms}ms)",
                                c.caps.len(),
                                c.solids.len()
                            )
                        }
                        Err(e) => format!("— {} ({cap_ms}ms)", e.why.chars().take(46).collect::<String>()),
                    };
                    format!("{} piezas, abiertas {before} -> {open} ({cut_ms}ms)", sides.len())
                }
                Err(e) => format!("— {} ({cut_ms}ms)", e.chars().take(38).collect::<String>()),
            };

            let wafer_txt = match &wafer {
                Ok(s) => {
                    wafer_ok += 1;
                    format!("{} + {} ({wafer_ms}ms)", s.part_a.triangle_count(), s.part_b.triangle_count())
                }
                Err(_) => format!("— ({wafer_ms}ms)"),
            };
            let sizes = match &verdict {
                SeamVerdict::Enclosed { piece_faces } => {
                    surface_ok += 1;
                    format!("encloses {piece_faces} faces")
                }
                SeamVerdict::NotSeparating => "separates nothing".to_string(),
                SeamVerdict::TooCoarse => "mesh too coarse to tell".to_string(),
            };
            println!(
                "{:<10} {:<5} {:>6}  {:<24}  {:>5}  {:<62}",
                stem,
                i,
                lp.len(),
                wafer_txt,
                "",
                format!("{sizes} ({surface_ms}ms) | corte: {cut_txt} | {cap_txt}")
            );
        }
        if loops.len() > 1 {
            // What the APP actually does: cut along every seam at once. The per-loop
            // rows above never show this, and a piece held by two seams only comes
            // away when both are walls at the same time.
            let together = match split_along_seams(&mesh, &loops) {
                Ok(s) => {
                    let pieces: std::collections::BTreeSet<u32> =
                        s.piece_of_face.iter().copied().collect();
                    let loose = s.loose_wall_ends();
                    if !loose.is_empty() {
                        for p in loose.iter().take(8) {
                            eprintln!(
                                "[muro] {stem}: el muro se queda a medias en ({:.3},{:.3},{:.3})",
                                p.x, p.y, p.z
                            );
                        }
                    }
                    format!("{} piezas juntas, {} cabos sueltos del muro", pieces.len(), loose.len())
                }
                Err(e) => format!("— {}", e.chars().take(46).collect::<String>()),
            };
            println!("{:<10} {:<5} {:>6}  {:<24}  {:>5}  {together}", stem, "todos", "", "", "");

            let sizes = match seams_enclose_a_piece(&mesh, &loops) {
                SeamVerdict::Enclosed { piece_faces } => format!("encloses {piece_faces} faces"),
                SeamVerdict::NotSeparating => "separates nothing".to_string(),
                SeamVerdict::TooCoarse => "mesh too coarse to tell".to_string(),
            };
            println!(
                "{:<10} {:<5} {:>6}  {:<24}  {:>5}  {:<62}",
                stem,
                "all",
                loops.iter().map(|l| l.len()).sum::<usize>(),
                "",
                "",
                sizes
            );
        }
    }
    println!(
        "\nseparated: wafer {wafer_ok}/{total}, surface walk {surface_ok}/{total}, \
         exact split watertight {split_ok}/{total}, every piece capped into a solid {cap_ok}/{total}"
    );
    Ok(())
}
