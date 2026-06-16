use std::collections::VecDeque;

use serde::{Deserialize, Serialize};

use crate::core::bvh::Bvh;
use crate::core::mesh::{Aabb, IndexedMesh, Vec3};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HollowMode {
    Cavity,
    Infill,
    ShellOpenFace,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InfillMode {
    Lattice,
    Pillar,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OpenFace {
    XMin,
    XMax,
    YMin,
    YMax,
    ZMin,
    ZMax,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrainHoleSpec {
    /// Normalized position inside source bbox, each axis in [0, 1].
    pub center_norm: [f32; 3],
    /// Radius in millimeters.
    pub radius_mm: f32,
    /// Optional unit direction for a manual punch, in source-mesh local space.
    pub direction: Option<[f32; 3]>,
    /// Optional punch depth in millimeters.
    pub length_mm: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HollowOptions {
    pub mode: HollowMode,
    pub voxel_resolution: u16,
    pub shell_thickness_mm: f32,
    pub blocked_voxel_indices: Vec<usize>,
    pub infill_mode: InfillMode,
    pub infill_cell_mm: f32,
    pub infill_beam_radius_mm: f32,
    pub open_face: OpenFace,
    pub drain_holes: Vec<DrainHoleSpec>,
    pub preview_cavity_only: bool,
    pub smooth_internal_surfaces: bool,
    /// Number of voxel chamfer passes to run on internal cavity boundaries.
    /// 0 disables chamfering, 1-2 progressively bevel 90° steps toward ~45° ramps.
    pub internal_chamfer_passes: u8,
    /// When true, skip building the smoothed cavity mesh and just render
    /// spheres at removed-voxel centers for a near-instant preview that is
    /// sufficient for interactively adjusting hollowing parameters.
    pub preview_voxel_spheres: bool,
    /// Unit quaternion `[x, y, z, w]` to rotate the source mesh before
    /// voxelizing. The output mesh is inversely rotated so DragonFruit's
    /// unrotated mesh stays in sync with the rotated scene transform.
    /// Default identity `[0, 0, 0, 1]` means no rotation.
    #[serde(default = "default_rotation_quat")]
    pub rotation_quat: [f32; 4],
}

const fn default_rotation_quat() -> [f32; 4] {
    [0.0, 0.0, 0.0, 1.0]
}

impl Default for HollowOptions {
    fn default() -> Self {
        Self {
            mode: HollowMode::Cavity,
            voxel_resolution: 64,
            shell_thickness_mm: 2.0,
            blocked_voxel_indices: Vec::new(),
            infill_mode: InfillMode::Lattice,
            infill_cell_mm: 4.2426,
            infill_beam_radius_mm: 0.35,
            open_face: OpenFace::ZMax,
            drain_holes: Vec::new(),
            preview_cavity_only: false,
            smooth_internal_surfaces: true,
            internal_chamfer_passes: 2,
            preview_voxel_spheres: false,
            rotation_quat: [0.0, 0.0, 0.0, 1.0],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HollowReport {
    pub mode: HollowMode,
    pub voxel_resolution: u16,
    pub voxel_size_mm: f32,
    pub shell_thickness_mm: f32,
    pub source_triangle_count: usize,
    pub output_triangle_count: usize,
    pub grid_size: [usize; 3],
    pub occupied_voxels: usize,
    pub shell_voxels: usize,
    pub removed_voxels: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HolePunchSpec {
    /// Normalized position inside source bbox, each axis in [0, 1].
    pub center_norm: [f32; 3],
    /// Cylinder radius in millimeters (X axis).
    pub radius_mm: f32,
    /// Optional Y-axis radius for oval punches. Defaults to radius_mm.
    #[serde(default)]
    pub radius_y_mm: Option<f32>,
    /// Optional unit direction for the punch axis, in source-mesh local space.
    pub direction: Option<[f32; 3]>,
    /// Optional punch depth in millimeters.
    pub length_mm: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HolePunchOptions {
    pub punches: Vec<HolePunchSpec>,
}

impl Default for HolePunchOptions {
    fn default() -> Self {
        Self {
            punches: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HolePunchReport {
    pub source_triangle_count: usize,
    pub output_triangle_count: usize,
    pub removed_triangle_count: usize,
    pub punch_count: usize,
}

#[derive(Debug, Clone)]
pub struct HolePunchOutcome {
    pub mesh: IndexedMesh,
    pub report: HolePunchReport,
}

#[derive(Debug, Clone)]
pub struct HollowOutcome {
    pub mesh: IndexedMesh,
    /// Interior cavity surface mesh, extracted separately so the frontend can
    /// render it as the solid interior in "Interior View Mode".
    pub cavity_mesh: Option<IndexedMesh>,
    pub preview_infill_mesh: Option<IndexedMesh>,
    pub removed_voxel_centers: Vec<f32>,
    pub removed_voxel_indices: Vec<u32>,
    pub blocked_voxel_centers: Vec<f32>,
    pub blocked_voxel_indices: Vec<u32>,
    pub report: HollowReport,
}

#[derive(Debug, Clone)]
pub struct HollowSession {
    source_mesh: IndexedMesh,
    source_bbox: Aabb,
    grid: GridSpec,
    solid: Vec<bool>,
    dist: Vec<f32>,
    source_void_components: Vec<i32>,
    source_triangle_count: usize,
    occupied_voxels: usize,
    voxel_resolution: u16,
    /// The rotation quaternion used when building this session.
    /// Stored so callers can detect when a session rebuild is needed.
    rotation_quat: [f32; 4],
}

#[derive(Clone, Copy)]
struct TriangleCache {
    a: Vec3,
    b: Vec3,
    c: Vec3,
    min: Vec3,
    max: Vec3,
}

impl TriangleCache {
    fn from_points(a: Vec3, b: Vec3, c: Vec3) -> Self {
        let min = a.min(b).min(c);
        let max = a.max(b).max(c);
        Self { a, b, c, min, max }
    }
}

#[derive(Debug, Clone, Copy)]
struct GridSpec {
    nx: usize,
    ny: usize,
    nz: usize,
    voxel_mm: f32,
    min: Vec3,
}

impl GridSpec {
    #[inline]
    fn idx(&self, x: usize, y: usize, z: usize) -> usize {
        x + self.nx * (y + self.ny * z)
    }

    #[inline]
    fn in_bounds(&self, x: isize, y: isize, z: isize) -> bool {
        x >= 0
            && y >= 0
            && z >= 0
            && (x as usize) < self.nx
            && (y as usize) < self.ny
            && (z as usize) < self.nz
    }

    #[inline]
    fn center_world(&self, x: usize, y: usize, z: usize) -> Vec3 {
        Vec3::new(
            self.min.x + (x as f32 + 0.5) * self.voxel_mm,
            self.min.y + (y as f32 + 0.5) * self.voxel_mm,
            self.min.z + (z as f32 + 0.5) * self.voxel_mm,
        )
    }
}

const N6: [(isize, isize, isize); 6] = [
    (1, 0, 0),
    (-1, 0, 0),
    (0, 1, 0),
    (0, -1, 0),
    (0, 0, 1),
    (0, 0, -1),
];

const SQRT_2: f32 = std::f32::consts::SQRT_2;
const SQRT_3: f32 = 1.732_050_8_f32;

/// Forward-scan neighbour offsets and weights for the two-pass 3-D chamfer
/// distance transform (z-outer, y-middle, x-inner ascending scan order).
/// These 13 entries cover voxels with a smaller linear index — already
/// computed when the forward pass arrives at the current cell.
const SHELL_DIST_FORWARD: [((isize, isize, isize), f32); 13] = [
    // dz = -1: all nine (dx, dy) combinations
    ((-1, -1, -1), SQRT_3),
    ((0, -1, -1), SQRT_2),
    ((1, -1, -1), SQRT_3),
    ((-1, 0, -1), SQRT_2),
    ((0, 0, -1), 1.0_f32),
    ((1, 0, -1), SQRT_2),
    ((-1, 1, -1), SQRT_3),
    ((0, 1, -1), SQRT_2),
    ((1, 1, -1), SQRT_3),
    // dz = 0, dy = -1: three (dx) values
    ((-1, -1, 0), SQRT_2),
    ((0, -1, 0), 1.0_f32),
    ((1, -1, 0), SQRT_2),
    // dz = 0, dy = 0, dx = -1
    ((-1, 0, 0), 1.0_f32),
];

/// Complementary backward-scan mask for the second EDT pass.
const SHELL_DIST_BACKWARD: [((isize, isize, isize), f32); 13] = [
    // dz = +1: all nine combinations
    ((-1, -1, 1), SQRT_3),
    ((0, -1, 1), SQRT_2),
    ((1, -1, 1), SQRT_3),
    ((-1, 0, 1), SQRT_2),
    ((0, 0, 1), 1.0_f32),
    ((1, 0, 1), SQRT_2),
    ((-1, 1, 1), SQRT_3),
    ((0, 1, 1), SQRT_2),
    ((1, 1, 1), SQRT_3),
    // dz = 0, dy = +1
    ((-1, 1, 0), SQRT_2),
    ((0, 1, 0), 1.0_f32),
    ((1, 1, 0), SQRT_2),
    // dz = 0, dy = 0, dx = +1
    ((1, 0, 0), 1.0_f32),
];

pub fn hollow_voxel(mut mesh: IndexedMesh, options: &HollowOptions) -> HollowOutcome {
    // Apply rotation so the voxel grid aligns with the rotated model.
    let is_identity = options.rotation_quat[0] == 0.0
        && options.rotation_quat[1] == 0.0
        && options.rotation_quat[2] == 0.0;
    if !is_identity {
        for p in &mut mesh.positions {
            *p = p.rotate_by_quat(options.rotation_quat);
        }
    }

    let source_triangle_count = mesh.triangle_count();
    if source_triangle_count == 0 || mesh.positions.is_empty() {
        return HollowOutcome {
            mesh,
            cavity_mesh: None,
            preview_infill_mesh: None,
            removed_voxel_centers: Vec::new(),
            removed_voxel_indices: Vec::new(),
            blocked_voxel_centers: Vec::new(),
            blocked_voxel_indices: Vec::new(),
            report: HollowReport {
                mode: options.mode,
                voxel_resolution: options.voxel_resolution,
                voxel_size_mm: 0.0,
                shell_thickness_mm: options.shell_thickness_mm,
                source_triangle_count,
                output_triangle_count: source_triangle_count,
                grid_size: [0, 0, 0],
                occupied_voxels: 0,
                shell_voxels: 0,
                removed_voxels: 0,
            },
        };
    }

    let source_bbox = mesh.bbox();
    let diag = source_bbox.max.sub(source_bbox.min);
    let max_extent = diag.x.max(diag.y).max(diag.z).max(1e-3);
    let resolution = options.voxel_resolution.clamp(24, 192) as f32;
    let voxel_mm = (max_extent / resolution).max(0.05);
    let shell_voxels = (options.shell_thickness_mm.max(0.2) / voxel_mm).ceil() as i32;
    let shell_voxels = shell_voxels.max(1);
    let smoothing_profile = effective_internal_cavity_smoothing_profile(
        options.shell_thickness_mm,
        options.smooth_internal_surfaces,
        shell_voxels as f32,
    );

    // Pad by 1 voxel so outside flood-fill has a guaranteed margin.
    let padded_min = source_bbox.min.sub(Vec3::new(voxel_mm, voxel_mm, voxel_mm));
    let padded_max = source_bbox.max.add(Vec3::new(voxel_mm, voxel_mm, voxel_mm));
    let padded = Aabb {
        min: padded_min,
        max: padded_max,
    };

    let size = padded.max.sub(padded.min);
    let nx = ((size.x / voxel_mm).ceil() as usize).max(4);
    let ny = ((size.y / voxel_mm).ceil() as usize).max(4);
    let nz = ((size.z / voxel_mm).ceil() as usize).max(4);

    let grid = GridSpec {
        nx,
        ny,
        nz,
        voxel_mm,
        min: padded.min,
    };

    let tri_cache: Vec<TriangleCache> = mesh
        .triangles
        .iter()
        .map(|tri| {
            let a = mesh.positions[tri[0] as usize];
            let b = mesh.positions[tri[1] as usize];
            let c = mesh.positions[tri[2] as usize];
            TriangleCache::from_points(a, b, c)
        })
        .collect();

    let mut surface = vec![false; nx * ny * nz];
    let voxel_diag_half = (3.0f32).sqrt() * voxel_mm * 0.5;

    // Surface voxelization by triangle AABB walk + point-to-triangle distance.
    for tri in &tri_cache {
        let min_ix = (((tri.min.x - grid.min.x) / voxel_mm).floor() as isize - 1).max(0) as usize;
        let max_ix = (((tri.max.x - grid.min.x) / voxel_mm).ceil() as isize + 1)
            .min(nx as isize - 1) as usize;
        let min_iy = (((tri.min.y - grid.min.y) / voxel_mm).floor() as isize - 1).max(0) as usize;
        let max_iy = (((tri.max.y - grid.min.y) / voxel_mm).ceil() as isize + 1)
            .min(ny as isize - 1) as usize;
        let min_iz = (((tri.min.z - grid.min.z) / voxel_mm).floor() as isize - 1).max(0) as usize;
        let max_iz = (((tri.max.z - grid.min.z) / voxel_mm).ceil() as isize + 1)
            .min(nz as isize - 1) as usize;

        for z in min_iz..=max_iz {
            for y in min_iy..=max_iy {
                for x in min_ix..=max_ix {
                    let p = grid.center_world(x, y, z);
                    let d = point_triangle_distance(p, tri.a, tri.b, tri.c);
                    if d <= voxel_diag_half {
                        surface[grid.idx(x, y, z)] = true;
                    }
                }
            }
        }
    }

    // Outside flood-fill through non-surface voxels.
    let mut outside = vec![false; nx * ny * nz];
    let mut q = VecDeque::<(usize, usize, usize)>::new();

    let mut push_seed = |x: usize, y: usize, z: usize| {
        let i = grid.idx(x, y, z);
        if surface[i] || outside[i] {
            return;
        }
        outside[i] = true;
        q.push_back((x, y, z));
    };

    for x in 0..nx {
        for y in 0..ny {
            push_seed(x, y, 0);
            push_seed(x, y, nz - 1);
        }
    }
    for x in 0..nx {
        for z in 0..nz {
            push_seed(x, 0, z);
            push_seed(x, ny - 1, z);
        }
    }
    for y in 0..ny {
        for z in 0..nz {
            push_seed(0, y, z);
            push_seed(nx - 1, y, z);
        }
    }

    while let Some((x, y, z)) = q.pop_front() {
        for (dx, dy, dz) in N6 {
            let nx_i = x as isize + dx;
            let ny_i = y as isize + dy;
            let nz_i = z as isize + dz;
            if !grid.in_bounds(nx_i, ny_i, nz_i) {
                continue;
            }
            let ux = nx_i as usize;
            let uy = ny_i as usize;
            let uz = nz_i as usize;
            let i = grid.idx(ux, uy, uz);
            if surface[i] || outside[i] {
                continue;
            }
            outside[i] = true;
            q.push_back((ux, uy, uz));
        }
    }

    // Fill interior = !outside. This includes the surface layer itself.
    let mut solid = vec![false; nx * ny * nz];
    for i in 0..solid.len() {
        solid[i] = !outside[i];
    }

    // Flood-fill alone treats sealed air pockets in already-hollow source
    // shells as "solid". Classify only the non-surface components with parity
    // so nested/smushed shells preserve their existing cavities without paying
    // for a parity test on every occupied voxel.
    refine_non_surface_solid_components_with_parity(&grid, &surface, &mut solid, &mesh);
    let source_void_components = label_void_components(&grid, &solid);

    let occupied_voxels = solid.iter().filter(|v| **v).count();

    // Multi-source BFS over solid voxels from boundary-adjacent solid cells.
    // Two-pass 26-neighbour chamfer distance transform.
    //
    // The old 6-neighbour hop-count BFS measured the L1 (taxicab) distance,
    // which underestimates the true Euclidean distance at diagonal directions
    // by up to 1 − 1/√2 ≈ 29 %.  At a 90° convex exterior corner the cavity
    // would intrude too deeply, producing thin walls and a 45° bevel where a
    // right-angle inner surface was expected.
    //
    // The two-pass EDT approximates Euclidean distance (in voxel units) to
    // within ~2 % by propagating face (cost 1), edge (cost √2), and corner
    // (cost √3) steps.  Scan order: z-outer, y-middle, x-inner.
    let mut dist = vec![f32::INFINITY; nx * ny * nz];

    // Seed every mesh-surface voxel so thickness is preserved to both exterior
    // walls and any pre-existing interior cavity walls.
    for z in 0..nz {
        for y in 0..ny {
            for x in 0..nx {
                let i = grid.idx(x, y, z);
                if solid[i] && surface[i] {
                    dist[i] = 0.0;
                }
            }
        }
    }

    // Forward pass: relax each voxel via the 13 already-visited
    // backward-offset neighbours.
    for z in 0..nz {
        for y in 0..ny {
            for x in 0..nx {
                let i = grid.idx(x, y, z);
                if !solid[i] {
                    continue;
                }
                let mut d = dist[i];
                for &((dx, dy, dz), w) in &SHELL_DIST_FORWARD {
                    let nx_i = x as isize + dx;
                    let ny_i = y as isize + dy;
                    let nz_i = z as isize + dz;
                    if !grid.in_bounds(nx_i, ny_i, nz_i) {
                        continue;
                    }
                    let ni = grid.idx(nx_i as usize, ny_i as usize, nz_i as usize);
                    if !solid[ni] {
                        continue;
                    }
                    let candidate = dist[ni] + w;
                    if candidate < d {
                        d = candidate;
                    }
                }
                dist[i] = d;
            }
        }
    }

    // Backward pass: relax via the 13 complementary forward-offset neighbours.
    for z in (0..nz).rev() {
        for y in (0..ny).rev() {
            for x in (0..nx).rev() {
                let i = grid.idx(x, y, z);
                if !solid[i] {
                    continue;
                }
                let mut d = dist[i];
                for &((dx, dy, dz), w) in &SHELL_DIST_BACKWARD {
                    let nx_i = x as isize + dx;
                    let ny_i = y as isize + dy;
                    let nz_i = z as isize + dz;
                    if !grid.in_bounds(nx_i, ny_i, nz_i) {
                        continue;
                    }
                    let ni = grid.idx(nx_i as usize, ny_i as usize, nz_i as usize);
                    if !solid[ni] {
                        continue;
                    }
                    let candidate = dist[ni] + w;
                    if candidate < d {
                        d = candidate;
                    }
                }
                dist[i] = d;
            }
        }
    }

    // Shell-membership threshold in voxel units (exact float, not ceiling-rounded).
    let shell_voxels_f = options.shell_thickness_mm.max(0.2) / voxel_mm;

    let mut keep = vec![false; nx * ny * nz];
    let mut kept_shell = 0usize;
    for i in 0..keep.len() {
        if solid[i] && dist[i] <= shell_voxels_f {
            keep[i] = true;
            kept_shell += 1;
        }
    }

    // Preserve separator voxels that sit between different source void
    // regions (outside or pre-existing enclosed cavities). This prevents the
    // generated cavity from "punching through" shell walls in multi-shell
    // source meshes when voxelization under-resolves nearby sheets.
    preserve_source_void_separators(&grid, &solid, &source_void_components, &mut keep);

    // Optional drain holes for cavity mode.
    if matches!(options.mode, HollowMode::Cavity) && !options.drain_holes.is_empty() {
        for hole in &options.drain_holes {
            apply_drain_hole_corridor(&grid, &mut keep, hole, &source_bbox, voxel_mm);
        }
    }

    // Shell-open-face mode removes the selected exterior face cap through at
    // least shell thickness depth.
    if matches!(options.mode, HollowMode::ShellOpenFace) {
        let depth = shell_voxels.max(1) as usize;
        for z in 0..nz {
            for y in 0..ny {
                for x in 0..nx {
                    let remove = match options.open_face {
                        OpenFace::XMin => x < depth,
                        OpenFace::XMax => x + depth >= nx,
                        OpenFace::YMin => y < depth,
                        OpenFace::YMax => y + depth >= ny,
                        OpenFace::ZMin => z < depth,
                        OpenFace::ZMax => z + depth >= nz,
                    };
                    if remove {
                        keep[grid.idx(x, y, z)] = false;
                    }
                }
            }
        }
    }

    // Optional voxel-level chamfering on cavity boundaries to turn hard
    // orthogonal internal steps into printable ~45° transitions.
    if options.internal_chamfer_passes > 0 && !options.smooth_internal_surfaces {
        let passes = effective_internal_cavity_chamfer_passes(
            options.shell_thickness_mm,
            shell_voxels_f,
            options.internal_chamfer_passes,
        );
        for _ in 0..passes {
            apply_internal_cavity_chamfer_pass(&grid, &solid, &mut keep, &dist);
        }
        if passes > 0 {
            preserve_source_void_separators(&grid, &solid, &source_void_components, &mut keep);
        }
    }

    // In cavity mode, keep exactly one connected interior cavity.
    // Any disconnected pockets are filled back to solid instead of tunneling
    // between them, which preserves minimum shell thickness guarantees.
    if matches!(options.mode, HollowMode::Cavity) {
        retain_largest_connected_cavity_component(&grid, &solid, &mut keep);
    }

    for &blocked_index in &options.blocked_voxel_indices {
        if blocked_index < keep.len() && solid[blocked_index] {
            keep[blocked_index] = true;
        }
    }

    let removed_voxels = occupied_voxels.saturating_sub(keep.iter().filter(|v| **v).count());

    let (mut out_mesh, cavity_mesh) = if options.preview_voxel_spheres {
        // Sphere preview: skip the expensive mesh building entirely.
        // The frontend will render spheres at removed_voxel_centers instead.
        (mesh.clone(), IndexedMesh::default())
    } else {
        let (out, cavity) = build_hollow_output_mesh(
            &mesh,
            &source_bbox,
            &grid,
            &solid,
            &dist,
            &keep,
            options,
            shell_voxels_f,
            smoothing_profile,
        );
        #[cfg(feature = "manifold")]
        let (out, cavity) = finalize_hollow_output_mesh_for_manifold(
            &mesh,
            &source_bbox,
            &grid,
            &solid,
            &dist,
            &keep,
            options,
            shell_voxels_f,
            smoothing_profile,
            out,
            cavity,
        );
        (out, cavity)
    };
    let output_triangle_count = out_mesh.triangle_count();
    let mut maybe_cavity = if cavity_mesh.triangles.is_empty() {
        None
    } else {
        Some(cavity_mesh)
    };
    let mut preview_infill_mesh =
        if options.preview_cavity_only && matches!(options.mode, HollowMode::Infill) {
            let mesh = build_smooth_infill_mesh(
                &source_bbox,
                &grid,
                &solid,
                &keep,
                options.infill_mode,
                options.infill_cell_mm,
                options.infill_beam_radius_mm,
            );
            if mesh.triangles.is_empty() {
                None
            } else {
                Some(mesh)
            }
        } else {
            None
        };
    let mut removed_voxel_centers = collect_removed_voxel_centers(&grid, &solid, &keep);
    let removed_voxel_indices = collect_removed_voxel_indices(&grid, &solid, &keep);
    let mut blocked_voxel_centers =
        collect_blocked_voxel_centers(&grid, &options.blocked_voxel_indices);

    // Unrotate all outputs so DragonFruit's own (unrotated) geometry stays in
    // sync with what Rust produces.
    if !is_identity {
        let inv_quat = [
            -options.rotation_quat[0],
            -options.rotation_quat[1],
            -options.rotation_quat[2],
            options.rotation_quat[3],
        ];
        for p in &mut out_mesh.positions {
            *p = p.rotate_by_quat(inv_quat);
        }
        if let Some(ref mut cm) = maybe_cavity {
            for p in &mut cm.positions {
                *p = p.rotate_by_quat(inv_quat);
            }
        }
        if let Some(ref mut im) = preview_infill_mesh {
            for p in &mut im.positions {
                *p = p.rotate_by_quat(inv_quat);
            }
        }
        for chunk in removed_voxel_centers.chunks_exact_mut(3) {
            let v = Vec3::new(chunk[0], chunk[1], chunk[2]).rotate_by_quat(inv_quat);
            chunk[0] = v.x;
            chunk[1] = v.y;
            chunk[2] = v.z;
        }
        for chunk in blocked_voxel_centers.chunks_exact_mut(3) {
            let v = Vec3::new(chunk[0], chunk[1], chunk[2]).rotate_by_quat(inv_quat);
            chunk[0] = v.x;
            chunk[1] = v.y;
            chunk[2] = v.z;
        }
    }

    HollowOutcome {
        mesh: out_mesh,
        cavity_mesh: maybe_cavity,
        preview_infill_mesh,
        removed_voxel_centers,
        removed_voxel_indices,
        blocked_voxel_centers,
        blocked_voxel_indices: options
            .blocked_voxel_indices
            .clone()
            .into_iter()
            .map(|i| i as u32)
            .collect(),
        report: HollowReport {
            mode: options.mode,
            voxel_resolution: options.voxel_resolution,
            voxel_size_mm: voxel_mm,
            shell_thickness_mm: options.shell_thickness_mm,
            source_triangle_count,
            output_triangle_count,
            grid_size: [nx, ny, nz],
            occupied_voxels,
            shell_voxels: kept_shell,
            removed_voxels,
        },
    }
}

impl HollowSession {
    pub fn new(mesh: IndexedMesh, voxel_resolution: u16) -> Self {
        Self::with_rotation(mesh, voxel_resolution, [0.0, 0.0, 0.0, 1.0])
    }

    pub fn with_rotation(
        mut mesh: IndexedMesh,
        voxel_resolution: u16,
        rotation_quat: [f32; 4],
    ) -> Self {
        // Apply rotation to mesh positions so the voxel grid aligns with the
        // rotated model. The output will be unrotated before returning.
        let is_identity =
            rotation_quat[0] == 0.0 && rotation_quat[1] == 0.0 && rotation_quat[2] == 0.0;
        if !is_identity {
            for p in &mut mesh.positions {
                *p = p.rotate_by_quat(rotation_quat);
            }
        }

        let source_triangle_count = mesh.triangle_count();
        let source_bbox = mesh.bbox();
        let diag = source_bbox.max.sub(source_bbox.min);
        let max_extent = diag.x.max(diag.y).max(diag.z).max(1e-3);
        let resolution = voxel_resolution.clamp(24, 192) as f32;
        let voxel_mm = (max_extent / resolution).max(0.05);

        let padded_min = source_bbox.min.sub(Vec3::new(voxel_mm, voxel_mm, voxel_mm));
        let padded_max = source_bbox.max.add(Vec3::new(voxel_mm, voxel_mm, voxel_mm));
        let padded = Aabb {
            min: padded_min,
            max: padded_max,
        };

        let size = padded.max.sub(padded.min);
        let nx = ((size.x / voxel_mm).ceil() as usize).max(4);
        let ny = ((size.y / voxel_mm).ceil() as usize).max(4);
        let nz = ((size.z / voxel_mm).ceil() as usize).max(4);

        let grid = GridSpec {
            nx,
            ny,
            nz,
            voxel_mm,
            min: padded.min,
        };

        let tri_cache: Vec<TriangleCache> = mesh
            .triangles
            .iter()
            .map(|tri| {
                let a = mesh.positions[tri[0] as usize];
                let b = mesh.positions[tri[1] as usize];
                let c = mesh.positions[tri[2] as usize];
                TriangleCache::from_points(a, b, c)
            })
            .collect();

        let mut surface = vec![false; nx * ny * nz];
        let voxel_diag_half = (3.0f32).sqrt() * voxel_mm * 0.5;
        for tri in &tri_cache {
            let min_ix =
                (((tri.min.x - grid.min.x) / voxel_mm).floor() as isize - 1).max(0) as usize;
            let max_ix = (((tri.max.x - grid.min.x) / voxel_mm).ceil() as isize + 1)
                .min(nx as isize - 1) as usize;
            let min_iy =
                (((tri.min.y - grid.min.y) / voxel_mm).floor() as isize - 1).max(0) as usize;
            let max_iy = (((tri.max.y - grid.min.y) / voxel_mm).ceil() as isize + 1)
                .min(ny as isize - 1) as usize;
            let min_iz =
                (((tri.min.z - grid.min.z) / voxel_mm).floor() as isize - 1).max(0) as usize;
            let max_iz = (((tri.max.z - grid.min.z) / voxel_mm).ceil() as isize + 1)
                .min(nz as isize - 1) as usize;

            for z in min_iz..=max_iz {
                for y in min_iy..=max_iy {
                    for x in min_ix..=max_ix {
                        let p = grid.center_world(x, y, z);
                        let d = point_triangle_distance(p, tri.a, tri.b, tri.c);
                        if d <= voxel_diag_half {
                            surface[grid.idx(x, y, z)] = true;
                        }
                    }
                }
            }
        }

        let mut outside = vec![false; nx * ny * nz];
        let mut q = VecDeque::<(usize, usize, usize)>::new();
        let mut push_seed = |x: usize, y: usize, z: usize| {
            let i = grid.idx(x, y, z);
            if surface[i] || outside[i] {
                return;
            }
            outside[i] = true;
            q.push_back((x, y, z));
        };

        for x in 0..nx {
            for y in 0..ny {
                push_seed(x, y, 0);
                push_seed(x, y, nz - 1);
            }
        }
        for x in 0..nx {
            for z in 0..nz {
                push_seed(x, 0, z);
                push_seed(x, ny - 1, z);
            }
        }
        for y in 0..ny {
            for z in 0..nz {
                push_seed(0, y, z);
                push_seed(nx - 1, y, z);
            }
        }

        while let Some((x, y, z)) = q.pop_front() {
            for (dx, dy, dz) in N6 {
                let nx_i = x as isize + dx;
                let ny_i = y as isize + dy;
                let nz_i = z as isize + dz;
                if !grid.in_bounds(nx_i, ny_i, nz_i) {
                    continue;
                }
                let ux = nx_i as usize;
                let uy = ny_i as usize;
                let uz = nz_i as usize;
                let i = grid.idx(ux, uy, uz);
                if surface[i] || outside[i] {
                    continue;
                }
                outside[i] = true;
                q.push_back((ux, uy, uz));
            }
        }

        let mut solid = vec![false; nx * ny * nz];
        for i in 0..solid.len() {
            solid[i] = !outside[i];
        }

        refine_non_surface_solid_components_with_parity(&grid, &surface, &mut solid, &mesh);
        let source_void_components = label_void_components(&grid, &solid);
        let occupied_voxels = solid.iter().filter(|v| **v).count();

        let mut dist = vec![f32::INFINITY; nx * ny * nz];
        for z in 0..nz {
            for y in 0..ny {
                for x in 0..nx {
                    let i = grid.idx(x, y, z);
                    if solid[i] && surface[i] {
                        dist[i] = 0.0;
                    }
                }
            }
        }

        for z in 0..nz {
            for y in 0..ny {
                for x in 0..nx {
                    let i = grid.idx(x, y, z);
                    if !solid[i] {
                        continue;
                    }
                    let mut d = dist[i];
                    for &((dx, dy, dz), w) in &SHELL_DIST_FORWARD {
                        let nx_i = x as isize + dx;
                        let ny_i = y as isize + dy;
                        let nz_i = z as isize + dz;
                        if !grid.in_bounds(nx_i, ny_i, nz_i) {
                            continue;
                        }
                        let ni = grid.idx(nx_i as usize, ny_i as usize, nz_i as usize);
                        if !solid[ni] {
                            continue;
                        }
                        let candidate = dist[ni] + w;
                        if candidate < d {
                            d = candidate;
                        }
                    }
                    dist[i] = d;
                }
            }
        }

        for z in (0..nz).rev() {
            for y in (0..ny).rev() {
                for x in (0..nx).rev() {
                    let i = grid.idx(x, y, z);
                    if !solid[i] {
                        continue;
                    }
                    let mut d = dist[i];
                    for &((dx, dy, dz), w) in &SHELL_DIST_BACKWARD {
                        let nx_i = x as isize + dx;
                        let ny_i = y as isize + dy;
                        let nz_i = z as isize + dz;
                        if !grid.in_bounds(nx_i, ny_i, nz_i) {
                            continue;
                        }
                        let ni = grid.idx(nx_i as usize, ny_i as usize, nz_i as usize);
                        if !solid[ni] {
                            continue;
                        }
                        let candidate = dist[ni] + w;
                        if candidate < d {
                            d = candidate;
                        }
                    }
                    dist[i] = d;
                }
            }
        }

        Self {
            source_mesh: mesh,
            source_bbox,
            grid,
            solid,
            dist,
            source_void_components,
            source_triangle_count,
            occupied_voxels,
            voxel_resolution,
            rotation_quat,
        }
    }

    pub fn voxel_resolution(&self) -> u16 {
        self.voxel_resolution
    }

    /// The rotation quaternion used when creating this session.
    pub fn rotation_quat(&self) -> [f32; 4] {
        self.rotation_quat
    }

    pub fn run(&self, options: &HollowOptions) -> HollowOutcome {
        let shell_voxels = (options.shell_thickness_mm.max(0.2) / self.grid.voxel_mm).ceil() as i32;
        let shell_voxels = shell_voxels.max(1);
        let shell_voxels_f = options.shell_thickness_mm.max(0.2) / self.grid.voxel_mm;
        let smoothing_profile = effective_internal_cavity_smoothing_profile(
            options.shell_thickness_mm,
            options.smooth_internal_surfaces,
            shell_voxels_f,
        );

        let mut keep = vec![false; self.solid.len()];
        let mut kept_shell = 0usize;
        for i in 0..keep.len() {
            if self.solid[i] && self.dist[i] <= shell_voxels_f {
                keep[i] = true;
                kept_shell += 1;
            }
        }

        preserve_source_void_separators(
            &self.grid,
            &self.solid,
            &self.source_void_components,
            &mut keep,
        );

        if matches!(options.mode, HollowMode::Cavity) && !options.drain_holes.is_empty() {
            for hole in &options.drain_holes {
                apply_drain_hole_corridor(
                    &self.grid,
                    &mut keep,
                    hole,
                    &self.source_bbox,
                    self.grid.voxel_mm,
                );
            }
        }

        if matches!(options.mode, HollowMode::ShellOpenFace) {
            let depth = shell_voxels.max(1) as usize;
            for z in 0..self.grid.nz {
                for y in 0..self.grid.ny {
                    for x in 0..self.grid.nx {
                        let remove = match options.open_face {
                            OpenFace::XMin => x < depth,
                            OpenFace::XMax => x + depth >= self.grid.nx,
                            OpenFace::YMin => y < depth,
                            OpenFace::YMax => y + depth >= self.grid.ny,
                            OpenFace::ZMin => z < depth,
                            OpenFace::ZMax => z + depth >= self.grid.nz,
                        };
                        if remove {
                            keep[self.grid.idx(x, y, z)] = false;
                        }
                    }
                }
            }
        }

        if options.internal_chamfer_passes > 0 && !options.smooth_internal_surfaces {
            let passes = effective_internal_cavity_chamfer_passes(
                options.shell_thickness_mm,
                shell_voxels_f,
                options.internal_chamfer_passes,
            );
            for _ in 0..passes {
                apply_internal_cavity_chamfer_pass(&self.grid, &self.solid, &mut keep, &self.dist);
            }
            if passes > 0 {
                preserve_source_void_separators(
                    &self.grid,
                    &self.solid,
                    &self.source_void_components,
                    &mut keep,
                );
            }
        }

        if matches!(options.mode, HollowMode::Cavity) {
            retain_largest_connected_cavity_component(&self.grid, &self.solid, &mut keep);
        }

        for &blocked_index in &options.blocked_voxel_indices {
            if blocked_index < keep.len() && self.solid[blocked_index] {
                keep[blocked_index] = true;
            }
        }

        let removed_voxels = self
            .occupied_voxels
            .saturating_sub(keep.iter().filter(|v| **v).count());
        let (mut out_mesh, cavity_mesh) = if options.preview_voxel_spheres {
            // Sphere preview: skip the expensive mesh building entirely.
            (self.source_mesh.clone(), IndexedMesh::default())
        } else {
            let (out, cavity) = build_hollow_output_mesh(
                &self.source_mesh,
                &self.source_bbox,
                &self.grid,
                &self.solid,
                &self.dist,
                &keep,
                options,
                shell_voxels_f,
                smoothing_profile,
            );
            #[cfg(feature = "manifold")]
            let (out, cavity) = finalize_hollow_output_mesh_for_manifold(
                &self.source_mesh,
                &self.source_bbox,
                &self.grid,
                &self.solid,
                &self.dist,
                &keep,
                options,
                shell_voxels_f,
                smoothing_profile,
                out,
                cavity,
            );
            (out, cavity)
        };
        let output_triangle_count = out_mesh.triangle_count();
        let mut maybe_cavity = if cavity_mesh.triangles.is_empty() {
            None
        } else {
            Some(cavity_mesh)
        };
        let mut preview_infill_mesh =
            if options.preview_cavity_only && matches!(options.mode, HollowMode::Infill) {
                let mesh = build_smooth_infill_mesh(
                    &self.source_bbox,
                    &self.grid,
                    &self.solid,
                    &keep,
                    options.infill_mode,
                    options.infill_cell_mm,
                    options.infill_beam_radius_mm,
                );
                if mesh.triangles.is_empty() {
                    None
                } else {
                    Some(mesh)
                }
            } else {
                None
            };
        let mut removed_voxel_centers =
            collect_removed_voxel_centers(&self.grid, &self.solid, &keep);
        let removed_voxel_indices = collect_removed_voxel_indices(&self.grid, &self.solid, &keep);
        let mut blocked_voxel_centers =
            collect_blocked_voxel_centers(&self.grid, &options.blocked_voxel_indices);

        // Unrotate all outputs so DragonFruit's own (unrotated) geometry
        // stays in sync with what Rust produces.
        let inv_quat = [
            -self.rotation_quat[0],
            -self.rotation_quat[1],
            -self.rotation_quat[2],
            self.rotation_quat[3],
        ];
        let is_identity = self.rotation_quat[0] == 0.0
            && self.rotation_quat[1] == 0.0
            && self.rotation_quat[2] == 0.0;
        if !is_identity {
            for p in &mut out_mesh.positions {
                *p = p.rotate_by_quat(inv_quat);
            }
            if let Some(ref mut cm) = maybe_cavity {
                for p in &mut cm.positions {
                    *p = p.rotate_by_quat(inv_quat);
                }
            }
            if let Some(ref mut im) = preview_infill_mesh {
                for p in &mut im.positions {
                    *p = p.rotate_by_quat(inv_quat);
                }
            }
            for chunk in removed_voxel_centers.chunks_exact_mut(3) {
                let v = Vec3::new(chunk[0], chunk[1], chunk[2]).rotate_by_quat(inv_quat);
                chunk[0] = v.x;
                chunk[1] = v.y;
                chunk[2] = v.z;
            }
            for chunk in blocked_voxel_centers.chunks_exact_mut(3) {
                let v = Vec3::new(chunk[0], chunk[1], chunk[2]).rotate_by_quat(inv_quat);
                chunk[0] = v.x;
                chunk[1] = v.y;
                chunk[2] = v.z;
            }
        }

        HollowOutcome {
            mesh: out_mesh,
            cavity_mesh: maybe_cavity,
            preview_infill_mesh,
            removed_voxel_centers,
            removed_voxel_indices,
            blocked_voxel_centers,
            blocked_voxel_indices: options
                .blocked_voxel_indices
                .clone()
                .into_iter()
                .map(|i| i as u32)
                .collect(),
            report: HollowReport {
                mode: options.mode,
                voxel_resolution: self.voxel_resolution,
                voxel_size_mm: self.grid.voxel_mm,
                shell_thickness_mm: options.shell_thickness_mm,
                source_triangle_count: self.source_triangle_count,
                output_triangle_count,
                grid_size: [self.grid.nx, self.grid.ny, self.grid.nz],
                occupied_voxels: self.occupied_voxels,
                shell_voxels: kept_shell,
                removed_voxels,
            },
        }
    }
}

fn collect_removed_voxel_centers(grid: &GridSpec, solid: &[bool], keep: &[bool]) -> Vec<f32> {
    let removed_count = solid
        .iter()
        .zip(keep.iter())
        .filter(|(is_solid, is_kept)| **is_solid && !**is_kept)
        .count();
    let mut centers = Vec::with_capacity(removed_count * 3);

    for z in 0..grid.nz {
        for y in 0..grid.ny {
            for x in 0..grid.nx {
                let index = grid.idx(x, y, z);
                if !solid[index] || keep[index] {
                    continue;
                }
                let center = grid.center_world(x, y, z);
                centers.push(center.x);
                centers.push(center.y);
                centers.push(center.z);
            }
        }
    }

    centers
}

fn collect_removed_voxel_indices(grid: &GridSpec, solid: &[bool], keep: &[bool]) -> Vec<u32> {
    let removed_count = solid
        .iter()
        .zip(keep.iter())
        .filter(|(is_solid, is_kept)| **is_solid && !**is_kept)
        .count();
    let mut indices = Vec::with_capacity(removed_count);

    for z in 0..grid.nz {
        for y in 0..grid.ny {
            for x in 0..grid.nx {
                let index = grid.idx(x, y, z);
                if !solid[index] || keep[index] {
                    continue;
                }
                indices.push(index as u32);
            }
        }
    }

    indices
}

fn collect_blocked_voxel_centers(grid: &GridSpec, blocked_indices: &[usize]) -> Vec<f32> {
    let mut centers = Vec::with_capacity(blocked_indices.len() * 3);
    for &index in blocked_indices {
        let nz = grid.nz;
        let ny = grid.ny;
        let nx = grid.nx;
        let z = index / (nx * ny);
        let yz = index % (nx * ny);
        let y = yz / nx;
        let x = yz % nx;
        if x < nx && y < ny && z < nz {
            let c = grid.center_world(x, y, z);
            centers.push(c.x);
            centers.push(c.y);
            centers.push(c.z);
        }
    }
    centers
}

#[cfg(not(feature = "manifold"))]
fn voxel_cavity_boundary_mesh(grid: &GridSpec, solid: &[bool], keep: &[bool]) -> IndexedMesh {
    let mut soup = Vec::<f32>::new();
    soup.reserve(keep.len() / 2 * 36);

    let s = grid.voxel_mm;
    for z in 0..grid.nz {
        for y in 0..grid.ny {
            for x in 0..grid.nx {
                let i = grid.idx(x, y, z);
                if !keep[i] {
                    continue;
                }

                let base = Vec3::new(
                    grid.min.x + x as f32 * s,
                    grid.min.y + y as f32 * s,
                    grid.min.z + z as f32 * s,
                );

                // +X face (only where neighboring voxel is carved interior)
                if is_cavity_neighbor(grid, solid, keep, x as isize + 1, y as isize, z as isize) {
                    emit_quad(
                        &mut soup,
                        Vec3::new(base.x + s, base.y, base.z),
                        Vec3::new(base.x + s, base.y + s, base.z),
                        Vec3::new(base.x + s, base.y + s, base.z + s),
                        Vec3::new(base.x + s, base.y, base.z + s),
                    );
                }

                // -X face
                if is_cavity_neighbor(grid, solid, keep, x as isize - 1, y as isize, z as isize) {
                    emit_quad(
                        &mut soup,
                        Vec3::new(base.x, base.y, base.z),
                        Vec3::new(base.x, base.y, base.z + s),
                        Vec3::new(base.x, base.y + s, base.z + s),
                        Vec3::new(base.x, base.y + s, base.z),
                    );
                }

                // +Y face
                if is_cavity_neighbor(grid, solid, keep, x as isize, y as isize + 1, z as isize) {
                    emit_quad(
                        &mut soup,
                        Vec3::new(base.x, base.y + s, base.z),
                        Vec3::new(base.x, base.y + s, base.z + s),
                        Vec3::new(base.x + s, base.y + s, base.z + s),
                        Vec3::new(base.x + s, base.y + s, base.z),
                    );
                }

                // -Y face
                if is_cavity_neighbor(grid, solid, keep, x as isize, y as isize - 1, z as isize) {
                    emit_quad(
                        &mut soup,
                        Vec3::new(base.x, base.y, base.z),
                        Vec3::new(base.x + s, base.y, base.z),
                        Vec3::new(base.x + s, base.y, base.z + s),
                        Vec3::new(base.x, base.y, base.z + s),
                    );
                }

                // +Z face
                if is_cavity_neighbor(grid, solid, keep, x as isize, y as isize, z as isize + 1) {
                    emit_quad(
                        &mut soup,
                        Vec3::new(base.x, base.y, base.z + s),
                        Vec3::new(base.x + s, base.y, base.z + s),
                        Vec3::new(base.x + s, base.y + s, base.z + s),
                        Vec3::new(base.x, base.y + s, base.z + s),
                    );
                }

                // -Z face
                if is_cavity_neighbor(grid, solid, keep, x as isize, y as isize, z as isize - 1) {
                    emit_quad(
                        &mut soup,
                        Vec3::new(base.x, base.y, base.z),
                        Vec3::new(base.x, base.y + s, base.z),
                        Vec3::new(base.x + s, base.y + s, base.z),
                        Vec3::new(base.x + s, base.y, base.z),
                    );
                }
            }
        }
    }

    IndexedMesh::from_triangle_soup(&soup, 1e-6)
}

const CUBE_CORNERS: [(usize, usize, usize); 8] = [
    (0, 0, 0),
    (1, 0, 0),
    (1, 1, 0),
    (0, 1, 0),
    (0, 0, 1),
    (1, 0, 1),
    (1, 1, 1),
    (0, 1, 1),
];

const TETRAHEDRA_IN_CUBE: [[usize; 4]; 6] = [
    [0, 5, 1, 6],
    [0, 1, 2, 6],
    [0, 2, 3, 6],
    [0, 3, 7, 6],
    [0, 7, 4, 6],
    [0, 4, 5, 6],
];

fn organic_boundary_mesh(
    grid: &GridSpec,
    positive: &[bool],
    negative: &[bool],
    scalar_field: &[f32],
) -> IndexedMesh {
    let mut soup = Vec::<f32>::new();
    let mut corner_pos = [Vec3::ZERO; 8];
    let mut corner_scalar = [0.0f32; 8];
    let mut corner_kept = [false; 8];
    let mut corner_carved = [false; 8];

    for z in 0..grid.nz.saturating_sub(1) {
        for y in 0..grid.ny.saturating_sub(1) {
            for x in 0..grid.nx.saturating_sub(1) {
                let mut has_kept = false;
                let mut has_carved = false;
                let mut has_scalar_positive = false;
                let mut has_scalar_negative = false;

                for (corner_i, &(dx, dy, dz)) in CUBE_CORNERS.iter().enumerate() {
                    let vx = x + dx;
                    let vy = y + dy;
                    let vz = z + dz;
                    let vi = grid.idx(vx, vy, vz);

                    corner_pos[corner_i] = grid.center_world(vx, vy, vz);
                    corner_kept[corner_i] = positive[vi];
                    corner_carved[corner_i] = negative[vi];
                    has_kept |= corner_kept[corner_i];
                    has_carved |= corner_carved[corner_i];
                    corner_scalar[corner_i] = scalar_field[vi];
                    if corner_kept[corner_i] || corner_carved[corner_i] {
                        if corner_scalar[corner_i] >= 0.0 {
                            has_scalar_positive = true;
                        } else {
                            has_scalar_negative = true;
                        }
                    }
                }

                if !(has_kept && has_carved) && !(has_scalar_positive && has_scalar_negative) {
                    continue;
                }

                for tet in TETRAHEDRA_IN_CUBE {
                    polygonize_cavity_tetrahedron(
                        &mut soup,
                        tet,
                        &corner_pos,
                        &corner_scalar,
                        &corner_kept,
                        &corner_carved,
                    );
                }
            }
        }
    }

    IndexedMesh::from_triangle_soup(&soup, 1e-6)
}

fn build_smoothed_cavity_scalar_field(
    grid: &GridSpec,
    solid: &[bool],
    keep: &[bool],
    dist: &[f32],
    shell_voxels_f: f32,
    smoothing_iterations: usize,
) -> Vec<f32> {
    let exterior_value = -2.5f32;
    let active_band_voxels = 4.5f32;
    let mut field = vec![exterior_value; solid.len()];

    for i in 0..solid.len() {
        if solid[i] {
            let shell_signed = shell_voxels_f - dist[i];
            if keep[i] {
                // Shell-proper voxels keep their natural positive value.
                // Blocked voxels deep in the cavity get a small epsilon so the
                // zero-crossing sits just inside the blocked region and the
                // scalar-field blur can smoothly diffuse it outward.
                field[i] = shell_signed.max(0.05 * shell_voxels_f.max(0.2));
            } else {
                field[i] = shell_signed.min(-0.05 * shell_voxels_f.max(0.2));
            }
        }
    }

    let mut active = vec![false; solid.len()];
    for z in 0..grid.nz {
        for y in 0..grid.ny {
            for x in 0..grid.nx {
                let i = grid.idx(x, y, z);
                if !solid[i] {
                    continue;
                }

                let center = field[i];
                let mut touches_sign_change = false;
                for dz in -1isize..=1 {
                    for dy in -1isize..=1 {
                        for dx in -1isize..=1 {
                            if dx == 0 && dy == 0 && dz == 0 {
                                continue;
                            }
                            let nx_i = x as isize + dx;
                            let ny_i = y as isize + dy;
                            let nz_i = z as isize + dz;
                            if !grid.in_bounds(nx_i, ny_i, nz_i) {
                                continue;
                            }
                            let ni = grid.idx(nx_i as usize, ny_i as usize, nz_i as usize);
                            if !solid[ni] {
                                continue;
                            }
                            if (center >= 0.0) != (field[ni] >= 0.0) {
                                touches_sign_change = true;
                                break;
                            }
                        }
                        if touches_sign_change {
                            break;
                        }
                    }
                    if touches_sign_change {
                        break;
                    }
                }

                if touches_sign_change || center.abs() <= active_band_voxels {
                    active[i] = true;
                }
            }
        }
    }

    let mut scratch = field.clone();
    for _ in 0..smoothing_iterations {
        for z in 0..grid.nz {
            for y in 0..grid.ny {
                for x in 0..grid.nx {
                    let i = grid.idx(x, y, z);
                    if !active[i] {
                        scratch[i] = field[i];
                        continue;
                    }

                    let mut sum = field[i] * 5.0;
                    let mut weight = 5.0;
                    for dz in -1isize..=1 {
                        for dy in -1isize..=1 {
                            for dx in -1isize..=1 {
                                if dx == 0 && dy == 0 && dz == 0 {
                                    continue;
                                }
                                let nx_i = x as isize + dx;
                                let ny_i = y as isize + dy;
                                let nz_i = z as isize + dz;
                                if !grid.in_bounds(nx_i, ny_i, nz_i) {
                                    continue;
                                }
                                let ni = grid.idx(nx_i as usize, ny_i as usize, nz_i as usize);
                                if !solid[ni] {
                                    continue;
                                }

                                let step = dx.abs() + dy.abs() + dz.abs();
                                let w = match step {
                                    1 => 2.5,
                                    2 => 1.25,
                                    _ => 0.6,
                                };
                                sum += field[ni] * w;
                                weight += w;
                            }
                        }
                    }
                    let blurred = sum / weight;
                    scratch[i] = field[i] * 0.2 + blurred * 0.8;
                }
            }
        }
        std::mem::swap(&mut field, &mut scratch);
    }

    field
}

fn build_hollow_output_mesh(
    source_mesh: &IndexedMesh,
    source_bbox: &Aabb,
    grid: &GridSpec,
    solid: &[bool],
    dist: &[f32],
    keep: &[bool],
    options: &HollowOptions,
    shell_voxels_f: f32,
    smoothing_profile: InternalCavitySmoothingProfile,
) -> (IndexedMesh, IndexedMesh) {
    let cavity_mesh = build_cavity_inner_mesh(
        source_bbox,
        grid,
        solid,
        dist,
        keep,
        options,
        shell_voxels_f,
        smoothing_profile,
    );
    let out_mesh = if options.preview_cavity_only {
        cavity_mesh.clone()
    } else {
        let filtered_source =
            filter_source_mesh_for_openings(source_mesh, options, source_bbox, grid.voxel_mm);
        merge_meshes(&filtered_source, &cavity_mesh)
    };

    (normalize_mesh_for_boolean(out_mesh), cavity_mesh)
}

/// Build only the internal cavity (+ infill) mesh without the outer shell.
/// This is the portion that depends on the smoothing profile and must be
/// rebuilt on manifold retries. The outer shell is invariant.
fn build_cavity_inner_mesh(
    source_bbox: &Aabb,
    grid: &GridSpec,
    solid: &[bool],
    dist: &[f32],
    keep: &[bool],
    options: &HollowOptions,
    shell_voxels_f: f32,
    smoothing_profile: InternalCavitySmoothingProfile,
) -> IndexedMesh {
    let cavity_positive = keep.to_vec();
    let cavity_negative: Vec<bool> = solid
        .iter()
        .zip(keep.iter())
        .map(|(is_solid, is_kept)| *is_solid && !*is_kept)
        .collect();

    let cavity_scalar = build_smoothed_cavity_scalar_field(
        grid,
        solid,
        keep,
        dist,
        shell_voxels_f,
        smoothing_profile.scalar_field_blur_iterations,
    );
    let cavity_mesh = stabilize_cavity_mesh_for_boolean(
        smooth_cavity_mesh(
            organic_boundary_mesh(grid, &cavity_positive, &cavity_negative, &cavity_scalar),
            grid.voxel_mm,
            smoothing_profile.taubin_iterations,
            smoothing_profile.taubin_max_step_scale,
        ),
        grid.voxel_mm,
    );

    let infill_mesh = if matches!(options.mode, HollowMode::Infill) {
        build_smooth_infill_mesh(
            source_bbox,
            grid,
            solid,
            keep,
            options.infill_mode,
            options.infill_cell_mm,
            options.infill_beam_radius_mm,
        )
    } else {
        IndexedMesh::default()
    };

    if infill_mesh.triangles.is_empty() {
        cavity_mesh
    } else if cavity_mesh.triangles.is_empty() {
        infill_mesh
    } else {
        merge_meshes(&cavity_mesh, &infill_mesh)
    }
}

fn polygonize_cavity_tetrahedron(
    soup: &mut Vec<f32>,
    tet: [usize; 4],
    positions: &[Vec3; 8],
    scalar: &[f32; 8],
    kept: &[bool; 8],
    carved: &[bool; 8],
) {
    let tet_edges = [(0usize, 1usize), (0, 2), (0, 3), (1, 2), (1, 3), (2, 3)];
    let mut intersections = [Vec3::ZERO; 4];
    let mut intersection_count = 0usize;
    let mut side = [None; 4];
    let mut scalar_positive_count = 0usize;
    let mut scalar_negative_count = 0usize;

    for (local_i, &corner_i) in tet.iter().enumerate() {
        if !(kept[corner_i] || carved[corner_i]) {
            continue;
        }

        let is_positive = scalar[corner_i] >= 0.0;
        side[local_i] = Some(is_positive);
        if is_positive {
            scalar_positive_count += 1;
        } else {
            scalar_negative_count += 1;
        }
    }

    // Prefer the blurred scalar field for contouring. The previous extractor
    // only crossed hard kept/carved voxel labels, which let smoothing slide
    // vertices along a blocky voxel edge network but not escape that network.
    // If the scalar field is locally degenerate, fall back to hard labels so a
    // disabled or numerically flat field still produces a closed cavity wall.
    let use_scalar_sides = scalar_positive_count > 0 && scalar_negative_count > 0;
    if !use_scalar_sides {
        for (local_i, &corner_i) in tet.iter().enumerate() {
            side[local_i] = if kept[corner_i] {
                Some(true)
            } else if carved[corner_i] {
                Some(false)
            } else {
                None
            };
        }
    }

    for (ea, eb) in tet_edges {
        let ia = tet[ea];
        let ib = tet[eb];
        let Some(a_positive) = side[ea] else {
            continue;
        };
        let Some(b_positive) = side[eb] else {
            continue;
        };

        if a_positive == b_positive {
            continue;
        }

        let pa = positions[ia];
        let pb = positions[ib];
        let va = scalar[ia];
        let vb = scalar[ib];
        let denom = va - vb;
        let t = if !use_scalar_sides || denom.abs() <= 1e-6 {
            0.5
        } else {
            (va / denom).clamp(0.0, 1.0)
        };

        intersections[intersection_count] = pa.add(pb.sub(pa).scale(t));
        intersection_count += 1;
    }

    if intersection_count < 3 {
        return;
    }

    let mut positive_centroid = Vec3::ZERO;
    let mut negative_centroid = Vec3::ZERO;
    let mut positive_count = 0usize;
    let mut negative_count = 0usize;
    for (local_i, &corner_i) in tet.iter().enumerate() {
        match side[local_i] {
            Some(true) => {
                positive_centroid = positive_centroid.add(positions[corner_i]);
                positive_count += 1;
            }
            Some(false) => {
                negative_centroid = negative_centroid.add(positions[corner_i]);
                negative_count += 1;
            }
            None => {}
        }
    }

    if positive_count == 0 || negative_count == 0 {
        return;
    }

    positive_centroid = positive_centroid.scale(1.0 / positive_count as f32);
    negative_centroid = negative_centroid.scale(1.0 / negative_count as f32);
    let desired_normal = negative_centroid.sub(positive_centroid);

    if intersection_count == 3 {
        emit_oriented_triangle(
            soup,
            intersections[0],
            intersections[1],
            intersections[2],
            desired_normal,
        );
        return;
    }

    if intersection_count == 4 {
        let center = intersections[0]
            .add(intersections[1])
            .add(intersections[2])
            .add(intersections[3])
            .scale(0.25);

        let mut ordered = [
            intersections[0],
            intersections[1],
            intersections[2],
            intersections[3],
        ];
        sort_points_around_axis(&mut ordered, center, desired_normal);

        emit_oriented_triangle(soup, ordered[0], ordered[1], ordered[2], desired_normal);
        emit_oriented_triangle(soup, ordered[0], ordered[2], ordered[3], desired_normal);
    }
}

fn emit_oriented_triangle(soup: &mut Vec<f32>, a: Vec3, b: Vec3, c: Vec3, desired_normal: Vec3) {
    let normal = b.sub(a).cross(c.sub(a));
    if normal.dot(desired_normal) < 0.0 {
        soup.extend_from_slice(&[a.x, a.y, a.z, c.x, c.y, c.z, b.x, b.y, b.z]);
    } else {
        soup.extend_from_slice(&[a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z]);
    }
}

fn sort_points_around_axis(points: &mut [Vec3; 4], center: Vec3, axis: Vec3) {
    let axis = vec3_normalize(axis).unwrap_or(Vec3::new(0.0, 0.0, 1.0));
    let helper = if axis.z.abs() < 0.95 {
        Vec3::new(0.0, 0.0, 1.0)
    } else {
        Vec3::new(0.0, 1.0, 0.0)
    };
    let u = vec3_normalize(helper.cross(axis)).unwrap_or(Vec3::new(1.0, 0.0, 0.0));
    let v = vec3_normalize(axis.cross(u)).unwrap_or(Vec3::new(0.0, 1.0, 0.0));

    points.sort_by(|a, b| {
        let da = (*a).sub(center);
        let db = (*b).sub(center);
        let aa = da.dot(v).atan2(da.dot(u));
        let ab = db.dot(v).atan2(db.dot(u));
        aa.partial_cmp(&ab).unwrap_or(std::cmp::Ordering::Equal)
    });
}

fn smooth_cavity_mesh(
    mesh: IndexedMesh,
    voxel_mm: f32,
    iterations: usize,
    max_step_scale: f32,
) -> IndexedMesh {
    if iterations == 0 || mesh.positions.len() < 4 || mesh.triangles.is_empty() {
        return mesh;
    }

    let vertex_count = mesh.positions.len();
    let mut neighbors: Vec<Vec<usize>> = vec![Vec::new(); vertex_count];
    let mut vertex_faces: Vec<Vec<usize>> = vec![Vec::new(); vertex_count];
    let mut edge_counts: std::collections::HashMap<(u32, u32), u8> =
        std::collections::HashMap::with_capacity(mesh.triangles.len() * 2);

    let mut add_edge = |a: u32, b: u32| {
        let ai = a as usize;
        let bi = b as usize;
        neighbors[ai].push(bi);
        neighbors[bi].push(ai);

        let key = if a < b { (a, b) } else { (b, a) };
        let entry = edge_counts.entry(key).or_insert(0);
        *entry = entry.saturating_add(1);
    };

    for tri in &mesh.triangles {
        let [a, b, c] = *tri;
        if a == b || b == c || c == a {
            continue;
        }
        add_edge(a, b);
        add_edge(b, c);
        add_edge(c, a);
    }
    for (face_idx, tri) in mesh.triangles.iter().enumerate() {
        vertex_faces[tri[0] as usize].push(face_idx);
        vertex_faces[tri[1] as usize].push(face_idx);
        vertex_faces[tri[2] as usize].push(face_idx);
    }

    for ring in &mut neighbors {
        ring.sort_unstable();
        ring.dedup();
    }

    let mut boundary_vertex = vec![false; vertex_count];
    for ((a, b), count) in edge_counts {
        if count == 1 {
            boundary_vertex[a as usize] = true;
            boundary_vertex[b as usize] = true;
        }
    }

    // Taubin smoothing (lambda / mu) to reduce voxel stair-stepping while
    // preserving volume better than pure Laplacian smoothing.
    // Lock boundary vertices to preserve opening rims/cut contours where the
    // cavity mesh meets preserved source shell triangles.
    let mut positions = mesh.positions.clone();
    let area_floor = (voxel_mm * voxel_mm * 1e-4).max(1e-8);
    let iterations = iterations.max(1);
    let max_step = (voxel_mm * max_step_scale).max(0.01);

    for _ in 0..iterations {
        let forward = taubin_pass(
            &mut positions,
            &mesh.triangles,
            &neighbors,
            &vertex_faces,
            &boundary_vertex,
            0.36,
            area_floor,
            max_step,
        );
        let backward = taubin_pass(
            &mut positions,
            &mesh.triangles,
            &neighbors,
            &vertex_faces,
            &boundary_vertex,
            -0.38,
            area_floor,
            max_step,
        );
        if forward.applied_vertices + backward.applied_vertices == 0 {
            break;
        }
    }

    let mut out = mesh;
    out.positions = positions;
    out
}

fn stabilize_cavity_mesh_for_boolean(mesh: IndexedMesh, voxel_mm: f32) -> IndexedMesh {
    if mesh.triangles.is_empty() || mesh.positions.is_empty() {
        return mesh;
    }

    let topo = crate::core::halfedge::Topology::build(&mesh);
    let boundary_edges = topo.boundary_edges().len();
    let non_manifold_edges = topo.non_manifold_edges().len();
    if boundary_edges == 0 && non_manifold_edges == 0 {
        return mesh;
    }

    let bbox_diag = mesh.bbox().diag().max(1e-6);
    let mut best_mesh = mesh;
    let mut best_score = boundary_edges + non_manifold_edges * 4;

    for absolute_weld_mm in [voxel_mm * 0.015, voxel_mm * 0.035, voxel_mm * 0.075] {
        let weld_epsilon = (absolute_weld_mm / bbox_diag).clamp(1e-7, 1e-3);
        let candidate = normalize_mesh_for_boolean_with_weld(best_mesh.clone(), weld_epsilon);
        let candidate_topo = crate::core::halfedge::Topology::build(&candidate);
        let candidate_boundary = candidate_topo.boundary_edges().len();
        let candidate_non_manifold = candidate_topo.non_manifold_edges().len();
        let candidate_score = candidate_boundary + candidate_non_manifold * 4;

        if candidate_score < best_score
            || (candidate_score == best_score
                && candidate.triangle_count() >= best_mesh.triangle_count().saturating_sub(8))
        {
            best_score = candidate_score;
            best_mesh = candidate;
        }

        if best_score == 0 {
            break;
        }
    }

    best_mesh
}

fn apply_internal_cavity_chamfer_pass(
    grid: &GridSpec,
    solid: &[bool],
    keep: &mut [bool],
    dist: &[f32],
) {
    let mut carve = vec![false; keep.len()];

    for z in 0..grid.nz {
        for y in 0..grid.ny {
            for x in 0..grid.nx {
                let i = grid.idx(x, y, z);
                if !keep[i] || !solid[i] {
                    continue;
                }

                // Preserve outer shell margin: only bevel deeper shell voxels.
                // Protect voxels within one diagonal step (√2 voxels) of the
                // surface so bevelling never thins convex exterior corners.
                if dist[i] <= SQRT_2 {
                    continue;
                }

                let mut cavity_x = false;
                let mut cavity_y = false;
                let mut cavity_z = false;

                for (dx, dy, dz) in N6 {
                    let nx_i = x as isize + dx;
                    let ny_i = y as isize + dy;
                    let nz_i = z as isize + dz;
                    if !grid.in_bounds(nx_i, ny_i, nz_i) {
                        continue;
                    }

                    let ni = grid.idx(nx_i as usize, ny_i as usize, nz_i as usize);
                    if solid[ni] && !keep[ni] {
                        if dx != 0 {
                            cavity_x = true;
                        }
                        if dy != 0 {
                            cavity_y = true;
                        }
                        if dz != 0 {
                            cavity_z = true;
                        }
                    }
                }

                let axis_count = (cavity_x as u8) + (cavity_y as u8) + (cavity_z as u8);
                if axis_count >= 2 {
                    carve[i] = true;
                }
            }
        }
    }

    for (i, should_carve) in carve.into_iter().enumerate() {
        if should_carve {
            keep[i] = false;
        }
    }
}

fn effective_internal_cavity_chamfer_passes(
    shell_thickness_mm: f32,
    shell_voxels_f: f32,
    requested_passes: u8,
) -> u8 {
    if requested_passes == 0 {
        return 0;
    }

    if shell_thickness_mm < 1.5 {
        return 0;
    }

    // The chamfer pass only has a narrow voxel band to work with near the
    // interior rim. When the requested shell is too thin, bevelling can punch
    // through or create brittle seams that later boolean ops reject.
    //
    // Thin shells therefore skip chamfering entirely, while thicker shells
    // progressively unlock one or two passes.
    let max_passes = if shell_voxels_f < 2.5 {
        0
    } else if shell_voxels_f < 4.0 {
        1
    } else {
        2
    };

    requested_passes.min(max_passes)
}

#[derive(Debug, Clone, Copy)]
struct InternalCavitySmoothingProfile {
    scalar_field_blur_iterations: usize,
    taubin_iterations: usize,
    taubin_max_step_scale: f32,
}

#[cfg_attr(not(feature = "manifold"), allow(dead_code))]
impl InternalCavitySmoothingProfile {
    fn disabled(self) -> Self {
        Self {
            scalar_field_blur_iterations: 0,
            taubin_iterations: 0,
            taubin_max_step_scale: self.taubin_max_step_scale,
        }
    }

    fn is_disabled(self) -> bool {
        self.scalar_field_blur_iterations == 0 && self.taubin_iterations == 0
    }
}

fn effective_internal_cavity_smoothing_profile(
    shell_thickness_mm: f32,
    requested: bool,
    shell_voxels_f: f32,
) -> InternalCavitySmoothingProfile {
    if !requested {
        return InternalCavitySmoothingProfile {
            scalar_field_blur_iterations: 0,
            taubin_iterations: 0,
            taubin_max_step_scale: 0.42,
        };
    }

    // Thin shells still get a light smoothing pass for surface quality, but
    // not enough to aggressively reshape or pinch the cavity wall.
    if shell_thickness_mm < 1.5 || shell_voxels_f < 2.5 {
        return InternalCavitySmoothingProfile {
            scalar_field_blur_iterations: 3,
            taubin_iterations: 8,
            taubin_max_step_scale: 0.38,
        };
    }

    // Moderate shells get a medium smoothing pass.
    if shell_voxels_f < 3.5 {
        return InternalCavitySmoothingProfile {
            scalar_field_blur_iterations: 6,
            taubin_iterations: 12,
            taubin_max_step_scale: 0.50,
        };
    }

    // Thick shells benefit from heavier smoothing to produce a noticeably
    // cleaner, more organic inner cavity surface.
    InternalCavitySmoothingProfile {
        scalar_field_blur_iterations: 9,
        taubin_iterations: 18,
        taubin_max_step_scale: 0.62,
    }
}

#[cfg_attr(not(feature = "manifold"), allow(dead_code))]
fn reduced_internal_cavity_smoothing_profile(
    profile: InternalCavitySmoothingProfile,
) -> Option<InternalCavitySmoothingProfile> {
    if profile.is_disabled() {
        return None;
    }

    let next_blur = match profile.scalar_field_blur_iterations {
        0 | 1 => 0,
        n => (n / 2).max(1),
    };
    let next_taubin = match profile.taubin_iterations {
        0 | 1 => 0,
        n => (n / 2).max(1),
    };
    let next_step =
        (profile.taubin_max_step_scale * 0.82).clamp(0.16, profile.taubin_max_step_scale);

    let reduced = InternalCavitySmoothingProfile {
        scalar_field_blur_iterations: next_blur,
        taubin_iterations: next_taubin,
        taubin_max_step_scale: next_step,
    };

    if reduced.scalar_field_blur_iterations == profile.scalar_field_blur_iterations
        && reduced.taubin_iterations == profile.taubin_iterations
        && (reduced.taubin_max_step_scale - profile.taubin_max_step_scale).abs() <= f32::EPSILON
    {
        None
    } else {
        Some(reduced)
    }
}

fn normalize_mesh_for_boolean(mesh: IndexedMesh) -> IndexedMesh {
    normalize_mesh_for_boolean_with_weld(mesh, 1e-6)
}

fn normalize_mesh_for_boolean_with_weld(mesh: IndexedMesh, weld_epsilon: f32) -> IndexedMesh {
    let weld_epsilon = weld_epsilon.clamp(1e-7, 1e-3);
    let mut normalized = IndexedMesh::from_triangle_soup(&mesh.to_triangle_soup(), weld_epsilon);
    let positions = normalized.positions.clone();
    normalized.triangles.retain(|tri| {
        if tri[0] == tri[1] || tri[1] == tri[2] || tri[0] == tri[2] {
            return false;
        }

        let a = positions[tri[0] as usize];
        let b = positions[tri[1] as usize];
        let c = positions[tri[2] as usize];
        let area = b.sub(a).cross(c.sub(a)).length() * 0.5;
        area > 1e-16
    });

    if normalized.triangles.len() != mesh.triangles.len() {
        normalized = IndexedMesh::from_triangle_soup(&normalized.to_triangle_soup(), weld_epsilon);
    }

    normalized
}

#[cfg(feature = "manifold")]
enum HollowManifoldStabilization {
    Stabilized(IndexedMesh),
    Failed(IndexedMesh),
}

#[cfg(feature = "manifold")]
fn try_roundtrip_manifold_mesh(mesh: IndexedMesh) -> Result<IndexedMesh, String> {
    use manifold_csg::Manifold;

    if mesh.triangles.is_empty() || mesh.positions.is_empty() {
        return Err("empty mesh".into());
    }

    let src_positions: Vec<f32> = mesh
        .positions
        .iter()
        .flat_map(|v| [v.x, v.y, v.z])
        .collect();
    let src_indices: Vec<u32> = mesh.triangles.iter().flat_map(|t| *t).collect();
    let model = Manifold::from_mesh_f32(&src_positions, 3, &src_indices)
        .map_err(|err| format!("from_mesh_f32 failed: {err:?}"))?;
    if model.is_empty() || model.num_tri() == 0 {
        return Err("manifold input became empty".into());
    }

    let (vp, np, ti) = model.to_mesh_f32();
    if np != 3 || ti.is_empty() || vp.is_empty() {
        return Err(format!(
            "to_mesh_f32 returned invalid output (np={np}, verts={}, tris={})",
            vp.len(),
            ti.len()
        ));
    }

    let out_positions: Vec<Vec3> = vp
        .chunks_exact(np)
        .map(|c| Vec3::new(c[0], c[1], c[2]))
        .collect();
    let out_triangles: Vec<[u32; 3]> = ti.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect();

    Ok(IndexedMesh {
        positions: out_positions,
        triangles: out_triangles,
    })
}

#[cfg(feature = "manifold")]
fn stabilize_hollow_mesh_for_manifold(mesh: IndexedMesh) -> HollowManifoldStabilization {
    eprintln!(
        "[dragonfruit-mesh-repair] hollow manifold stabilization: start tris={} verts={}",
        mesh.triangle_count(),
        mesh.vertex_count()
    );

    match try_roundtrip_manifold_mesh(mesh.clone()) {
        Ok(roundtripped) => {
            eprintln!(
                "[dragonfruit-mesh-repair] hollow manifold stabilization: direct roundtrip ok tris={} verts={}",
                roundtripped.triangle_count(),
                roundtripped.vertex_count()
            );
            return HollowManifoldStabilization::Stabilized(roundtripped);
        }
        Err(reason) => {
            eprintln!(
                "[dragonfruit-mesh-repair] hollow manifold stabilization: direct roundtrip failed ({reason})"
            );
        }
    }

    for weld_epsilon in [2e-6_f32, 5e-6_f32, 1e-5_f32] {
        let candidate = normalize_mesh_for_boolean_with_weld(mesh.clone(), weld_epsilon);
        eprintln!(
            "[dragonfruit-mesh-repair] hollow manifold stabilization: retry weld_epsilon={weld_epsilon:.1e} tris={} verts={}",
            candidate.triangle_count(),
            candidate.vertex_count()
        );
        match try_roundtrip_manifold_mesh(candidate) {
            Ok(roundtripped) => {
                eprintln!(
                    "[dragonfruit-mesh-repair] hollow manifold stabilization: retry succeeded weld_epsilon={weld_epsilon:.1e} tris={} verts={}",
                    roundtripped.triangle_count(),
                    roundtripped.vertex_count()
                );
                return HollowManifoldStabilization::Stabilized(roundtripped);
            }
            Err(reason) => {
                eprintln!(
                    "[dragonfruit-mesh-repair] hollow manifold stabilization: retry failed weld_epsilon={weld_epsilon:.1e} ({reason})"
                );
            }
        }
    }

    eprintln!(
        "[dragonfruit-mesh-repair] hollow manifold stabilization: all retries failed, returning normalized non-manifold mesh"
    );

    let analysis = crate::analysis::analyze(&mesh);
    eprintln!(
        "[dragonfruit-mesh-repair] hollow manifold stabilization: failure summary nme={} nmv={} boundary={} loops={} inconsistent={} self_int={} comps={}",
        analysis.non_manifold_edges,
        analysis.non_manifold_vertices,
        analysis.boundary_edges,
        analysis.boundary_loops,
        analysis.inconsistent_winding_edges,
        analysis.self_intersection_triangles,
        analysis.connected_components,
    );

    HollowManifoldStabilization::Failed(mesh)
}

#[cfg(feature = "manifold")]
fn finalize_hollow_output_mesh_for_manifold(
    source_mesh: &IndexedMesh,
    source_bbox: &Aabb,
    grid: &GridSpec,
    solid: &[bool],
    dist: &[f32],
    keep: &[bool],
    options: &HollowOptions,
    shell_voxels_f: f32,
    smoothing_profile: InternalCavitySmoothingProfile,
    out_mesh: IndexedMesh,
    cavity_mesh: IndexedMesh,
) -> (IndexedMesh, IndexedMesh) {
    match stabilize_hollow_mesh_for_manifold(out_mesh) {
        HollowManifoldStabilization::Stabilized(mesh) => (mesh, cavity_mesh),
        HollowManifoldStabilization::Failed(original_mesh) => {
            if smoothing_profile.is_disabled() {
                return (original_mesh, cavity_mesh);
            }

            // Build the outer shell once — it never changes between retries.
            let filtered_source =
                filter_source_mesh_for_openings(source_mesh, options, source_bbox, grid.voxel_mm);

            let mut retry_profile = smoothing_profile;
            while let Some(reduced_profile) =
                reduced_internal_cavity_smoothing_profile(retry_profile)
            {
                retry_profile = reduced_profile;
                eprintln!(
                    "[dragonfruit-mesh-repair] hollow manifold stabilization: retrying hollow build with reduced internal smoothing blur={} taubin={} step_scale={:.2}",
                    retry_profile.scalar_field_blur_iterations,
                    retry_profile.taubin_iterations,
                    retry_profile.taubin_max_step_scale,
                );

                // Only rebuild the cavity mesh — the outer shell is cached.
                let retry_cavity_mesh = build_cavity_inner_mesh(
                    source_bbox,
                    grid,
                    solid,
                    dist,
                    keep,
                    options,
                    shell_voxels_f,
                    retry_profile,
                );
                let retry_mesh =
                    normalize_mesh_for_boolean(merge_meshes(&filtered_source, &retry_cavity_mesh));

                if let HollowManifoldStabilization::Stabilized(mesh) =
                    stabilize_hollow_mesh_for_manifold(retry_mesh)
                {
                    return (mesh, retry_cavity_mesh);
                }
            }

            if !retry_profile.is_disabled() {
                eprintln!(
                    "[dragonfruit-mesh-repair] hollow manifold stabilization: retrying hollow build without internal smoothing"
                );

                let retry_cavity_mesh = build_cavity_inner_mesh(
                    source_bbox,
                    grid,
                    solid,
                    dist,
                    keep,
                    options,
                    shell_voxels_f,
                    smoothing_profile.disabled(),
                );
                let retry_mesh =
                    normalize_mesh_for_boolean(merge_meshes(&filtered_source, &retry_cavity_mesh));

                match stabilize_hollow_mesh_for_manifold(retry_mesh) {
                    HollowManifoldStabilization::Stabilized(mesh) => (mesh, retry_cavity_mesh),
                    HollowManifoldStabilization::Failed(_) => (original_mesh, cavity_mesh),
                }
            } else {
                (original_mesh, cavity_mesh)
            }
        }
    }
}

fn retain_largest_connected_cavity_component(grid: &GridSpec, solid: &[bool], keep: &mut [bool]) {
    let mut component_ids = vec![-1i32; keep.len()];
    let mut component_sizes = Vec::<usize>::new();
    let mut queue = VecDeque::<(usize, usize, usize)>::new();

    for z in 0..grid.nz {
        for y in 0..grid.ny {
            for x in 0..grid.nx {
                let start_idx = grid.idx(x, y, z);
                if !solid[start_idx] || keep[start_idx] || component_ids[start_idx] >= 0 {
                    continue;
                }

                let component_id = component_sizes.len() as i32;
                component_ids[start_idx] = component_id;
                queue.push_back((x, y, z));

                let mut size = 0usize;
                while let Some((cx, cy, cz)) = queue.pop_front() {
                    size += 1;

                    for (dx, dy, dz) in N6 {
                        let nx_i = cx as isize + dx;
                        let ny_i = cy as isize + dy;
                        let nz_i = cz as isize + dz;
                        if !grid.in_bounds(nx_i, ny_i, nz_i) {
                            continue;
                        }

                        let ux = nx_i as usize;
                        let uy = ny_i as usize;
                        let uz = nz_i as usize;
                        let ni = grid.idx(ux, uy, uz);

                        if !solid[ni] || keep[ni] || component_ids[ni] >= 0 {
                            continue;
                        }

                        component_ids[ni] = component_id;
                        queue.push_back((ux, uy, uz));
                    }
                }

                component_sizes.push(size);
            }
        }
    }

    if component_sizes.len() <= 1 {
        return;
    }

    let mut largest_component_id = 0i32;
    let mut largest_size = 0usize;
    for (idx, size) in component_sizes.iter().enumerate() {
        if *size > largest_size {
            largest_size = *size;
            largest_component_id = idx as i32;
        }
    }

    for i in 0..keep.len() {
        if solid[i] && !keep[i] && component_ids[i] != largest_component_id {
            keep[i] = true;
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct TaubinPassStats {
    applied_vertices: usize,
}

fn taubin_pass(
    positions: &mut [Vec3],
    triangles: &[[u32; 3]],
    neighbors: &[Vec<usize>],
    vertex_faces: &[Vec<usize>],
    boundary_vertex: &[bool],
    weight: f32,
    area_floor: f32,
    max_step: f32,
) -> TaubinPassStats {
    let prev = positions.to_vec();
    let mut stats = TaubinPassStats::default();

    for i in 0..positions.len() {
        if boundary_vertex[i] {
            continue;
        }
        let ring = &neighbors[i];
        if ring.len() < 3 {
            continue;
        }

        let mut centroid = Vec3::ZERO;
        for &j in ring {
            centroid = centroid.add(prev[j]);
        }
        centroid = centroid.scale(1.0 / ring.len() as f32);

        let mut delta = centroid.sub(prev[i]).scale(weight);
        let len = delta.length();
        if len > max_step && len > 1e-8 {
            delta = delta.scale(max_step / len);
        }

        for scale in [1.0_f32, 0.5, 0.25] {
            let candidate = prev[i].add(delta.scale(scale));
            if !candidate.finite() {
                continue;
            }
            if !candidate_vertex_update_is_safe(
                i,
                candidate,
                &prev,
                triangles,
                vertex_faces,
                area_floor,
            ) {
                continue;
            }

            positions[i] = candidate;
            stats.applied_vertices += 1;
            break;
        }
    }

    stats
}

fn candidate_vertex_update_is_safe(
    vertex_index: usize,
    candidate: Vec3,
    prev_positions: &[Vec3],
    triangles: &[[u32; 3]],
    vertex_faces: &[Vec<usize>],
    area_floor: f32,
) -> bool {
    for &face_idx in &vertex_faces[vertex_index] {
        let tri = triangles[face_idx];
        let prev_tri = [
            prev_positions[tri[0] as usize],
            prev_positions[tri[1] as usize],
            prev_positions[tri[2] as usize],
        ];
        let mut next_tri = prev_tri;
        for (corner, &vertex) in tri.iter().enumerate() {
            if vertex as usize == vertex_index {
                next_tri[corner] = candidate;
            }
        }

        let prev_cross = prev_tri[1]
            .sub(prev_tri[0])
            .cross(prev_tri[2].sub(prev_tri[0]));
        let next_cross = next_tri[1]
            .sub(next_tri[0])
            .cross(next_tri[2].sub(next_tri[0]));
        let prev_area2 = prev_cross.length();
        let next_area2 = next_cross.length();

        if !next_area2.is_finite() || next_area2 <= area_floor * 2.0 {
            return false;
        }
        if prev_area2 > area_floor * 4.0 && next_area2 < prev_area2 * 0.12 {
            return false;
        }
        if prev_area2 > area_floor * 4.0 && next_cross.dot(prev_cross) <= 0.0 {
            return false;
        }
    }

    true
}

#[cfg(not(feature = "manifold"))]
#[inline]
fn is_cavity_neighbor(
    grid: &GridSpec,
    solid: &[bool],
    keep: &[bool],
    x: isize,
    y: isize,
    z: isize,
) -> bool {
    if !grid.in_bounds(x, y, z) {
        return false;
    }
    let idx = grid.idx(x as usize, y as usize, z as usize);
    solid[idx] && !keep[idx]
}

fn merge_meshes(a: &IndexedMesh, b: &IndexedMesh) -> IndexedMesh {
    if b.triangles.is_empty() {
        return a.clone();
    }
    if a.triangles.is_empty() {
        return b.clone();
    }

    let mut out = IndexedMesh {
        positions: Vec::with_capacity(a.positions.len() + b.positions.len()),
        triangles: Vec::with_capacity(a.triangles.len() + b.triangles.len()),
    };

    out.positions.extend_from_slice(&a.positions);
    out.triangles.extend_from_slice(&a.triangles);

    let index_offset = out.positions.len() as u32;
    out.positions.extend_from_slice(&b.positions);
    for tri in &b.triangles {
        out.triangles.push([
            tri[0] + index_offset,
            tri[1] + index_offset,
            tri[2] + index_offset,
        ]);
    }

    out
}

fn filter_source_mesh_for_openings(
    mesh: &IndexedMesh,
    options: &HollowOptions,
    bbox: &Aabb,
    voxel_mm: f32,
) -> IndexedMesh {
    let mut out = IndexedMesh {
        positions: mesh.positions.clone(),
        triangles: Vec::with_capacity(mesh.triangles.len()),
    };

    let shell_cut_depth = options.shell_thickness_mm.max(voxel_mm * 1.5);

    for tri in &mesh.triangles {
        let a = mesh.positions[tri[0] as usize];
        let b = mesh.positions[tri[1] as usize];
        let c = mesh.positions[tri[2] as usize];
        let centroid = a.add(b).add(c).scale(1.0 / 3.0);

        let mut drop = false;

        if matches!(options.mode, HollowMode::ShellOpenFace) {
            let dist_to_open_face = match options.open_face {
                OpenFace::XMin => centroid.x - bbox.min.x,
                OpenFace::XMax => bbox.max.x - centroid.x,
                OpenFace::YMin => centroid.y - bbox.min.y,
                OpenFace::YMax => bbox.max.y - centroid.y,
                OpenFace::ZMin => centroid.z - bbox.min.z,
                OpenFace::ZMax => bbox.max.z - centroid.z,
            };
            if dist_to_open_face <= shell_cut_depth {
                drop = true;
            }
        }

        if !drop && matches!(options.mode, HollowMode::Cavity) && !options.drain_holes.is_empty() {
            for hole in &options.drain_holes {
                if point_in_drain_hole_cylinder(centroid, hole, bbox, voxel_mm) {
                    drop = true;
                    break;
                }
            }
        }

        if !drop {
            out.triangles.push(*tri);
        }
    }

    out
}

fn point_in_drain_hole_cylinder(p: Vec3, hole: &DrainHoleSpec, bbox: &Aabb, voxel_mm: f32) -> bool {
    // If the hole center is outside the bbox, the cylinder cannot contain
    // any point inside the mesh — bail early.
    if hole.center_norm.iter().any(|&c| c < 0.0 || c > 1.0) {
        return false;
    }
    let cx = hole.center_norm[0];
    let cy = hole.center_norm[1];
    let cz = hole.center_norm[2];
    let center = Vec3::new(
        bbox.min.x + (bbox.max.x - bbox.min.x) * cx,
        bbox.min.y + (bbox.max.y - bbox.min.y) * cy,
        bbox.min.z + (bbox.max.z - bbox.min.z) * cz,
    );

    let (axis, length_to_surface) = hole_axis_and_length(
        hole.direction,
        hole.center_norm,
        hole.length_mm,
        bbox,
        voxel_mm,
    );

    let r = hole.radius_mm.max(voxel_mm * 0.75) * 1.2;
    let d = p.sub(center);
    let proj = d.dot(axis);
    if proj < -voxel_mm || proj > length_to_surface + voxel_mm {
        return false;
    }

    let radial_sq = d.dot(d) - (proj * proj);
    radial_sq <= r * r
}

fn apply_drain_hole_corridor(
    grid: &GridSpec,
    keep: &mut [bool],
    hole: &DrainHoleSpec,
    bbox: &Aabb,
    voxel_mm: f32,
) {
    // If the hole center is outside the bbox, no corridor to carve.
    if hole.center_norm.iter().any(|&c| c < 0.0 || c > 1.0) {
        return;
    }
    let cx = hole.center_norm[0];
    let cy = hole.center_norm[1];
    let cz = hole.center_norm[2];
    let center = Vec3::new(
        bbox.min.x + (bbox.max.x - bbox.min.x) * cx,
        bbox.min.y + (bbox.max.y - bbox.min.y) * cy,
        bbox.min.z + (bbox.max.z - bbox.min.z) * cz,
    );
    let (axis, length_to_surface) = hole_axis_and_length(
        hole.direction,
        hole.center_norm,
        hole.length_mm,
        bbox,
        voxel_mm,
    );

    let radius = hole.radius_mm.max(voxel_mm * 0.75) * 1.15;
    let radius_sq = radius * radius;
    let corridor_pad = voxel_mm * 1.5;
    let corridor_min = -corridor_pad;
    let corridor_max = length_to_surface + corridor_pad;

    let (min_x, max_x, min_y, max_y, min_z, max_z) =
        corridor_index_bounds(grid, center, axis, length_to_surface, radius, corridor_pad);

    for z in min_z..=max_z {
        for y in min_y..=max_y {
            for x in min_x..=max_x {
                let i = grid.idx(x, y, z);
                if !keep[i] {
                    continue;
                }

                let p = grid.center_world(x, y, z);
                let d = p.sub(center);
                let proj = d.dot(axis);
                if proj < corridor_min || proj > corridor_max {
                    continue;
                }

                let radial_sq = d.dot(d) - (proj * proj);
                if radial_sq <= radius_sq {
                    keep[i] = false;
                }
            }
        }
    }
}

fn corridor_index_bounds(
    grid: &GridSpec,
    center: Vec3,
    axis: Vec3,
    length_to_surface: f32,
    radius: f32,
    pad: f32,
) -> (usize, usize, usize, usize, usize, usize) {
    let end = center.add(axis.scale(length_to_surface.max(0.0)));
    let reach = radius + pad + grid.voxel_mm;

    let min_w = center.min(end).sub(Vec3::new(reach, reach, reach));
    let max_w = center.max(end).add(Vec3::new(reach, reach, reach));

    let to_index_min = |value: f32, min_world: f32| -> isize {
        ((value - min_world) / grid.voxel_mm).floor() as isize
    };
    let to_index_max = |value: f32, min_world: f32| -> isize {
        ((value - min_world) / grid.voxel_mm).ceil() as isize
    };

    let min_x = to_index_min(min_w.x, grid.min.x).clamp(0, grid.nx as isize - 1) as usize;
    let max_x = to_index_max(max_w.x, grid.min.x).clamp(0, grid.nx as isize - 1) as usize;
    let min_y = to_index_min(min_w.y, grid.min.y).clamp(0, grid.ny as isize - 1) as usize;
    let max_y = to_index_max(max_w.y, grid.min.y).clamp(0, grid.ny as isize - 1) as usize;
    let min_z = to_index_min(min_w.z, grid.min.z).clamp(0, grid.nz as isize - 1) as usize;
    let max_z = to_index_max(max_w.z, grid.min.z).clamp(0, grid.nz as isize - 1) as usize;

    (min_x, max_x, min_y, max_y, min_z, max_z)
}

fn build_smooth_infill_mesh(
    source_bbox: &Aabb,
    grid: &GridSpec,
    solid: &[bool],
    keep: &[bool],
    infill_mode: InfillMode,
    infill_cell_mm: f32,
    infill_beam_radius_mm: f32,
) -> IndexedMesh {
    let spacing_mm = infill_cell_mm.clamp(3.0, 24.0);
    let radius_mm = infill_beam_radius_mm.clamp(0.25, 3.0);
    let sample_step = (grid.voxel_mm * 0.75).clamp(0.2, 1.2);
    let embed_pad = (radius_mm * 0.8).max(grid.voxel_mm * 0.8);
    let min_run_length = spacing_mm * 0.45;
    let circumference = std::f32::consts::TAU * radius_mm;
    let radial_segments = ((circumference / 0.45).ceil() as usize).clamp(14, 56);

    let center = source_bbox.min.add(source_bbox.max).scale(0.5);
    let extent = source_bbox.max.sub(source_bbox.min).scale(0.5);
    let dir_extent_pad = extent.length() + spacing_mm * 1.5;

    let directions: &[Vec3] = match infill_mode {
        InfillMode::Lattice => &[
            Vec3::new(1.0, 1.0, 1.0),
            Vec3::new(1.0, 1.0, -1.0),
            Vec3::new(1.0, -1.0, 1.0),
            Vec3::new(1.0, -1.0, -1.0),
        ],
        InfillMode::Pillar => &[Vec3::new(0.0, 0.0, 1.0)],
    };

    let mut soup = Vec::<f32>::new();
    for direction in directions {
        let axis = vec3_normalize(*direction).unwrap_or(Vec3::new(1.0, 1.0, 1.0));
        let helper = if axis.z.abs() < 0.95 {
            Vec3::new(0.0, 0.0, 1.0)
        } else {
            Vec3::new(0.0, 1.0, 0.0)
        };
        let basis_u = vec3_normalize(helper.cross(axis)).unwrap_or(Vec3::new(1.0, 0.0, 0.0));
        let basis_v = vec3_normalize(axis.cross(basis_u)).unwrap_or(Vec3::new(0.0, 1.0, 0.0));

        let u_extent = projected_half_extent(extent, basis_u) + spacing_mm;
        let v_extent = projected_half_extent(extent, basis_v) + spacing_mm;
        let line_span = dir_extent_pad * 2.0;
        let line_sample_count = (line_span / sample_step).ceil() as usize;
        let u_steps = ((u_extent * 2.0) / spacing_mm).ceil() as isize;
        let v_steps = ((v_extent * 2.0) / spacing_mm).ceil() as isize;

        for u_step in 0..=u_steps {
            let u_offset = -u_extent + u_step as f32 * spacing_mm;
            for v_step in 0..=v_steps {
                let v_offset = -v_extent + v_step as f32 * spacing_mm;
                let line_origin = center
                    .add(basis_u.scale(u_offset))
                    .add(basis_v.scale(v_offset))
                    .sub(axis.scale(dir_extent_pad));

                let mut run_start: Option<f32> = None;
                let mut last_inside_t = 0.0f32;
                for sample_idx in 0..=line_sample_count {
                    let t = sample_idx as f32 * sample_step;
                    let point = line_origin.add(axis.scale(t));
                    let inside = point_samples_carved_cavity(grid, solid, keep, point);
                    if inside {
                        if run_start.is_none() {
                            run_start = Some(t);
                        }
                        last_inside_t = t;
                    } else if let Some(start_t) = run_start.take() {
                        append_infill_beam_segment(
                            &mut soup,
                            line_origin,
                            axis,
                            start_t,
                            last_inside_t,
                            embed_pad,
                            min_run_length,
                            radius_mm,
                            radial_segments,
                        );
                    }
                }

                if let Some(start_t) = run_start.take() {
                    append_infill_beam_segment(
                        &mut soup,
                        line_origin,
                        axis,
                        start_t,
                        last_inside_t,
                        embed_pad,
                        min_run_length,
                        radius_mm,
                        radial_segments,
                    );
                }
            }
        }
    }

    if soup.is_empty() {
        return IndexedMesh::default();
    }

    normalize_mesh_for_boolean(IndexedMesh::from_triangle_soup(&soup, 1e-6))
}

fn append_infill_beam_segment(
    soup: &mut Vec<f32>,
    line_origin: Vec3,
    axis: Vec3,
    start_t: f32,
    end_t: f32,
    embed_pad: f32,
    min_run_length: f32,
    radius_mm: f32,
    radial_segments: usize,
) {
    let length = (end_t - start_t) + embed_pad * 2.0;
    if length < min_run_length {
        return;
    }

    let origin = line_origin.add(axis.scale((start_t - embed_pad).max(0.0)));
    let beam = build_cylinder_mesh(origin, axis, radius_mm, radius_mm, length, radial_segments);
    soup.extend_from_slice(&beam.to_triangle_soup());
}

#[inline]
fn point_samples_carved_cavity(
    grid: &GridSpec,
    solid: &[bool],
    keep: &[bool],
    point: Vec3,
) -> bool {
    let x = ((point.x - grid.min.x) / grid.voxel_mm).floor() as isize;
    let y = ((point.y - grid.min.y) / grid.voxel_mm).floor() as isize;
    let z = ((point.z - grid.min.z) / grid.voxel_mm).floor() as isize;
    if !grid.in_bounds(x, y, z) {
        return false;
    }
    let i = grid.idx(x as usize, y as usize, z as usize);
    solid[i] && !keep[i]
}

#[inline]
fn projected_half_extent(extent: Vec3, axis: Vec3) -> f32 {
    extent.x * axis.x.abs() + extent.y * axis.y.abs() + extent.z * axis.z.abs()
}

pub fn punch_cylinders(mesh: IndexedMesh, options: &HolePunchOptions) -> HolePunchOutcome {
    let source_triangle_count = mesh.triangle_count();
    if source_triangle_count == 0 || mesh.positions.is_empty() || options.punches.is_empty() {
        return HolePunchOutcome {
            mesh,
            report: HolePunchReport {
                source_triangle_count,
                output_triangle_count: source_triangle_count,
                removed_triangle_count: 0,
                punch_count: options.punches.len(),
            },
        };
    }

    #[cfg(feature = "manifold")]
    {
        eprintln!(
            "[dragonfruit-mesh-repair] hole punch: manifold-only mode start tris={} verts={} punches={}",
            mesh.triangle_count(),
            mesh.vertex_count(),
            options.punches.len()
        );

        if let Some(outcome) =
            punch_cylinders_manifold(mesh.clone(), options, source_triangle_count)
        {
            eprintln!(
                "[dragonfruit-mesh-repair] hole punch: direct manifold boolean succeeded tris={} -> {}",
                source_triangle_count,
                outcome.report.output_triangle_count
            );
            return outcome;
        }

        eprintln!(
            "[dragonfruit-mesh-repair] hole punch: direct manifold boolean failed, trying welded retries"
        );

        // Retry manifold punching on progressively more welded/normalized
        // variants before falling back to voxel punching.
        for weld_epsilon in [2e-6_f32, 5e-6_f32, 1e-5_f32] {
            let retry_mesh = normalize_mesh_for_boolean_with_weld(mesh.clone(), weld_epsilon);
            eprintln!(
                "[dragonfruit-mesh-repair] hole punch: retry weld_epsilon={weld_epsilon:.1e} tris={} verts={}",
                retry_mesh.triangle_count(),
                retry_mesh.vertex_count()
            );
            if retry_mesh.triangles.is_empty() || retry_mesh.positions.is_empty() {
                eprintln!(
                    "[dragonfruit-mesh-repair] hole punch: retry weld_epsilon={weld_epsilon:.1e} skipped because mesh became empty"
                );
                continue;
            }
            if let Some(outcome) =
                punch_cylinders_manifold(retry_mesh, options, source_triangle_count)
            {
                eprintln!(
                    "[dragonfruit-mesh-repair] hole punch: retry succeeded weld_epsilon={weld_epsilon:.1e} tris={} -> {}",
                    source_triangle_count,
                    outcome.report.output_triangle_count
                );
                return outcome;
            }
            eprintln!(
                "[dragonfruit-mesh-repair] hole punch: retry failed weld_epsilon={weld_epsilon:.1e}"
            );
        }

        eprintln!(
            "[dragonfruit-mesh-repair] hole punch: all manifold attempts failed; refusing voxel fallback and returning original mesh unchanged"
        );
        return HolePunchOutcome {
            mesh,
            report: HolePunchReport {
                source_triangle_count,
                output_triangle_count: source_triangle_count,
                removed_triangle_count: 0,
                punch_count: options.punches.len(),
            },
        };
    }

    #[cfg(not(feature = "manifold"))]
    {
        let source_bbox = mesh.bbox();
        let diag = source_bbox.diag().max(1e-3);

        let min_radius = options
            .punches
            .iter()
            .map(|p| p.radius_mm.max(0.1))
            .fold(f32::INFINITY, f32::min);
        let detail_voxel = if min_radius.is_finite() {
            (min_radius / 6.0).max(0.02)
        } else {
            0.08
        };
        let coarse_voxel = (diag / 220.0).max(0.02);
        let voxel_mm = detail_voxel.min(coarse_voxel).clamp(0.02, 0.2);

        // Pad by 1 voxel so outside flood-fill has a guaranteed margin.
        let padded_min = source_bbox.min.sub(Vec3::new(voxel_mm, voxel_mm, voxel_mm));
        let padded_max = source_bbox.max.add(Vec3::new(voxel_mm, voxel_mm, voxel_mm));
        let padded = Aabb {
            min: padded_min,
            max: padded_max,
        };

        let size = padded.max.sub(padded.min);
        let nx = ((size.x / voxel_mm).ceil() as usize).max(4);
        let ny = ((size.y / voxel_mm).ceil() as usize).max(4);
        let nz = ((size.z / voxel_mm).ceil() as usize).max(4);

        let grid = GridSpec {
            nx,
            ny,
            nz,
            voxel_mm,
            min: padded.min,
        };

        let tri_cache: Vec<TriangleCache> = mesh
            .triangles
            .iter()
            .map(|tri| {
                let a = mesh.positions[tri[0] as usize];
                let b = mesh.positions[tri[1] as usize];
                let c = mesh.positions[tri[2] as usize];
                TriangleCache::from_points(a, b, c)
            })
            .collect();

        let mut surface = vec![false; nx * ny * nz];
        let voxel_diag_half = (3.0f32).sqrt() * voxel_mm * 0.5;

        for tri in &tri_cache {
            let min_ix =
                (((tri.min.x - grid.min.x) / voxel_mm).floor() as isize - 1).max(0) as usize;
            let max_ix = (((tri.max.x - grid.min.x) / voxel_mm).ceil() as isize + 1)
                .min(nx as isize - 1) as usize;
            let min_iy =
                (((tri.min.y - grid.min.y) / voxel_mm).floor() as isize - 1).max(0) as usize;
            let max_iy = (((tri.max.y - grid.min.y) / voxel_mm).ceil() as isize + 1)
                .min(ny as isize - 1) as usize;
            let min_iz =
                (((tri.min.z - grid.min.z) / voxel_mm).floor() as isize - 1).max(0) as usize;
            let max_iz = (((tri.max.z - grid.min.z) / voxel_mm).ceil() as isize + 1)
                .min(nz as isize - 1) as usize;

            for z in min_iz..=max_iz {
                for y in min_iy..=max_iy {
                    for x in min_ix..=max_ix {
                        let p = grid.center_world(x, y, z);
                        let d = point_triangle_distance(p, tri.a, tri.b, tri.c);
                        if d <= voxel_diag_half {
                            surface[grid.idx(x, y, z)] = true;
                        }
                    }
                }
            }
        }

        let mut outside = vec![false; nx * ny * nz];
        let mut q = VecDeque::<(usize, usize, usize)>::new();

        let mut push_seed = |x: usize, y: usize, z: usize| {
            let i = grid.idx(x, y, z);
            if surface[i] || outside[i] {
                return;
            }
            outside[i] = true;
            q.push_back((x, y, z));
        };

        for x in 0..nx {
            for y in 0..ny {
                push_seed(x, y, 0);
                push_seed(x, y, nz - 1);
            }
        }
        for x in 0..nx {
            for z in 0..nz {
                push_seed(x, 0, z);
                push_seed(x, ny - 1, z);
            }
        }
        for y in 0..ny {
            for z in 0..nz {
                push_seed(0, y, z);
                push_seed(nx - 1, y, z);
            }
        }

        while let Some((x, y, z)) = q.pop_front() {
            for (dx, dy, dz) in N6 {
                let nx_i = x as isize + dx;
                let ny_i = y as isize + dy;
                let nz_i = z as isize + dz;
                if !grid.in_bounds(nx_i, ny_i, nz_i) {
                    continue;
                }
                let ux = nx_i as usize;
                let uy = ny_i as usize;
                let uz = nz_i as usize;
                let i = grid.idx(ux, uy, uz);
                if surface[i] || outside[i] {
                    continue;
                }
                outside[i] = true;
                q.push_back((ux, uy, uz));
            }
        }

        let mut solid: Vec<bool> = outside.iter().map(|is_outside| !*is_outside).collect();

        let drain_holes: Vec<DrainHoleSpec> = options
            .punches
            .iter()
            .map(|p| DrainHoleSpec {
                center_norm: p.center_norm,
                radius_mm: p.radius_mm,
                direction: p.direction,
                length_mm: p.length_mm,
            })
            .collect();

        refine_solid_near_punches_with_parity(&grid, &mut solid, &mesh, &source_bbox, &drain_holes);

        let mut keep = solid.clone();

        for hole in &drain_holes {
            apply_drain_hole_corridor(&grid, &mut keep, hole, &source_bbox, voxel_mm);
        }

        let tunnel_mesh = voxel_cavity_boundary_mesh(&grid, &solid, &keep);
        let filtered_source =
            filter_source_mesh_for_punch_openings(&mesh, &drain_holes, &source_bbox, voxel_mm);
        let out = merge_meshes(&filtered_source, &tunnel_mesh);
        let output_triangle_count = out.triangle_count();

        return HolePunchOutcome {
            mesh: out,
            report: HolePunchReport {
                source_triangle_count,
                output_triangle_count,
                removed_triangle_count: source_triangle_count.saturating_sub(output_triangle_count),
                punch_count: options.punches.len(),
            },
        };
    }
}

#[cfg(feature = "manifold")]
fn punch_cylinders_manifold(
    mesh: IndexedMesh,
    options: &HolePunchOptions,
    source_triangle_count: usize,
) -> Option<HolePunchOutcome> {
    use manifold_csg::Manifold;

    let src_positions: Vec<f32> = mesh
        .positions
        .iter()
        .flat_map(|v| [v.x, v.y, v.z])
        .collect();
    let src_indices: Vec<u32> = mesh.triangles.iter().flat_map(|t| *t).collect();
    let model = match Manifold::from_mesh_f32(&src_positions, 3, &src_indices) {
        Ok(model) => model,
        Err(err) => {
            eprintln!(
                "[dragonfruit-mesh-repair] hole punch manifold: source mesh rejected ({err:?}) tris={} verts={}",
                mesh.triangle_count(),
                mesh.vertex_count()
            );
            return None;
        }
    };
    if model.is_empty() || model.num_tri() == 0 {
        eprintln!(
            "[dragonfruit-mesh-repair] hole punch manifold: source mesh produced empty manifold tris={} verts={}",
            mesh.triangle_count(),
            mesh.vertex_count()
        );
        return None;
    }

    let bbox = mesh.bbox();
    let mut cutters: Option<Manifold> = None;
    let mut valid_punch_count = 0usize;

    for punch in &options.punches {
        if punch.radius_mm <= 0.0 {
            continue;
        }

        // Do not clamp center_norm to [0,1] — the gizmo allows pulling holes
        // outside the model bbox, and the cylinder should remain exactly where
        // the user placed it. If the cylinder does not intersect the mesh the
        // boolean is a no-op (correct), and partial intersections cut correctly.
        let cx = punch.center_norm[0];
        let cy = punch.center_norm[1];
        let cz = punch.center_norm[2];
        let center = Vec3::new(
            bbox.min.x + (bbox.max.x - bbox.min.x) * cx,
            bbox.min.y + (bbox.max.y - bbox.min.y) * cy,
            bbox.min.z + (bbox.max.z - bbox.min.z) * cz,
        );

        let (axis, length_mm) = hole_axis_and_length(
            punch.direction,
            punch.center_norm,
            punch.length_mm,
            &bbox,
            0.02,
        );

        if length_mm <= 1e-4 {
            continue;
        }

        let radius = punch.radius_mm.max(0.02);
        let radius_y = punch.radius_y_mm.unwrap_or(punch.radius_mm).max(0.02);
        let circumference = std::f32::consts::TAU * radius.max(radius_y);
        let radial_segments = ((circumference / 0.7).ceil() as usize).clamp(16, 80);
        let punch_mesh =
            build_cylinder_mesh(center, axis, radius, radius_y, length_mm, radial_segments);
        if punch_mesh.triangles.is_empty() {
            continue;
        }

        let p_positions: Vec<f32> = punch_mesh
            .positions
            .iter()
            .flat_map(|v| [v.x, v.y, v.z])
            .collect();
        let p_indices: Vec<u32> = punch_mesh.triangles.iter().flat_map(|t| *t).collect();

        let punch_m = match Manifold::from_mesh_f32(&p_positions, 3, &p_indices) {
            Ok(m) if !m.is_empty() && m.num_tri() > 0 => m,
            Ok(_) => {
                eprintln!(
                    "[dragonfruit-mesh-repair] hole punch manifold: punch #{:?} became empty radius_mm={} length_mm={} segments={}",
                    punch.center_norm,
                    radius,
                    length_mm,
                    radial_segments
                );
                continue;
            }
            Err(err) => {
                eprintln!(
                    "[dragonfruit-mesh-repair] hole punch manifold: punch mesh rejected center={:?} radius_mm={} length_mm={} segments={} ({err:?})",
                    punch.center_norm,
                    radius,
                    length_mm,
                    radial_segments
                );
                continue;
            }
        };

        valid_punch_count += 1;
        cutters = Some(match cutters {
            Some(existing) => existing.union(&punch_m),
            None => punch_m,
        });
    }

    let Some(cutters) = cutters else {
        return Some(HolePunchOutcome {
            mesh,
            report: HolePunchReport {
                source_triangle_count,
                output_triangle_count: source_triangle_count,
                removed_triangle_count: 0,
                punch_count: options.punches.len(),
            },
        });
    };

    let model = model.difference(&cutters);
    if model.is_empty() || model.num_tri() == 0 {
        eprintln!(
            "[dragonfruit-mesh-repair] hole punch manifold: batched difference became empty after {} valid punches",
            valid_punch_count
        );
        return Some(HolePunchOutcome {
            mesh: IndexedMesh::default(),
            report: HolePunchReport {
                source_triangle_count,
                output_triangle_count: 0,
                removed_triangle_count: source_triangle_count,
                punch_count: options.punches.len(),
            },
        });
    }

    if model.is_empty() || model.num_tri() == 0 {
        return Some(HolePunchOutcome {
            mesh: IndexedMesh::default(),
            report: HolePunchReport {
                source_triangle_count,
                output_triangle_count: 0,
                removed_triangle_count: source_triangle_count,
                punch_count: options.punches.len(),
            },
        });
    }

    let (vp, np, ti) = model.to_mesh_f32();
    if np != 3 || ti.is_empty() || vp.is_empty() {
        eprintln!(
            "[dragonfruit-mesh-repair] hole punch manifold: invalid output np={} verts={} tris={}",
            np,
            vp.len(),
            ti.len()
        );
        return None;
    }

    let out_positions: Vec<Vec3> = vp
        .chunks_exact(np)
        .map(|c| Vec3::new(c[0], c[1], c[2]))
        .collect();
    let out_triangles: Vec<[u32; 3]> = ti.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect();

    let out = IndexedMesh {
        positions: out_positions,
        triangles: out_triangles,
    };
    let output_triangle_count = out.triangle_count();

    Some(HolePunchOutcome {
        mesh: out,
        report: HolePunchReport {
            source_triangle_count,
            output_triangle_count,
            removed_triangle_count: source_triangle_count.saturating_sub(output_triangle_count),
            punch_count: options.punches.len(),
        },
    })
}

fn build_cylinder_mesh(
    origin: Vec3,
    axis: Vec3,
    radius: f32,
    radius_y: f32,
    length: f32,
    segments: usize,
) -> IndexedMesh {
    let axis = vec3_normalize(axis).unwrap_or(Vec3::new(0.0, 0.0, -1.0));

    // Build orthonormal basis (u, v, axis).
    let helper = if axis.z.abs() < 0.95 {
        Vec3::new(0.0, 0.0, 1.0)
    } else {
        Vec3::new(0.0, 1.0, 0.0)
    };
    let u = vec3_normalize(helper.cross(axis)).unwrap_or(Vec3::new(1.0, 0.0, 0.0));
    let v = vec3_normalize(axis.cross(u)).unwrap_or(Vec3::new(0.0, 1.0, 0.0));

    let segs = segments.max(8);
    let mut positions = Vec::<Vec3>::with_capacity(2 + segs * 2);
    let mut triangles = Vec::<[u32; 3]>::with_capacity(segs * 4);

    let bottom_center_index = 0u32;
    let top_center_index = 1u32;

    positions.push(origin);
    positions.push(origin.add(axis.scale(length)));

    // Rings — use separate X/Y radii for oval support.
    for i in 0..segs {
        let t = i as f32 / segs as f32;
        let theta = t * std::f32::consts::TAU;
        let cs = theta.cos();
        let sn = theta.sin();
        let radial = u.scale(cs * radius).add(v.scale(sn * radius_y));

        positions.push(origin.add(radial));
        positions.push(origin.add(axis.scale(length)).add(radial));
    }

    let ring_base = 2u32;

    for i in 0..segs as u32 {
        let next = (i + 1) % segs as u32;

        let bi = ring_base + i * 2;
        let ti = bi + 1;
        let bn = ring_base + next * 2;
        let tn = bn + 1;

        // Bottom cap (normal approximately -axis)
        triangles.push([bottom_center_index, bn, bi]);

        // Top cap (normal approximately +axis)
        triangles.push([top_center_index, ti, tn]);

        // Side quad split
        triangles.push([bi, bn, tn]);
        triangles.push([bi, tn, ti]);
    }

    IndexedMesh {
        positions,
        triangles,
    }
}

#[cfg(not(feature = "manifold"))]
fn refine_solid_near_punches_with_parity(
    grid: &GridSpec,
    solid: &mut [bool],
    mesh: &IndexedMesh,
    bbox: &Aabb,
    punches: &[DrainHoleSpec],
) {
    if punches.is_empty() {
        return;
    }

    let bvh = Bvh::build(mesh);
    let mut parity_cache: Vec<Option<bool>> = vec![None; solid.len()];

    for hole in punches {
        // Skip holes positioned outside the bbox — they cannot intersect the mesh.
        if hole.center_norm.iter().any(|&c| c < 0.0 || c > 1.0) {
            continue;
        }
        let cx = hole.center_norm[0];
        let cy = hole.center_norm[1];
        let cz = hole.center_norm[2];
        let center = Vec3::new(
            bbox.min.x + (bbox.max.x - bbox.min.x) * cx,
            bbox.min.y + (bbox.max.y - bbox.min.y) * cy,
            bbox.min.z + (bbox.max.z - bbox.min.z) * cz,
        );

        let (axis, length_to_surface) = hole_axis_and_length(
            hole.direction,
            hole.center_norm,
            hole.length_mm,
            bbox,
            grid.voxel_mm,
        );

        let radius = hole.radius_mm.max(grid.voxel_mm * 0.75) * 1.2;
        let radius_sq = radius * radius;
        let corridor_pad = grid.voxel_mm * 1.5;
        let corridor_min = -corridor_pad;
        let corridor_max = length_to_surface + corridor_pad;

        let (min_x, max_x, min_y, max_y, min_z, max_z) =
            corridor_index_bounds(grid, center, axis, length_to_surface, radius, corridor_pad);

        for z in min_z..=max_z {
            for y in min_y..=max_y {
                for x in min_x..=max_x {
                    let i = grid.idx(x, y, z);
                    if !solid[i] {
                        continue;
                    }

                    let p = grid.center_world(x, y, z);
                    let d = p.sub(center);
                    let proj = d.dot(axis);
                    if proj < corridor_min || proj > corridor_max {
                        continue;
                    }

                    let radial_sq = d.dot(d) - (proj * proj);
                    if radial_sq > radius_sq {
                        continue;
                    }

                    let is_inside = if let Some(cached) = parity_cache[i] {
                        cached
                    } else {
                        let computed = point_inside_mesh_parity(mesh, &bvh, p, grid.voxel_mm);
                        parity_cache[i] = Some(computed);
                        computed
                    };

                    if !is_inside {
                        solid[i] = false;
                    }
                }
            }
        }
    }
}

fn refine_non_surface_solid_components_with_parity(
    grid: &GridSpec,
    surface: &[bool],
    solid: &mut [bool],
    mesh: &IndexedMesh,
) {
    let mut visited = vec![false; solid.len()];
    let bvh = Bvh::build(mesh);
    let mut component = Vec::<usize>::new();
    let mut queue = VecDeque::<usize>::new();

    for start in 0..solid.len() {
        if visited[start] || !solid[start] || surface[start] {
            continue;
        }

        visited[start] = true;
        queue.push_back(start);
        component.clear();

        while let Some(i) = queue.pop_front() {
            component.push(i);
            let z = i / (grid.nx * grid.ny);
            let rem = i - z * grid.nx * grid.ny;
            let y = rem / grid.nx;
            let x = rem - y * grid.nx;

            for (dx, dy, dz) in N6 {
                let nx_i = x as isize + dx;
                let ny_i = y as isize + dy;
                let nz_i = z as isize + dz;
                if !grid.in_bounds(nx_i, ny_i, nz_i) {
                    continue;
                }

                let ni = grid.idx(nx_i as usize, ny_i as usize, nz_i as usize);
                if visited[ni] || !solid[ni] || surface[ni] {
                    continue;
                }

                visited[ni] = true;
                queue.push_back(ni);
            }
        }

        let sample = component[0];
        let z = sample / (grid.nx * grid.ny);
        let rem = sample - z * grid.nx * grid.ny;
        let y = rem / grid.nx;
        let x = rem - y * grid.nx;
        let sample_p = grid.center_world(x, y, z);

        if !point_inside_mesh_parity(mesh, &bvh, sample_p, grid.voxel_mm) {
            for &i in &component {
                solid[i] = false;
            }
        }
    }
}

fn label_void_components(grid: &GridSpec, solid: &[bool]) -> Vec<i32> {
    let mut labels = vec![-1i32; solid.len()];
    let mut queue = VecDeque::<usize>::new();
    let mut next_label = 0i32;

    for start in 0..solid.len() {
        if solid[start] || labels[start] >= 0 {
            continue;
        }

        labels[start] = next_label;
        queue.push_back(start);

        while let Some(i) = queue.pop_front() {
            let z = i / (grid.nx * grid.ny);
            let rem = i - z * grid.nx * grid.ny;
            let y = rem / grid.nx;
            let x = rem - y * grid.nx;

            for (dx, dy, dz) in N6 {
                let nx_i = x as isize + dx;
                let ny_i = y as isize + dy;
                let nz_i = z as isize + dz;
                if !grid.in_bounds(nx_i, ny_i, nz_i) {
                    continue;
                }

                let ni = grid.idx(nx_i as usize, ny_i as usize, nz_i as usize);
                if solid[ni] || labels[ni] >= 0 {
                    continue;
                }

                labels[ni] = next_label;
                queue.push_back(ni);
            }
        }

        next_label += 1;
    }

    labels
}

fn preserve_source_void_separators(
    grid: &GridSpec,
    solid: &[bool],
    void_components: &[i32],
    keep: &mut [bool],
) {
    for z in 0..grid.nz {
        for y in 0..grid.ny {
            for x in 0..grid.nx {
                let i = grid.idx(x, y, z);
                if !solid[i] || keep[i] {
                    continue;
                }

                let mut first_label = -1i32;
                let mut separates_distinct_voids = false;

                for (dx, dy, dz) in N6 {
                    let nx_i = x as isize + dx;
                    let ny_i = y as isize + dy;
                    let nz_i = z as isize + dz;
                    if !grid.in_bounds(nx_i, ny_i, nz_i) {
                        continue;
                    }

                    let ni = grid.idx(nx_i as usize, ny_i as usize, nz_i as usize);
                    if solid[ni] {
                        continue;
                    }

                    let label = void_components[ni];
                    if label < 0 {
                        continue;
                    }

                    if first_label < 0 {
                        first_label = label;
                    } else if label != first_label {
                        separates_distinct_voids = true;
                        break;
                    }
                }

                if separates_distinct_voids {
                    keep[i] = true;
                }
            }
        }
    }
}

fn point_inside_mesh_parity(mesh: &IndexedMesh, bvh: &Bvh, p: Vec3, voxel_mm: f32) -> bool {
    // Skewed direction avoids axis-aligned degeneracy against many triangles.
    let ray_dir = Vec3::new(0.893, 0.372, 0.254);
    let origin = p.add(ray_dir.scale(voxel_mm * 0.173));
    (bvh.ray_hit_count(mesh, origin, ray_dir) & 1) == 1
}

#[cfg(not(feature = "manifold"))]
fn filter_source_mesh_for_punch_openings(
    mesh: &IndexedMesh,
    punches: &[DrainHoleSpec],
    bbox: &Aabb,
    voxel_mm: f32,
) -> IndexedMesh {
    let mut out = IndexedMesh {
        positions: mesh.positions.clone(),
        triangles: Vec::with_capacity(mesh.triangles.len()),
    };

    if punches.is_empty() {
        out.triangles.extend_from_slice(&mesh.triangles);
        return out;
    }

    for tri in &mesh.triangles {
        let a = mesh.positions[tri[0] as usize];
        let b = mesh.positions[tri[1] as usize];
        let c = mesh.positions[tri[2] as usize];
        let centroid = a.add(b).add(c).scale(1.0 / 3.0);

        let mut drop = false;
        for hole in punches {
            // Remove where source shell triangles overlap punch corridors so
            // tunnel openings fully break through both shell faces.
            if triangle_overlaps_drain_hole_cylinder(a, b, c, centroid, hole, bbox, voxel_mm) {
                drop = true;
                break;
            }
        }

        if !drop {
            out.triangles.push(*tri);
        }
    }

    out
}

#[cfg(not(feature = "manifold"))]
fn triangle_overlaps_drain_hole_cylinder(
    a: Vec3,
    b: Vec3,
    c: Vec3,
    centroid: Vec3,
    hole: &DrainHoleSpec,
    bbox: &Aabb,
    voxel_mm: f32,
) -> bool {
    // If the hole center is outside the bbox, no triangle can overlap it.
    if hole.center_norm.iter().any(|&c| c < 0.0 || c > 1.0) {
        return false;
    }
    let cx = hole.center_norm[0];
    let cy = hole.center_norm[1];
    let cz = hole.center_norm[2];
    let center = Vec3::new(
        bbox.min.x + (bbox.max.x - bbox.min.x) * cx,
        bbox.min.y + (bbox.max.y - bbox.min.y) * cy,
        bbox.min.z + (bbox.max.z - bbox.min.z) * cz,
    );

    let (axis, length_to_surface) = hole_axis_and_length(
        hole.direction,
        hole.center_norm,
        hole.length_mm,
        bbox,
        voxel_mm,
    );

    let radius = hole.radius_mm.max(voxel_mm * 0.55) * 1.03;
    let radius_sq = radius * radius;
    let length_pad = voxel_mm * 0.55;
    let min_t = -length_pad;
    let max_t = length_to_surface + length_pad;

    let point_inside = |p: Vec3| {
        let d = p.sub(center);
        let t = d.dot(axis);
        if t < min_t || t > max_t {
            return false;
        }
        let radial_sq = d.dot(d) - t * t;
        radial_sq <= radius_sq
    };

    // Fast point checks first.
    if point_inside(a) || point_inside(b) || point_inside(c) || point_inside(centroid) {
        return true;
    }

    // Then robust segment-vs-cylinder-axis checks for each triangle edge.
    segment_overlaps_finite_cylinder(a, b, center, axis, min_t, max_t, radius_sq)
        || segment_overlaps_finite_cylinder(b, c, center, axis, min_t, max_t, radius_sq)
        || segment_overlaps_finite_cylinder(c, a, center, axis, min_t, max_t, radius_sq)
}

#[cfg(not(feature = "manifold"))]
fn segment_overlaps_finite_cylinder(
    p0: Vec3,
    p1: Vec3,
    cyl_origin: Vec3,
    cyl_axis: Vec3,
    min_t: f32,
    max_t: f32,
    radius_sq: f32,
) -> bool {
    let d = p1.sub(p0); // segment direction
    let m = p0.sub(cyl_origin);

    let dd = d.dot(d).max(1e-12);
    let da = d.dot(cyl_axis);
    let ma = m.dot(cyl_axis);

    // Closest approach between segment and infinite axis line.
    let s = (-(m.dot(d) - ma * da) / dd).clamp(0.0, 1.0);
    let p = p0.add(d.scale(s));
    let dp = p.sub(cyl_origin);
    let t = dp.dot(cyl_axis);
    let t_clamped = t.clamp(min_t, max_t);
    let radial = dp.sub(cyl_axis.scale(t_clamped));
    let radial_sq = radial.dot(radial);

    radial_sq <= radius_sq
}

fn hole_axis_and_length(
    direction: Option<[f32; 3]>,
    center_norm: [f32; 3],
    length_mm: Option<f32>,
    bbox: &Aabb,
    tolerance_mm: f32,
) -> (Vec3, f32) {
    if let Some(dir) = direction {
        if let Some(axis) = vec3_normalize(Vec3::new(dir[0], dir[1], dir[2])) {
            let length = length_mm
                .unwrap_or_else(|| bbox.diag())
                .max(tolerance_mm * 2.0);
            return (axis, length);
        }
    }

    let cx = center_norm[0].clamp(0.0, 1.0);
    let cy = center_norm[1].clamp(0.0, 1.0);
    let cz = center_norm[2].clamp(0.0, 1.0);
    let center = Vec3::new(
        bbox.min.x + (bbox.max.x - bbox.min.x) * cx,
        bbox.min.y + (bbox.max.y - bbox.min.y) * cy,
        bbox.min.z + (bbox.max.z - bbox.min.z) * cz,
    );

    let distances = [
        (center.x - bbox.min.x, Vec3::new(-1.0, 0.0, 0.0)),
        (bbox.max.x - center.x, Vec3::new(1.0, 0.0, 0.0)),
        (center.y - bbox.min.y, Vec3::new(0.0, -1.0, 0.0)),
        (bbox.max.y - center.y, Vec3::new(0.0, 1.0, 0.0)),
        (center.z - bbox.min.z, Vec3::new(0.0, 0.0, -1.0)),
        (bbox.max.z - center.z, Vec3::new(0.0, 0.0, 1.0)),
    ];

    distances
        .iter()
        .copied()
        .min_by(|(da, _), (db, _)| da.partial_cmp(db).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(length, axis)| (axis, length.max(tolerance_mm * 2.0)))
        .unwrap_or((Vec3::new(0.0, 0.0, -1.0), tolerance_mm * 2.0))
}

fn vec3_normalize(v: Vec3) -> Option<Vec3> {
    let len = v.length();
    if len <= 1e-6 {
        None
    } else {
        Some(v.scale(1.0 / len))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parity_refinement_clears_enclosed_non_surface_cavity_component() {
        let grid = GridSpec {
            nx: 5,
            ny: 5,
            nz: 5,
            voxel_mm: 1.0,
            min: Vec3::new(0.0, 0.0, 0.0),
        };

        let mut solid = vec![false; grid.nx * grid.ny * grid.nz];
        let mut surface = vec![false; solid.len()];

        for z in 1..=3 {
            for y in 1..=3 {
                for x in 1..=3 {
                    let i = grid.idx(x, y, z);
                    solid[i] = true;
                    surface[i] = x == 1 || x == 3 || y == 1 || y == 3 || z == 1 || z == 3;
                }
            }
        }

        let cavity_index = grid.idx(2, 2, 2);
        assert!(solid[cavity_index]);
        assert!(!surface[cavity_index]);

        let mesh = hollow_box_mesh(1.0, 4.0, 2.0, 3.0);
        refine_non_surface_solid_components_with_parity(&grid, &surface, &mut solid, &mesh);

        assert!(
            !solid[cavity_index],
            "parity refinement should clear the enclosed cavity center"
        );
    }

    #[test]
    fn source_void_separator_voxel_is_preserved() {
        let grid = GridSpec {
            nx: 3,
            ny: 3,
            nz: 3,
            voxel_mm: 1.0,
            min: Vec3::new(0.0, 0.0, 0.0),
        };

        let mut solid = vec![true; grid.nx * grid.ny * grid.nz];
        let left_void = grid.idx(0, 1, 1);
        let right_void = grid.idx(2, 1, 1);
        let separator = grid.idx(1, 1, 1);

        solid[left_void] = false;
        solid[right_void] = false;

        let void_components = label_void_components(&grid, &solid);
        assert_ne!(void_components[left_void], void_components[right_void]);

        let mut keep = solid.clone();
        keep[separator] = false;

        preserve_source_void_separators(&grid, &solid, &void_components, &mut keep);

        assert!(
            keep[separator],
            "separator voxel between distinct source voids should be preserved"
        );
    }

    #[test]
    fn thin_shells_disable_chamfering_until_there_is_enough_slack() {
        assert_eq!(effective_internal_cavity_chamfer_passes(1.0, 4.0, 2), 0);
        assert_eq!(effective_internal_cavity_chamfer_passes(2.0, 2.4, 2), 0);
        assert_eq!(effective_internal_cavity_chamfer_passes(2.0, 2.5, 2), 1);
        assert_eq!(effective_internal_cavity_chamfer_passes(2.0, 3.9, 2), 1);
        assert_eq!(effective_internal_cavity_chamfer_passes(2.0, 4.0, 2), 2);
        assert_eq!(effective_internal_cavity_chamfer_passes(2.0, 4.0, 1), 1);
    }

    #[test]
    fn thin_shells_use_reduced_internal_smoothing_until_there_is_enough_slack() {
        let thin = effective_internal_cavity_smoothing_profile(1.0, true, 2.4);
        assert_eq!(thin.scalar_field_blur_iterations, 3);
        assert_eq!(thin.taubin_iterations, 8);
        assert!(thin.taubin_max_step_scale < 0.42);

        let thick = effective_internal_cavity_smoothing_profile(2.0, true, 4.0);
        assert_eq!(thick.scalar_field_blur_iterations, 9);
        assert_eq!(thick.taubin_iterations, 18);
        assert!((thick.taubin_max_step_scale - 0.62).abs() < 1e-5);

        let disabled = effective_internal_cavity_smoothing_profile(2.0, false, 4.0);
        assert_eq!(disabled.scalar_field_blur_iterations, 0);
        assert_eq!(disabled.taubin_iterations, 0);
    }

    #[test]
    fn internal_smoothing_profile_backs_off_progressively_before_disabling() {
        let full = InternalCavitySmoothingProfile {
            scalar_field_blur_iterations: 9,
            taubin_iterations: 18,
            taubin_max_step_scale: 0.62,
        };

        let reduced_once = reduced_internal_cavity_smoothing_profile(full).unwrap();
        assert_eq!(reduced_once.scalar_field_blur_iterations, 4);
        assert_eq!(reduced_once.taubin_iterations, 9);
        assert!(reduced_once.taubin_max_step_scale < full.taubin_max_step_scale);

        let reduced_twice = reduced_internal_cavity_smoothing_profile(reduced_once).unwrap();
        assert_eq!(reduced_twice.scalar_field_blur_iterations, 2);
        assert_eq!(reduced_twice.taubin_iterations, 4);
        assert!(reduced_twice.taubin_max_step_scale < reduced_once.taubin_max_step_scale);

        let reduced_thrice = reduced_internal_cavity_smoothing_profile(reduced_twice).unwrap();
        assert_eq!(reduced_thrice.scalar_field_blur_iterations, 1);
        assert_eq!(reduced_thrice.taubin_iterations, 2);

        let reduced_fourth = reduced_internal_cavity_smoothing_profile(reduced_thrice).unwrap();
        assert_eq!(reduced_fourth.scalar_field_blur_iterations, 0);
        assert_eq!(reduced_fourth.taubin_iterations, 1);

        let disabled = reduced_internal_cavity_smoothing_profile(reduced_fourth).unwrap();
        assert!(disabled.is_disabled());
        assert!(reduced_internal_cavity_smoothing_profile(disabled).is_none());
    }

    #[test]
    fn blocked_kept_voxels_stay_positive_in_cavity_scalar_field() {
        let grid = GridSpec {
            nx: 3,
            ny: 1,
            nz: 1,
            voxel_mm: 1.0,
            min: Vec3::new(0.0, 0.0, 0.0),
        };

        let solid = vec![true, true, true];
        let keep = vec![true, false, true];
        let dist = vec![0.5, 1.5, 4.5];

        let field = build_smoothed_cavity_scalar_field(&grid, &solid, &keep, &dist, 1.0, 0);

        assert!(
            field[0] > 0.0,
            "shell-side kept voxels should stay positive"
        );
        assert!(field[1] < 0.0, "carved cavity voxels should stay negative");
        assert!(
            field[2] > 0.0,
            "blocked kept voxels deep in the cavity should remain positive"
        );
    }

    #[test]
    fn cavity_polygonizer_uses_scalar_sign_not_only_hard_voxel_labels() {
        let positions = [
            Vec3::new(0.0, 0.0, 0.0),
            Vec3::new(1.0, 0.0, 0.0),
            Vec3::new(1.0, 1.0, 0.0),
            Vec3::new(0.0, 1.0, 0.0),
            Vec3::new(0.0, 0.0, 1.0),
            Vec3::new(1.0, 0.0, 1.0),
            Vec3::new(1.0, 1.0, 1.0),
            Vec3::new(0.0, 1.0, 1.0),
        ];
        let scalar = [1.0, -1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0];
        let kept = [true; 8];
        let carved = [false; 8];
        let mut soup = Vec::new();

        polygonize_cavity_tetrahedron(&mut soup, [0, 5, 1, 6], &positions, &scalar, &kept, &carved);

        assert_eq!(
            soup.len(),
            9,
            "scalar sign changes should contour through same-label voxel edges"
        );
    }

    #[test]
    fn cavity_smoothing_rejects_vertex_moves_that_flip_adjacent_triangles() {
        let positions = vec![
            Vec3::new(0.0, 0.0, 0.0),
            Vec3::new(1.0, 0.0, 0.0),
            Vec3::new(0.0, 1.0, 0.0),
            Vec3::new(-1.0, 0.0, 0.0),
            Vec3::new(0.0, -1.0, 0.0),
        ];
        let triangles = vec![[0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 1]];
        let vertex_faces = vec![
            vec![0, 1, 2, 3],
            vec![0, 3],
            vec![0, 1],
            vec![1, 2],
            vec![2, 3],
        ];

        assert!(candidate_vertex_update_is_safe(
            0,
            Vec3::new(0.1, 0.1, 0.0),
            &positions,
            &triangles,
            &vertex_faces,
            1e-8,
        ));
        assert!(!candidate_vertex_update_is_safe(
            0,
            Vec3::new(1.6, 1.6, 0.0),
            &positions,
            &triangles,
            &vertex_faces,
            1e-8,
        ));
    }

    #[test]
    fn cavity_micro_repair_can_weld_a_tiny_near_seam_before_boolean() {
        let v0 = Vec3::new(0.0, 0.0, 0.0);
        let v1 = Vec3::new(1.0, 0.0, 0.0);
        let v2 = Vec3::new(0.0, 1.0, 0.0);
        let v3 = Vec3::new(0.0, 0.0, 1.0);
        let v3_seam = Vec3::new(0.00002, 0.0, 1.00001);

        let mesh = IndexedMesh {
            positions: vec![v0, v1, v2, v3, v3_seam],
            triangles: vec![[0, 1, 2], [0, 3, 1], [1, 4, 2], [2, 3, 0]],
        };

        let before = crate::core::halfedge::Topology::build(&mesh);
        assert!(before.boundary_edges().len() > 0);

        let repaired = stabilize_cavity_mesh_for_boolean(mesh, 1.0);
        let after = crate::core::halfedge::Topology::build(&repaired);

        assert_eq!(after.boundary_edges().len(), 0);
        assert_eq!(after.non_manifold_edges().len(), 0);
    }

    fn hollow_box_mesh(
        outer_min: f32,
        outer_max: f32,
        inner_min: f32,
        inner_max: f32,
    ) -> IndexedMesh {
        merge_meshes(
            &box_mesh(outer_min, outer_max, false),
            &box_mesh(inner_min, inner_max, true),
        )
    }

    fn box_mesh(min: f32, max: f32, flip: bool) -> IndexedMesh {
        let positions = vec![
            Vec3::new(min, min, min),
            Vec3::new(max, min, min),
            Vec3::new(max, max, min),
            Vec3::new(min, max, min),
            Vec3::new(min, min, max),
            Vec3::new(max, min, max),
            Vec3::new(max, max, max),
            Vec3::new(min, max, max),
        ];

        let mut triangles = vec![
            [0, 2, 1],
            [0, 3, 2],
            [4, 5, 6],
            [4, 6, 7],
            [0, 1, 5],
            [0, 5, 4],
            [1, 2, 6],
            [1, 6, 5],
            [2, 3, 7],
            [2, 7, 6],
            [3, 0, 4],
            [3, 4, 7],
        ];

        if flip {
            for tri in &mut triangles {
                tri.swap(1, 2);
            }
        }

        IndexedMesh {
            positions,
            triangles,
        }
    }

    #[test]
    fn infill_mode_keeps_more_material_than_plain_cavity() {
        let mesh = box_mesh(0.0, 10.0, false);
        let mut cavity_options = HollowOptions::default();
        cavity_options.mode = HollowMode::Cavity;
        cavity_options.voxel_resolution = 64;
        cavity_options.shell_thickness_mm = 1.6;
        cavity_options.smooth_internal_surfaces = false;
        cavity_options.internal_chamfer_passes = 0;

        let mut infill_options = cavity_options.clone();
        infill_options.mode = HollowMode::Infill;

        let cavity = hollow_voxel(mesh.clone(), &cavity_options);
        let infill = hollow_voxel(mesh, &infill_options);

        assert_eq!(
            infill.report.removed_voxels, cavity.report.removed_voxels,
            "smooth infill keeps the same cavity carve and adds support geometry afterward"
        );
        assert!(
            infill.mesh.triangle_count() > cavity.mesh.triangle_count(),
            "infill should generate additional internal lattice surfaces"
        );
    }
}

#[cfg(not(feature = "manifold"))]
#[inline]
fn emit_quad(out: &mut Vec<f32>, v0: Vec3, v1: Vec3, v2: Vec3, v3: Vec3) {
    // Tri 1: v0, v1, v2
    out.extend_from_slice(&[v0.x, v0.y, v0.z, v1.x, v1.y, v1.z, v2.x, v2.y, v2.z]);
    // Tri 2: v0, v2, v3
    out.extend_from_slice(&[v0.x, v0.y, v0.z, v2.x, v2.y, v2.z, v3.x, v3.y, v3.z]);
}

#[inline]
fn point_triangle_distance(p: Vec3, a: Vec3, b: Vec3, c: Vec3) -> f32 {
    // Real-Time Collision Detection (Christer Ericson), closest point on triangle.
    let ab = b.sub(a);
    let ac = c.sub(a);
    let ap = p.sub(a);

    let d1 = ab.dot(ap);
    let d2 = ac.dot(ap);
    if d1 <= 0.0 && d2 <= 0.0 {
        return ap.length();
    }

    let bp = p.sub(b);
    let d3 = ab.dot(bp);
    let d4 = ac.dot(bp);
    if d3 >= 0.0 && d4 <= d3 {
        return bp.length();
    }

    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        let v = d1 / (d1 - d3);
        let proj = a.add(ab.scale(v));
        return p.sub(proj).length();
    }

    let cp = p.sub(c);
    let d5 = ab.dot(cp);
    let d6 = ac.dot(cp);
    if d6 >= 0.0 && d5 <= d6 {
        return cp.length();
    }

    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        let w = d2 / (d2 - d6);
        let proj = a.add(ac.scale(w));
        return p.sub(proj).length();
    }

    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0 {
        let edge = c.sub(b);
        let w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        let proj = b.add(edge.scale(w));
        return p.sub(proj).length();
    }

    let n = ab.cross(ac);
    let n_len = n.length().max(1e-20);
    (p.sub(a).dot(n)).abs() / n_len
}
