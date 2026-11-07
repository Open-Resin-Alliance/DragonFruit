#include "raster.h"
#include <cub/cub.cuh>
#include <thrust/iterator/reverse_iterator.h>
#include <thrust/iterator/counting_iterator.h>
#include <cmath>
#include <climits>

namespace dfcuda {
namespace {

constexpr std::uint32_t launch_items = 1u << 22;
constexpr std::uint32_t serial_items = 4096;
constexpr std::uint32_t index_block_size = 256;

__device__ float add(float a, float b) { return __fadd_rn(a, b); }
__device__ float sub(float a, float b) { return __fsub_rn(a, b); }
__device__ float mul(float a, float b) { return __fmul_rn(a, b); }
__device__ float div(float a, float b) { return __fdiv_rn(a, b); }
__device__ float clampf(float x, float lo, float hi) { return fminf(fmaxf(x, lo), hi); }
__device__ std::uint32_t clamp_row(float x, std::uint32_t height) {
    if (!(x > 0.0f)) return 0;
    if (x >= static_cast<float>(height)) return height;
    return static_cast<std::uint32_t>(x);
}
__device__ std::uint32_t x_key(float x) {
    if (!isfinite(x)) return UINT_MAX;
    if (x == 0.0f) x = 0.0f;
    const auto bits = __float_as_uint(x);
    return (bits & 0x80000000u) ? ~bits : bits ^ 0x80000000u;
}

template<class... T> void initialize(Runtime &r, T &...buffers) {
    (buffers.initialize(r.memory, r.compute), ...);
}

template<class F> void primitive(Runtime &r, Buffer<std::uint8_t> &scratch, F f) {
    std::size_t bytes = 0;
    checked(f(nullptr, bytes), "query raster primitive scratch");
    scratch.resize(bytes);
    checked(f(scratch.data(), bytes), "execute raster primitive");
    scratch.mark_used(r.compute);
}

template<class F> void bounded_primitive(Runtime &r, Buffer<std::uint8_t> &scratch, F f) {
    // CUB validates the supplied capacity. Do not repeat its null-storage
    // query for every queued row; all primitives reuse the admitted reserve.
    std::size_t bytes = scratch.capacity();
    checked(f(scratch.data(), bytes), "execute bounded raster primitive");
    scratch.mark_used(r.compute);
}

struct RasterControlPin {
    Runtime &runtime;
    HostPin pin;
    bool complete = false;
    RasterControlPin(Runtime &r, void *p, std::size_t bytes) : runtime(r), pin(p, bytes) {}
    ~RasterControlPin() {
        // Exception unwinding must not release host storage still read by DMA.
        if (!complete) (void)cudaStreamSynchronize(runtime.compute);
    }
    void joined() { complete = true; pin.unregister(); }
};

struct RasterControlEvent {
    cudaEvent_t completion = nullptr;
    RasterControlEvent() {
        checked(cudaEventCreateWithFlags(&completion, cudaEventDisableTiming | cudaEventBlockingSync),
                "create raster descriptor copy event");
    }
    ~RasterControlEvent() { (void)cudaEventDestroy(completion); }
};

template<class T> void metadata(Runtime &r, T *destination, const T *source, std::size_t count) {
    const auto chunk = std::max<std::size_t>(1, r.transfer_bytes() / sizeof(T));
    for (std::size_t offset = 0; offset < count; offset += chunk) {
        r.check_cancelled();
        const auto n = std::min(chunk, count - offset);
        HostPin pin(destination + offset, checked_bytes(n, sizeof(T)));
        checked(cudaMemcpyAsync(destination + offset, source + offset, checked_bytes(n, sizeof(T)),
                                cudaMemcpyDeviceToHost, r.compute), "read raster control metadata");
        checked(cudaStreamSynchronize(r.compute), "finish raster control metadata");
        pin.unregister();
    }
}

template<class T> T metadata(Runtime &r, const T *source) {
    T result{};
    metadata(r, &result, source, 1);
    return result;
}

void launched(Runtime &r) {
    checked(cudaGetLastError(), "launch raster kernel");
    r.check_cancelled();
}

__device__ void scene_rows(const RasterTriangle &tri, std::uint32_t *bounds,
                           DfCudaConfig cfg, std::uint32_t factor) {
    float low = tri.y[0], high = tri.y[0];
    bool finite = true;
    for (int a = 0; a < 3; ++a) {
        const int b = (a + 1) % 3;
        const float delta = sub(tri.y[b], tri.y[a]);
        const float endpoint = add(tri.y[a], delta);
        // intersection() has no explicit t clamp. Finite Z endpoints and
        // their finite rounded difference make any accepted crossing's t
        // lie in [0,1]. Rounded Y lerp is monotone, but its t=1 endpoint
        // need not equal b; include that reconstructed endpoint too.
        finite = finite && isfinite(tri.z[a]) && isfinite(sub(tri.z[b], tri.z[a]))
            && isfinite(tri.y[a]) && isfinite(delta) && isfinite(endpoint);
        low = fminf(low, fminf(tri.y[a], endpoint));
        high = fmaxf(high, fmaxf(tri.y[a], endpoint));
    }
    std::uint32_t first = 0, last = cfg.height;
    const auto height = cfg.height * factor;
    if (finite) {
        // Match the raster's rounded ceil/clamp operations, bounding every
        // binary/perturbation subrow phase in [0,1]. One extra physical row
        // covers the interleaved terminal phase before render() rounds up.
        first = clamp_row(ceilf(sub(low, 1.0f)), height) / factor;
        const auto end = clamp_row(ceilf(high), height);
        last = static_cast<std::uint32_t>(min(static_cast<std::uint64_t>(cfg.height),
            (static_cast<std::uint64_t>(end) + factor - 1) / factor + 1));
        if (cfg.dense_raster_semantics == 1 && cfg.raster_mode == DF_CUDA_COVERAGE && cfg.aa_samples > 1) {
            const auto rows = static_cast<std::uint64_t>(height) * cfg.aa_samples;
            const auto divisor = static_cast<std::uint64_t>(factor) * cfg.aa_samples;
            if (rows > INT_MAX) { first = 0; last = cfg.height; }
            else {
                // Analytic Coverage multiplies Y before rounding. Repeating
                // those f32 operations also bounds their rounding at 16K+.
                const auto begin = clamp_row(ceilf(sub(mul(low, static_cast<float>(cfg.aa_samples)), 0.5f)),
                                             static_cast<std::uint32_t>(rows));
                const auto finish = clamp_row(ceilf(sub(mul(high, static_cast<float>(cfg.aa_samples)), 0.5f)),
                                              static_cast<std::uint32_t>(rows));
                first = min(first, static_cast<std::uint32_t>(begin / divisor));
                last = max(last, static_cast<std::uint32_t>((finish + divisor - 1) / divisor));
            }
        }
    }
    // Never use an X vertex hull: incremental f32 edge X can drift outside it.
    atomicMin(bounds, first); atomicMax(bounds + 1, last);
}

__global__ void parse_geometry(const float *raw, const std::uint32_t *tanks,
                               RasterTriangle *triangles, std::uint32_t *row_bounds,
                               DfCudaConfig cfg, std::uint32_t first, std::uint32_t count,
                               std::uint32_t factor, bool have_tanks) {
    const auto i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= count) return;
    const float *v = raw + static_cast<std::size_t>(i) * 9;
    RasterTriangle t{};
    const float ux = sub(v[3], v[0]), uy = sub(v[4], v[1]), uz = sub(v[5], v[2]);
    const float vx = sub(v[6], v[0]), vy = sub(v[7], v[1]), vz = sub(v[8], v[2]);
    const float nx = sub(mul(uy, vz), mul(uz, vy));
    t.dir_x = sub(mul(uz, vx), mul(ux, vz));
    t.dir_y = -nx;
    t.wind = nx > 0.0f ? -1 : 1;
    const float mx = mul(-cfg.build_width_mm, 0.5f);
    const float my = mul(-cfg.build_depth_mm, 0.5f);
    const float px = static_cast<float>(cfg.width * factor - 1);
    const float py = static_cast<float>(cfg.height * factor - 1);
    const float ax = div(cfg.mirror_x ? -px : px, cfg.build_width_mm);
    const float bx = cfg.mirror_x ? add(px, div(mul(mx, px), cfg.build_width_mm))
                                 : div(mul(-mx, px), cfg.build_width_mm);
    const float ay = div(cfg.mirror_y ? py : -py, cfg.build_depth_mm);
    const float by = cfg.mirror_y ? div(mul(-my, py), cfg.build_depth_mm)
                                 : add(py, div(mul(my, py), cfg.build_depth_mm));
    for (int j = 0; j < 3; ++j) {
        t.z[j] = v[j * 3 + 2];
        t.x[j] = add(mul(v[j * 3], ax), bx);
        t.y[j] = add(mul(v[j * 3 + 1], ay), by);
    }
    t.z_min = fminf(fminf(t.z[0], t.z[1]), t.z[2]);
    t.z_max = fmaxf(fmaxf(t.z[0], t.z[1]), t.z[2]);
    const bool full = cfg.raster_mode == DF_CUDA_PERTURBATION && cfg.aa_samples > 1;
    const float begin = full ? ceilf(sub(sub(div(t.z_min, cfg.layer_height_mm), 1.0f), 1e-5f))
                             : ceilf(sub(div(t.z_min, cfg.layer_height_mm), 0.5f));
    const float end = full ? floorf(add(div(t.z_max, cfg.layer_height_mm), 1e-5f))
                           : floorf(sub(div(t.z_max, cfg.layer_height_mm), 0.5f));
    if (end < 0.0f || begin >= static_cast<float>(cfg.total_layers) || end < begin) {
        t.first_layer = UINT_MAX;
        t.last_layer = 0;
    } else {
        t.first_layer = clamp_row(begin, cfg.total_layers - 1);
        t.last_layer = clamp_row(end, cfg.total_layers - 1);
    }
    const auto id = first + i;
    const bool support = cfg.model_triangle_count > 0 && id >= cfg.model_triangle_count;
    t.tank = support || !have_tanks ? 0 : min(tanks[i], cfg.tank_count - 1);
    triangles[id] = t;
    scene_rows(t, row_bounds, cfg, factor);
}

__global__ void index_keys(const RasterTriangle *tri, std::uint32_t *keys,
                           std::uint32_t *ids, std::uint32_t first, std::uint32_t n) {
    const auto i = first + blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) return;
    keys[i] = tri[i].first_layer;
    ids[i] = i;
}

__global__ void index_blocks(const RasterTriangle *tri, const std::uint32_t *ids,
                             RasterIndexBlock *blocks, std::uint32_t first,
                             std::uint32_t n) {
    const auto b = first + blockIdx.x * blockDim.x + threadIdx.x;
    const auto begin = static_cast<std::uint64_t>(b) * index_block_size;
    if (begin >= n) return;
    RasterIndexBlock result{tri[ids[begin]].first_layer, 0};
    for (auto i = begin; i < min(begin + index_block_size, static_cast<std::uint64_t>(n)); ++i)
        result.last_layer = max(result.last_layer, tri[ids[i]].last_layer);
    blocks[b] = result;
}

__global__ void candidate_flags(const RasterTriangle *tri, const std::uint32_t *ids,
                                const RasterIndexBlock *blocks, std::uint32_t *flags,
                                std::uint32_t first, std::uint32_t n, std::uint32_t layer,
                                std::uint32_t tank, std::uint32_t split, int selection) {
    const auto i = first + blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) return;
    const auto block = blocks[i / index_block_size];
    bool selected = block.first_layer <= layer && block.last_layer >= layer;
    if (selected) {
        const auto id = ids[i];
        const auto t = tri[id];
        selected = t.first_layer <= layer && t.last_layer >= layer && t.tank == tank;
        if (selection == static_cast<int>(RasterSelection::ModelForTank) && split > 0)
            selected = selected && id < split;
        if (selection == static_cast<int>(RasterSelection::BinarySupports))
            selected = selected && split > 0 && id >= split && tank == 0;
    }
    flags[i] = selected ? 1 : 0;
}

__device__ float sample_offset(std::uint32_t pattern, std::uint32_t index, std::uint32_t n) {
    if (pattern == DF_CUDA_UNIFORM) return div(add(static_cast<float>(index), 0.5f), static_cast<float>(n));
    ++index;
    float result = 0.0f;
    float f = pattern == DF_CUDA_HALTON ? div(1.0f, 5.0f) : 0.5f;
    while (index > 0) {
        const auto digit = pattern == DF_CUDA_HALTON ? index % 5 : index & 1;
        result = add(result, mul(f, static_cast<float>(digit)));
        index = pattern == DF_CUDA_HALTON ? index / 5 : index >> 1;
        f = pattern == DF_CUDA_HALTON ? div(f, 5.0f) : mul(f, 0.5f);
    }
    return result;
}

__device__ bool intersection(float az, float bz, float z, float &t) {
    const float a = sub(az, z), b = sub(bz, z);
    if (!((a <= 0.0f && b > 0.0f) || (b <= 0.0f && a > 0.0f))) return false;
    const float denominator = sub(bz, az);
    if (fabsf(denominator) < 1e-8f) return false;
    t = div(sub(z, az), denominator);
    return true;
}

__global__ void make_events(const RasterTriangle *triangles, const std::uint32_t *candidates,
                            RasterEdge *events, std::uint64_t *keys, std::uint32_t *counts,
                            DfCudaConfig cfg, std::uint32_t layer, std::uint32_t height,
                            std::uint32_t steps, std::uint32_t candidates_count,
                            std::uint32_t first, std::uint32_t n, bool perturb, bool analytic) {
    const auto i = first + blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) return;
    keys[i] = UINT64_MAX;
    events[i] = {};
    const auto phase_index = i / candidates_count;
    const auto candidate = i % candidates_count;
    const auto tri = triangles[candidates[candidate]];
    const bool duplicate = cfg.duplicate_terminal_z && (steps == 16 || steps == 32 || steps == 64);
    const auto z_steps = duplicate ? max(steps / 2, 1u) : steps;
    const float offset = perturb ? sample_offset(cfg.sample_pattern, phase_index * z_steps / steps, z_steps) : 0.5f;
    const float z = mul(add(static_cast<float>(layer), offset), cfg.layer_height_mm);
    if (z < tri.z_min || z >= tri.z_max) return;
    float xs[3], ys[3];
    int points = 0;
    for (int a = 0; a < 3; ++a) {
        const int b = (a + 1) % 3;
        float t;
        if (!intersection(tri.z[a], tri.z[b], z, t)) continue;
        const float x = add(tri.x[a], mul(sub(tri.x[b], tri.x[a]), t));
        const float y = add(tri.y[a], mul(sub(tri.y[b], tri.y[a]), t));
        bool distinct = true;
        for (int j = 0; j < points; ++j)
            if (fabsf(sub(x, xs[j])) <= 1e-5f && fabsf(sub(y, ys[j])) <= 1e-5f) distinct = false;
        if (distinct && points < 3) { xs[points] = x; ys[points++] = y; }
    }
    if (points < 2) return;
    if (fabsf(tri.dir_x) > 1e-10f || fabsf(tri.dir_y) > 1e-10f) {
        if (add(mul(sub(xs[1], xs[0]), tri.dir_x), mul(sub(ys[1], ys[0]), tri.dir_y)) < 0.0f) {
            const float x = xs[0], y = ys[0];
            xs[0] = xs[1]; ys[0] = ys[1]; xs[1] = x; ys[1] = y;
        }
    }
    const float dy = sub(ys[1], ys[0]);
    if (fabsf(dy) < 1e-8f) return;
    const float slope = div(sub(xs[1], xs[0]), dy);
    const float phase = perturb ? div(add(static_cast<float>(phase_index), 0.5f), static_cast<float>(steps)) : 0.5f;
    const auto begin = analytic
        ? clamp_row(ceilf(sub(mul(fminf(ys[0], ys[1]), static_cast<float>(steps)), 0.5f)), height * steps)
        : clamp_row(ceilf(sub(fminf(ys[0], ys[1]), phase)), height);
    const auto end = analytic
        ? clamp_row(ceilf(sub(mul(fmaxf(ys[0], ys[1]), static_cast<float>(steps)), 0.5f)), height * steps)
        : clamp_row(ceilf(sub(fmaxf(ys[0], ys[1]), phase)), height);
    if (begin >= end) return;
    const auto start_row = perturb ? begin * steps + phase_index : begin;
    const auto end_row = perturb ? end * steps + phase_index : end;
    const float y_sample = analytic ? div(add(static_cast<float>(begin), 0.5f), static_cast<float>(steps))
                                    : add(static_cast<float>(begin), phase);
    events[i] = {add(xs[0], mul(sub(y_sample, ys[0]), slope)), analytic ? div(slope, static_cast<float>(steps)) : slope,
                 cfg.mirror_x ? -tri.wind : tri.wind, end_row, xs[0], ys[0]};
    keys[i] = (static_cast<std::uint64_t>(start_row) << 32) | candidate;
    const auto rows = height * steps;
    atomicAdd(counts + start_row, 1u);
    atomicAdd(counts + rows + end_row, 1u);
    atomicAdd(counts + static_cast<std::size_t>(rows) * 2 + steps, 1u);
}

struct Alive {
    std::uint32_t row;
    __device__ bool operator()(const RasterEdge &e) const { return e.end_exclusive > row; }
};

__global__ void append_events(RasterEdge *row, const RasterEdge *events, std::uint32_t offset,
                              std::uint32_t first, std::uint32_t n) {
    const auto i = first + blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) row[offset + i] = events[i];
}

__global__ void row_keys(RasterEdge *edges, std::uint32_t *keys, std::uint32_t first,
                         std::uint32_t n, std::uint32_t row, std::uint32_t steps, bool perturb) {
    const auto i = first + blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) return;
    if (perturb) {
        const float phase = div(add(static_cast<float>(row % steps), 0.5f), static_cast<float>(steps));
        const float y = add(static_cast<float>(row / steps), phase);
        edges[i].x = add(edges[i].base_x, mul(sub(y, edges[i].base_y), edges[i].dx_dy));
    }
    keys[i] = x_key(edges[i].x);
}

__global__ void advance_edges(RasterEdge *edges, std::uint32_t first, std::uint32_t n) {
    const auto i = first + blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) edges[i].x = add(edges[i].x, edges[i].dx_dy);
}

__device__ bool make_span(float x0, float x1, std::uint32_t width, bool snap, RasterSpan &s) {
    s.a = fmaxf(fminf(x0, x1), 0.0f);
    s.b = fminf(fmaxf(x0, x1), static_cast<float>(width));
    if (s.b <= s.a) return false;
    const float start = snap ? ceilf(sub(s.a, 0.5f)) : floorf(s.a);
    const float end = snap ? ceilf(sub(s.b, 0.5f)) : ceilf(s.b);
    if (end <= start || end <= 0.0f || start >= static_cast<float>(width)) return false;
    s.start = clamp_row(start, width - 1);
    s.end = clamp_row(sub(end, 1.0f), width - 1);
    return s.end >= s.start;
}

#include "raster_band.cuh"

} // namespace

namespace {
__global__ void raster_bounds(PlaneView plane, std::uint32_t *bounds,
                              std::size_t first, std::size_t count) {
    const auto i = first + blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= count || plane.data[i] == 0) return;
    const auto x = static_cast<std::uint32_t>(i % plane.width) + plane.x0;
    const auto y = static_cast<std::uint32_t>(i / plane.width) + plane.y0;
    atomicMin(bounds, x); atomicMin(bounds + 1, y);
    atomicMax(bounds + 2, x); atomicMax(bounds + 3, y);
    if (plane.data[i] > 127) {
        atomicMin(bounds + 4, x); atomicMin(bounds + 5, y);
        atomicMax(bounds + 6, x); atomicMax(bounds + 7, y);
    }
}
__global__ void model_z_extents(const RasterTriangle *triangles, std::uint32_t *extents,
                              std::uint32_t first, std::uint32_t count) {
    const auto i = first + blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= count) return;
    for (int j = 0; j < 3; ++j) {
        const float z = triangles[i].z[j];
        if (isfinite(z)) { atomicMin(extents, x_key(z)); atomicMax(extents + 1, x_key(z)); }
    }
}

__global__ void model_layer_window(std::uint32_t *extents, DfCudaConfig cfg) {
    const auto low = extents[0], high = extents[1];
    const float minimum = __uint_as_float((low & 0x80000000u) ? low ^ 0x80000000u : ~low);
    const float maximum = __uint_as_float((high & 0x80000000u) ? high ^ 0x80000000u : ~high);
    const float height = fmaxf(cfg.layer_height_mm, 1.1920928955078125e-7f);
    if (low == UINT_MAX || high == 0 || maximum < 0.0f) {
        extents[2] = 0; extents[3] = cfg.total_layers - 1;
    } else {
        extents[2] = clamp_row(floorf(div(minimum, height)), cfg.total_layers - 1);
        extents[3] = clamp_row(ceilf(div(maximum, height)), cfg.total_layers - 1);
    }
}

__global__ void combine_raw_supports(PlaneView output, PlaneView model, PlaneView supports,
                                    std::size_t first, std::size_t count) {
    const auto i = first + blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= count) return;
    const auto x = static_cast<std::uint32_t>(i % output.width) + output.x0;
    const auto y = static_cast<std::uint32_t>(i / output.width) + output.y0;
    output.data[i] = max(pixel(model, x, y), pixel(supports, x, y));
}

__global__ void raw_byte_count(PlaneView plane, std::uint64_t *count,
                               std::size_t first, std::size_t total) {
    const auto i = first + blockIdx.x * blockDim.x + threadIdx.x;
    if (i < total && plane.data[i])
        atomicAdd(reinterpret_cast<unsigned long long *>(count), 1ull);
}

Bounds union_bounds(Bounds a, Bounds b) {
    if (a.x1 < a.x0 || a.y1 < a.y0) return b;
    if (b.x1 < b.x0 || b.y1 < b.y0) return a;
    return {std::min(a.x0, b.x0), std::min(a.y0, b.y0), std::max(a.x1, b.x1), std::max(a.y1, b.y1)};
}


}

Rasterizer::Rasterizer(Runtime &runtime, const DfCudaConfig &config,
                       const float *host_xyz, std::size_t float_count,
                       const std::uint32_t *host_tanks, std::size_t tank_count)
    : runtime_(runtime), config_(config) {
    runtime_.activate();
    if (float_count % 9 != 0 || float_count / 9 > static_cast<std::size_t>(INT_MAX))
        throw Error(DF_CUDA_INVALID_ARGUMENT, "CUDA triangle count exceeds indexed range");
    auto geometry = std::make_shared<RasterGeometry>();
    geometry_ = geometry;
    auto &triangle_count_ = geometry->triangle_count;
    auto &ssaa_factor_ = geometry->ssaa_factor;
    auto &model_first_layer_ = geometry->model_first_layer;
    auto &model_last_layer_ = geometry->model_last_layer;
    auto &triangles_ = geometry->triangles;
    auto &index_ = geometry->index;
    auto &index_blocks_ = geometry->index_blocks;
    triangle_count_ = static_cast<std::uint32_t>(float_count / 9);
    model_last_layer_ = config_.total_layers - 1;
    ssaa_factor_ = config_.raster_mode == DF_CUDA_COVERAGE && config_.dense_raster_semantics == 0
        ? std::max(config_.aa_samples, 1u) : 1;
    if (static_cast<std::uint64_t>(config_.width) * ssaa_factor_ > INT_MAX
        || static_cast<std::uint64_t>(config_.height) * ssaa_factor_ > INT_MAX)
        throw Error(DF_CUDA_OUT_OF_MEMORY, "CUDA supersampled dimensions exceed indexed range");
    const auto steps = config_.aa_samples > 1 && (config_.raster_mode == DF_CUDA_PERTURBATION
        || (config_.raster_mode == DF_CUDA_COVERAGE && config_.dense_raster_semantics == 1)) ? config_.aa_samples : 1;
    const auto events = checked_bytes(triangle_count_, config_.raster_mode == DF_CUDA_PERTURBATION ? steps : 1);
    const auto rows = checked_bytes(checked_bytes(config_.height, ssaa_factor_), steps);
    // Worst candidate set, all active lanes, and one subrow with exact carry.
    // At most 272 bytes/crossing holds both orientation candidates; 256 more
    // reserves CUB scan/segmented-sort temporaries without row allocations.
    // The 60-byte fixed triangle reserve includes keys/keys_out/ids/candidates
    // (16 bytes), row_edges (24 bytes) and previous spans (16 bytes).
    geometry->minimum_workspace_bytes = checked_bytes(events, 100)
        + checked_bytes(triangle_count_, 60) + checked_bytes(rows + steps + 1, 8)
        + checked_bytes(triangle_count_, 528) + sizeof(RasterBandRow) + 2 * sizeof(RasterState)
        + (steps * ssaa_factor_ > 1 ? checked_bytes(config_.width, 2 * sizeof(RasterCarry)) : 0)
        + checked_bytes(std::max(events, checked_bytes(triangle_count_, 2)), 128) + 16 * 1024 * 1024 + 512;
    initialize_scratch();
    if (source_statistics_) {
        const auto raw = geometry->minimum_workspace_bytes;
        geometry->minimum_workspace_bytes = std::max(raw + (raw + 6) / 7,
            checked_bytes(source_statistics_->minimum_workspace_bytes(), 8));
    }
    initialize(runtime_, triangles_, index_, index_blocks_);
    triangles_.resize(triangle_count_);
    if (!triangle_count_) return;
    Buffer<float> upload_xyz;
    Buffer<std::uint32_t> upload_tanks;
    initialize(runtime_, upload_xyz, upload_tanks);
    const auto chunk = static_cast<std::uint32_t>(std::max<std::size_t>(1,
        std::min<std::size_t>(launch_items, runtime_.transfer_bytes() / (9 * sizeof(float)))));
    upload_xyz.resize(static_cast<std::size_t>(chunk) * 9);
    upload_tanks.resize(chunk);
    const bool have_tanks = host_tanks != nullptr && tank_count >= triangle_count_;
    checked(cudaMemsetAsync(counts_.data(), 255, sizeof(std::uint32_t), runtime_.compute), "initialize scene first row");
    checked(cudaMemsetAsync(counts_.data() + 1, 0, sizeof(std::uint32_t), runtime_.compute), "initialize scene last row");
    for (std::uint32_t first = 0; first < triangle_count_; first += chunk) {
        runtime_.check_cancelled();
        const auto n = std::min(chunk, triangle_count_ - first);
        // Reusing the upload scratch is safe even though upload and compute
        // are distinct streams. The original caller ranges are pinned by Runtime.
        checked(cudaStreamSynchronize(runtime_.compute), "join parsed input scratch use");
        runtime_.upload_bytes(upload_xyz.data(), host_xyz + static_cast<std::size_t>(first) * 9,
                              checked_bytes(static_cast<std::size_t>(n) * 9, sizeof(float)));
        if (have_tanks)
            runtime_.upload_bytes(upload_tanks.data(), host_tanks + first, checked_bytes(n, sizeof(std::uint32_t)));
        parse_geometry<<<(n + 255) / 256, 256, 0, runtime_.compute>>>(upload_xyz.data(), upload_tanks.data(),
            triangles_.data(), counts_.data(), config_, first, n, ssaa_factor_, have_tanks);
        launched(runtime_);
        upload_xyz.mark_used(runtime_.compute);
        upload_tanks.mark_used(runtime_.compute);
    }
    std::uint32_t scene[2];
    metadata(runtime_, scene, counts_.data(), 2);
    // All tanks, supports and Z neighbors share this global Y interval.
    // Raw/full-width/cropped planes fit inside it; spatial and legacy work
    // frames expand raw bounds by at most 64 rows, and Z/support unions
    // cannot escape it. Preserve global origins and denominator frames.
    const auto scene_first = scene[0] > 64 ? scene[0] - 64 : 0;
    const auto scene_last = std::min<std::uint64_t>(config_.height, static_cast<std::uint64_t>(scene[1]) + 64);
    geometry->max_plane_bytes = checked_bytes(config_.width, scene_last - scene_first);
    keys_.resize(triangle_count_);
    ids_.resize(triangle_count_);
    keys_out_.resize(triangle_count_);
    index_.resize(triangle_count_);
    for (std::uint32_t first = 0; first < triangle_count_; first += launch_items) {
        const auto n = std::min(launch_items, triangle_count_ - first);
        index_keys<<<(n + 255) / 256, 256, 0, runtime_.compute>>>(triangles_.data(), keys_.data(), ids_.data(), first, triangle_count_);
        launched(runtime_);
    }
    primitive(runtime_, temporary_, [&](void *p, std::size_t &bytes) {
        return cub::DeviceRadixSort::SortPairs(p, bytes, keys_.data(), keys_out_.data(), ids_.data(), index_.data(),
                                             static_cast<int>(triangle_count_), 0, 32, runtime_.compute);
    });
    const auto blocks = (triangle_count_ + index_block_size - 1) / index_block_size;
    index_blocks_.resize(blocks);
    for (std::uint32_t first = 0; first < blocks; first += launch_items) {
        const auto n = std::min(launch_items, blocks - first);
        index_blocks<<<(n + 255) / 256, 256, 0, runtime_.compute>>>(triangles_.data(), index_.data(), index_blocks_.data(), first, triangle_count_);
        launched(runtime_);
    }
    const auto split = config_.model_triangle_count;
    if (split > 0 && split < triangle_count_) {
        counts_.resize(4);
        checked(cudaMemsetAsync(counts_.data(), 255, sizeof(std::uint32_t), runtime_.compute), "initialize model minimum Z");
        checked(cudaMemsetAsync(counts_.data() + 1, 0, sizeof(std::uint32_t), runtime_.compute), "initialize model maximum Z");
        for (std::uint32_t first = 0; first < split; first += launch_items) {
            const auto count = std::min(launch_items, split - first);
            model_z_extents<<<(count + 255) / 256, 256, 0, runtime_.compute>>>(triangles_.data(), counts_.data(), first, split);
            launched(runtime_);
        }
        model_layer_window<<<1, 1, 0, runtime_.compute>>>(counts_.data(), config_);
        launched(runtime_);
        std::uint32_t window[2];
        metadata(runtime_, window, counts_.data() + 2, 2);
        model_first_layer_ = window[0]; model_last_layer_ = window[1];
    }
    checked(cudaStreamSynchronize(runtime_.compute), "publish immutable raster geometry");
}

Rasterizer::Rasterizer(Runtime &runtime, const DfCudaConfig &config, RasterGeometryPtr geometry)
    : runtime_(runtime), config_(config), geometry_(std::move(geometry)) {
    runtime_.activate();
    if (!geometry_) throw Error(DF_CUDA_INVALID_ARGUMENT, "null shared CUDA raster geometry");
    initialize_scratch();
}

void Rasterizer::initialize_scratch() {
    initialize(runtime_, temporary_, keys_, keys_out_, ids_, candidates_, counts_,
        event_keys_, event_keys_out_, events_, events_out_, row_edges_, band_edges_,
        collapsed_, spans_, positive_, negative_, previous_, pairs_, pairs_out_,
        orphans_, orphans_out_, float_keys_, float_keys_out_, open_, endpoints_, endpoints_out_,
        winding_, winding_prefix_, state_, band_rows_, carry_a_, carry_b_, span_flags_, span_prefix_, frontier_, evidence_);
    state_.resize(1); evidence_.resize(4); counts_.resize(2); frontier_.resize(1);
    if (config_.dense_raster_semantics == 1 && config_.raster_mode == DF_CUDA_COVERAGE
        && config_.aa_samples > 1 && config_.compute_area_stats)
        source_statistics_.emplace(runtime_, config_);
}

void Rasterizer::process_band(const RasterBandRow *host_rows, std::uint32_t rows,
                              std::uint32_t maximum, std::uint32_t first_row,
                              std::uint32_t divisor, bool coverage, bool raw_supports,
                              Plane &output, Plane &occupancy, PostBasic *source_basic) {
    BandPointers p{band_rows_.data(), band_edges_.data(), collapsed_.data(), spans_.data(),
        positive_.data(), negative_.data(), previous_.data(), pairs_.data(), pairs_out_.data(),
        orphans_.data(), orphans_out_.data(), open_.data(), endpoints_.data(), endpoints_out_.data(),
        float_keys_.data(), span_flags_.data(), span_prefix_.data(), span_prefix_.data(),
        winding_.data(), winding_prefix_.data(), frontier_.data(), state_.data()};
    const auto width = config_.width * geometry_->ssaa_factor;
    const auto items = host_rows[rows - 1].offset + host_rows[rows - 1].n;
    p.items = items;
    auto index = thrust::make_counting_iterator(std::uint32_t{0});
    const auto begins = cub::TransformInputIterator<std::uint32_t, BandOffset, decltype(index)>(index, BandOffset{band_rows_.data(), rows, items, 1, false});
    const auto ends = cub::TransformInputIterator<std::uint32_t, BandOffset, decltype(index)>(index, BandOffset{band_rows_.data(), rows, items, 1, true});
    const auto endpoint_begins = cub::TransformInputIterator<std::uint32_t, BandOffset, decltype(index)>(index, BandOffset{band_rows_.data(), rows, items, 2, false});
    const auto endpoint_ends = cub::TransformInputIterator<std::uint32_t, BandOffset, decltype(index)>(index, BandOffset{band_rows_.data(), rows, items, 2, true});
    const dim3 crossing_grid(std::max(1u, (maximum + 255) / 256), rows);
    const dim3 candidate_grid(crossing_grid.x, rows, 2);
    const dim3 candidate_walk(rows, 1, 2);
    band_winds<<<crossing_grid, 256, 0, runtime_.compute>>>(p); launched(runtime_);
    if (items) bounded_primitive(runtime_, temporary_, [&](void *scratch, std::size_t &bytes) {
        return cub::DeviceScan::InclusiveScan(scratch, bytes, winding_.data(), winding_prefix_.data(),
            BandSum{}, static_cast<int>(items), runtime_.compute);
    });
    band_naive<<<crossing_grid, 256, 0, runtime_.compute>>>(p, width, !coverage); launched(runtime_);
    if (items) bounded_primitive(runtime_, temporary_, [&](void *scratch, std::size_t &bytes) {
        return cub::DeviceScan::InclusiveScan(scratch, bytes, span_flags_.data(), span_prefix_.data(),
            BandSum{}, static_cast<int>(items), runtime_.compute);
    });
    band_compact<<<crossing_grid, 256, 0, runtime_.compute>>>(p); launched(runtime_);
    checked(cudaMemsetAsync(state_.data(), 0, checked_bytes(rows, sizeof(RasterState)), runtime_.compute), "reset band collapse state");
    for (std::uint32_t i = 0; i < maximum; i += serial_items) {
        band_repair_step<<<rows, 1, 0, runtime_.compute>>>(p, 0, 1, width, !coverage); launched(runtime_);
    }
    band_repair_prepare<<<crossing_grid, 256, 0, runtime_.compute>>>(p, 4, 1); launched(runtime_);
    checked(cudaMemsetAsync(state_.data(), 0, checked_bytes(rows, 2 * sizeof(RasterState)), runtime_.compute), "reset both band pair states");
    band_repair_prepare<<<candidate_grid, 256, 0, runtime_.compute>>>(p, 0, 0); launched(runtime_);
    if (items) bounded_primitive(runtime_, temporary_, [&](void *scratch, std::size_t &bytes) {
        return cub::DeviceScan::InclusiveScan(scratch, bytes,
            thrust::make_reverse_iterator(span_flags_.data() + items * 2),
            thrust::make_reverse_iterator(span_prefix_.data() + items * 2), BandMin{},
            static_cast<int>(items * 2), runtime_.compute);
    });
    for (std::uint32_t i = 0; i < maximum; i += serial_items) {
        band_repair_step<<<candidate_walk, 1, 0, runtime_.compute>>>(p, 1, 0, width, !coverage); launched(runtime_);
    }
    band_repair_prepare<<<candidate_grid, 256, 0, runtime_.compute>>>(p, 1, 0); launched(runtime_);
    if (items) {
        bounded_primitive(runtime_, temporary_, [&](void *scratch, std::size_t &bytes) {
            return cub::DeviceSegmentedRadixSort::SortPairs(scratch, bytes, float_keys_.data(), float_keys_out_.data(),
                orphans_.data(), orphans_out_.data(), static_cast<int>(items * 2), static_cast<int>(rows * 2),
                begins, ends, 0, 32, runtime_.compute);
        });
        bounded_primitive(runtime_, temporary_, [&](void *scratch, std::size_t &bytes) {
            return cub::DeviceSegmentedRadixSort::SortKeys(scratch, bytes, endpoints_.data(), endpoints_out_.data(),
                static_cast<int>(items * 4), static_cast<int>(rows * 2), endpoint_begins, endpoint_ends, 0, 32, runtime_.compute);
        });
    }
    for (std::uint32_t i = 0; i < maximum; i += serial_items) {
        band_repair_step<<<candidate_walk, 1, 0, runtime_.compute>>>(p, 2, 0, width, !coverage); launched(runtime_);
    }
    band_repair_prepare<<<candidate_grid, 256, 0, runtime_.compute>>>(p, 2, 0); launched(runtime_);
    if (items) bounded_primitive(runtime_, temporary_, [&](void *scratch, std::size_t &bytes) {
        return cub::DeviceSegmentedRadixSort::SortPairs(scratch, bytes, float_keys_.data(), float_keys_out_.data(),
            pairs_.data(), pairs_out_.data(), static_cast<int>(items * 2), static_cast<int>(rows * 2),
            begins, ends, 0, 32, runtime_.compute);
    });
    checked(cudaMemsetAsync(state_.data(), 0, checked_bytes(rows, 2 * sizeof(RasterState)), runtime_.compute), "reset both band merge states");
    for (std::uint32_t i = 0; i < maximum; i += serial_items) {
        band_repair_step<<<candidate_walk, 1, 0, runtime_.compute>>>(p, 3, 0, width, !coverage); launched(runtime_);
    }
    band_repair_prepare<<<candidate_grid, 256, 0, runtime_.compute>>>(p, 3, 0); launched(runtime_);
    band_evidence<<<crossing_grid, 256, 0, runtime_.compute>>>(p); launched(runtime_);
    for (std::uint32_t i = 0; i < rows; i += serial_items) {
        band_frontier<<<1, 1, 0, runtime_.compute>>>(p, rows, i); launched(runtime_);
    }
    if (source_basic) {
        band_source<<<crossing_grid, 256, 0, runtime_.compute>>>(p, source_basic, first_row, divisor); launched(runtime_);
    }
    const auto pixels = checked_bytes(output.width, (first_row % divisor + rows + divisor - 1) / divisor);
    const auto steps = divisor / geometry_->ssaa_factor;
    for (std::size_t first = 0; first < pixels; first += launch_items) {
        const auto count = std::min<std::size_t>(launch_items, pixels - first);
        band_pixels<<<(count + 255) / 256, 256, 0, runtime_.compute>>>(p, output.view(), occupancy.view(), rows,
            first_row, divisor, steps, geometry_->ssaa_factor, coverage, raw_supports,
            carry_a_.data(), carry_b_.data(), first, pixels);
        launched(runtime_);
    }
    std::swap(carry_a_, carry_b_);
    band_save_frontier<<<std::max(1u, (maximum + 255) / 256), 256, 0, runtime_.compute>>>(p, rows); launched(runtime_);
}

bool Rasterizer::applies_model_aa(std::uint32_t layer) const {
    if (config_.model_triangle_count == 0 || config_.model_triangle_count >= geometry_->triangle_count) return true;
    return layer >= geometry_->model_first_layer && layer <= geometry_->model_last_layer;
}


Plane Rasterizer::render(std::uint32_t layer, std::uint32_t tank, RasterSelection selection) {
    runtime_.activate();
    runtime_.check_cancelled();
    if (layer >= config_.total_layers || tank >= config_.tank_count)
        throw Error(DF_CUDA_INVALID_ARGUMENT, "CUDA raster layer or tank is out of range");
    const auto triangle_count_ = geometry_->triangle_count;
    const auto ssaa_factor_ = geometry_->ssaa_factor;
    const auto &triangles_ = geometry_->triangles;
    const auto &index_ = geometry_->index;
    const auto &index_blocks_ = geometry_->index_blocks;
    if (!triangle_count_) return {};
    const auto split = config_.model_triangle_count > 0 && config_.model_triangle_count < triangle_count_
        ? config_.model_triangle_count : 0;
    if (selection == RasterSelection::BinarySupports && tank == 0 && cached_supports_
        && cached_support_layer_ == layer) {
        Plane result = std::move(*cached_supports_);
        cached_supports_.reset();
        return result;
    }
    cached_supports_.reset();
    const bool bypass = config_.dense_raster_semantics == 1 && split && !config_.aa_on_supports
        && (config_.raster_mode == DF_CUDA_BLUR
            || ((config_.raster_mode == DF_CUDA_COVERAGE || config_.raster_mode == DF_CUDA_PERTURBATION) && config_.aa_samples > 1));
    if (selection == RasterSelection::AllForTank && bypass) {
        Plane model = render(layer, tank, RasterSelection::ModelForTank);
        if (tank != 0) return model;
        Plane supports = render(layer, tank, RasterSelection::BinarySupports);
        cached_support_layer_ = layer;
        if (supports.empty()) {
            cached_supports_.emplace(std::move(supports));
            return model;
        }
        const auto bounds = union_bounds(model.nonzero_bounds, supports.nonzero_bounds);
        Plane combined(runtime_, static_cast<std::uint32_t>(bounds.x0), static_cast<std::uint32_t>(bounds.y0),
                       static_cast<std::uint32_t>(bounds.x1 - bounds.x0 + 1), static_cast<std::uint32_t>(bounds.y1 - bounds.y0 + 1));
        for (std::size_t first = 0; first < combined.bytes(); first += launch_items) {
            const auto count = std::min<std::size_t>(launch_items, combined.bytes() - first);
            combine_raw_supports<<<(count + 255) / 256, 256, 0, runtime_.compute>>>(combined.view(), model.view(), supports.view(), first, combined.bytes());
            launched(runtime_);
        }
        combined.nonzero_bounds = bounds;
        combined.topology_bounds = union_bounds(model.topology_bounds, supports.topology_bounds);
        combined.bounds_valid = true;
        if (config_.raster_mode == DF_CUDA_PERTURBATION) {
            checked(cudaMemsetAsync(evidence_.data(), 0, sizeof(std::uint64_t), runtime_.compute), "clear combined raw source count");
            for (std::size_t first = 0; first < combined.bytes(); first += launch_items) {
                const auto count = std::min<std::size_t>(launch_items, combined.bytes() - first);
                raw_byte_count<<<(count + 255) / 256, 256, 0, runtime_.compute>>>(combined.view(), evidence_.data(), first, combined.bytes());
                launched(runtime_);
            }
            const auto count = std::min(metadata(runtime_, evidence_.data()), static_cast<std::uint64_t>(UINT_MAX));
            const double pixel_area = (static_cast<double>(config_.build_width_mm) / config_.width)
                * (static_cast<double>(config_.build_depth_mm) / config_.height);
            combined.raster_area_stats = empty_stats();
            combined.raster_area_stats.total_solid_pixels = count;
            combined.raster_area_stats.total_solid_area_mm2 = count * pixel_area;
            combined.raster_area_stats.largest_area_mm2 = count * pixel_area;
            combined.raster_area_stats.smallest_area_mm2 = count * pixel_area;
            combined.raster_area_stats.area_count = count ? 1 : 0;
            combined.raster_area_stats.min_x = bounds.x0; combined.raster_area_stats.min_y = bounds.y0;
            combined.raster_area_stats.max_x = bounds.x1; combined.raster_area_stats.max_y = bounds.y1;
        }
        cached_supports_.emplace(std::move(supports));
        return combined;
    }
    keys_.resize(triangle_count_);
    keys_out_.resize(triangle_count_);
    candidates_.resize(triangle_count_);
    ids_.resize(triangle_count_);
    counts_.resize(2);
    for (std::uint32_t first = 0; first < triangle_count_; first += launch_items) {
        const auto count = std::min(launch_items, triangle_count_ - first);
        candidate_flags<<<(count + 255) / 256, 256, 0, runtime_.compute>>>(triangles_.data(), index_.data(),
            index_blocks_.data(), keys_.data(), first, triangle_count_, layer, tank, split, static_cast<int>(selection));
        launched(runtime_);
    }
    primitive(runtime_, temporary_, [&](void *p, std::size_t &bytes) {
        return cub::DeviceSelect::Flagged(p, bytes, index_.data(), keys_.data(), candidates_.data(), counts_.data(),
                                         static_cast<int>(triangle_count_), runtime_.compute);
    });
    const auto candidate_count = metadata(runtime_, counts_.data());
    if (!candidate_count) return {};
    primitive(runtime_, temporary_, [&](void *p, std::size_t &bytes) {
        return cub::DeviceRadixSort::SortKeys(p, bytes, candidates_.data(), ids_.data(), static_cast<int>(candidate_count),
                                            0, 32, runtime_.compute);
    });
    const bool raw_supports = selection == RasterSelection::BinarySupports;
    const bool perturb = !raw_supports && config_.raster_mode == DF_CUDA_PERTURBATION && config_.aa_samples > 1;
    const bool analytic = !raw_supports && config_.dense_raster_semantics == 1 && config_.raster_mode == DF_CUDA_COVERAGE && config_.aa_samples > 1;
    const bool coverage = perturb || analytic;
    const auto steps = coverage ? std::max(config_.aa_samples, 1u) : 1;
    const auto factor = ssaa_factor_;
    const auto height = config_.height * factor;
    const auto row_count64 = static_cast<std::uint64_t>(height) * steps;
    const auto event_count64 = static_cast<std::uint64_t>(candidate_count) * (perturb ? steps : 1);
    if (row_count64 > INT_MAX || event_count64 > INT_MAX)
        throw Error(DF_CUDA_OUT_OF_MEMORY, "CUDA scanline index exceeds primitive range");
    const auto row_count = static_cast<std::uint32_t>(row_count64);
    const auto event_capacity = static_cast<std::uint32_t>(event_count64);
    events_.resize(event_capacity);
    events_out_.resize(event_capacity);
    event_keys_.resize(event_capacity);
    event_keys_out_.resize(event_capacity);
    counts_.resize(static_cast<std::size_t>(row_count) * 2 + steps + 1);
    checked(cudaMemsetAsync(counts_.data(), 0, counts_.bytes(), runtime_.compute), "clear scanline event counts");
    for (std::uint32_t first = 0; first < event_capacity; first += launch_items) {
        const auto count = std::min(launch_items, event_capacity - first);
        make_events<<<(count + 255) / 256, 256, 0, runtime_.compute>>>(triangles_.data(), ids_.data(), events_.data(),
            event_keys_.data(), counts_.data(), config_, layer, height, steps, candidate_count, first, event_capacity, perturb, analytic);
        launched(runtime_);
    }
    const auto event_count = metadata(runtime_, counts_.data() + static_cast<std::size_t>(row_count) * 2 + steps);
    if (!event_count) return {};
    primitive(runtime_, temporary_, [&](void *p, std::size_t &bytes) {
        return cub::DeviceRadixSort::SortPairs(p, bytes, event_keys_.data(), event_keys_out_.data(),
            events_.data(), events_out_.data(), static_cast<int>(event_capacity), 0, 64, runtime_.compute);
    });
    std::vector<std::uint32_t> control(static_cast<std::size_t>(row_count) * 2 + steps);
    metadata(runtime_, control.data(), counts_.data(), control.size());
    std::uint32_t first_row = 0, last_row = 0;
    while (first_row < row_count && control[first_row] == 0) ++first_row;
    // End events are metadata, not a row to render. Terminal phase end
    // events may lie beyond the final interleaved sub-row.
    for (std::uint32_t end = 0; end < row_count + steps; ++end)
        if (control[row_count + end]) last_row = std::max(last_row, std::min(end, row_count));
    if (first_row >= last_row) return {};
    const auto divisor = steps * factor;
    const auto y0 = first_row / divisor;
    const auto y1 = (last_row + divisor - 1) / divisor;
    Plane output(runtime_, 0, y0, config_.width, y1 - y0);
    checked(cudaMemsetAsync(output.pixels.data(), 0, output.bytes(), runtime_.compute), "clear cropped raster output");
    const auto maximum_steps = config_.aa_samples > 1 && (config_.raster_mode == DF_CUDA_PERTURBATION
        || (config_.raster_mode == DF_CUDA_COVERAGE && config_.dense_raster_semantics == 1)) ? config_.aa_samples : 1;
    const auto maximum_divisor = maximum_steps * factor;
    const auto maximum_events = checked_bytes(triangle_count_, config_.raster_mode == DF_CUDA_PERTURBATION ? maximum_steps : 1);
    const auto maximum_rows = checked_bytes(height, maximum_steps);
    const auto primitive_bytes = checked_bytes(std::max(maximum_events, checked_bytes(triangle_count_, 2)), 128) + 16 * 1024 * 1024;
    const auto fixed_bytes = checked_bytes(maximum_events, 100) + checked_bytes(triangle_count_, 60)
        + checked_bytes(maximum_rows + maximum_steps + 1, 8) + primitive_bytes
        + (maximum_divisor > 1 ? checked_bytes(config_.width, 2 * sizeof(RasterCarry)) : 0) + 512;
    const auto budget = runtime_.workspace_budget();
    if (budget < minimum_workspace_bytes())
        throw Error(DF_CUDA_OUT_OF_MEMORY, "CUDA raster worker budget cannot hold one subrow and its frontier");
    const bool statistics_helper = source_statistics_.has_value();
    const auto raster_budget = budget - (statistics_helper ? budget / 8 : 0);
    const auto remaining = raster_budget - fixed_bytes;
    const auto row_bytes = sizeof(RasterBandRow) + 2 * sizeof(RasterState);
    const auto pin_rows = runtime_.transfer_bytes() / sizeof(RasterBandRow);
    const auto row_capacity64 = std::min<std::size_t>(65535, std::min(pin_rows,
        std::min(maximum_rows, remaining / (checked_bytes(triangle_count_, 528) + row_bytes))));
    const auto row_capacity = static_cast<std::uint32_t>(row_capacity64);
    const auto item_capacity = std::min(checked_bytes(triangle_count_, row_capacity),
        std::min<std::size_t>(INT_MAX / 4, (remaining - checked_bytes(row_capacity, row_bytes)) / 528));
    temporary_.resize(primitive_bytes + checked_bytes(item_capacity, 256));
    row_edges_.resize(triangle_count_); previous_.resize(triangle_count_);
    band_edges_.resize(item_capacity); collapsed_.resize(item_capacity);
    spans_.resize(item_capacity); positive_.resize(item_capacity); negative_.resize(item_capacity);
    pairs_.resize(checked_bytes(item_capacity, 2)); pairs_out_.resize(checked_bytes(item_capacity, 2));
    orphans_.resize(checked_bytes(item_capacity, 2)); orphans_out_.resize(checked_bytes(item_capacity, 2));
    float_keys_.resize(checked_bytes(item_capacity, 2)); float_keys_out_.resize(checked_bytes(item_capacity, 2)); open_.resize(checked_bytes(item_capacity, 2));
    endpoints_.resize(checked_bytes(item_capacity, 4)); endpoints_out_.resize(checked_bytes(item_capacity, 4));
    winding_.resize(item_capacity); winding_prefix_.resize(item_capacity);
    span_flags_.resize(checked_bytes(item_capacity, 2)); span_prefix_.resize(checked_bytes(item_capacity, 2));
    band_rows_.resize(row_capacity); state_.resize(checked_bytes(row_capacity, 2));
    carry_a_.resize(maximum_divisor > 1 ? config_.width : 0);
    carry_b_.resize(maximum_divisor > 1 ? config_.width : 0);
    checked(cudaMemsetAsync(frontier_.data(), 0, sizeof(std::uint32_t), runtime_.compute), "reset layer orientation frontier");
    const auto lane_count = perturb ? steps : 1;
    if (active_.size() < lane_count) active_.resize(lane_count);
    std::vector<std::uint32_t> active_count(lane_count, 0);
    for (std::uint32_t lane = 0; lane < lane_count; ++lane) {
        active_[lane].initialize(runtime_.memory, runtime_.compute);
        active_[lane].resize(triangle_count_);
    }
    const bool source_stats = analytic || (config_.dense_raster_semantics == 1 && config_.raster_mode == DF_CUDA_PERTURBATION);
    Buffer<PostBasic> source_basic;
    source_basic.initialize(runtime_.memory, runtime_.compute);
    Plane occupancy;
    if (source_stats) {
        source_basic.resize(1);
        checked(cudaMemsetAsync(source_basic.data(), 0, sizeof(PostBasic), runtime_.compute), "clear source raster statistics");
        checked(cudaMemsetAsync(&source_basic.data()->min_x, 255, 2 * sizeof(std::uint32_t), runtime_.compute), "initialize source raster bounds");
        if (analytic && config_.compute_area_stats) {
            occupancy = Plane(runtime_, output.x0, output.y0, output.width, output.height);
            checked(cudaMemsetAsync(occupancy.pixels.data(), 0, occupancy.bytes(), runtime_.compute), "clear source occupancy plane");
        }
    }
    // Counts are read once per layer. All row cardinalities and event offsets
    // are then known without reading healthy or defective row state back.
    std::vector<RasterBandRow> descriptors((y1 - y0) * divisor);
    for (std::uint32_t y = y0 * divisor; y < y1 * divisor; ++y) {
        const auto lane = perturb ? y % steps : 0;
        if (y < row_count) {
            active_count[lane] -= control[row_count + y];
            active_count[lane] += control[y];
        } else active_count[lane] = 0;
        descriptors[y - y0 * divisor].n = active_count[lane];
    }
    struct Band { std::uint32_t begin, rows, maximum; };
    std::vector<Band> bands;
    for (std::uint32_t begin = 0; begin < descriptors.size();) {
        std::uint32_t rows = 0, maximum = 0;
        std::size_t items = 0;
        while (begin + rows < descriptors.size() && rows < row_capacity) {
            auto &r = descriptors[begin + rows];
            if (items + r.n > item_capacity) break;
            r.offset = static_cast<std::uint32_t>(items);
            items += r.n; maximum = std::max(maximum, r.n);
            ++rows;
        }
        if (!rows) throw Error(DF_CUDA_OUT_OF_MEMORY, "CUDA raster row exceeds worker crossing workspace");
        bands.push_back({begin, rows, maximum}); begin += rows;
    }
    // Register only each band's original vector range, not the full layer.
    // One reusable event ends its DMA lease before that band's GPU work;
    // no host descriptor staging copy or healthy-row completion wait.
    RasterControlEvent descriptor_copy;
    std::fill(active_count.begin(), active_count.end(), 0);
    std::uint32_t event_offset = 0;
    for (const auto band : bands) {
        const auto band_first = y0 * divisor + band.begin;
        RasterControlPin descriptor_pin(runtime_, descriptors.data() + band.begin,
                                        checked_bytes(band.rows, sizeof(RasterBandRow)));
        checked(cudaMemcpyAsync(band_rows_.data(), descriptors.data() + band.begin,
            checked_bytes(band.rows, sizeof(RasterBandRow)), cudaMemcpyHostToDevice, runtime_.compute), "upload raster band descriptors");
        checked(cudaEventRecord(descriptor_copy.completion, runtime_.compute), "record raster descriptor copy");
        for (std::uint32_t row = 0; row < band.rows; ++row) {
            runtime_.check_cancelled();
            const auto y = band_first + row;
            if (y >= row_count) continue;
            const auto lane = perturb ? y % steps : 0;
            const auto old_count = active_count[lane];
            const auto retained = old_count - control[row_count + y];
            if (old_count) {
                bounded_primitive(runtime_, temporary_, [&](void *p, std::size_t &bytes) {
                    return cub::DeviceSelect::If(p, bytes, active_[lane].data(), row_edges_.data(), counts_.data(),
                        static_cast<int>(old_count), Alive{y}, runtime_.compute);
                });
            }
            const auto starting = control[y];
            for (std::uint32_t first = 0; first < starting; first += launch_items) {
                const auto count = std::min(launch_items, starting - first);
                append_events<<<(count + 255) / 256, 256, 0, runtime_.compute>>>(row_edges_.data(), events_out_.data() + event_offset,
                    retained, first, starting); launched(runtime_);
            }
            event_offset += starting;
            const auto n = retained + starting;
            active_count[lane] = n;
            for (std::uint32_t first = 0; first < n; first += launch_items) {
                const auto count = std::min(launch_items, n - first);
                row_keys<<<(count + 255) / 256, 256, 0, runtime_.compute>>>(row_edges_.data(), keys_.data(), first, n, y, steps, perturb);
                launched(runtime_);
            }
            if (n) {
                bounded_primitive(runtime_, temporary_, [&](void *p, std::size_t &bytes) {
                    return cub::DeviceRadixSort::SortPairs(p, bytes, keys_.data(), keys_out_.data(), row_edges_.data(),
                        active_[lane].data(), static_cast<int>(n), 0, 32, runtime_.compute);
                });
                checked(cudaMemcpyAsync(band_edges_.data() + descriptors[band.begin + row].offset, active_[lane].data(),
                    checked_bytes(n, sizeof(RasterEdge)), cudaMemcpyDeviceToDevice, runtime_.compute), "retain sorted band crossings");
                if (!perturb) {
                    for (std::uint32_t first = 0; first < n; first += launch_items) {
                        const auto count = std::min(launch_items, n - first);
                        advance_edges<<<(count + 255) / 256, 256, 0, runtime_.compute>>>(active_[lane].data(), first, n); launched(runtime_);
                    }
                }
            }
        }
        process_band(descriptors.data() + band.begin, band.rows, band.maximum, band_first,
            divisor, coverage, raw_supports, output, occupancy, source_basic.data());
        checked(cudaEventSynchronize(descriptor_copy.completion), "finish raster descriptor DMA");
        descriptor_pin.joined();
    }
    if (source_stats) {
        const auto basic = metadata(runtime_, source_basic.data());
        output.raster_area_stats = empty_stats();
        output.raster_stats_valid = analytic;
        const auto count = basic.pixels / steps;
        if (count) {
            const double pixel_area = (static_cast<double>(config_.build_width_mm) / config_.width)
                * (static_cast<double>(config_.build_depth_mm) / config_.height);
            if (analytic && config_.compute_area_stats) output.raster_area_stats = source_statistics_->statistics(occupancy);
            else {
                output.raster_area_stats.total_solid_pixels = count;
                output.raster_area_stats.total_solid_area_mm2 = count * pixel_area;
                output.raster_area_stats.largest_area_mm2 = count * pixel_area;
                output.raster_area_stats.smallest_area_mm2 = count * pixel_area;
                output.raster_area_stats.area_count = 1;
            }
            output.raster_area_stats.min_x = static_cast<std::int32_t>(basic.min_x);
            output.raster_area_stats.min_y = static_cast<std::int32_t>(basic.min_y);
            output.raster_area_stats.max_x = static_cast<std::int32_t>(basic.max_x);
            output.raster_area_stats.max_y = static_cast<std::int32_t>(basic.max_y);
        }
    }
    counts_.resize(8);
    checked(cudaMemsetAsync(counts_.data(), 255, 2 * sizeof(std::uint32_t), runtime_.compute), "initialize raster minimum bounds");
    checked(cudaMemsetAsync(counts_.data() + 2, 0, 2 * sizeof(std::uint32_t), runtime_.compute), "initialize raster maximum bounds");
    checked(cudaMemsetAsync(counts_.data() + 4, 255, 2 * sizeof(std::uint32_t), runtime_.compute), "initialize topology minimum bounds");
    checked(cudaMemsetAsync(counts_.data() + 6, 0, 2 * sizeof(std::uint32_t), runtime_.compute), "initialize topology maximum bounds");
    for (std::size_t first = 0; first < output.bytes(); first += launch_items) {
        const auto count = std::min<std::size_t>(launch_items, output.bytes() - first);
        raster_bounds<<<(count + 255) / 256, 256, 0, runtime_.compute>>>(output.view(), counts_.data(), first, output.bytes());
        launched(runtime_);
    }
    std::uint32_t bounds[8];
    metadata(runtime_, bounds, counts_.data(), 8);
    output.bounds_valid = true;
    if (bounds[0] != UINT_MAX) output.nonzero_bounds = {static_cast<std::int32_t>(bounds[0]), static_cast<std::int32_t>(bounds[1]),
                                                     static_cast<std::int32_t>(bounds[2]), static_cast<std::int32_t>(bounds[3])};
    if (bounds[4] != UINT_MAX) output.topology_bounds = {static_cast<std::int32_t>(bounds[4]), static_cast<std::int32_t>(bounds[5]),
                                                      static_cast<std::int32_t>(bounds[6]), static_cast<std::int32_t>(bounds[7])};
    if (bounds[0] == UINT_MAX) {
        output.pixels.clear(); output.x0 = output.y0 = output.width = output.height = 0;
        return output;
    }
    if (bounds[0] == output.x0 && bounds[1] == output.y0
        && bounds[2] + 1 == output.x0 + output.width && bounds[3] + 1 == output.y0 + output.height) return output;
    Plane cropped(runtime_, bounds[0], bounds[1], bounds[2] - bounds[0] + 1, bounds[3] - bounds[1] + 1);
    const auto offset = static_cast<std::size_t>(bounds[1] - output.y0) * output.width + bounds[0] - output.x0;
    checked(cudaMemcpy2DAsync(cropped.pixels.data(), cropped.width, output.pixels.data() + offset, output.width,
                             cropped.width, cropped.height, cudaMemcpyDeviceToDevice, runtime_.compute), "crop raster device plane");
    cropped.raster_area_stats = output.raster_area_stats;
    cropped.raster_stats_valid = output.raster_stats_valid;
    cropped.nonzero_bounds = output.nonzero_bounds;
    cropped.topology_bounds = output.topology_bounds;
    cropped.bounds_valid = true;
    cropped.work_frame = output.work_frame;
    return cropped;
}

} // namespace dfcuda
