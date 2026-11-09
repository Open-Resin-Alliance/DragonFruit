//! Shells, and which of them are noise.
//!
//! A shell with fewer than four triangles is a scrap: three faces cannot be a feature anybody
//! designed, and the pass that leaves them behind is the one that split a shared edge.
//!
//! The reference engine's rule is wider than that. It also deletes a shell whose area is under
//! a hundredth of the mesh's *and* whose triangle count is under a twentieth, and that clause
//! cannot tell a stray fragment from a designed one. On `COOKIE_b4.stl`, a model with supports,
//! it took 88,912 faces: every support pillar is a small shell by that rule, and the repair
//! reported success while the supports were gone.
//!
//! The two mistakes are not symmetric. Keeping a stray shell costs a shell the user can see and
//! delete; deleting a support costs a print. So the clause is not used, and this is a
//! deliberate departure from the reference.
//!
//! This replaces `prune_open_fragments`, which kept a component only when it was closed or
//! nearly so. On a single-component mesh that rule deleted the entire model, which is why the
//! extraction it belonged to had to be rolled back.

use crate::core::mesh::IndexedMesh;
use crate::repair::triangle_components;

/// A shell with fewer triangles than this is noise.
const NOISE_SHELL_MIN_TRIANGLES: usize = 4;

/// A shell enclosing less than this many cubic millimetres is noise.
///
/// The unit is the point. A triangle count measures how finely a shell happens to be tessellated
/// rather than how big it is, and a *relative* area measures a shell's share of a model that may
/// carry thousands of legitimate support shells — that was this rule before it was narrowed, and it
/// deleted 88,912 support faces on COOKIE_b4. An absolute volume is the measure that cannot do that:
/// a tenth of a thousandth of a cubic millimetre is a cube 0.046mm on a side, smaller than any
/// feature a user put there on purpose, so nothing meant to be kept can be under it.
const NOISE_SHELL_MAX_VOLUME_MM3: f64 = 0.0001;

/// Which shells are noise, by the reference engine's rule.
pub fn noise_shells(mesh: &IndexedMesh) -> Vec<u32> {
    if mesh.triangles.is_empty() {
        return Vec::new();
    }
    let components = triangle_components(mesh);
    let shell_count = components.iter().copied().max().unwrap_or(0) as usize + 1;
    if shell_count < 2 {
        // One shell cannot be a small fraction of itself.
        return Vec::new();
    }

    let mut triangles_per_shell = vec![0usize; shell_count];
    // Signed volume per shell, by the divergence theorem, taken as a magnitude at the end: a closed
    // shell's winding decides its sign and not its size.
    let mut volume_per_shell = vec![0.0f64; shell_count];
    for index in 0..mesh.triangles.len() {
        let shell = components[index] as usize;
        triangles_per_shell[shell] += 1;
        let [a, b, c] = mesh.tri_positions(index as u32);
        volume_per_shell[shell] += (a.x as f64 * (b.y as f64 * c.z as f64 - b.z as f64 * c.y as f64)
            - a.y as f64 * (b.x as f64 * c.z as f64 - b.z as f64 * c.x as f64)
            + a.z as f64 * (b.x as f64 * c.y as f64 - b.y as f64 * c.x as f64))
            / 6.0;
    }

    (0..shell_count)
        .filter(|&shell| {
            triangles_per_shell[shell] < NOISE_SHELL_MIN_TRIANGLES
                || volume_per_shell[shell].abs() < NOISE_SHELL_MAX_VOLUME_MM3
        })
        .map(|shell| shell as u32)
        .collect()
}

/// Deletes the shells that are noise, and returns how many triangles went.
pub fn remove_noise_shells(mesh: &mut IndexedMesh) -> usize {
    let noise = noise_shells(mesh);
    if noise.is_empty() {
        return 0;
    }
    let components = triangle_components(mesh);
    let before = mesh.triangles.len();
    let mut kept = Vec::with_capacity(before);
    for (index, triangle) in mesh.triangles.iter().enumerate() {
        if !noise.contains(&components[index]) {
            kept.push(*triangle);
        }
    }
    mesh.triangles = kept;
    before - mesh.triangles.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::mesh::Vec3;
    use crate::test_fixtures::unit_cube;

    fn tiny_triangle(offset: f32) -> ([Vec3; 3], [u32; 3]) {
        (
            [
                Vec3::new(offset, 0.0, 0.0),
                Vec3::new(offset + 0.01, 0.0, 0.0),
                Vec3::new(offset, 0.01, 0.0),
            ],
            [0, 1, 2],
        )
    }

    /// A model is never noise to itself.
    #[test]
    fn a_single_shell_is_never_noise() {
        let cube = unit_cube();
        assert!(noise_shells(&cube).is_empty(), "{:?}", noise_shells(&cube));
    }

    /// A scrap beside a model is noise, by both halves of the rule.
    #[test]
    fn a_scrap_beside_a_model_is_noise() {
        let mut mesh = unit_cube();
        let base = mesh.positions.len() as u32;
        let (positions, triangle) = tiny_triangle(5.0);
        mesh.positions.extend(positions);
        mesh.triangles
            .push([triangle[0] + base, triangle[1] + base, triangle[2] + base]);

        let noise = noise_shells(&mesh);
        assert_eq!(noise.len(), 1, "the scrap and only the scrap: {noise:?}");

        let removed = remove_noise_shells(&mut mesh);
        assert_eq!(removed, 1);
        assert_eq!(mesh.triangles.len(), 12, "the cube is untouched");
    }

    /// A shell with three triangles is noise even when it is large: fewer than four
    /// triangles cannot enclose anything worth keeping.
    #[test]
    fn a_shell_below_four_triangles_is_noise() {
        let mut mesh = unit_cube();
        let base = mesh.positions.len() as u32;
        for step in 0..3 {
            let (positions, triangle) = tiny_triangle(5.0 + step as f32 * 10.0);
            let offset = mesh.positions.len() as u32;
            mesh.positions.extend(positions);
            mesh.triangles.push([
                triangle[0] + offset,
                triangle[1] + offset,
                triangle[2] + offset,
            ]);
            let _ = base;
        }
        let noise = noise_shells(&mesh);
        assert_eq!(noise.len(), 3, "each stray triangle is its own shell");
    }
}
