#include "post.h"
#include <climits>
#include <cmath>

namespace dfcuda {
namespace {

constexpr std::uint32_t threads = 256;
constexpr std::uint32_t minimum_blur_rows = 32;

struct ZWindow { WindowPlane planes[17]; };
// Leave space for every other argument and its alignment on Pascal's 4 KiB ABI.
static_assert(sizeof(ZWindow) + 128 <= 4096, "CUDA Z window exceeds Pascal kernel parameter limit");

unsigned blocks_for(std::size_t count) {
    return static_cast<unsigned>(std::min<std::size_t>((count + threads - 1) / threads, 65535));
}

__device__ std::uint32_t sat_add(std::uint32_t a, std::uint32_t b) {
    return b > UINT32_MAX - a ? UINT32_MAX : a + b;
}

__device__ unsigned long long sat_add64(unsigned long long a, unsigned long long b) {
    return b > ULLONG_MAX - a ? ULLONG_MAX : a + b;
}

__device__ unsigned long long axis_denom(std::uint32_t position, std::uint32_t dimension,
                                       std::uint32_t radius, const std::uint32_t *weights) {
    unsigned long long sum = weights[0];
    for (std::uint32_t d = 1; d <= radius; ++d) {
        if (d <= position) sum += weights[d];
        if (d < dimension - position) sum += weights[d];
    }
    return sum;
}

__global__ void horizontal_blur(PlaneView input, PlaneView roi, std::uint32_t first_y,
                                std::uint32_t row_count, std::uint32_t frame_x0,
                                std::uint32_t frame_width,
                                std::uint32_t radius, const PostTables *tables,
                                bool gaussian, std::uint32_t *scratch) {
    const std::size_t count = static_cast<std::size_t>(roi.width) * row_count;
    for (std::size_t i = blockIdx.x * blockDim.x + threadIdx.x; i < count;
         i += static_cast<std::size_t>(gridDim.x) * blockDim.x) {
        const auto x = roi.x0 + static_cast<std::uint32_t>(i % roi.width);
        const auto y = first_y + static_cast<std::uint32_t>(i / roi.width);
        unsigned long long sum = static_cast<unsigned long long>(pixel(input, x, y)) *
                                 (gaussian ? tables->x_weights[0] : 1);
        for (std::uint32_t d = 1; d <= radius; ++d) {
            const auto weight = gaussian ? tables->x_weights[d] : 1;
            if (d <= x - frame_x0) sum += static_cast<unsigned long long>(pixel(input, x - d, y)) * weight;
            if (d < frame_width - (x - frame_x0)) sum += static_cast<unsigned long long>(pixel(input, x + d, y)) * weight;
        }
        scratch[i] = static_cast<std::uint32_t>(sum > UINT32_MAX ? UINT32_MAX : sum);
    }
}

__global__ void vertical_blur(PlaneView output, PlaneView roi, std::uint32_t first_y,
                              std::uint32_t scratch_rows, std::uint32_t output_y,
                              std::uint32_t output_rows, std::uint32_t frame_x0,
                              std::uint32_t frame_y0, std::uint32_t frame_width,
                              std::uint32_t frame_height, std::uint32_t radius,
                              const PostTables *tables, bool gaussian,
                              const std::uint32_t *scratch) {
    const std::size_t count = static_cast<std::size_t>(roi.width) * output_rows;
    for (std::size_t i = blockIdx.x * blockDim.x + threadIdx.x; i < count;
         i += static_cast<std::size_t>(gridDim.x) * blockDim.x) {
        const auto local_x = static_cast<std::uint32_t>(i % roi.width);
        const auto x = roi.x0 + local_x;
        const auto y = output_y + static_cast<std::uint32_t>(i / roi.width);
        auto lo = y > radius ? y - radius : 0;
        // Gaussian evicts by out_y in the CPU's denominator frame, unlike
        // BOX's output-ROI-local out_row. Preserve cropped-top attenuation,
        // including the legacy 3DAA work-frame origin, not an ideal convolution.
        if (gaussian) {
            const auto roi_y0 = roi.y0 - frame_y0;
            const auto delay = roi_y0 < radius ? radius - roi_y0 : 0;
            const auto local_y = y - roi.y0;
            lo = roi.y0 + (local_y > delay ? local_y - delay : 0);
        }
        lo = lo < first_y ? first_y : lo;
        const auto bottom = static_cast<unsigned long long>(y) + radius;
        const auto frame_bottom = static_cast<unsigned long long>(frame_y0) + frame_height;
        auto hi = static_cast<std::uint32_t>(bottom < frame_bottom ? bottom : frame_bottom - 1);
        const auto scratch_end = first_y + scratch_rows - 1;
        hi = hi > scratch_end ? scratch_end : hi;
        unsigned long long sum = 0;
        for (auto sy = lo; sy <= hi; ++sy) {
            const auto d = sy > y ? sy - y : y - sy;
            const auto weight = gaussian ? tables->y_weights[d] : 1;
            sum = sat_add64(sum, static_cast<unsigned long long>(
                scratch[static_cast<std::size_t>(sy - first_y) * roi.width + local_x]) * weight);
        }
        const auto fx = x - frame_x0, fy = y - frame_y0;
        const unsigned long long dx = gaussian ? axis_denom(fx, frame_width, radius, tables->x_weights)
            : 1 + (fx < radius ? fx : radius) + (frame_width - 1 - fx < radius ? frame_width - 1 - fx : radius);
        const unsigned long long dy = gaussian ? axis_denom(fy, frame_height, radius, tables->y_weights)
            : 1 + (fy < radius ? fy : radius) + (frame_height - 1 - fy < radius ? frame_height - 1 - fy : radius);
        const auto denominator = dx * dy;
        auto value = (sum + denominator / 2) / denominator;
        output.data[static_cast<std::size_t>(y - output.y0) * output.width + x - output.x0] =
            static_cast<std::uint8_t>(value > 255 ? 255 : value);
    }
}

__global__ void blend_planes(PlaneView output, const ZWindow window, std::size_t count,
                             const PostTables *tables, std::uint32_t radius,
                             std::uint32_t denominator) {
    const std::size_t pixels = static_cast<std::size_t>(output.width) * output.height;
    for (std::size_t i = blockIdx.x * blockDim.x + threadIdx.x; i < pixels;
         i += static_cast<std::size_t>(gridDim.x) * blockDim.x) {
        const auto x = output.x0 + static_cast<std::uint32_t>(i % output.width);
        const auto y = output.y0 + static_cast<std::uint32_t>(i / output.width);
        std::uint32_t sum = 0;
        // Fixed, unrolled accesses avoid taking the parameter array's address
        // (which can force a per-thread local copy on Pascal).
        #pragma unroll
        for (std::size_t s = 0; s < 17; ++s) {
            if (s < count) {
                const auto distance = window.planes[s].layer_distance;
                const auto d = static_cast<std::uint32_t>(distance < 0 ? -static_cast<std::int64_t>(distance) : distance);
                if (d <= radius) {
                    sum = sat_add(sum, static_cast<std::uint32_t>(pixel(window.planes[s].plane, x, y)) * tables->z_weights[d]);
                }
            }
        }
        auto value = (sum + denominator / 2) / denominator;
        output.data[i] = static_cast<std::uint8_t>(value > 255 ? 255 : value);
    }
}

__global__ void map_lut(PlaneView output, const PostTables *tables) {
    const std::size_t count = static_cast<std::size_t>(output.width) * output.height;
    for (std::size_t i = blockIdx.x * blockDim.x + threadIdx.x; i < count;
         i += static_cast<std::size_t>(gridDim.x) * blockDim.x) {
        output.data[i] = tables->lut[output.data[i]];
    }
}

__global__ void merge_supports(PlaneView output, PlaneView model, PlaneView support) {
    const std::size_t count = static_cast<std::size_t>(output.width) * output.height;
    for (std::size_t i = blockIdx.x * blockDim.x + threadIdx.x; i < count;
         i += static_cast<std::size_t>(gridDim.x) * blockDim.x) {
        const auto x = output.x0 + static_cast<std::uint32_t>(i % output.width);
        const auto y = output.y0 + static_cast<std::uint32_t>(i / output.width);
        const auto a = pixel(model, x, y);
        const auto b = pixel(support, x, y);
        output.data[i] = a > b ? a : b;
    }
}

__global__ void clear_raw_supports(PlaneView model, PlaneView support) {
    const std::size_t count = static_cast<std::size_t>(model.width) * model.height;
    for (std::size_t i = blockIdx.x * blockDim.x + threadIdx.x; i < count;
         i += static_cast<std::size_t>(gridDim.x) * blockDim.x) {
        const auto x = model.x0 + static_cast<std::uint32_t>(i % model.width);
        const auto y = model.y0 + static_cast<std::uint32_t>(i / model.width);
        if (pixel(support, x, y) != 0) model.data[i] = 0;
    }
}

__global__ void copy_plane(PlaneView output, PlaneView input) {
    const std::size_t count = static_cast<std::size_t>(output.width) * output.height;
    for (std::size_t i = blockIdx.x * blockDim.x + threadIdx.x; i < count;
         i += static_cast<std::size_t>(gridDim.x) * blockDim.x) {
        const auto x = output.x0 + static_cast<std::uint32_t>(i % output.width);
        const auto y = output.y0 + static_cast<std::uint32_t>(i / output.width);
        output.data[i] = pixel(input, x, y);
    }
}

__global__ void basic_statistics(PlaneView output, PostBasic *stats, std::uint8_t threshold) {
    __shared__ unsigned long long counts[threads];
    __shared__ std::uint32_t min_x[threads], min_y[threads], max_x[threads], max_y[threads];
    unsigned long long count = 0;
    std::uint32_t lx = UINT32_MAX, ly = UINT32_MAX, hx = 0, hy = 0;
    const std::size_t pixels = static_cast<std::size_t>(output.width) * output.height;
    for (std::size_t i = blockIdx.x * blockDim.x + threadIdx.x; i < pixels;
         i += static_cast<std::size_t>(gridDim.x) * blockDim.x) {
        if (output.data[i] <= threshold) continue;
        ++count;
        const auto x = output.x0 + static_cast<std::uint32_t>(i % output.width);
        const auto y = output.y0 + static_cast<std::uint32_t>(i / output.width);
        lx = x < lx ? x : lx; ly = y < ly ? y : ly;
        hx = x > hx ? x : hx; hy = y > hy ? y : hy;
    }
    counts[threadIdx.x] = count;
    min_x[threadIdx.x] = lx; min_y[threadIdx.x] = ly;
    max_x[threadIdx.x] = hx; max_y[threadIdx.x] = hy;
    __syncthreads();
    for (unsigned stride = threads / 2; stride != 0; stride /= 2) {
        if (threadIdx.x < stride) {
            counts[threadIdx.x] += counts[threadIdx.x + stride];
            min_x[threadIdx.x] = min(min_x[threadIdx.x], min_x[threadIdx.x + stride]);
            min_y[threadIdx.x] = min(min_y[threadIdx.x], min_y[threadIdx.x + stride]);
            max_x[threadIdx.x] = max(max_x[threadIdx.x], max_x[threadIdx.x + stride]);
            max_y[threadIdx.x] = max(max_y[threadIdx.x], max_y[threadIdx.x + stride]);
        }
        __syncthreads();
    }
    if (threadIdx.x == 0 && counts[0] != 0) {
        atomicAdd(&stats->pixels, counts[0]);
        atomicMin(&stats->min_x, min_x[0]); atomicMin(&stats->min_y, min_y[0]);
        atomicMax(&stats->max_x, max_x[0]); atomicMax(&stats->max_y, max_y[0]);
    }
}

#include "post_components.cuh"

template<class T> T download_control(Runtime &runtime, const Buffer<T> &source) {
    T result{};
    HostPin pin(&result, sizeof(result));
    checked(cudaMemcpyAsync(&result, source.data(), sizeof(result), cudaMemcpyDeviceToHost,
                            runtime.compute), "reading CUDA post control");
    checked(cudaStreamSynchronize(runtime.compute), "joining CUDA post control");
    pin.unregister();
    return result;
}

void union_bounds(PlaneView view, bool &present, std::uint32_t &x0, std::uint32_t &y0,
                  std::uint32_t &x1, std::uint32_t &y1) {
    if (view.width == 0 || view.height == 0) return;
    if (!present) { x0 = view.x0; y0 = view.y0; x1 = view.x0 + view.width; y1 = view.y0 + view.height; present = true; }
    else { x0 = std::min(x0, view.x0); y0 = std::min(y0, view.y0);
        x1 = std::max(x1, view.x0 + view.width); y1 = std::max(y1, view.y0 + view.height); }
}

} // namespace

SharedPostTables::SharedPostTables(Runtime &runtime, const PostTables &tables)
    : device_(runtime.memory, 1, runtime.compute) {
    for (std::uint32_t d = 0; d < 9; ++d) z_weights_[d] = tables.z_weights[d];
    runtime.upload_bytes(device_.data(), &tables, sizeof(tables));
}

void Postprocessor::initialize() {
    runtime_.activate();
    basic_.initialize(runtime_.memory, runtime_.compute);
    nodes_.initialize(runtime_.memory, runtime_.compute);
    frontier_labels_.initialize(runtime_.memory, runtime_.compute);
    frontier_pixels_.initialize(runtime_.memory, runtime_.compute);
    components_.initialize(runtime_.memory, runtime_.compute);
    horizontal_.initialize(runtime_.memory, runtime_.compute);
    numerical_error_.initialize(runtime_.memory, runtime_.compute);
    // Direct RLE-PNG and statistics-only contexts allocate no tables.
    if (config_.dense_raster_semantics == 2) return;
    const bool perturb = config_.raster_mode == DF_CUDA_PERTURBATION;
    const bool dense = config_.dense_raster_semantics != 0;
    if (perturb) xy_radius_ = std::min(config_.xy_blur_radius, dense ? 64u : 6u);
    else if (config_.raster_mode == DF_CUDA_BLUR) {
        xy_radius_ = dense ? std::min(std::max(config_.xy_blur_radius, 1u), 64u)
                           : std::min(config_.xy_blur_radius, 64u);
    }
    z_radius_ = perturb ? std::min(config_.z_blur_radius, dense ? 8u : 6u) : 0;
    gaussian_xy_ = perturb && dense && config_.xy_blur_gaussian != 0;
    tail_enabled_ = perturb || xy_radius_ != 0 ||
        (!dense && config_.raster_mode == DF_CUDA_COVERAGE && config_.aa_samples > 1);
    dither_enabled_ = perturb && config_.dither_bit_depth != 0 && config_.dither_bit_depth < 8;
}

Postprocessor::Postprocessor(Runtime &runtime, const DfCudaConfig &config)
    : runtime_(runtime), config_(config) {
    initialize();
    if (xy_radius_ == 0 && z_radius_ == 0 && !tail_enabled_ && !dither_enabled_) return;
    const bool perturb = config.raster_mode == DF_CUDA_PERTURBATION;
    const bool dense = config.dense_raster_semantics != 0;
    PostTables tables{};
    auto weights = [](std::uint32_t *values, std::uint32_t radius, double sigma, bool gaussian) {
        sigma = std::fmax(sigma, 0.05);
        for (std::uint32_t d = 0; d <= radius; ++d) {
            const auto distance = static_cast<double>(d);
            values[d] = gaussian ? static_cast<std::uint32_t>(std::max(1.0,
                std::round(std::exp(-(distance * distance) / (2.0 * sigma * sigma)) * 1024.0))) : 1;
        }
    };
    weights(tables.x_weights, xy_radius_, config.xy_sigma_x, gaussian_xy_);
    weights(tables.y_weights, xy_radius_, config.xy_sigma_y, gaussian_xy_);
    weights(tables.z_weights, z_radius_, config.z_sigma, config.z_blur_gaussian != 0);
    // The ABI carries the resolved CPU environment value/default. Only the
    // legacy dense 3DAA path scales its Gaussian center weight.
    if (dense && perturb && z_radius_ != 0 && config.z_blur_gaussian != 0) {
        const auto scale = std::min(std::max(config.generic_z_center_weight_scale, 0.1), 2.0);
        tables.z_weights[0] = static_cast<std::uint32_t>(std::max(1.0,
            std::round(static_cast<double>(tables.z_weights[0]) * scale)));
    }
    const auto minimum_percent = perturb ? config.z_blend_minimum_alpha_percent : config.minimum_aa_alpha_percent;
    const auto clamped_percent = std::isnan(minimum_percent) ? 0.0f
        : std::min(std::max(minimum_percent, 0.0f), 100.0f);
    const auto minimum = static_cast<std::uint8_t>(std::round((clamped_percent / 100.0f) * 255.0f));
    for (std::uint32_t i = 0; i < 256; ++i) {
        if (tail_enabled_ && config.custom_lut_count != 0) {
            tables.lut[i] = i < std::min(config.custom_lut_count, 256u) ? config.custom_lut[i] : 0;
        } else if (tail_enabled_ && minimum != 0 && i != 0 && i != 255) {
            const float t = static_cast<float>(i - 1) / 254.0f;
            const float span = static_cast<float>(255 - minimum);
            tables.lut[i] = static_cast<std::uint8_t>(std::round(static_cast<float>(minimum) + span * t));
        } else tables.lut[i] = static_cast<std::uint8_t>(i);
    }
    tables.lut[0] = 0;
    tables.lut[255] = 255;
    if (dither_enabled_) {
        if (!std::isfinite(config.dither_gamma) || config.dither_gamma <= 0.0) {
            throw Error(DF_CUDA_NUMERICAL_ERROR, "CUDA dithering requires finite positive panel gamma");
        }
        tables.palette_count = 1u << std::max(config.dither_bit_depth, 2u);
        for (std::uint32_t i = 0; i < 256; ++i) {
            tables.source_energy[i] = std::pow(static_cast<double>(tables.lut[i]) / 255.0, config.dither_gamma);
        }
        for (std::uint32_t i = 0; i < tables.palette_count; ++i) {
            tables.palette[i] = static_cast<std::uint8_t>(std::round(
                static_cast<double>(i) * (255.0 / (tables.palette_count - 1))));
            tables.palette_energy[i] = std::pow(static_cast<double>(tables.palette[i]) / 255.0, config.dither_gamma);
        }
    }
    tables_ = std::make_shared<SharedPostTables>(runtime_, tables);
}

Postprocessor::Postprocessor(Runtime &runtime, const DfCudaConfig &config, SharedPostTablesPtr tables)
    : runtime_(runtime), config_(config), tables_(std::move(tables)) {
    initialize();
    if ((xy_radius_ != 0 || z_radius_ != 0 || tail_enabled_ || dither_enabled_) && !tables_) {
        throw Error(DF_CUDA_INVALID_ARGUMENT, "CUDA post worker requires its job's shared tables");
    }
}

Postprocessor::~Postprocessor() {
    // Retain the immutable holder through this worker's queued GPU readers,
    // even when an exception exits before the scheduler's normal stage join.
    if (tables_ && runtime_.compute != nullptr) {
        cudaSetDevice(runtime_.device);
        cudaStreamSynchronize(runtime_.compute);
    }
}

std::size_t Postprocessor::small_workspace_bytes() const noexcept {
    return 2 * sizeof(PostBasic) +
        (dither_enabled_ ? sizeof(std::uint32_t) : 0);
}

std::size_t Postprocessor::horizontal_workspace_bytes(std::size_t worker_workspace) const {
    if (xy_radius_ == 0) return 0;
    const auto rows = std::min(config_.height, minimum_blur_rows + 2 * xy_radius_);
    const auto minimum = checked_bytes(checked_bytes(config_.width, rows), sizeof(std::uint32_t));
    return std::max(minimum, worker_workspace / 8);
}

std::size_t Postprocessor::additional_horizontal_workspace_bytes(std::size_t worker_workspace) const {
    return horizontal_workspace_bytes(worker_workspace) - horizontal_workspace_bytes(0);
}

std::size_t Postprocessor::minimum_workspace_bytes() const {
    const auto horizontal = horizontal_workspace_bytes(0);
    // Charge labels only when component statistics are requested. Include
    // every retained small buffer inside the same one-eighth workspace share.
    const auto small = small_workspace_bytes();
    const auto statistics = config_.compute_area_stats == 0 ? small
        : checked_bytes(checked_bytes(config_.width,
            2 * sizeof(PostNode) + 2 * sizeof(std::uint32_t)) + sizeof(PostComponents) + small, 8u);
    if (horizontal > std::numeric_limits<std::size_t>::max() - statistics) {
        throw Error(DF_CUDA_OUT_OF_MEMORY, "CUDA post workspace size overflow");
    }
    return horizontal + statistics;
}

void Postprocessor::refresh_bounds(Plane &plane) {
    plane.nonzero_bounds = Bounds{};
    plane.topology_bounds = Bounds{};
    plane.bounds_valid = false;
    if (plane.empty()) { plane.bounds_valid = true; return; }
    basic_.resize(2);
    const PostBasic initial[2] = {
        {0, UINT32_MAX, UINT32_MAX, 0, 0}, {0, UINT32_MAX, UINT32_MAX, 0, 0}
    };
    runtime_.upload_bytes(basic_.data(), initial, sizeof(initial));
    basic_statistics<<<blocks_for(plane.bytes()), threads, 0, runtime_.compute>>>(plane.view(), basic_.data(), 0);
    checked(cudaGetLastError(), "launching CUDA nonzero bounds");
    basic_statistics<<<blocks_for(plane.bytes()), threads, 0, runtime_.compute>>>(plane.view(), basic_.data() + 1, 127);
    checked(cudaGetLastError(), "launching CUDA topology bounds");
    basic_.mark_used(runtime_.compute);
    PostBasic result[2]{};
    HostPin pin(result, sizeof(result));
    checked(cudaMemcpyAsync(result, basic_.data(), sizeof(result), cudaMemcpyDeviceToHost,
                            runtime_.compute), "reading CUDA legacy bounds");
    checked(cudaStreamSynchronize(runtime_.compute), "joining CUDA legacy bounds");
    pin.unregister();
    auto bounds = [](const PostBasic &value) {
        if (value.pixels == 0) return Bounds{};
        return Bounds{static_cast<std::int32_t>(value.min_x), static_cast<std::int32_t>(value.min_y),
                      static_cast<std::int32_t>(value.max_x), static_cast<std::int32_t>(value.max_y)};
    };
    plane.nonzero_bounds = bounds(result[0]);
    plane.topology_bounds = bounds(result[1]);
    plane.bounds_valid = true;
}

void Postprocessor::prepare_legacy(Plane &model, const Plane *raw_supports, bool apply_model_aa) {
    runtime_.activate(); runtime_.check_cancelled();
    if (!apply_model_aa || model.empty()) {
        model = Plane{};
        model.bounds_valid = true;
        return;
    }
    if (raw_supports != nullptr && !raw_supports->empty()) {
        clear_raw_supports<<<blocks_for(model.bytes()), threads, 0, runtime_.compute>>>(model.view(), raw_supports->view());
        checked(cudaGetLastError(), "launching CUDA legacy raw support removal");
        model.pixels.mark_used(runtime_.compute);
    }
    // The parent retains pre-support-removal raster statistics for the CPU
    // model_non_empty gate. Topology is derived from the remaining >127 bytes;
    // the CURRENT legacy gray constructor then crops to that exact bbox, not
    // the nonzero bbox. Low gray outside it is intentionally discarded.
    model.raster_stats_valid = false;
    refresh_bounds(model);
    const auto topology = model.topology_bounds;
    if (topology.x1 < topology.x0 || topology.y1 < topology.y0) {
        model = Plane{};
        model.bounds_valid = true;
        return;
    }
    const auto x0 = static_cast<std::uint32_t>(topology.x0);
    const auto y0 = static_cast<std::uint32_t>(topology.y0);
    const auto width = static_cast<std::uint32_t>(topology.x1 - topology.x0 + 1);
    const auto height = static_cast<std::uint32_t>(topology.y1 - topology.y0 + 1);
    if (model.x0 != x0 || model.y0 != y0 || model.width != width || model.height != height) {
        Plane cropped(runtime_, x0, y0, width, height);
        copy_plane<<<blocks_for(cropped.bytes()), threads, 0, runtime_.compute>>>(cropped.view(), model.view());
        checked(cudaGetLastError(), "launching CUDA legacy topology gray crop");
        model.pixels.mark_used(runtime_.compute);
        cropped.pixels.mark_used(runtime_.compute);
        model = std::move(cropped);
    }
    // Every bounding edge contains a >127 pixel, so cropped nonzero bounds
    // equal topology bounds exactly; no second pixel scan is necessary.
    model.nonzero_bounds = model.topology_bounds = topology;
    model.bounds_valid = true;
}

Plane Postprocessor::spatial(Plane input) {
    runtime_.activate(); runtime_.check_cancelled();
    auto frame = input.work_frame;
    if (!frame.configured && (input.empty() || xy_radius_ == 0)) return input;
    auto empty_bounds = [](Bounds value) { return value.x1 < value.x0 || value.y1 < value.y0; };
    if (!frame.configured) {
        // Preferred RLE/ordinary blur expands actual device-derived nonzero
        // byte bounds. Legacy generic 3DAA instead supplies its exact CPU
        // topology/window-seeded ROI and denominator work frame below.
        if (!input.bounds_valid) refresh_bounds(input);
        if (empty_bounds(input.nonzero_bounds)) return Plane{};
        frame.x0 = frame.y0 = 0;
        frame.width = config_.width; frame.height = config_.height;
        const auto source = input.nonzero_bounds;
        frame.blur_bounds = {
            static_cast<std::int32_t>(std::max<std::int64_t>(0, static_cast<std::int64_t>(source.x0) - xy_radius_)),
            static_cast<std::int32_t>(std::max<std::int64_t>(0, static_cast<std::int64_t>(source.y0) - xy_radius_)),
            static_cast<std::int32_t>(std::min<std::int64_t>(config_.width - 1, static_cast<std::int64_t>(source.x1) + xy_radius_)),
            static_cast<std::int32_t>(std::min<std::int64_t>(config_.height - 1, static_cast<std::int64_t>(source.y1) + xy_radius_))
        };
        frame.apply_blur = true;
    }
    if (frame.width == 0 || frame.height == 0) {
        Plane output;
        output.work_frame = frame;
        return output;
    }
    if (frame.x0 >= config_.width || frame.y0 >= config_.height ||
        frame.width > config_.width - frame.x0 || frame.height > config_.height - frame.y0) {
        throw Error(DF_CUDA_INVALID_ARGUMENT, "CUDA blur work frame is outside the image");
    }
    const bool apply = frame.apply_blur && xy_radius_ != 0 && !empty_bounds(frame.blur_bounds);
    const auto bounds = frame.blur_bounds;
    if (apply && (bounds.x0 < static_cast<std::int64_t>(frame.x0) ||
        bounds.y0 < static_cast<std::int64_t>(frame.y0) ||
        bounds.x1 >= static_cast<std::int64_t>(frame.x0) + frame.width ||
        bounds.y1 >= static_cast<std::int64_t>(frame.y0) + frame.height)) {
        throw Error(DF_CUDA_INVALID_ARGUMENT, "CUDA blur ROI is outside its denominator frame");
    }
    if (!apply && input.x0 == frame.x0 && input.y0 == frame.y0 &&
        input.width == frame.width && input.height == frame.height) return input;
    const auto x0 = frame.configured ? frame.x0 : static_cast<std::uint32_t>(bounds.x0);
    const auto y0 = frame.configured ? frame.y0 : static_cast<std::uint32_t>(bounds.y0);
    const auto width = frame.configured ? frame.width : static_cast<std::uint32_t>(bounds.x1 - bounds.x0 + 1);
    const auto height = frame.configured ? frame.height : static_cast<std::uint32_t>(bounds.y1 - bounds.y0 + 1);
    Plane output(runtime_, x0, y0, width, height);
    output.work_frame = frame;
    if (frame.configured) {
        // CPU BOX is in-place and retains pixels outside its output ROI;
        // Gaussian allocates a zeroed work frame and replaces ONLY that ROI.
        if (apply && gaussian_xy_) {
            checked(cudaMemsetAsync(output.pixels.data(), 0, output.bytes(), runtime_.compute),
                    "clearing CUDA Gaussian work frame");
        } else {
            copy_plane<<<blocks_for(output.bytes()), threads, 0, runtime_.compute>>>(output.view(), input.view());
            checked(cudaGetLastError(), "launching CUDA legacy work-frame copy");
        }
    }
    if (apply) {
        const PlaneView roi{nullptr, static_cast<std::uint32_t>(bounds.x0), static_cast<std::uint32_t>(bounds.y0),
            static_cast<std::uint32_t>(bounds.x1 - bounds.x0 + 1), static_cast<std::uint32_t>(bounds.y1 - bounds.y0 + 1)};
        const auto y1 = roi.y0 + roi.height;
        const auto row_bytes = checked_bytes(roi.width, sizeof(std::uint32_t));
        const auto scratch_rows = static_cast<std::uint32_t>(std::min<std::size_t>(roi.height,
            horizontal_workspace_bytes(runtime_.workspace_budget()) / row_bytes));
        horizontal_.resize(checked_bytes(roi.width, scratch_rows));
        for (auto y = roi.y0; y < y1;) {
            runtime_.check_cancelled();
            const auto first = std::max(roi.y0, y > xy_radius_ ? y - xy_radius_ : 0);
            const auto end = static_cast<std::uint32_t>(std::min<std::uint64_t>(y1,
                static_cast<std::uint64_t>(first) + scratch_rows));
            // The admission floor fits both halos plus at least 32 output
            // rows, unless the entire ROI already fits. Reclaim clipped halos
            // at the top/bottom instead of imposing a host-side row granularity.
            const auto rows = end == y1 ? y1 - y : end - y - xy_radius_;
            horizontal_blur<<<blocks_for(checked_bytes(roi.width, end - first)), threads, 0, runtime_.compute>>>(
                input.view(), roi, first, end - first, frame.x0, frame.width, xy_radius_,
                tables_->data(), gaussian_xy_, horizontal_.data());
            checked(cudaGetLastError(), "launching CUDA horizontal blur");
            vertical_blur<<<blocks_for(checked_bytes(roi.width, rows)), threads, 0, runtime_.compute>>>(
                output.view(), roi, first, end - first, y, rows, frame.x0, frame.y0, frame.width, frame.height,
                xy_radius_, tables_->data(), gaussian_xy_, horizontal_.data());
            checked(cudaGetLastError(), "launching CUDA vertical blur");
            y += rows;
        }
        horizontal_.mark_used(runtime_.compute);
    }
    input.pixels.mark_used(runtime_.compute);
    output.pixels.mark_used(runtime_.compute);
    return output;
}

Plane Postprocessor::blend_z(const WindowPlane *sources, std::size_t count) {
    runtime_.activate(); runtime_.check_cancelled();
    if (sources == nullptr || count == 0 || count > 2 * z_radius_ + 1) {
        throw Error(DF_CUDA_INVALID_ARGUMENT, "invalid CUDA Z neighbor window");
    }
    bool present = false, center = false;
    std::uint32_t x0 = 0, y0 = 0, x1 = 0, y1 = 0;
    std::uint32_t denominator = 0;
    bool seen[17]{};
    for (std::size_t i = 0; i < count; ++i) {
        const auto distance = static_cast<std::int64_t>(sources[i].layer_distance);
        const auto d = static_cast<std::uint32_t>(distance < 0 ? -distance : distance);
        if (d > z_radius_ || seen[distance + z_radius_]) {
            throw Error(DF_CUDA_INVALID_ARGUMENT, "CUDA Z window contains duplicate or out-of-radius neighbors");
        }
        seen[distance + z_radius_] = true;
        center = center || distance == 0;
        union_bounds(sources[i].plane, present, x0, y0, x1, y1);
        if (z_radius_ != 0) denominator += tables_->z_weight(d);
    }
    if (!center) throw Error(DF_CUDA_INVALID_ARGUMENT, "CUDA Z window has no center layer");
    if (!present) return Plane{};
    Plane output(runtime_, x0, y0, x1 - x0, y1 - y0);
    if (z_radius_ == 0) {
        copy_plane<<<blocks_for(output.bytes()), threads, 0, runtime_.compute>>>(output.view(), sources[0].plane);
        checked(cudaGetLastError(), "launching CUDA unblurred center copy");
        output.pixels.mark_used(runtime_.compute);
        return output;
    }
    ZWindow window{};
    for (std::size_t i = 0; i < count; ++i) window.planes[i] = sources[i];
    blend_planes<<<blocks_for(output.bytes()), threads, 0, runtime_.compute>>>(
        output.view(), window, count, tables_->data(), z_radius_, denominator);
    checked(cudaGetLastError(), "launching CUDA Z blur");
    output.pixels.mark_used(runtime_.compute);
    return output;
}

DfCudaAreaStats Postprocessor::statistics(const Plane &output) {
    runtime_.activate(); runtime_.check_cancelled();
    if (output.raster_stats_valid) return output.raster_area_stats;
    auto stats = empty_stats();
    if (output.empty()) return stats;
    basic_.resize(1);
    const PostBasic initial{0, UINT32_MAX, UINT32_MAX, 0, 0};
    runtime_.upload_bytes(basic_.data(), &initial, sizeof(initial));
    basic_statistics<<<blocks_for(output.bytes()), threads, 0, runtime_.compute>>>(output.view(), basic_.data(), 0);
    checked(cudaGetLastError(), "launching CUDA area bounds");
    basic_.mark_used(runtime_.compute);
    const auto basic = download_control(runtime_, basic_);
    if (basic.pixels == 0) return stats;
    stats.total_solid_pixels = std::min<unsigned long long>(basic.pixels, UINT32_MAX);
    stats.min_x = static_cast<std::int32_t>(basic.min_x); stats.min_y = static_cast<std::int32_t>(basic.min_y);
    stats.max_x = static_cast<std::int32_t>(basic.max_x); stats.max_y = static_cast<std::int32_t>(basic.max_y);
    const auto pixel_area = (static_cast<double>(config_.build_width_mm) / config_.width)
        * (static_cast<double>(config_.build_depth_mm) / config_.height);
    if (config_.compute_area_stats == 0) {
        stats.total_solid_area_mm2 = stats.total_solid_pixels * pixel_area;
        stats.largest_area_mm2 = stats.smallest_area_mm2 = stats.total_solid_area_mm2;
        stats.area_count = 1;
        return stats;
    }
    // Keep components and all retained small post buffers within one eighth
    // of the admitted worker workspace. Frontier capacities use the job width
    // so varying ROI widths cannot grow retained scratch beyond that share.
    // A 1024-row ceiling bounds latency and prevents default full-frame labels.
    const auto share = runtime_.workspace_budget() / 8;
    const auto small = small_workspace_bytes();
    if (share <= small) {
        throw Error(DF_CUDA_OUT_OF_MEMORY, "CUDA component workspace cannot hold its metadata");
    }
    const auto component_budget = share - small;
    const auto frontier_bytes = checked_bytes(config_.width, 2 * sizeof(std::uint32_t));
    const auto fixed_bytes = frontier_bytes + sizeof(PostComponents);
    if (component_budget <= fixed_bytes) {
        throw Error(DF_CUDA_OUT_OF_MEMORY, "CUDA component workspace cannot hold its frontier");
    }
    const auto node_capacity = std::min((component_budget - fixed_bytes) / sizeof(PostNode),
        checked_bytes(config_.width, 1025u));
    const auto row_capacity = node_capacity / output.width;
    const auto label_rows = static_cast<std::size_t>(UINT32_MAX - 1) / output.width;
    if (row_capacity < 2 || label_rows < 2) {
        throw Error(DF_CUDA_OUT_OF_MEMORY, "CUDA component workspace cannot hold one band row");
    }
    const auto band_rows = static_cast<std::uint32_t>(std::min<std::size_t>(output.height,
        std::min<std::size_t>(1024, std::min(row_capacity - 1, label_rows - 1))));
    nodes_.resize(checked_bytes(output.width, static_cast<std::size_t>(band_rows) + 1));
    frontier_labels_.resize(config_.width); frontier_pixels_.resize(config_.width);
    components_.resize(1);
    const PostComponents initial_components{0, 0, 0, UINT32_MAX};
    runtime_.upload_bytes(components_.data(), &initial_components, sizeof(initial_components));
    checked(cudaMemsetAsync(frontier_labels_.data(), 0xff, frontier_labels_.bytes(), runtime_.compute),
            "clearing CUDA initial component frontier labels");
    checked(cudaMemsetAsync(frontier_pixels_.data(), 0, frontier_pixels_.bytes(), runtime_.compute),
            "clearing CUDA initial component frontier counts");
    for (std::uint32_t row = 0; row < output.height;) {
        runtime_.check_cancelled();
        const auto rows = std::min(band_rows, output.height - row);
        const auto count = checked_bytes(output.width, static_cast<std::size_t>(rows) + 1);
        component_initialize<<<blocks_for(count), threads, 0, runtime_.compute>>>(
            output.view(), row, rows, nodes_.data(), frontier_pixels_.data());
        checked(cudaGetLastError(), "launching CUDA parallel component initialization");
        component_edges<<<blocks_for(checked_bytes(output.width, rows)), threads, 0, runtime_.compute>>>(
            output.view(), row, rows, nodes_.data(), frontier_labels_.data());
        checked(cudaGetLastError(), "launching CUDA parallel component edges");
        component_compress<<<blocks_for(count), threads, 0, runtime_.compute>>>(nodes_.data(), count);
        checked(cudaGetLastError(), "launching CUDA parallel component counts");
        checked(cudaMemsetAsync(frontier_labels_.data(), 0xff, frontier_labels_.bytes(), runtime_.compute),
                "clearing CUDA next component frontier labels");
        checked(cudaMemsetAsync(frontier_pixels_.data(), 0, frontier_pixels_.bytes(), runtime_.compute),
                "clearing CUDA next component frontier counts");
        const bool last_band = rows == output.height - row;
        if (!last_band) {
            component_frontier<<<blocks_for(output.width), threads, 0, runtime_.compute>>>(
                output.view(), row + rows - 1, rows, nodes_.data());
            checked(cudaGetLastError(), "launching CUDA parallel component frontier");
        }
        component_collect<<<blocks_for(count), threads, 0, runtime_.compute>>>(nodes_.data(), count,
            output.width, last_band, frontier_labels_.data(), frontier_pixels_.data(), components_.data());
        checked(cudaGetLastError(), "launching CUDA parallel component finalization");
        row += rows;
    }
    nodes_.mark_used(runtime_.compute);
    frontier_labels_.mark_used(runtime_.compute); frontier_pixels_.mark_used(runtime_.compute);
    components_.mark_used(runtime_.compute);
    const auto result = download_control(runtime_, components_);
    stats.total_solid_pixels = result.total_pixels;
    stats.total_solid_area_mm2 = result.total_pixels * pixel_area;
    stats.largest_area_mm2 = result.largest_pixels * pixel_area;
    stats.smallest_area_mm2 = result.area_count == 0 ? 0.0 : result.smallest_pixels * pixel_area;
    stats.area_count = result.area_count;
    return stats;
}

} // namespace dfcuda

#include "post_finish.cuh"
