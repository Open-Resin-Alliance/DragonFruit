//! Safe-ish Rust surface over the OpenVDB C ABI shim (`cpp/df_vdb_shim.cpp`).
//!
//! One entry point: [`remesh`] converts an arbitrary triangle soup — including
//! non-manifold / self-intersecting input — into a watertight, 2-manifold
//! triangle mesh via an OpenVDB level set. All C++/OpenVDB detail is hidden
//! behind the flat C ABI so downstream crates never see a template.

use std::os::raw::{c_float, c_int};

/// Build a curvature-driven spatial-adaptivity mask inside the shim.
pub const FLAG_CURVATURE_ADAPTIVE: c_int = 0x1;

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct DfVdbParams {
    pub voxel_size: c_float,
    pub exterior_band: c_float,
    pub interior_band: c_float,
    pub adaptivity: c_float,
    pub curvature_adaptivity: c_float,
    pub flags: c_int,
}

#[repr(C)]
struct DfVdbResult {
    verts: *mut c_float,
    nverts: usize,
    tris: *mut u32,
    ntris: usize,
    ok: c_int,
}

extern "C" {
    fn df_vdb_remesh(
        verts: *const c_float,
        nverts: usize,
        tris: *const u32,
        ntris: usize,
        params: *const DfVdbParams,
        out: *mut DfVdbResult,
    ) -> c_int;
    fn df_vdb_free(r: *mut DfVdbResult);
}

/// Parameters for [`remesh`], in world units / voxel counts.
#[derive(Debug, Clone, Copy)]
pub struct RemeshParams {
    pub voxel_size: f32,
    pub exterior_band: f32,
    pub interior_band: f32,
    pub adaptivity: f32,
    pub curvature_adaptivity: f32,
}

impl Default for RemeshParams {
    fn default() -> Self {
        Self {
            voxel_size: 1.0,
            exterior_band: 3.0,
            interior_band: 3.0,
            adaptivity: 0.0,
            curvature_adaptivity: 0.0,
        }
    }
}

/// Output triangle mesh: flat xyz positions and u32 index triplets.
pub struct RemeshOutput {
    pub positions: Vec<[f32; 3]>,
    pub triangles: Vec<[u32; 3]>,
}

/// Remesh `verts` (xyz triplets) / `tris` (u32 triplets). Returns `None` if the
/// shim fails or produces an empty mesh.
pub fn remesh(verts: &[f32], tris: &[u32], params: &RemeshParams) -> Option<RemeshOutput> {
    if verts.is_empty() || tris.is_empty() || verts.len() % 3 != 0 || tris.len() % 3 != 0 {
        return None;
    }
    let flags = if params.curvature_adaptivity > 0.0 {
        FLAG_CURVATURE_ADAPTIVE
    } else {
        0
    };
    let c_params = DfVdbParams {
        voxel_size: params.voxel_size,
        exterior_band: params.exterior_band,
        interior_band: params.interior_band,
        adaptivity: params.adaptivity,
        curvature_adaptivity: params.curvature_adaptivity,
        flags,
    };

    let mut out = DfVdbResult {
        verts: std::ptr::null_mut(),
        nverts: 0,
        tris: std::ptr::null_mut(),
        ntris: 0,
        ok: 0,
    };

    // SAFETY: pointers/lengths are consistent; the shim only reads the inputs
    // and writes malloc'd buffers into `out`, which we copy then free.
    let rc = unsafe {
        df_vdb_remesh(
            verts.as_ptr(),
            verts.len() / 3,
            tris.as_ptr(),
            tris.len() / 3,
            &c_params,
            &mut out,
        )
    };

    let result = if rc == 1 && out.ok == 1 && !out.verts.is_null() && !out.tris.is_null() {
        let positions = unsafe { std::slice::from_raw_parts(out.verts, out.nverts * 3) }
            .chunks_exact(3)
            .map(|c| [c[0], c[1], c[2]])
            .collect();
        let triangles = unsafe { std::slice::from_raw_parts(out.tris, out.ntris * 3) }
            .chunks_exact(3)
            .map(|c| [c[0], c[1], c[2]])
            .collect();
        Some(RemeshOutput { positions, triangles })
    } else {
        None
    };

    // SAFETY: `out` was zeroed then only populated by the shim; safe to free.
    unsafe { df_vdb_free(&mut out) };
    result
}
