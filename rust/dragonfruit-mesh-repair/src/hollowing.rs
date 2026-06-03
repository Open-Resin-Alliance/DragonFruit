use std::collections::VecDeque;

use serde::{Deserialize, Serialize};

use crate::core::mesh::{Aabb, IndexedMesh, Vec3};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HollowMode {
    Cavity,
    ShellOpenFace,
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
    pub open_face: OpenFace,
    pub drain_holes: Vec<DrainHoleSpec>,
    pub preview_cavity_only: bool,
}

impl Default for HollowOptions {
    fn default() -> Self {
        Self {
            mode: HollowMode::Cavity,
            voxel_resolution: 96,
            shell_thickness_mm: 2.0,
            open_face: OpenFace::ZMax,
            drain_holes: Vec::new(),
            preview_cavity_only: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HollowReport {
    pub mode: HollowMode,
    pub voxel_resolution: u16,
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
    /// Cylinder radius in millimeters.
    pub radius_mm: f32,
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
    pub report: HollowReport,
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

#[derive(Clone, Copy)]
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

pub fn hollow_voxel(mesh: IndexedMesh, options: &HollowOptions) -> HollowOutcome {
    let source_triangle_count = mesh.triangle_count();
    if source_triangle_count == 0 || mesh.positions.is_empty() {
        return HollowOutcome {
            mesh,
            report: HollowReport {
                mode: options.mode,
                voxel_resolution: options.voxel_resolution,
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
    let mut occupied_voxels = 0usize;
    for i in 0..solid.len() {
        let is_solid = !outside[i];
        solid[i] = is_solid;
        if is_solid {
            occupied_voxels += 1;
        }
    }

    // Multi-source BFS over solid voxels from boundary-adjacent solid cells.
    let mut dist = vec![i32::MAX; nx * ny * nz];
    let mut shell_q = VecDeque::<(usize, usize, usize)>::new();

    for z in 0..nz {
        for y in 0..ny {
            for x in 0..nx {
                let i = grid.idx(x, y, z);
                if !solid[i] {
                    continue;
                }
                let mut touches_outside = false;
                for (dx, dy, dz) in N6 {
                    let ax = x as isize + dx;
                    let ay = y as isize + dy;
                    let az = z as isize + dz;
                    if !grid.in_bounds(ax, ay, az) {
                        touches_outside = true;
                        break;
                    }
                    let ni = grid.idx(ax as usize, ay as usize, az as usize);
                    if !solid[ni] {
                        touches_outside = true;
                        break;
                    }
                }
                if touches_outside {
                    dist[i] = 0;
                    shell_q.push_back((x, y, z));
                }
            }
        }
    }

    while let Some((x, y, z)) = shell_q.pop_front() {
        let base = dist[grid.idx(x, y, z)];
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
            if !solid[i] {
                continue;
            }
            if dist[i] <= base + 1 {
                continue;
            }
            dist[i] = base + 1;
            shell_q.push_back((ux, uy, uz));
        }
    }

    let mut keep = vec![false; nx * ny * nz];
    let mut kept_shell = 0usize;
    for i in 0..keep.len() {
        if solid[i] && dist[i] <= shell_voxels {
            keep[i] = true;
            kept_shell += 1;
        }
    }

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

    let removed_voxels = occupied_voxels.saturating_sub(keep.iter().filter(|v| **v).count());

    let cavity_mesh = voxel_cavity_boundary_mesh(&grid, &solid, &keep);
    let out_mesh = if options.preview_cavity_only {
        cavity_mesh
    } else {
        // Preserve the original exterior surface to avoid full-model voxelization,
        // then add only newly exposed cavity/opening surfaces extracted from voxel
        // boundaries.
        let filtered_source =
            filter_source_mesh_for_openings(&mesh, options, &source_bbox, voxel_mm);
        merge_meshes(&filtered_source, &cavity_mesh)
    };
    let output_triangle_count = out_mesh.triangle_count();

    HollowOutcome {
        mesh: out_mesh,
        report: HollowReport {
            mode: options.mode,
            voxel_resolution: options.voxel_resolution,
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
    let cx = hole.center_norm[0].clamp(0.0, 1.0);
    let cy = hole.center_norm[1].clamp(0.0, 1.0);
    let cz = hole.center_norm[2].clamp(0.0, 1.0);
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
    let cx = hole.center_norm[0].clamp(0.0, 1.0);
    let cy = hole.center_norm[1].clamp(0.0, 1.0);
    let cz = hole.center_norm[2].clamp(0.0, 1.0);
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

    for z in 0..grid.nz {
        for y in 0..grid.ny {
            for x in 0..grid.nx {
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

    let bbox = mesh.bbox();
    let diag = bbox.diag().max(1e-3);
    let tolerance_mm = (diag / 384.0).max(0.05);

    let mut out = IndexedMesh {
        positions: mesh.positions.clone(),
        triangles: Vec::with_capacity(mesh.triangles.len()),
    };

    for tri in &mesh.triangles {
        let a = mesh.positions[tri[0] as usize];
        let b = mesh.positions[tri[1] as usize];
        let c = mesh.positions[tri[2] as usize];
        let centroid = a.add(b).add(c).scale(1.0 / 3.0);

        let mut remove = false;
        for punch in &options.punches {
            // Centroid-only tests are too aggressive on coarse meshes and can
            // erase large swaths of triangles when a cylinder passes nearby.
            // Require stronger evidence of overlap: at least two triangle
            // vertices inside the cylinder, or one vertex + centroid.
            let inside_a = point_in_punch_cylinder(a, punch, &bbox, tolerance_mm);
            let inside_b = point_in_punch_cylinder(b, punch, &bbox, tolerance_mm);
            let inside_c = point_in_punch_cylinder(c, punch, &bbox, tolerance_mm);
            let inside_count = inside_a as u8 + inside_b as u8 + inside_c as u8;
            let centroid_inside = point_in_punch_cylinder(centroid, punch, &bbox, tolerance_mm);

            if inside_count >= 2 || (inside_count >= 1 && centroid_inside) {
                remove = true;
                break;
            }
        }

        if !remove {
            out.triangles.push(*tri);
        }
    }

    let output_triangle_count = out.triangle_count();
    HolePunchOutcome {
        mesh: out,
        report: HolePunchReport {
            source_triangle_count,
            output_triangle_count,
            removed_triangle_count: source_triangle_count.saturating_sub(output_triangle_count),
            punch_count: options.punches.len(),
        },
    }
}

fn point_in_punch_cylinder(p: Vec3, punch: &HolePunchSpec, bbox: &Aabb, tolerance_mm: f32) -> bool {
    let cx = punch.center_norm[0].clamp(0.0, 1.0);
    let cy = punch.center_norm[1].clamp(0.0, 1.0);
    let cz = punch.center_norm[2].clamp(0.0, 1.0);
    let center = Vec3::new(
        bbox.min.x + (bbox.max.x - bbox.min.x) * cx,
        bbox.min.y + (bbox.max.y - bbox.min.y) * cy,
        bbox.min.z + (bbox.max.z - bbox.min.z) * cz,
    );

    let (axis, length_mm) = hole_axis_and_length(
        punch.direction,
        punch.center_norm,
        punch.length_mm,
        bbox,
        tolerance_mm,
    );
    let radius = punch.radius_mm.max(tolerance_mm * 1.5) * 1.1;
    let length_pad = tolerance_mm * 1.5;
    let proj_max = length_mm + length_pad;

    let d = p.sub(center);
    let proj = d.dot(axis);
    if proj < -length_pad || proj > proj_max {
        return false;
    }

    let radial_sq = d.dot(d) - (proj * proj);
    radial_sq <= radius * radius
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
