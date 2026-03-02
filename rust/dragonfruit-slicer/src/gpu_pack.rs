#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GpuPackingMode {
    None,
    Rgb8Div3,
    Gray3Div2,
}

#[cfg(not(target_arch = "wasm32"))]
mod native {
    use super::GpuPackingMode;
    use std::borrow::Cow;
    use std::sync::{Condvar, Mutex, OnceLock};
    use wgpu::util::DeviceExt;

    struct Semaphore {
        permits: Mutex<u32>,
        condvar: Condvar,
    }

    impl Semaphore {
        fn new(permits: u32) -> Self {
            Semaphore {
                permits: Mutex::new(permits),
                condvar: Condvar::new(),
            }
        }

        fn acquire(&self) {
            let mut p = self.permits.lock().unwrap();
            while *p == 0 {
                p = self.condvar.wait(p).unwrap();
            }
            *p -= 1;
        }

        fn release(&self) {
            let mut p = self.permits.lock().unwrap();
            *p += 1;
            self.condvar.notify_one();
        }
    }

    const SHADER: &str = r#"
struct Params {
  src_w: u32,
  src_h: u32,
  out_w: u32,
  out_h: u32,
  pad_left: u32,
  mode: u32,
    word_offset: u32,
  _pad1: u32,
}

@group(0) @binding(0) var<storage, read> src_words: array<u32>;
@group(0) @binding(1) var<storage, read_write> dst_words: array<u32>;
@group(0) @binding(2) var<uniform> params: Params;

fn sample(ix: i32, y: u32) -> u32 {
  if (ix < 0 || ix >= i32(params.src_w) || y >= params.src_h) {
    return 0u;
  }
    let linear = y * params.src_w + u32(ix);
    let word = src_words[linear >> 2u];
    let shift = (linear & 3u) * 8u;
    return (word >> shift) & 0xFFu;
}

@compute @workgroup_size(64)
fn pack(@builtin(global_invocation_id) gid: vec3<u32>) {
    let word_idx = params.word_offset + gid.x;
    let count = params.out_w * params.out_h;
    let base = word_idx * 4u;
    if (base >= count) {
    return;
  }

    var packed: u32 = 0u;

    for (var lane: u32 = 0u; lane < 4u; lane = lane + 1u) {
        let idx = base + lane;
        if (idx >= count) {
            continue;
        }

        let y = idx / params.out_w;
        let x = idx - y * params.out_w;

        var pixel: u32 = 0u;
        if (params.mode == 0u) {
            pixel = sample(i32(x), y);
        } else if (params.mode == 1u) {
            let sx = i32(x * 3u) - i32(params.pad_left);
            let r = sample(sx, y);
            let g = sample(sx + 1, y);
            let b = sample(sx + 2, y);
            pixel = (r + g + b) / 3u;
        } else {
            // Gray3Div2
            let sx = i32(x * 2u) - i32(params.pad_left);
            let a = sample(sx, y);
            let b = sample(sx + 1, y);
            pixel = (a + b) >> 1u;
        }

        packed = packed | ((pixel & 0xFFu) << (lane * 8u));
  }

    dst_words[word_idx] = packed;
}
"#;

    struct GpuPackingEngine {
        device: wgpu::Device,
        queue: wgpu::Queue,
        bind_layout: wgpu::BindGroupLayout,
        pipeline: wgpu::ComputePipeline,
        max_buffer_size: u64,
        max_storage_buffer_binding_size: u32,
        max_uniform_buffer_binding_size: u32,
        max_compute_workgroups_per_dimension: u32,
    }

    impl GpuPackingEngine {
        #[inline]
        fn pack_bytes_to_words(src: &[u8]) -> Vec<u32> {
            let words_len = src.len().div_ceil(4);
            let mut words = vec![0u32; words_len];
            for (i, &b) in src.iter().enumerate() {
                let wi = i >> 2;
                let shift = ((i & 3) * 8) as u32;
                words[wi] |= (b as u32) << shift;
            }
            words
        }

        #[inline]
        fn unpack_words_to_bytes(words: &[u32], out_len: usize) -> Vec<u8> {
            let mut out = vec![0u8; out_len];
            for i in 0..out_len {
                let wi = i >> 2;
                let shift = ((i & 3) * 8) as u32;
                out[i] = ((words[wi] >> shift) & 0xFF) as u8;
            }
            out
        }

        fn new() -> Result<Self, String> {
            let instance = wgpu::Instance::default();
            let adapter =
                pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
                    power_preference: wgpu::PowerPreference::HighPerformance,
                    compatible_surface: None,
                    force_fallback_adapter: false,
                }))
                .ok_or_else(|| "No GPU adapter available for compute backend".to_string())?;

            let (device, queue) = pollster::block_on(adapter.request_device(
                &wgpu::DeviceDescriptor {
                    label: Some("dragonfruit-gpu-pack-device"),
                    required_features: wgpu::Features::empty(),
                    required_limits: wgpu::Limits::default(),
                },
                None,
            ))
            .map_err(|e| format!("GPU device init failed: {e}"))?;

            let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("dragonfruit-gpu-pack-shader"),
                source: wgpu::ShaderSource::Wgsl(Cow::Borrowed(SHADER)),
            });

            let bind_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("dragonfruit-gpu-pack-bind-layout"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Storage { read_only: true },
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Storage { read_only: false },
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                ],
            });

            let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("dragonfruit-gpu-pack-pipeline-layout"),
                bind_group_layouts: &[&bind_layout],
                push_constant_ranges: &[],
            });

            let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("dragonfruit-gpu-pack-pipeline"),
                layout: Some(&pipeline_layout),
                module: &shader,
                entry_point: "pack",
            });

            let limits = device.limits();

            Ok(Self {
                device,
                queue,
                bind_layout,
                pipeline,
                max_buffer_size: limits.max_buffer_size,
                max_storage_buffer_binding_size: limits.max_storage_buffer_binding_size,
                max_uniform_buffer_binding_size: limits.max_uniform_buffer_binding_size,
                max_compute_workgroups_per_dimension: limits.max_compute_workgroups_per_dimension,
            })
        }

        fn run(
            &self,
            source_mask: &[u8],
            source_width_px: u32,
            source_height_px: u32,
            output_width_px: u32,
            output_height_px: u32,
            mode: GpuPackingMode,
        ) -> Result<Vec<u8>, String> {
            let src_len = (source_width_px as usize) * (source_height_px as usize);
            if source_mask.len() != src_len {
                return Err("GPU pack input length mismatch".to_string());
            }

            let out_len = (output_width_px as usize) * (output_height_px as usize);
            let src_words_len = src_len.div_ceil(4);
            let dst_words_len = out_len.div_ceil(4);
            let src_size = (src_words_len * std::mem::size_of::<u32>()) as u64;
            let dst_size = (dst_words_len * std::mem::size_of::<u32>()) as u64;
            let params_size = (8 * std::mem::size_of::<u32>()) as u64;

            // Hard guard against device limits to avoid wgpu validation panics.
            if src_size > self.max_buffer_size
                || dst_size > self.max_buffer_size
                || params_size > self.max_buffer_size
            {
                return Err(format!(
                    "GPU buffer exceeds device max_buffer_size (src={src_size}, dst={dst_size}, max={})",
                    self.max_buffer_size
                ));
            }

            if src_size > self.max_storage_buffer_binding_size as u64
                || dst_size > self.max_storage_buffer_binding_size as u64
            {
                return Err(format!(
                    "GPU storage binding exceeds max_storage_buffer_binding_size (src={src_size}, dst={dst_size}, max={})",
                    self.max_storage_buffer_binding_size
                ));
            }

            if params_size > self.max_uniform_buffer_binding_size as u64 {
                return Err(format!(
                    "GPU uniform binding exceeds max_uniform_buffer_binding_size (params={params_size}, max={})",
                    self.max_uniform_buffer_binding_size
                ));
            }

            let src_u32 = Self::pack_bytes_to_words(source_mask);

            let required_subpixels = match mode {
                GpuPackingMode::None => output_width_px as usize,
                GpuPackingMode::Rgb8Div3 => (output_width_px as usize).saturating_mul(3),
                GpuPackingMode::Gray3Div2 => (output_width_px as usize).saturating_mul(2),
            };
            let pad_left = required_subpixels
                .saturating_sub(source_width_px as usize)
                .saturating_div(2) as u32;

            let mode_u32 = match mode {
                GpuPackingMode::None => 0u32,
                GpuPackingMode::Rgb8Div3 => 1u32,
                GpuPackingMode::Gray3Div2 => 2u32,
            };

            let mut params: [u32; 8] = [
                source_width_px,
                source_height_px,
                output_width_px,
                output_height_px,
                pad_left,
                mode_u32,
                0,
                0,
            ];

            let src_buf = self
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("dragonfruit-gpu-pack-src"),
                    contents: bytemuck::cast_slice(&src_u32),
                    usage: wgpu::BufferUsages::STORAGE,
                });

            let dst_buf = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("dragonfruit-gpu-pack-dst"),
                size: dst_size,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            });

            let params_buf = self
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("dragonfruit-gpu-pack-params"),
                    contents: bytemuck::cast_slice(&params),
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                });

            let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("dragonfruit-gpu-pack-bind-group"),
                layout: &self.bind_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: src_buf.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: dst_buf.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: params_buf.as_entire_binding(),
                    },
                ],
            });

            let readback = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("dragonfruit-gpu-pack-readback"),
                size: dst_size,
                usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });

            let mut encoder = self
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("dragonfruit-gpu-pack-encoder"),
                });

            {
                let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                    label: Some("dragonfruit-gpu-pack-pass"),
                    timestamp_writes: None,
                });
                pass.set_pipeline(&self.pipeline);
                pass.set_bind_group(0, &bind_group, &[]);

                // Dispatch is limited per-dimension by device limits (usually 65535).
                // We process output in chunks and advance via params.word_offset.
                let total_groups = (dst_words_len as u32).div_ceil(64);
                let max_groups_x = self.max_compute_workgroups_per_dimension.max(1);
                let mut dispatched_groups = 0u32;

                while dispatched_groups < total_groups {
                    let remaining = total_groups - dispatched_groups;
                    let groups_this = remaining.min(max_groups_x);

                    params[6] = dispatched_groups.saturating_mul(64);
                    self.queue
                        .write_buffer(&params_buf, 0, bytemuck::cast_slice(&params));

                    pass.dispatch_workgroups(groups_this, 1, 1);
                    dispatched_groups += groups_this;
                }
            }

            encoder.copy_buffer_to_buffer(&dst_buf, 0, &readback, 0, dst_size);
            self.queue.submit(Some(encoder.finish()));

            let slice = readback.slice(..);
            let (tx, rx) = std::sync::mpsc::channel();
            slice.map_async(wgpu::MapMode::Read, move |res| {
                let _ = tx.send(res);
            });
            self.device.poll(wgpu::Maintain::Wait);

            rx.recv()
                .map_err(|_| "GPU map callback channel closed".to_string())?
                .map_err(|e| format!("GPU readback map failed: {e:?}"))?;

            let mapped = slice.get_mapped_range();
            let words: &[u32] = bytemuck::cast_slice(&mapped);
            let out = Self::unpack_words_to_bytes(words, out_len);
            drop(mapped);
            readback.unmap();

            Ok(out)
        }
    }

    static GPU_ENGINE: OnceLock<Option<GpuPackingEngine>> = OnceLock::new();
    static GPU_PACK_RUN_LOCK: OnceLock<Semaphore> = OnceLock::new();

    fn engine() -> Option<&'static GpuPackingEngine> {
        GPU_ENGINE
            .get_or_init(|| GpuPackingEngine::new().ok())
            .as_ref()
    }

    pub fn is_available() -> bool {
        engine().is_some()
    }

    pub fn try_pack_mask(
        source_mask: &[u8],
        source_width_px: u32,
        source_height_px: u32,
        output_width_px: u32,
        output_height_px: u32,
        mode: GpuPackingMode,
    ) -> Option<Vec<u8>> {
        let engine = engine()?;

        // Use semaphore(4) to allow up to 4 concurrent GPU packing ops,
        // balancing throughput with memory safety.
        let run_lock = GPU_PACK_RUN_LOCK.get_or_init(|| Semaphore::new(4));
        run_lock.acquire();

        let result = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            engine.run(
                source_mask,
                source_width_px,
                source_height_px,
                output_width_px,
                output_height_px,
                mode,
            )
        })) {
            Ok(Ok(mask)) => Some(mask),
            Ok(Err(_)) => None,
            Err(_) => None,
        };

        run_lock.release();
        result
    }
}

#[cfg(target_arch = "wasm32")]
mod native {
    use super::GpuPackingMode;

    pub fn is_available() -> bool {
        false
    }

    pub fn try_pack_mask(
        _source_mask: &[u8],
        _source_width_px: u32,
        _source_height_px: u32,
        _output_width_px: u32,
        _output_height_px: u32,
        _mode: GpuPackingMode,
    ) -> Option<Vec<u8>> {
        None
    }
}

pub fn is_gpu_pack_available() -> bool {
    native::is_available()
}

pub fn try_pack_mask_gpu(
    source_mask: &[u8],
    source_width_px: u32,
    source_height_px: u32,
    output_width_px: u32,
    output_height_px: u32,
    mode: GpuPackingMode,
) -> Option<Vec<u8>> {
    native::try_pack_mask(
        source_mask,
        source_width_px,
        source_height_px,
        output_width_px,
        output_height_px,
        mode,
    )
}
