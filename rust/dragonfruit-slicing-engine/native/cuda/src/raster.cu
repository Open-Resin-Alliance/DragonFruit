#include "raster.h"
#include <cub/cub.cuh>
#include <thrust/iterator/reverse_iterator.h>
#include <cmath>
#include <climits>

namespace dfcuda {
namespace {

constexpr std::uint32_t launch_items = 16384;
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

__global__ void parse_geometry(const float *raw, const std::uint32_t *tanks,
                               RasterTriangle *triangles, DfCudaConfig cfg,
                               std::uint32_t first, std::uint32_t count,
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

// These stateful walks deliberately stay on the device. A launch visits at
// most 4096 crossings; row history is never approximated or reset at a batch.
__global__ void naive_spans(const RasterEdge *edges, std::uint32_t n, RasterSpan *spans,
                            RasterState *state, std::uint32_t limit, std::uint32_t width, bool snap) {
    auto s = *state;
    const auto end = min(n, s.cursor + limit);
    for (; s.cursor < end; ++s.cursor) {
        const auto e = edges[s.cursor];
        if (!isfinite(e.x)) { s.cursor = n; break; }
        s.winding += e.wind;
        s.minimum_winding = min(s.minimum_winding, s.winding);
        s.maximum_winding = max(s.maximum_winding, s.winding);
        if (s.cursor + 1 < n && s.winding != 0 && isfinite(edges[s.cursor + 1].x)) {
            RasterSpan span;
            if (make_span(e.x, edges[s.cursor + 1].x, width, snap, span)) spans[s.count++] = span;
        }
    }
    *state = s;
}

__global__ void collapse_edges(const RasterEdge *edges, std::uint32_t n, RasterEdge *output,
                               RasterState *state, std::uint32_t limit) {
    auto s = *state;
    const auto end = min(n, s.cursor + limit);
    for (; s.cursor < end; ++s.cursor) {
        const auto e = edges[s.cursor];
        const bool cancel = s.count && isfinite(e.x) && isfinite(output[s.count - 1].x)
            && output[s.count - 1].wind + e.wind == 0 && sub(e.x, output[s.count - 1].x) < 1.0f;
        if (cancel) --s.count;
        else output[s.count++] = e;
    }
    *state = s;
}

__global__ void exit_indices(const RasterEdge *edges, std::uint32_t *indices,
                             std::uint32_t first, std::uint32_t n, std::int32_t orientation) {
    const auto i = first + blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) indices[i] = isfinite(edges[i].x) && edges[i].wind * orientation < 0 ? i : UINT_MAX;
}

__global__ void match_pairs(const RasterEdge *edges, const std::uint32_t *next_exit,
                            std::uint32_t n, float *open, RasterPair *pairs,
                            RasterOrphan *orphans, RasterState *state,
                            std::uint32_t limit, std::int32_t orientation) {
    auto s = *state;
    const auto end = min(n, s.cursor + limit);
    while (s.cursor < end) {
        const auto e = edges[s.cursor];
        if (!isfinite(e.x)) { s.cursor = n; break; }
        int w = e.wind * orientation;
        if (w == -1 && s.open_count == 0 && s.cursor + 2 < n) {
            const auto entry = edges[s.cursor + 1];
            const auto exit = next_exit[s.cursor + 2];
            if (isfinite(entry.x) && entry.wind * orientation == 1 && entry.x > e.x
                && exit < n && sub(entry.x, e.x) < sub(edges[exit].x, entry.x)) {
                s.cursor += 2;
                continue;
            }
        }
        while (w > 0) { open[s.open_count++] = e.x; --w; }
        while (w < 0) {
            ++w;
            if (s.open_count) {
                const float x = open[--s.open_count];
                if (e.x > x) pairs[s.pair_count++] = {x, e.x};
            } else orphans[s.orphan_count++] = {e.x, -1};
        }
        ++s.cursor;
    }
    *state = s;
}

__global__ void finish_orphans(const float *open, RasterOrphan *orphans, RasterState *state,
                               std::uint32_t first, std::uint32_t n, std::uint32_t offset) {
    const auto i = first + blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) orphans[offset + i] = {open[i], 1};
    if (i == 0) state->orphan_count = offset + n;
}

__global__ void orphan_keys(const RasterOrphan *orphans, float *keys,
                            std::uint32_t first, std::uint32_t n) {
    const auto i = first + blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) keys[i] = orphans[i].x;
}

__global__ void pair_endpoints(const RasterPair *pairs, float *endpoints,
                               std::uint32_t first, std::uint32_t n) {
    const auto i = first + blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) { endpoints[i * 2] = pairs[i].a; endpoints[i * 2 + 1] = pairs[i].b; }
}

__global__ void append_orphan_pairs(const RasterOrphan *orphans, std::uint32_t n,
                                   const float *endpoints, std::uint32_t endpoint_count,
                                   RasterPair *pairs, RasterState *state, std::uint32_t limit) {
    auto s = *state;
    const auto end = min(n / 2, s.cursor + limit);
    for (; s.cursor < end; ++s.cursor) {
        const auto a = orphans[s.cursor * 2], b = orphans[s.cursor * 2 + 1];
        std::uint32_t lo = 0, hi = endpoint_count;
        while (lo < hi) {
            const auto mid = lo + (hi - lo) / 2;
            if (endpoints[mid] <= a.x) lo = mid + 1; else hi = mid;
        }
        const bool crosses = lo < endpoint_count && endpoints[lo] < b.x;
        if (!(a.wind < 0 && b.wind > 0) && !crosses && b.x > a.x)
            pairs[s.pair_count++] = {a.x, b.x};
    }
    *state = s;
}

__global__ void pair_keys(const RasterPair *pairs, float *keys,
                          std::uint32_t first, std::uint32_t n) {
    const auto i = first + blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) keys[i] = pairs[i].a;
}

__global__ void merge_pairs(const RasterPair *pairs, std::uint32_t n, RasterSpan *output,
                            RasterState *state, std::uint32_t limit, std::uint32_t width, bool snap) {
    auto s = *state;
    const auto end = min(n, s.cursor + limit);
    for (; s.cursor < end; ++s.cursor) {
        const auto p = pairs[s.cursor];
        if (!s.merge_live) { s.merge_a = p.a; s.merge_b = p.b; s.merge_live = 1; }
        else if (p.a <= s.merge_b) s.merge_b = fmaxf(s.merge_b, p.b);
        else {
            RasterSpan span;
            if (make_span(s.merge_a, s.merge_b, width, snap, span)) output[s.count++] = span;
            s.merge_a = p.a; s.merge_b = p.b;
        }
    }
    if (s.cursor == n && s.merge_live) {
        RasterSpan span;
        if (make_span(s.merge_a, s.merge_b, width, snap, span)) output[s.count++] = span;
        s.merge_live = 0;
    }
    *state = s;
}

__global__ void span_evidence(const RasterSpan *a, std::uint32_t n, const RasterSpan *previous,
                              std::uint32_t prev_n, std::uint64_t *result, std::uint32_t first) {
    const auto i = first + blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) return;
    const auto s = a[i];
    std::uint64_t overlap = 0;
    std::uint32_t lo = 0, hi = prev_n;
    while (lo < hi) {
        const auto mid = lo + (hi - lo) / 2;
        if (previous[mid].end < s.start) lo = mid + 1; else hi = mid;
    }
    for (auto j = lo; j < prev_n && previous[j].start <= s.end; ++j) {
        const auto left = max(s.start, previous[j].start), right = min(s.end, previous[j].end);
        if (right >= left) overlap += static_cast<std::uint64_t>(right) - left + 1;
    }
    atomicAdd(reinterpret_cast<unsigned long long *>(result), static_cast<unsigned long long>(overlap));
    atomicAdd(reinterpret_cast<unsigned long long *>(result + 1),
              static_cast<unsigned long long>(s.end) - s.start + 1);
}

__global__ void accumulate_spans(const RasterSpan *spans, std::uint32_t n, float *accum,
                                 std::int32_t *delta, std::uint32_t *lit,
                                 RasterState *state, std::uint32_t limit,
                                 std::uint32_t width, std::uint32_t factor, bool coverage) {
    auto s = *state;
    const auto end = min(n, s.cursor + limit);
    for (; s.cursor < end; ++s.cursor) {
        const auto span = spans[s.cursor];
        if (coverage) {
            const auto left = static_cast<std::uint32_t>(floorf(span.a));
            const auto right = static_cast<std::uint32_t>(ceilf(span.b)) - 1;
            if (left == right) accum[left] = add(accum[left], mul(clampf(sub(span.b, span.a), 0.0f, 1.0f), 255.0f));
            else {
                accum[left] = add(accum[left], mul(clampf(sub(add(static_cast<float>(left), 1.0f), span.a), 0.0f, 1.0f), 255.0f));
                if (right > left + 1) { delta[left + 1] += 255; delta[right] -= 255; }
                accum[right] = add(accum[right], mul(clampf(sub(span.b, static_cast<float>(right)), 0.0f, 1.0f), 255.0f));
            }
        } else {
            // Binary spans partition half-open center intervals. Clipping the
            // running cursor also guarantees their union under repeated walls.
            const auto begin = max(span.start, s.open_count);
            const auto finish = span.end + 1;
            if (begin >= finish) continue;
            s.open_count = finish;
            const auto left = begin / factor, right = (finish - 1) / factor;
            if (left == right) lit[left] += finish - begin;
            else {
                lit[left] += (left + 1) * factor - begin;
                lit[right] += finish - right * factor;
                if (right > left + 1) { delta[left + 1] += factor; delta[right] -= factor; }
            }
        }
    }
    *state = s;
}

__global__ void resolve_row(PlaneView plane, std::uint32_t global_y, float *accum,
                            std::int32_t *delta, const std::int32_t *prefix,
                            std::uint32_t *lit, std::uint32_t first,
                            std::uint32_t steps, std::uint32_t factor,
                            bool coverage, bool raw_supports) {
    const auto x = first + blockIdx.x * blockDim.x + threadIdx.x;
    if (x >= plane.width) return;
    std::uint32_t value;
    if (coverage) {
        const float total = prefix[x] > 0 ? add(accum[x], static_cast<float>(prefix[x])) : accum[x];
        value = total <= 0.0f ? 0 : static_cast<std::uint32_t>(clampf(roundf(div(total, static_cast<float>(steps))), 0.0f, 255.0f));
        accum[x] = 0.0f;
    } else {
        const auto count = static_cast<std::uint64_t>(lit[x]) + max(prefix[x], 0);
        const auto maximum = factor * factor;
        value = static_cast<std::uint32_t>(min((count * 255 + maximum / 2) / maximum, static_cast<std::uint64_t>(255)));
        if (raw_supports && value < 255) value = 0;
        lit[x] = 0;
    }
    delta[x] = 0;
    plane.data[static_cast<std::size_t>(global_y - plane.y0) * plane.width + x] = static_cast<std::uint8_t>(value);
}

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


__global__ void record_source_spans(const RasterSpan *spans, std::uint32_t n, PostBasic *basic,
                                   std::int32_t *hit_delta, RasterState *state,
                                   std::uint32_t y, std::uint32_t limit) {
    auto s = *state;
    auto b = *basic;
    const auto end = min(n, s.cursor + limit);
    for (; s.cursor < end; ++s.cursor) {
        const auto span = spans[s.cursor];
        b.pixels = min(b.pixels + static_cast<unsigned long long>(span.end) - span.start + 1,
                       static_cast<unsigned long long>(UINT_MAX));
        b.min_x = min(b.min_x, span.start); b.max_x = max(b.max_x, span.end);
        b.min_y = min(b.min_y, y); b.max_y = max(b.max_y, y);
        if (hit_delta) { ++hit_delta[span.start]; --hit_delta[span.end + 1]; }
    }
    *basic = b;
    *state = s;
}

__global__ void resolve_source_hits(PlaneView occupancy, std::uint32_t y,
                                   std::int32_t *delta, const std::int32_t *prefix,
                                   std::uint32_t first) {
    const auto x = first + blockIdx.x * blockDim.x + threadIdx.x;
    if (x >= occupancy.width) return;
    occupancy.data[static_cast<std::size_t>(y - occupancy.y0) * occupancy.width + x] = prefix[x] > 0 ? 255 : 0;
    delta[x] = 0;
}
}

Rasterizer::Rasterizer(Runtime &runtime, const DfCudaConfig &config,
                       const float *host_xyz, std::size_t float_count,
                       const std::uint32_t *host_tanks, std::size_t tank_count)
    : runtime_(runtime), config_(config) {
    runtime_.activate();
    if (float_count % 9 != 0 || float_count / 9 > static_cast<std::size_t>(INT_MAX))
        throw Error(DF_CUDA_INVALID_ARGUMENT, "CUDA triangle count exceeds indexed range");
    triangle_count_ = static_cast<std::uint32_t>(float_count / 9);
    model_last_layer_ = config_.total_layers - 1;
    ssaa_factor_ = config_.raster_mode == DF_CUDA_COVERAGE && config_.dense_raster_semantics == 0
        ? std::max(config_.aa_samples, 1u) : 1;
    if (static_cast<std::uint64_t>(config_.width) * ssaa_factor_ > INT_MAX
        || static_cast<std::uint64_t>(config_.height) * ssaa_factor_ > INT_MAX)
        throw Error(DF_CUDA_OUT_OF_MEMORY, "CUDA supersampled dimensions exceed indexed range");
    initialize(runtime_, triangles_, index_, index_blocks_, temporary_, keys_, keys_out_,
               ids_, candidates_, counts_, event_keys_, event_keys_out_, events_, events_out_,
               row_edges_, collapsed_, spans_, positive_, negative_, previous_, pairs_, pairs_out_,
               orphans_, orphans_out_, float_keys_, float_keys_out_, open_, endpoints_, endpoints_out_,
               row_accum_, row_delta_, row_prefix_, state_, evidence_);
    state_.resize(1);
    evidence_.resize(4);
    counts_.resize(2);
    triangles_.resize(triangle_count_);
    if (config_.dense_raster_semantics == 1 && config_.raster_mode == DF_CUDA_COVERAGE
        && config_.aa_samples > 1 && config_.compute_area_stats)
        source_statistics_.emplace(runtime_, config_);
    if (!triangle_count_) return;
    Buffer<float> upload_xyz;
    Buffer<std::uint32_t> upload_tanks;
    initialize(runtime_, upload_xyz, upload_tanks);
    const auto chunk = static_cast<std::uint32_t>(std::max<std::size_t>(1,
        std::min<std::size_t>(launch_items, runtime_.transfer_bytes() / (9 * sizeof(float)))));
    upload_xyz.resize(static_cast<std::size_t>(chunk) * 9);
    upload_tanks.resize(chunk);
    const bool have_tanks = host_tanks != nullptr && tank_count >= triangle_count_;
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
            triangles_.data(), config_, first, n, ssaa_factor_, have_tanks);
        launched(runtime_);
        upload_xyz.mark_used(runtime_.compute);
        upload_tanks.mark_used(runtime_.compute);
    }
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
}

std::uint32_t Rasterizer::repair(RasterEdge *edges, std::uint32_t n, std::uint32_t width,
                                 bool snap, std::int32_t orientation, Buffer<RasterSpan> &output) {
    keys_.resize(n);
    keys_out_.resize(n);
    for (std::uint32_t first = 0; first < n; first += launch_items) {
        const auto count = std::min(launch_items, n - first);
        exit_indices<<<(count + 255) / 256, 256, 0, runtime_.compute>>>(edges, keys_.data(), first, n, orientation);
        launched(runtime_);
    }
    primitive(runtime_, temporary_, [&](void *p, std::size_t &bytes) {
        return cub::DeviceScan::InclusiveScan(p, bytes, thrust::make_reverse_iterator(keys_.data() + n),
            thrust::make_reverse_iterator(keys_out_.data() + n), cub::Min(), static_cast<int>(n), runtime_.compute);
    });
    checked(cudaMemsetAsync(state_.data(), 0, sizeof(RasterState), runtime_.compute), "reset matched row state");
    for (std::uint32_t first = 0; first < n; first += serial_items) {
        match_pairs<<<1, 1, 0, runtime_.compute>>>(edges, keys_out_.data(), n, open_.data(), pairs_.data(),
                                                orphans_.data(), state_.data(), serial_items, orientation);
        launched(runtime_);
    }
    const auto matched = metadata(runtime_, state_.data());
    checked(cudaMemcpyAsync(counts_.data() + 1, &state_.data()->pair_count, sizeof(std::uint32_t),
                            cudaMemcpyDeviceToDevice, runtime_.compute), "retain matched orientation evidence");
    for (std::uint32_t first = 0; first < matched.open_count; first += launch_items) {
        const auto count = std::min(launch_items, matched.open_count - first);
        finish_orphans<<<(count + 255) / 256, 256, 0, runtime_.compute>>>(open_.data(), orphans_.data(), state_.data(),
            first, matched.open_count, matched.orphan_count);
        launched(runtime_);
    }
    const auto orphan_count = matched.orphan_count + matched.open_count;
    if (orphan_count > 1) {
        for (std::uint32_t first = 0; first < orphan_count; first += launch_items) {
            const auto count = std::min(launch_items, orphan_count - first);
            orphan_keys<<<(count + 255) / 256, 256, 0, runtime_.compute>>>(orphans_.data(), float_keys_.data(), first, orphan_count);
            launched(runtime_);
        }
        primitive(runtime_, temporary_, [&](void *p, std::size_t &bytes) {
            return cub::DeviceRadixSort::SortPairs(p, bytes, float_keys_.data(), float_keys_out_.data(),
                orphans_.data(), orphans_out_.data(), static_cast<int>(orphan_count), 0, 32, runtime_.compute);
        });
        const auto endpoint_count = matched.pair_count * 2;
        if (endpoint_count) {
            for (std::uint32_t first = 0; first < matched.pair_count; first += launch_items) {
                const auto count = std::min(launch_items, matched.pair_count - first);
                pair_endpoints<<<(count + 255) / 256, 256, 0, runtime_.compute>>>(pairs_.data(), endpoints_.data(), first, matched.pair_count);
                launched(runtime_);
            }
            primitive(runtime_, temporary_, [&](void *p, std::size_t &bytes) {
                return cub::DeviceRadixSort::SortKeys(p, bytes, endpoints_.data(), endpoints_out_.data(),
                                                    static_cast<int>(endpoint_count), 0, 32, runtime_.compute);
            });
        }
        checked(cudaMemsetAsync(&state_.data()->cursor, 0, sizeof(std::uint32_t), runtime_.compute), "restart orphan row cursor");
        for (std::uint32_t first = 0; first < orphan_count / 2; first += serial_items) {
            append_orphan_pairs<<<1, 1, 0, runtime_.compute>>>(orphans_out_.data(), orphan_count,
                endpoints_out_.data(), endpoint_count, pairs_.data(), state_.data(), serial_items);
            launched(runtime_);
        }
    }
    const auto pair_count = metadata(runtime_, &state_.data()->pair_count);
    if (!pair_count) return 0;
    for (std::uint32_t first = 0; first < pair_count; first += launch_items) {
        const auto count = std::min(launch_items, pair_count - first);
        pair_keys<<<(count + 255) / 256, 256, 0, runtime_.compute>>>(pairs_.data(), float_keys_.data(), first, pair_count);
        launched(runtime_);
    }
    primitive(runtime_, temporary_, [&](void *p, std::size_t &bytes) {
        return cub::DeviceRadixSort::SortPairs(p, bytes, float_keys_.data(), float_keys_out_.data(), pairs_.data(),
                                             pairs_out_.data(), static_cast<int>(pair_count), 0, 32, runtime_.compute);
    });
    checked(cudaMemsetAsync(state_.data(), 0, sizeof(RasterState), runtime_.compute), "reset merged row state");
    for (std::uint32_t first = 0; first < pair_count; first += serial_items) {
        merge_pairs<<<1, 1, 0, runtime_.compute>>>(pairs_out_.data(), pair_count, output.data(), state_.data(), serial_items, width, snap);
        launched(runtime_);
    }
    return metadata(runtime_, &state_.data()->count);
}

std::uint32_t Rasterizer::build_spans(RasterEdge *edges, std::uint32_t n, std::uint32_t width,
                                      bool snap, std::uint32_t previous_count) {
    if (n < 2) return 0;
    checked(cudaMemsetAsync(state_.data(), 0, sizeof(RasterState), runtime_.compute), "reset winding row state");
    for (std::uint32_t first = 0; first < n; first += serial_items) {
        naive_spans<<<1, 1, 0, runtime_.compute>>>(edges, n, spans_.data(), state_.data(), serial_items, width, snap);
        launched(runtime_);
    }
    const auto winding = metadata(runtime_, state_.data());
    if (winding.winding == 0 && !(winding.minimum_winding < 0 && winding.maximum_winding > 0)) return winding.count;
    const auto capacity = row_edges_.size();
    collapsed_.resize(capacity); positive_.resize(capacity); negative_.resize(capacity);
    pairs_.resize(capacity); pairs_out_.resize(capacity);
    orphans_.resize(capacity); orphans_out_.resize(capacity);
    float_keys_.resize(capacity); float_keys_out_.resize(capacity); open_.resize(capacity);
    endpoints_.resize(checked_bytes(capacity, 2)); endpoints_out_.resize(checked_bytes(capacity, 2));
    checked(cudaMemsetAsync(state_.data(), 0, sizeof(RasterState), runtime_.compute), "reset defective collapse state");
    for (std::uint32_t first = 0; first < n; first += serial_items) {
        collapse_edges<<<1, 1, 0, runtime_.compute>>>(edges, n, collapsed_.data(), state_.data(), serial_items);
        launched(runtime_);
    }
    const auto collapsed_count = metadata(runtime_, &state_.data()->count);
    if (!collapsed_count) return 0;
    const auto positive_count = repair(collapsed_.data(), collapsed_count, width, snap, 1, positive_);
    const auto positive_matches = metadata(runtime_, counts_.data() + 1);
    const auto negative_count = repair(collapsed_.data(), collapsed_count, width, snap, -1, negative_);
    const auto negative_matches = metadata(runtime_, counts_.data() + 1);
    checked(cudaMemsetAsync(evidence_.data(), 0, evidence_.bytes(), runtime_.compute), "reset vertical orientation evidence");
    for (std::uint32_t first = 0; first < positive_count; first += launch_items) {
        const auto count = std::min(launch_items, positive_count - first);
        span_evidence<<<(count + 255) / 256, 256, 0, runtime_.compute>>>(positive_.data(), positive_count,
            previous_.data(), previous_count, evidence_.data(), first);
        launched(runtime_);
    }
    for (std::uint32_t first = 0; first < negative_count; first += launch_items) {
        const auto count = std::min(launch_items, negative_count - first);
        span_evidence<<<(count + 255) / 256, 256, 0, runtime_.compute>>>(negative_.data(), negative_count,
            previous_.data(), previous_count, evidence_.data() + 2, first);
        launched(runtime_);
    }
    std::uint64_t evidence[4];
    metadata(runtime_, evidence, evidence_.data(), 4);
    const bool choose_positive = evidence[0] != evidence[2] ? evidence[0] > evidence[2]
        : positive_matches != negative_matches ? positive_matches > negative_matches : evidence[1] <= evidence[3];
    const auto count = choose_positive ? positive_count : negative_count;
    if (count)
        checked(cudaMemcpyAsync(spans_.data(), choose_positive ? positive_.data() : negative_.data(),
            checked_bytes(count, sizeof(RasterSpan)), cudaMemcpyDeviceToDevice, runtime_.compute), "select repaired row orientation");
    return count;
}
bool Rasterizer::applies_model_aa(std::uint32_t layer) const {
    if (config_.model_triangle_count == 0 || config_.model_triangle_count >= triangle_count_) return true;
    return layer >= model_first_layer_ && layer <= model_last_layer_;
}


Plane Rasterizer::render(std::uint32_t layer, std::uint32_t tank, RasterSelection selection) {
    runtime_.activate();
    runtime_.check_cancelled();
    if (layer >= config_.total_layers || tank >= config_.tank_count)
        throw Error(DF_CUDA_INVALID_ARGUMENT, "CUDA raster layer or tank is out of range");
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
    const auto lane_count = perturb ? steps : 1;
    std::vector<std::uint32_t> maximum(lane_count, 0), active_count(lane_count, 0);
    for (std::uint32_t y = first_row; y < last_row; ++y) {
        const auto lane = perturb ? y % steps : 0;
        active_count[lane] -= control[row_count + y];
        active_count[lane] += control[y];
        maximum[lane] = std::max(maximum[lane], active_count[lane]);
    }
    std::vector<Buffer<RasterEdge>> active(lane_count);
    std::fill(active_count.begin(), active_count.end(), 0);
    std::uint32_t capacity = 0;
    for (std::uint32_t lane = 0; lane < lane_count; ++lane) {
        active[lane].initialize(runtime_.memory, runtime_.compute);
        active[lane].resize(maximum[lane]);
        capacity = std::max(capacity, maximum[lane]);
    }
    row_edges_.resize(capacity);
    spans_.resize(capacity); previous_.resize(capacity);
    keys_.resize(capacity); keys_out_.resize(capacity);
    counts_.resize(2);
    Buffer<std::uint32_t> lit(runtime_.memory, coverage ? 0 : config_.width, runtime_.compute);
    row_accum_.resize(coverage ? config_.width : 0);
    row_delta_.resize(static_cast<std::size_t>(config_.width) + 1);
    row_prefix_.resize(config_.width);
    if (!coverage) checked(cudaMemsetAsync(lit.data(), 0, lit.bytes(), runtime_.compute), "clear supersample row counts");
    if (coverage) checked(cudaMemsetAsync(row_accum_.data(), 0, row_accum_.bytes(), runtime_.compute), "clear fractional row accumulation");
    checked(cudaMemsetAsync(row_delta_.data(), 0, row_delta_.bytes(), runtime_.compute), "clear row difference accumulation");
    const bool source_stats = analytic || (config_.dense_raster_semantics == 1 && config_.raster_mode == DF_CUDA_PERTURBATION);
    Buffer<PostBasic> source_basic;
    Buffer<std::int32_t> hit_delta, hit_prefix;
    initialize(runtime_, source_basic, hit_delta, hit_prefix);
    Plane occupancy;
    if (source_stats) {
        source_basic.resize(1);
        checked(cudaMemsetAsync(source_basic.data(), 0, sizeof(PostBasic), runtime_.compute), "clear source raster statistics");
        checked(cudaMemsetAsync(&source_basic.data()->min_x, 255, 2 * sizeof(std::uint32_t), runtime_.compute), "initialize source raster bounds");
        if (analytic && config_.compute_area_stats) {
            occupancy = Plane(runtime_, output.x0, output.y0, output.width, output.height);
            checked(cudaMemsetAsync(occupancy.pixels.data(), 0, occupancy.bytes(), runtime_.compute), "clear source occupancy plane");
            hit_delta.resize(static_cast<std::size_t>(config_.width) + 1);
            hit_prefix.resize(config_.width);
            checked(cudaMemsetAsync(hit_delta.data(), 0, hit_delta.bytes(), runtime_.compute), "clear source occupancy differences");
        }
    }
    std::uint32_t event_offset = 0, previous_count = 0;
    for (std::uint32_t y = first_row; y < last_row; ++y) {
        runtime_.check_cancelled();
        const auto lane = perturb ? y % steps : 0;
        const auto old_count = active_count[lane];
        const auto retained = old_count - control[row_count + y];
        if (old_count) {
            primitive(runtime_, temporary_, [&](void *p, std::size_t &bytes) {
                return cub::DeviceSelect::If(p, bytes, active[lane].data(), row_edges_.data(), counts_.data(),
                                             static_cast<int>(old_count), Alive{y}, runtime_.compute);
            });
        }
        const auto starting = control[y];
        for (std::uint32_t first = 0; first < starting; first += launch_items) {
            const auto count = std::min(launch_items, starting - first);
            append_events<<<(count + 255) / 256, 256, 0, runtime_.compute>>>(row_edges_.data(), events_out_.data() + event_offset,
                                                                         retained, first, starting);
            launched(runtime_);
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
            primitive(runtime_, temporary_, [&](void *p, std::size_t &bytes) {
                return cub::DeviceRadixSort::SortPairs(p, bytes, keys_.data(), keys_out_.data(), row_edges_.data(),
                                                     active[lane].data(), static_cast<int>(n), 0, 32, runtime_.compute);
            });
        }
        const auto span_count = build_spans(active[lane].data(), n, config_.width * factor, !coverage, previous_count);
        checked(cudaMemsetAsync(state_.data(), 0, sizeof(RasterState), runtime_.compute), "reset raster span accumulation cursor");
        for (std::uint32_t first = 0; first < span_count; first += serial_items) {
            accumulate_spans<<<1, 1, 0, runtime_.compute>>>(spans_.data(), span_count, row_accum_.data(), row_delta_.data(),
                lit.data(), state_.data(), serial_items, config_.width, factor, coverage);
            launched(runtime_);
        }
        if (source_stats) {
            checked(cudaMemsetAsync(state_.data(), 0, sizeof(RasterState), runtime_.compute), "reset source raster cursor");
            for (std::uint32_t first = 0; first < span_count; first += serial_items) {
                record_source_spans<<<1, 1, 0, runtime_.compute>>>(spans_.data(), span_count, source_basic.data(),
                    hit_delta.data(), state_.data(), y / divisor, serial_items);
                launched(runtime_);
            }
        }
        if (span_count)
            checked(cudaMemcpyAsync(previous_.data(), spans_.data(), checked_bytes(span_count, sizeof(RasterSpan)),
                                    cudaMemcpyDeviceToDevice, runtime_.compute), "retain previous scanline orientation");
        previous_count = span_count;
        if (!perturb) {
            for (std::uint32_t first = 0; first < n; first += launch_items) {
                const auto count = std::min(launch_items, n - first);
                advance_edges<<<(count + 255) / 256, 256, 0, runtime_.compute>>>(active[lane].data(), first, n);
                launched(runtime_);
            }
        }
        if ((y + 1) % divisor == 0 || y + 1 == last_row) {
            primitive(runtime_, temporary_, [&](void *p, std::size_t &bytes) {
                return cub::DeviceScan::InclusiveSum(p, bytes, row_delta_.data(), row_prefix_.data(),
                                                    static_cast<int>(config_.width), runtime_.compute);
            });
            for (std::uint32_t first = 0; first < config_.width; first += launch_items) {
                const auto count = std::min(launch_items, config_.width - first);
                resolve_row<<<(count + 255) / 256, 256, 0, runtime_.compute>>>(output.view(), y / divisor, row_accum_.data(),
                    row_delta_.data(), row_prefix_.data(), lit.data(), first, steps, factor, coverage, raw_supports);
                launched(runtime_);
            }
            checked(cudaMemsetAsync(row_delta_.data() + config_.width, 0, sizeof(std::int32_t), runtime_.compute), "clear closing row sentinel");
            if (!occupancy.empty()) {
                primitive(runtime_, temporary_, [&](void *p, std::size_t &bytes) {
                    return cub::DeviceScan::InclusiveSum(p, bytes, hit_delta.data(), hit_prefix.data(),
                                                        static_cast<int>(config_.width), runtime_.compute);
                });
                for (std::uint32_t first = 0; first < config_.width; first += launch_items) {
                    const auto count = std::min(launch_items, config_.width - first);
                    resolve_source_hits<<<(count + 255) / 256, 256, 0, runtime_.compute>>>(occupancy.view(), y / divisor,
                                                                                      hit_delta.data(), hit_prefix.data(), first);
                    launched(runtime_);
                }
                checked(cudaMemsetAsync(hit_delta.data() + config_.width, 0, sizeof(std::int32_t), runtime_.compute), "clear source occupancy sentinel");
            }
        }
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
