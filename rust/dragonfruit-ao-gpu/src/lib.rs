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

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    vertex_count: u32,
    root: u32,
    leaf_flag: u32,
    rays: u32,
    reach: f32,
    plateau: f32,
    bias: f32,
    rotate: f32,
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
    let params = Params {
        vertex_count: mesh.positions.len() as u32,
        root: layout.root,
        leaf_flag: layout.leaf_flag,
        rays: rays.clamp(1, 256) as u32,
        reach,
        plateau: reach * FALLOFF_PLATEAU,
        bias: reach * ORIGIN_BIAS_RATIO,
        rotate: if rotate { 1.0 } else { 0.0 },
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
        queue.write_buffer(&buffer, 0, bytemuck::bytes_of(&params));
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

    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
    {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: None,
            timestamp_writes: None,
        });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &bind_group, &[]);
        let groups = (mesh.positions.len() as u32).div_ceil(64);
        pass.dispatch_workgroups(groups.min(65535), groups.div_ceil(65535), 1);
    }
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
