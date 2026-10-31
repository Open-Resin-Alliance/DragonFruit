//! The ambient-occlusion bake on the GPU.
//!
//! Same estimator as `dragonfruit-mesh-core::vertex_occlusion`, same BVH, same
//! falloff — a compute shader instead of a rayon loop. It exists because the bake
//! is the only ray consumer heavy enough to care: measured on a 384,324-vertex
//! model, 32 rays per vertex costs 1.8 s of CPU and 0.14 s here, which is what
//! makes 64 or 128 rays a choice rather than a budget.
//!
//! **The GPU is not required.** `available()` is false on a machine wgpu cannot
//! find an adapter for, `bake` returns an error on anything that goes wrong
//! mid-flight, and the caller falls back to the CPU bake. Every failure here is
//! meant to be survivable: the CPU path is correct, so the GPU is only ever a
//! faster way to the same field.
//!
//! The shader mirrors `Bvh::gpu_layout`'s documented contract and is checked
//! against the crate's own values in `tests/gpu_matches_cpu.rs`, so a traversal
//! that drifts shows up as a mismatch rather than as a subtly different look.

use dragonfruit_mesh_core::bvh::Bvh;
use dragonfruit_mesh_core::mesh::{IndexedMesh, Vec3};
use dragonfruit_mesh_core::vertex_occlusion::{
    smooth_over_mesh_graph, SMOOTHING_PASSES,
};

const REACH_RATIO: f32 = 0.08;
const FALLOFF_PLATEAU: f32 = 0.15;
const ORIGIN_BIAS_RATIO: f32 = 1e-3;

/// GPU time each submit aims for.
///
/// One dispatch over a whole model is a single GPU job, and drivers kill a job
/// that runs too long: amdgpu's lockup timeout is 10 s, Windows' TDR 2 s. A
/// 3M-triangle model at 32 rays measured over 10 s on a Radeon R7 350, and the
/// killed job came back as a zeroed buffer with no error, or as a GPU reset that
/// took the desktop's GL contexts with it. Submits this short stay far below
/// either limit and cost a submit and a wait each, which is noise next to them.
const BATCH_TARGET: std::time::Duration = std::time::Duration::from_millis(100);
/// The fewest vertices a submit covers, so it still fills the GPU.
///
/// Shrinking the vertex batch alone cannot shorten a submit below one thread's
/// time, and a thread traces all its rays in sequence: on the R7 350 at 32 rays
/// that is ~150 ms, so a vertex-only split shrank to a single workgroup and ran
/// at 555 vertices/s. Below this size a submit traces fewer rays instead.
const FILL_BATCH: u32 = 8 * 1024;
/// One-dimensional dispatches only: `65535` workgroups of 64.
const MAX_BATCH: u32 = 65_535 * 64;

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    vertex_end: u32,
    vertex_start: u32,
    root: u32,
    leaf_flag: u32,
    rays: u32,
    reach: f32,
    plateau: f32,
    bias: f32,
    rotate: f32,
    ray_start: u32,
    ray_end: u32,
    _pad: u32,
}

struct Gpu {
    device: wgpu::Device,
    queue: wgpu::Queue,
    adapter: String,
}

/// The process-wide device, or `None` when this machine has no usable adapter.
///
/// Created once: a wgpu device costs tens of milliseconds to bring up, which
/// would be most of a small bake's wall time if it were per model.
static GPU: std::sync::LazyLock<Option<Gpu>> = std::sync::LazyLock::new(|| {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::all(),
        flags: Default::default(),
        memory_budget_thresholds: Default::default(),
        backend_options: Default::default(),
        display: Default::default(),
    });
    let adapters = pollster::block_on(instance.enumerate_adapters(wgpu::Backends::all()));
    let chosen = adapters
        .iter()
        .find(|a| a.get_info().device_type == wgpu::DeviceType::DiscreteGpu)
        .or_else(|| {
            adapters
                .iter()
                .find(|a| a.get_info().device_type == wgpu::DeviceType::IntegratedGpu)
        })?;
    let name = chosen.get_info().name.clone();
    let (device, queue) = pollster::block_on(chosen.request_device(&wgpu::DeviceDescriptor {
        label: Some("dragonfruit-ao"),
        ..Default::default()
    }))
    .ok()?;
    Some(Gpu { device, queue, adapter: name })
});

fn gpu() -> Option<&'static Gpu> {
    GPU.as_ref()
}

/// Whether this machine has a GPU this crate can bake on.
pub fn available() -> bool {
    gpu().is_some()
}

/// The adapter's name, for a log line. `None` when there is no adapter.
pub fn adapter_name() -> Option<&'static str> {
    gpu().map(|g| g.adapter.as_str())
}

fn writable(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    label: &str,
    bytes: &[u8],
) -> wgpu::Buffer {
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some(label),
        size: bytes.len() as u64,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    queue.write_buffer(&buffer, 0, bytes);
    buffer
}

/// Bake the turned-fan field on the GPU: one value per vertex.
///
/// The fan turn is the same recipe `bake_smoothed_vertex_occlusion` uses, so the
/// caller can hand this straight to
/// [`dragonfruit_mesh_core::vertex_occlusion::smooth_over_mesh_graph`].
pub fn bake(mesh: &IndexedMesh, rays: usize) -> Result<Vec<f32>, String> {
    bake_raw(mesh, rays, true)
}

/// The bake with the fan turn under the caller's control.
///
/// `rotate: false` is the fixed fan, which is what the GPU-vs-CPU test compares
/// the two implementations on: the turn is a different hash on each side, so a
/// turned comparison would be measuring two RNGs rather than two traversals.
pub fn bake_raw(mesh: &IndexedMesh, rays: usize, rotate: bool) -> Result<Vec<f32>, String> {
    let gpu = gpu().ok_or("no GPU adapter")?;
    if mesh.positions.is_empty() || mesh.triangles.is_empty() {
        return Err("empty mesh".into());
    }

    // Vertex normals, exactly as the CPU bake builds them.
    let mut normals = vec![Vec3::ZERO; mesh.positions.len()];
    for tri in &mesh.triangles {
        let a = mesh.positions[tri[0] as usize];
        let b = mesh.positions[tri[1] as usize];
        let c = mesh.positions[tri[2] as usize];
        let face = b.sub(a).cross(c.sub(a));
        for index in tri {
            let slot = &mut normals[*index as usize];
            *slot = slot.add(face);
        }
    }
    let normals_flat: Vec<f32> = normals
        .iter()
        .flat_map(|n| {
            let len = n.length().max(1e-12);
            [n.x / len, n.y / len, n.z / len]
        })
        .collect();
    let positions_flat: Vec<f32> = mesh
        .positions
        .iter()
        .flat_map(|p| [p.x, p.y, p.z])
        .collect();
    let indices_flat: Vec<u32> = mesh.triangles.iter().flat_map(|t| *t).collect();

    let bvh = Bvh::build(mesh);
    let layout = bvh.gpu_layout();
    if layout.nodes.is_empty() {
        return Err("empty tree".into());
    }
    let node_words: &[u32] = bytemuck::cast_slice(layout.nodes);

    let bbox = mesh.bbox();
    let reach = (bbox.diag() * REACH_RATIO).max(1e-3);
    let vertex_count = mesh.positions.len() as u32;
    let mut params = Params {
        vertex_end: 0,
        vertex_start: 0,
        root: layout.root,
        leaf_flag: layout.leaf_flag,
        rays: rays.clamp(1, 256) as u32,
        reach,
        plateau: reach * FALLOFF_PLATEAU,
        bias: reach * ORIGIN_BIAS_RATIO,
        rotate: if rotate { 1.0 } else { 0.0 },
        ray_start: 0,
        ray_end: 0,
        _pad: 0,
    };
    if layout.nodes.len() * 32 > gpu.device.limits().max_storage_buffer_binding_size as usize {
        return Err("tree does not fit a storage binding".into());
    }

    let device = &gpu.device;
    let queue = &gpu.queue;
    let node_buf = writable(device, queue, "nodes", bytemuck::cast_slice(node_words));
    let face_buf = writable(device, queue, "faces", bytemuck::cast_slice(layout.faces));
    let pos_buf = writable(device, queue, "positions", bytemuck::cast_slice(&positions_flat));
    let idx_buf = writable(device, queue, "indices", bytemuck::cast_slice(&indices_flat));
    let nrm_buf = writable(device, queue, "normals", bytemuck::cast_slice(&normals_flat));
    let param_buf = {
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("params"),
            size: std::mem::size_of::<Params>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        buffer
    };
    let out_size = (mesh.positions.len() * 4) as u64;
    let out_buf = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("out"),
        size: out_size,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("readback"),
        size: out_size,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });

    let shader = device.create_shader_module(wgpu::include_wgsl!("ao.wgsl"));
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("ao"),
        layout: None,
        module: &shader,
        entry_point: Some("main"),
        compilation_options: Default::default(),
        cache: None,
    });
    let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: node_buf.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: face_buf.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 2, resource: pos_buf.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 3, resource: idx_buf.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 4, resource: nrm_buf.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 5, resource: param_buf.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 6, resource: out_buf.as_entire_binding() },
        ],
    });

    // One submit per slice of the work, each waited on, so no single GPU job
    // outlives the driver's watchdog (see `BATCH_TARGET`). A slice is a batch of
    // vertices and a run of their rays; `work` (vertex-rays per submit) follows the
    // measured rate, so a fast GPU reaches a whole model in a few submits and a
    // slow one traces a few rays of `FILL_BATCH` vertices at a time.
    let rays = params.rays;
    let mut work = (FILL_BATCH * rays.min(4)) as f64;
    while params.vertex_start < vertex_count {
        let batch = ((work / rays as f64) as u32).clamp(FILL_BATCH, MAX_BATCH);
        params.vertex_end = vertex_count.min(params.vertex_start + batch);
        let vertices = params.vertex_end - params.vertex_start;
        params.ray_start = 0;
        while params.ray_start < rays {
            let chunk = ((work / vertices as f64) as u32).clamp(1, rays);
            params.ray_end = rays.min(params.ray_start + chunk);
            queue.write_buffer(&param_buf, 0, bytemuck::bytes_of(&params));
            let mut encoder =
                device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
            {
                let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                    label: None,
                    timestamp_writes: None,
                });
                pass.set_pipeline(&pipeline);
                pass.set_bind_group(0, &bind_group, &[]);
                pass.dispatch_workgroups(vertices.div_ceil(64), 1, 1);
            }
            let started = std::time::Instant::now();
            queue.submit(Some(encoder.finish()));
            device
                .poll(wgpu::PollType::wait_indefinitely())
                .map_err(|e| format!("poll: {e:?}"))?;
            let took = started.elapsed().as_secs_f64().max(1e-4);
            let done = (vertices * (params.ray_end - params.ray_start)) as f64;
            work = done * (BATCH_TARGET.as_secs_f64() / took).clamp(0.25, 4.0);
            params.ray_start = params.ray_end;
        }
        params.vertex_start = params.vertex_end;
    }

    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
    encoder.copy_buffer_to_buffer(&out_buf, 0, &readback, 0, out_size);
    queue.submit(Some(encoder.finish()));
    device
        .poll(wgpu::PollType::wait_indefinitely())
        .map_err(|e| format!("poll: {e:?}"))?;

    let slice = readback.slice(..);
    slice.map_async(wgpu::MapMode::Read, |_| {});
    device
        .poll(wgpu::PollType::wait_indefinitely())
        .map_err(|e| format!("map: {e:?}"))?;
    let values: Vec<f32> = bytemuck::cast_slice(&slice.get_mapped_range()).to_vec();
    readback.unmap();
    Ok(values)
}

/// The finished field: the GPU bake with the fan turned, then the same
/// [`SMOOTHING_PASSES`] the CPU recipe applies.
///
/// The pass stays on the CPU on purpose. It is a graph sweep over the mesh, which
/// measured in milliseconds against the bake's seconds, and keeping it in
/// `mesh-core` means the GPU and CPU paths cannot end up with different fields.
pub fn bake_smoothed(mesh: &IndexedMesh, rays: usize) -> Result<Vec<f32>, String> {
    let field = bake(mesh, rays)?;
    Ok(smooth_over_mesh_graph(mesh, &field, SMOOTHING_PASSES))
}
