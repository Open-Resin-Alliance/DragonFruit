#![cfg(test)]
#![cfg(feature = "manifold")]

use dragonfruit_mesh_core::mesh::{IndexedMesh, Vec3};
use crate::membrane::to_manifold;

/// Generates two concentric cylinders representing a main body and an outer sleeve (e.g., arm + bracer).
/// Pre-cut: represented as a single mesh (watertight union).
pub fn concentric_elbow_bracer() -> IndexedMesh {
    let mut positions = Vec::new();
    let mut triangles = Vec::new();
    
    // Cylinder 1 (Arm): R=5, Height=20, centered on Z=0
    let arm = cylinder_mesh(5.0, 20.0, 16);
    positions.extend(arm.positions);
    triangles.extend(arm.triangles);
    
    // Cylinder 2 (Bracer sleeve): R_inner=6, R_outer=7, Height=8, centered on Z=0
    let base_idx = positions.len() as u32;
    let bracer = sleeve_mesh(6.0, 7.0, 8.0, 16);
    positions.extend(bracer.positions);
    for t in bracer.triangles {
        triangles.push([t[0] + base_idx, t[1] + base_idx, t[2] + base_idx]);
    }
    
    IndexedMesh { positions, triangles }
}

/// Generates a mesh with an overhanging cuff folder (saddle cut scenario).
pub fn overhanging_cuff() -> IndexedMesh {
    // Arm cylinder with an overhanging sleeve portion connected at the top
    let mut arm = cylinder_mesh(5.0, 20.0, 16);
    // Add cuff points that flare out at Z=5 and overhang down to Z=1
    let base_idx = arm.positions.len() as u32;
    let cuff = sleeve_mesh(5.0, 6.5, 4.0, 16);
    // Translate cuff to Z=3 (so it overhangs Z=1 to Z=5)
    let mut cuff_positions = cuff.positions;
    for p in &mut cuff_positions {
        p.z += 3.0;
    }
    arm.positions.extend(cuff_positions);
    for t in cuff.triangles {
        arm.triangles.push([t[0] + base_idx, t[1] + base_idx, t[2] + base_idx]);
    }
    arm
}

/// Generates a hollowed sphere (concentric spheres, watertight cavity).
pub fn hollow_sphere(outer_r: f32, inner_r: f32, segments: usize) -> IndexedMesh {
    let mut outer = sphere_mesh(outer_r, segments, false); // wound outward
    let inner = sphere_mesh(inner_r, segments, true);   // wound inward (cavity)
    let base_idx = outer.positions.len() as u32;
    outer.positions.extend(inner.positions);
    for t in inner.triangles {
        outer.triangles.push([t[0] + base_idx, t[1] + base_idx, t[2] + base_idx]);
    }
    outer
}

// --- Primitive Helpers ---
fn cylinder_mesh(r: f32, h: f32, segments: usize) -> IndexedMesh {
    let mut positions = Vec::new();
    let half_h = h * 0.5;
    for i in 0..segments {
        let theta = 2.0 * std::f32::consts::PI * (i as f32 / segments as f32);
        let x = r * theta.cos();
        let y = r * theta.sin();
        positions.push(Vec3::new(x, y, half_h));  // Top ring
        positions.push(Vec3::new(x, y, -half_h)); // Bottom ring
    }
    
    let mut triangles = Vec::new();
    for i in 0..segments {
        let next = (i + 1) % segments;
        let t0 = (i * 2) as u32;
        let b0 = (i * 2 + 1) as u32;
        let t1 = (next * 2) as u32;
        let b1 = (next * 2 + 1) as u32;
        // Side walls
        triangles.push([t0, b0, b1]);
        triangles.push([t0, b1, t1]);
    }
    // Caps
    let top_center = positions.len() as u32;
    positions.push(Vec3::new(0.0, 0.0, half_h));
    let bottom_center = positions.len() as u32;
    positions.push(Vec3::new(0.0, 0.0, -half_h));
    
    for i in 0..segments {
        let next = (i + 1) % segments;
        triangles.push([top_center, (i * 2) as u32, (next * 2) as u32]);
        triangles.push([bottom_center, (next * 2 + 1) as u32, (i * 2 + 1) as u32]);
    }
    IndexedMesh { positions, triangles }
}

fn sleeve_mesh(r_in: f32, r_out: f32, h: f32, segments: usize) -> IndexedMesh {
    let mut positions = Vec::new();
    let half_h = h * 0.5;
    // Inner vertices
    for i in 0..segments {
        let theta = 2.0 * std::f32::consts::PI * (i as f32 / segments as f32);
        positions.push(Vec3::new(r_in * theta.cos(), r_in * theta.sin(), half_h));
        positions.push(Vec3::new(r_in * theta.cos(), r_in * theta.sin(), -half_h));
    }
    // Outer vertices
    let outer_base = positions.len() as u32;
    for i in 0..segments {
        let theta = 2.0 * std::f32::consts::PI * (i as f32 / segments as f32);
        positions.push(Vec3::new(r_out * theta.cos(), r_out * theta.sin(), half_h));
        positions.push(Vec3::new(r_out * theta.cos(), r_out * theta.sin(), -half_h));
    }
    // Stitched quads (Inner walls, outer walls, top rim cap, bottom rim cap)
    let mut triangles = Vec::new();
    for i in 0..segments {
        let next = (i + 1) % segments;
        let i_t0 = (i * 2) as u32;
        let i_b0 = (i * 2 + 1) as u32;
        let i_t1 = (next * 2) as u32;
        let i_b1 = (next * 2 + 1) as u32;
        
        let o_t0 = outer_base + (i * 2) as u32;
        let o_b0 = outer_base + (i * 2 + 1) as u32;
        let o_t1 = outer_base + (next * 2) as u32;
        let o_b1 = outer_base + (next * 2 + 1) as u32;
        
        // Outer wall (wound outward)
        triangles.push([o_t0, o_b1, o_b0]);
        triangles.push([o_t0, o_t1, o_b1]);
        
        // Inner wall (wound inward)
        triangles.push([i_t0, i_b0, i_b1]);
        triangles.push([i_t0, i_b1, i_t1]);
        
        // Top rim cap
        triangles.push([i_t0, o_t1, o_t0]);
        triangles.push([i_t0, i_t1, o_t1]);
        
        // Bottom rim cap
        triangles.push([i_b0, o_b0, o_b1]);
        triangles.push([i_b0, o_b1, i_b1]);
    }
    IndexedMesh { positions, triangles }
}

fn sphere_mesh(r: f32, steps: usize, invert: bool) -> IndexedMesh {
    let mut positions = Vec::new();
    // Latitude / Longitude grid
    for lat in 0..=steps {
        let theta = std::f32::consts::PI * (lat as f32 / steps as f32);
        let sin_t = theta.sin();
        let cos_t = theta.cos();
        for lon in 0..steps {
            let phi = 2.0 * std::f32::consts::PI * (lon as f32 / steps as f32);
            positions.push(Vec3::new(r * sin_t * phi.cos(), r * sin_t * phi.sin(), r * cos_t));
        }
    }
    let mut triangles = Vec::new();
    for lat in 0..steps {
        for lon in 0..steps {
            let next_lon = (lon + 1) % steps;
            let i00 = (lat * steps + lon) as u32;
            let i10 = ((lat + 1) * steps + lon) as u32;
            let i01 = (lat * steps + next_lon) as u32;
            let i11 = ((lat + 1) * steps + next_lon) as u32;
            if invert {
                triangles.push([i00, i10, i11]);
                triangles.push([i00, i11, i01]);
            } else {
                triangles.push([i00, i11, i10]);
                triangles.push([i00, i01, i11]);
            }
        }
    }
    IndexedMesh { positions, triangles }
}

/// Asserts that a mesh is a 100% watertight manifold.
pub fn assert_watertight_manifold(mesh: &IndexedMesh) {
    let (open_edges, non_manifold_edges, degenerate_tris) = mesh_edge_defects(mesh);
    assert_eq!(open_edges, 0, "Mesh contains open boundary edges!");
    assert_eq!(non_manifold_edges, 0, "Mesh contains non-manifold edges!");
    assert_eq!(degenerate_tris, 0, "Mesh contains degenerate triangles!");
    
    let manifold_result = to_manifold(mesh);
    assert!(manifold_result.is_ok(), "Manifold rejected the mesh: {:?}", manifold_result.err());
}

/// Verifies all triangles have consistent outward-pointing normals.
pub fn assert_winding_outward(mesh: &IndexedMesh) {
    // Evaluate volume: a manifold with outward-pointing winding yields a positive volume.
    let manifold = to_manifold(mesh).expect("Must be a valid manifold to calculate volume");
    assert!(manifold.volume() > 0.0, "Manifold volume is <= 0.0 (possibly inside-out winding)");
}

/// Helper to count edge defects (copied from diagnostic utilities).
fn mesh_edge_defects(mesh: &IndexedMesh) -> (usize, usize, usize) {
    let mut counts = ahash::AHashMap::new();
    let mut degenerate = 0;
    for t in &mesh.triangles {
        if t[0] == t[1] || t[1] == t[2] || t[2] == t[0] {
            degenerate += 1;
            continue;
        }
        for &(a, b) in &[(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
            let k = if a < b { (a, b) } else { (b, a) };
            *counts.entry(k).or_insert(0) += 1;
        }
    }
    let open = counts.values().filter(|&&c| c == 1).count();
    let nonmanifold = counts.values().filter(|&&c| c > 2).count();
    (open, nonmanifold, degenerate)
}
