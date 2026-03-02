#[cfg(not(target_arch = "wasm32"))]
mod native {
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

    #[repr(C)]
    #[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
    pub struct GpuSegment {
        pub x1: f32,
        pub y1: f32,
        pub dx_dy: f32,
        pub y_min: f32,
        pub y_max: f32,
        pub wind: i32,
        pub _pad: i32,
    }

    #[repr(C)]
    #[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
    struct Params {
        width: u32,
        height: u32,
        seg_count: u32,
        word_offset: u32,
    }

    const SHADER: &str = r#"
struct Segment {
  x1: f32,
  y1: f32,
  dx_dy: f32,
  y_min: f32,
  y_max: f32,
  wind: i32,
  _pad: i32,
}

struct Params {
  width: u32,
  height: u32,
  seg_count: u32,
  word_offset: u32,
}

@group(0) @binding(0) var<storage, read> segments: array<Segment>;
@group(0) @binding(1) var<storage, read_write> dst_words: array<u32>;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(64)
fn raster(@builtin(global_invocation_id) gid: vec3<u32>) {
  let word_idx = params.word_offset + gid.x;
  let count = params.width * params.height;
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

    let y = idx / params.width;
    let x = idx - y * params.width;

    let x_sample = f32(x) + 0.5;
    let y_sample = f32(y) + 0.5;

    var winding: i32 = 0;
    for (var i: u32 = 0u; i < params.seg_count; i = i + 1u) {
      let s = segments[i];
      if (y_sample < s.y_min || y_sample >= s.y_max) {
        continue;
      }
      let x_int = s.x1 + (y_sample - s.y1) * s.dx_dy;
      if (x_int > x_sample) {
        winding = winding + s.wind;
      }
    }

    let px: u32 = select(0u, 255u, winding != 0);
    packed = packed | ((px & 0xFFu) << (lane * 8u));
  }

  dst_words[word_idx] = packed;
}
"#;

    struct GpuRasterEngine {
        device: wgpu::Device,
        queue: wgpu::Queue,
        bind_layout: wgpu::BindGroupLayout,
        pipeline: wgpu::ComputePipeline,
        max_buffer_size: u64,
        max_storage_buffer_binding_size: u32,
        max_uniform_buffer_binding_size: u32,
        max_compute_workgroups_per_dimension: u32,
    }

    impl GpuRasterEngine {
        fn new() -> Result<Self, String> {
            let instance = wgpu::Instance::default();
            let adapter =
                pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
                    power_preference: wgpu::PowerPreference::HighPerformance,
                    compatible_surface: None,
                    force_fallback_adapter: false,
                }))
                .ok_or_else(|| "No GPU adapter available for raster backend".to_string())?;

            let (device, queue) = pollster::block_on(adapter.request_device(
                &wgpu::DeviceDescriptor {
                    label: Some("dragonfruit-gpu-raster-device"),
                    required_features: wgpu::Features::empty(),
                    required_limits: wgpu::Limits::default(),
                },
                None,
            ))
            .map_err(|e| format!("GPU raster device init failed: {e}"))?;

            let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("dragonfruit-gpu-raster-shader"),
                source: wgpu::ShaderSource::Wgsl(Cow::Borrowed(SHADER)),
            });

            let bind_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("dragonfruit-gpu-raster-bind-layout"),
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
                label: Some("dragonfruit-gpu-raster-pipeline-layout"),
                bind_group_layouts: &[&bind_layout],
                push_constant_ranges: &[],
            });

            let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("dragonfruit-gpu-raster-pipeline"),
                layout: Some(&pipeline_layout),
                module: &shader,
                entry_point: "raster",
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

        fn unpack_words_to_bytes(words: &[u32], out_len: usize) -> Vec<u8> {
            let mut out = vec![0u8; out_len];
            for i in 0..out_len {
                let wi = i >> 2;
                let shift = ((i & 3) * 8) as u32;
                out[i] = ((words[wi] >> shift) & 0xFF) as u8;
            }
            out
        }

        fn run(
            &self,
            segments: &[GpuSegment],
            width_px: u32,
            height_px: u32,
        ) -> Result<Vec<u8>, String> {
            let out_len = (width_px as usize) * (height_px as usize);
            let dst_words_len = out_len.div_ceil(4);

            let seg_size = std::mem::size_of_val(segments) as u64;
            let dst_size = (dst_words_len * std::mem::size_of::<u32>()) as u64;
            let params_size = std::mem::size_of::<Params>() as u64;

            if seg_size > self.max_buffer_size
                || dst_size > self.max_buffer_size
                || params_size > self.max_buffer_size
            {
                return Err(format!(
                    "GPU raster buffer exceeds max_buffer_size (seg={seg_size}, dst={dst_size}, max={})",
                    self.max_buffer_size
                ));
            }

            if seg_size > self.max_storage_buffer_binding_size as u64
                || dst_size > self.max_storage_buffer_binding_size as u64
            {
                return Err(format!(
                    "GPU raster storage binding exceeds limit (seg={seg_size}, dst={dst_size}, max={})",
                    self.max_storage_buffer_binding_size
                ));
            }

            if params_size > self.max_uniform_buffer_binding_size as u64 {
                return Err(format!(
                    "GPU raster uniform binding exceeds limit (params={params_size}, max={})",
                    self.max_uniform_buffer_binding_size
                ));
            }

            let seg_buf = self
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("dragonfruit-gpu-raster-segments"),
                    contents: bytemuck::cast_slice(segments),
                    usage: wgpu::BufferUsages::STORAGE,
                });

            let dst_buf = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("dragonfruit-gpu-raster-dst"),
                size: dst_size,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            });

            let mut params = Params {
                width: width_px,
                height: height_px,
                seg_count: segments.len() as u32,
                word_offset: 0,
            };
            let params_buf = self
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("dragonfruit-gpu-raster-params"),
                    contents: bytemuck::bytes_of(&params),
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                });

            let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("dragonfruit-gpu-raster-bind-group"),
                layout: &self.bind_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: seg_buf.as_entire_binding(),
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
                label: Some("dragonfruit-gpu-raster-readback"),
                size: dst_size,
                usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });

            let mut encoder = self
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("dragonfruit-gpu-raster-encoder"),
                });

            {
                let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                    label: Some("dragonfruit-gpu-raster-pass"),
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

                    params.word_offset = dispatched_groups.saturating_mul(64);
                    self.queue
                        .write_buffer(&params_buf, 0, bytemuck::bytes_of(&params));

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
                .map_err(|_| "GPU raster map callback channel closed".to_string())?
                .map_err(|e| format!("GPU raster readback map failed: {e:?}"))?;

            let mapped = slice.get_mapped_range();
            let words: &[u32] = bytemuck::cast_slice(&mapped);
            let out = Self::unpack_words_to_bytes(words, out_len);
            drop(mapped);
            readback.unmap();

            Ok(out)
        }
    }

    static GPU_RASTER_ENGINE: OnceLock<Option<GpuRasterEngine>> = OnceLock::new();
    static GPU_RASTER_RUN_LOCK: OnceLock<Semaphore> = OnceLock::new();

    fn engine() -> Option<&'static GpuRasterEngine> {
        GPU_RASTER_ENGINE
            .get_or_init(|| GpuRasterEngine::new().ok())
            .as_ref()
    }

    pub fn is_available() -> bool {
        engine().is_some()
    }

    pub fn try_rasterize_binary(
        segments: &[GpuSegment],
        width_px: u32,
        height_px: u32,
    ) -> Option<Vec<u8>> {
        let eng = engine()?;
        // GPU raster dispatch allocates transient storage + readback buffers per call.
        // Use semaphore(4) to allow up to 4 concurrent GPU ops, reducing contention
        // while still preventing OOM thrashing from unlimited parallel GPU work.
        let run_lock = GPU_RASTER_RUN_LOCK.get_or_init(|| Semaphore::new(4));
        run_lock.acquire();

        let result = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            eng.run(segments, width_px, height_px)
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
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct GpuSegment {
        pub x1: f32,
        pub y1: f32,
        pub dx_dy: f32,
        pub y_min: f32,
        pub y_max: f32,
        pub wind: i32,
        pub _pad: i32,
    }

    pub fn is_available() -> bool {
        false
    }

    pub fn try_rasterize_binary(
        _segments: &[GpuSegment],
        _width_px: u32,
        _height_px: u32,
    ) -> Option<Vec<u8>> {
        None
    }
}

pub use native::GpuSegment;

pub fn is_gpu_raster_available() -> bool {
    native::is_available()
}

pub fn try_rasterize_binary_gpu(
    segments: &[GpuSegment],
    width_px: u32,
    height_px: u32,
) -> Option<Vec<u8>> {
    native::try_rasterize_binary(segments, width_px, height_px)
}
