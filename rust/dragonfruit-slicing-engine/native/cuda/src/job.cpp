#include "df_cuda_slicer.h"
#include "common.h"
#include "raster.h"
#include "post.h"
#include "rle.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <limits>
#include <memory>
#include <mutex>
#include <new>
#include <utility>
#include <vector>

namespace {
using dfcuda::Bounds;
using dfcuda::Plane;
using dfcuda::RasterSelection;

bool empty_bounds(const Bounds &b) noexcept { return b.x1 < b.x0 || b.y1 < b.y0; }
Bounds merge_bounds(Bounds a, Bounds b) noexcept {
    if (empty_bounds(a)) return b;
    if (empty_bounds(b)) return a;
    return {std::min(a.x0, b.x0), std::min(a.y0, b.y0),
            std::max(a.x1, b.x1), std::max(a.y1, b.y1)};
}
Bounds expand_bounds(Bounds b, std::uint32_t radius,
                     std::uint32_t width, std::uint32_t height) noexcept {
    if (empty_bounds(b) || width == 0 || height == 0) return {};
    const auto r = static_cast<std::int64_t>(radius);
    b.x0 = static_cast<std::int32_t>(std::max<std::int64_t>(0, b.x0 - r));
    b.y0 = static_cast<std::int32_t>(std::max<std::int64_t>(0, b.y0 - r));
    b.x1 = static_cast<std::int32_t>(std::min<std::int64_t>(width - 1, b.x1 + r));
    b.y1 = static_cast<std::int32_t>(std::min<std::int64_t>(height - 1, b.y1 + r));
    return b;
}
bool finite_value(double value) noexcept { return std::isfinite(value); }
}

struct DfCudaJob {
    struct LayerInput {
        Plane combined, supports;
        Bounds topology;
        bool model_non_empty = false;
        bool source_stats_valid = false;
        DfCudaAreaStats source_stats{};
    };
    struct LayerSource {
        Plane model, supports;
        Bounds topology;
        std::uint32_t layer = 0;
        bool model_non_empty = false;
        bool source_stats_valid = false;
        DfCudaAreaStats source_stats{};
    };
    struct OutputLease {
        std::uint64_t token = 0;
        std::uint32_t layer = 0, tank = 0, block = 0;
        DfCudaAreaStats stats{};
        Plane plane;
        bool active = false;
    };
    struct Transfer {
        std::uint64_t token = 0;
        std::unique_ptr<dfcuda::HostPin> pin;
        cudaEvent_t event = nullptr;
        bool active = false;
    };

    DfCudaConfig config{};
    const float *host_xyz = nullptr;
    std::uint64_t host_float_count = 0;
    const std::uint32_t *host_tanks = nullptr;
    std::uint64_t host_tank_count = 0;
    std::vector<DfCudaBlock> blocks;
    std::unique_ptr<dfcuda::Runtime> runtime;
    std::unique_ptr<dfcuda::Rasterizer> raster;
    std::unique_ptr<dfcuda::Postprocessor> post;
    std::unique_ptr<dfcuda::RleReader> rle;
    std::mutex mutex;
    std::uint32_t tank = 0, layer = 0;
    std::uint64_t next_token = 1, next_transfer = 1;
    std::deque<LayerSource> history, queue;
    OutputLease output;
    Transfer transfer;

    DfCudaJob(const DfCudaConfig &cfg, const float *xyz, std::uint64_t float_count,
              const std::uint32_t *tanks, std::uint64_t tank_count,
              const DfCudaBlock *block_data, std::uint64_t block_count)
        : config(cfg), host_xyz(xyz), host_float_count(float_count),
          host_tanks(tanks), host_tank_count(tank_count),
          blocks(),
          runtime(std::make_unique<dfcuda::Runtime>()) {
        const auto triangle_count = host_float_count / 9;
        const bool valid_split = config.model_triangle_count > 0 &&
            static_cast<std::uint64_t>(config.model_triangle_count) < triangle_count;
        const bool bypass_aa = config.aa_on_supports == 0 && valid_split &&
            (config.raster_mode == DF_CUDA_BLUR ||
             (config.raster_mode == DF_CUDA_COVERAGE && config.aa_samples > 1));
        if (config.dense_raster_semantics == 0 && bypass_aa)
            config.dense_raster_semantics = 1;
        if (block_count == 0) {
            blocks.push_back({0, config.width});
        } else {
            blocks.assign(block_data, block_data + static_cast<std::size_t>(block_count));
        }
        raster = std::make_unique<dfcuda::Rasterizer>(*runtime, config, host_xyz,
            static_cast<std::size_t>(host_float_count), host_tanks,
            static_cast<std::size_t>(host_tank_count));
        post = std::make_unique<dfcuda::Postprocessor>(*runtime, config);
        rle = std::make_unique<dfcuda::RleReader>(*runtime, config);
    }
    ~DfCudaJob() noexcept {
        runtime->cancelled.store(true, std::memory_order_relaxed);
        drain_transfer_noexcept();
    }
    DfCudaJob(const DfCudaJob &) = delete;
    DfCudaJob &operator=(const DfCudaJob &) = delete;

    bool has_split() const noexcept {
        const auto count = host_float_count / 9;
        return config.model_triangle_count > 0 &&
               static_cast<std::uint64_t>(config.model_triangle_count) < count;
    }
    bool generic_legacy() const noexcept {
        return config.raster_mode == DF_CUDA_PERTURBATION && config.dense_raster_semantics == 1;
    }
    bool dense_coverage() const noexcept {
        return config.dense_raster_semantics == 1 && config.raster_mode == DF_CUDA_COVERAGE &&
               config.aa_samples > 1;
    }
    std::size_t topology_depth() const noexcept {
        return std::max<std::size_t>(config.look_back, post->z_radius());
    }
    static void append_metadata(std::deque<LayerSource> &destination,
                                const LayerSource &source) {
        LayerSource metadata;
        metadata.layer = source.layer;
        metadata.topology = source.topology;
        destination.push_back(std::move(metadata));
    }
    bool stats_non_empty(const Plane &plane) const noexcept {
        return plane.raster_stats_valid ? plane.raster_area_stats.total_solid_pixels != 0 : !plane.empty();
    }

    LayerInput render_input(std::uint32_t layer_index, std::uint32_t tank_index) {
        runtime->check_cancelled();
        LayerInput input;
        const bool generic = generic_legacy();
        const bool dense_blur = config.dense_raster_semantics == 1 &&
            config.raster_mode == DF_CUDA_BLUR && has_split() && config.aa_on_supports == 0;
        const bool dense_cov_split = dense_coverage() && has_split() && config.aa_on_supports == 0;
        if (generic || dense_blur || dense_cov_split) {
            Plane model = raster->render(layer_index, tank_index, RasterSelection::ModelForTank);
            input.model_non_empty = stats_non_empty(model);
            input.source_stats_valid = model.raster_stats_valid;
            input.source_stats = model.raster_area_stats;
            input.topology = model.bounds_valid ? model.topology_bounds : Bounds{};
            if (dense_blur) {
                input.combined = std::move(model);
                input.supports = raster->render(layer_index, tank_index, RasterSelection::BinarySupports);
                return input;
            }
            input.combined = raster->render(layer_index, tank_index, RasterSelection::AllForTank);
            if (has_split() && config.aa_on_supports == 0)
                input.supports = raster->render(layer_index, tank_index, RasterSelection::BinarySupports);
            if (dense_cov_split) input.source_stats_valid = false;
            return input;
        }
        input.combined = raster->render(layer_index, tank_index, RasterSelection::AllForTank);
        input.model_non_empty = stats_non_empty(input.combined);
        input.source_stats_valid = input.combined.raster_stats_valid;
        input.source_stats = input.combined.raster_area_stats;
        input.topology = input.combined.bounds_valid ? input.combined.topology_bounds : Bounds{};
        return input;
    }

    std::vector<Bounds> prior_bounds(const std::deque<LayerSource> &local_history) const {
        std::vector<Bounds> result;
        const auto depth = static_cast<std::size_t>(config.look_back);
        const auto first = local_history.size() > depth ? local_history.size() - depth : 0;
        for (std::size_t i = first; i < local_history.size(); ++i)
            result.push_back(local_history[i].topology);
        return result;
    }

    LayerSource prepare_input(LayerInput input, std::uint32_t layer_index,
                              const std::deque<LayerSource> &local_history,
                              const std::vector<Bounds> &future_bounds) {
        LayerSource source;
        source.layer = layer_index;
        source.topology = input.topology;
        source.model_non_empty = input.model_non_empty;
        source.source_stats_valid = input.source_stats_valid;
        source.source_stats = input.source_stats;
        const bool apply_model_aa = raster->applies_model_aa(layer_index);
        if (generic_legacy()) {
            if (apply_model_aa && input.model_non_empty)
                post->prepare_legacy(input.combined, &input.supports, true);
            else if (apply_model_aa)
                post->prepare_legacy(input.combined, nullptr, false);
            else
                input.supports = Plane{};
            if (input.combined.bounds_valid) source.topology = input.combined.topology_bounds;

            bool prior_has_topology = false;
            const auto prior = prior_bounds(local_history);
            for (const auto &bounds : prior) prior_has_topology |= !empty_bounds(bounds);
            const bool backward_applied = apply_model_aa &&
                (input.model_non_empty || prior_has_topology);
            Bounds backward_seed = source.topology;
            if (backward_applied)
                for (const auto &bounds : prior) backward_seed = merge_bounds(backward_seed, bounds);
            const bool future_has_topology = std::any_of(future_bounds.begin(), future_bounds.end(),
                [](Bounds bounds) { return !empty_bounds(bounds); });
            const bool forward_applied = apply_model_aa && !empty_bounds(source.topology) && future_has_topology;
            Bounds forward_seed = source.topology;
            if (forward_applied)
                for (const auto &bounds : future_bounds) forward_seed = merge_bounds(forward_seed, bounds);
            Bounds active;
            if (!input.combined.empty() && input.combined.bounds_valid) active = input.combined.nonzero_bounds;
            active = merge_bounds(active, input.supports.bounds_valid ? input.supports.nonzero_bounds : Bounds{});
            if (backward_applied) active = merge_bounds(active, backward_seed);
            if (forward_applied) active = merge_bounds(active, forward_seed);
            const bool should_blur = apply_model_aa &&
                (input.model_non_empty || backward_applied || forward_applied);
            Bounds blur_seed = backward_seed;
            if (forward_applied) {
                blur_seed = merge_bounds(blur_seed, source.topology);
                for (const auto &bounds : future_bounds) blur_seed = merge_bounds(blur_seed, bounds);
            }
            if (should_blur) active = merge_bounds(active,
                expand_bounds(blur_seed, post->xy_radius(), config.width, config.height));
            if (!empty_bounds(active)) {
                dfcuda::WorkFrame frame;
                frame.x0 = static_cast<std::uint32_t>(active.x0);
                frame.y0 = static_cast<std::uint32_t>(active.y0);
                frame.width = static_cast<std::uint32_t>(active.x1 - active.x0 + 1);
                frame.height = static_cast<std::uint32_t>(active.y1 - active.y0 + 1);
                frame.blur_bounds = should_blur ? expand_bounds(blur_seed, post->xy_radius(),
                                                                  config.width, config.height) : Bounds{};
                frame.configured = true;
                frame.apply_blur = should_blur;
                input.combined.work_frame = frame;
            }
            source.model = post->spatial(std::move(input.combined));
            source.supports = std::move(input.supports);
            return source;
        }
        if (config.dense_raster_semantics == 1 && config.raster_mode == DF_CUDA_COVERAGE) {
            source.model = std::move(input.combined);
            source.supports = std::move(input.supports);
            return source;
        }
        source.model = post->spatial(std::move(input.combined));
        source.supports = std::move(input.supports);
        return source;
    }

    void build_queue_initial() {
        const auto depth = topology_depth();
        std::vector<LayerInput> raw;
        raw.reserve(depth + 1);
        const auto available = static_cast<std::size_t>(config.total_layers - layer);
        const auto count = std::min(depth + 1, available);
        for (std::size_t i = 0; i < count; ++i)
            raw.push_back(render_input(layer + static_cast<std::uint32_t>(i), tank));
        std::deque<LayerSource> local_history;
        for (const auto &source : history) append_metadata(local_history, source);
        for (std::size_t i = 0; i < raw.size(); ++i) {
            std::vector<Bounds> future;
            const auto last = std::min(raw.size(), i + depth + 1);
            for (std::size_t j = i + 1; j < last; ++j) future.push_back(raw[j].topology);
            queue.push_back(prepare_input(std::move(raw[i]),
                layer + static_cast<std::uint32_t>(i), local_history, future));
            append_metadata(local_history, queue.back());
        }
    }

    void append_queue_tail() {
        const auto depth = topology_depth();
        if (queue.empty()) return;
        const auto next_layer = queue.back().layer + 1;
        if (next_layer >= config.total_layers) return;
        LayerInput input = render_input(next_layer, tank);
        std::vector<LayerInput> extra;
        extra.reserve(depth);
        const auto last = std::min<std::uint64_t>(config.total_layers,
            static_cast<std::uint64_t>(next_layer) + depth + 1);
        for (std::uint64_t index = static_cast<std::uint64_t>(next_layer) + 1; index < last; ++index)
            extra.push_back(render_input(static_cast<std::uint32_t>(index), tank));
        std::vector<Bounds> future;
        for (const auto &value : extra) future.push_back(value.topology);
        std::deque<LayerSource> local_history;
        for (const auto &source : history) append_metadata(local_history, source);
        for (const auto &value : queue) append_metadata(local_history, value);
        queue.push_back(prepare_input(std::move(input), next_layer, local_history, future));
    }

    void finalize_current() {
        if (queue.empty()) build_queue_initial();
        if (queue.empty()) throw dfcuda::Error(DF_CUDA_NUMERICAL_ERROR, "native layer queue is empty");
        LayerSource &center = queue.front();
        Plane final_plane;
        if (config.raster_mode == DF_CUDA_PERTURBATION && post->z_radius() != 0) {
            std::vector<dfcuda::WindowPlane> windows;
            windows.reserve(history.size() + queue.size());
            for (const auto &prior : history) {
                const auto distance = static_cast<std::int64_t>(prior.layer) - center.layer;
                if (distance >= -static_cast<std::int64_t>(post->z_radius()))
                    windows.push_back({prior.model.view(), static_cast<std::int32_t>(distance)});
            }
            for (const auto &future : queue) {
                const auto distance = static_cast<std::int64_t>(future.layer) - center.layer;
                if (distance <= static_cast<std::int64_t>(post->z_radius()))
                    windows.push_back({future.model.view(), static_cast<std::int32_t>(distance)});
            }
            final_plane = post->blend_z(windows.data(), windows.size());
        } else {
            final_plane = std::move(center.model);
        }
        const Plane *supports = center.supports.empty() ? nullptr : &center.supports;
        if (!dense_coverage() && config.dense_raster_semantics != 2)
            post->finish(final_plane, supports);
        if (dense_coverage() && center.source_stats_valid) output.stats = center.source_stats;
        else output.stats = post->statistics(final_plane);
        output.plane = std::move(final_plane);
        output.layer = center.layer;
        output.tank = tank;
        output.block = 0;
        output.token = next_token++;
        if (output.token == 0) output.token = next_token++;
    }

    void fill_descriptor(DfCudaOutput *descriptor) const {
        const auto &block = blocks[output.block];
        descriptor->token = output.token;
        descriptor->run_count = rle->count();
        descriptor->max_transfer_runs = rle->max_transfer_runs();
        descriptor->layer_index = output.layer;
        descriptor->tank_index = output.tank;
        descriptor->block_index = output.block;
        descriptor->start_column = block.start_column;
        descriptor->width = block.width;
        descriptor->height = config.height;
        descriptor->area_stats = output.stats;
    }

    int next_output(DfCudaOutput *descriptor) {
        std::lock_guard<std::mutex> lock(mutex);
        runtime->activate();
        runtime->check_cancelled();
        if (descriptor == nullptr) throw dfcuda::Error(DF_CUDA_INVALID_ARGUMENT, "null output descriptor");
        if (transfer.active) throw dfcuda::Error(DF_CUDA_INVALID_ARGUMENT, "transfer is still outstanding");
        if (output.active) throw dfcuda::Error(DF_CUDA_INVALID_ARGUMENT, "output lease is still outstanding");
        if (output.token != 0 && output.layer == layer && output.block + 1 < blocks.size()) {
            ++output.block;
            output.token = next_token++;
            if (output.token == 0) output.token = next_token++;
            rle->reset(output.plane.view(), blocks[output.block].start_column, blocks[output.block].width);
            output.active = true;
            fill_descriptor(descriptor);
            return DF_CUDA_OK;
        }
        while (tank < config.tank_count) {
            if (layer >= config.total_layers) {
                ++tank; layer = 0; queue.clear(); history.clear(); output.token = 0; continue;
            }
            if (blocks.empty()) { ++tank; layer = 0; continue; }
            finalize_current();
            rle->reset(output.plane.view(), blocks[0].start_column, blocks[0].width);
            output.active = true;
            fill_descriptor(descriptor);
            return DF_CUDA_OK;
        }
        return DF_CUDA_END;
    }

    int read_runs_async(std::uint64_t output_token, std::uint64_t first_run,
                        std::uint64_t run_count, DfCudaRun *destination,
                        std::uint64_t destination_capacity, std::uint64_t *token) {
        std::lock_guard<std::mutex> lock(mutex);
        runtime->activate(); runtime->check_cancelled();
        if (token == nullptr) throw dfcuda::Error(DF_CUDA_INVALID_ARGUMENT, "null transfer token");
        *token = 0;
        if (!output.active || output.token != output_token)
            throw dfcuda::Error(DF_CUDA_INVALID_ARGUMENT, "invalid output lease");
        if (transfer.active) throw dfcuda::Error(DF_CUDA_INVALID_ARGUMENT, "another transfer is outstanding");
        if (first_run > rle->count() || run_count > rle->count() - first_run ||
            run_count > rle->max_transfer_runs() || run_count > destination_capacity)
            throw dfcuda::Error(DF_CUDA_INVALID_ARGUMENT, "invalid RLE transfer range or capacity");
        if (run_count != 0 && destination == nullptr)
            throw dfcuda::Error(DF_CUDA_INVALID_ARGUMENT, "null RLE destination");
        const auto bytes = dfcuda::checked_bytes(static_cast<std::size_t>(run_count), sizeof(DfCudaRun));
        Transfer pending;
        pending.token = next_transfer++;
        if (pending.token == 0) pending.token = next_transfer++;
        try {
            if (bytes != 0) pending.pin = std::make_unique<dfcuda::HostPin>(destination, bytes);
            rle->enqueue(first_run, run_count, destination);
            dfcuda::checked(cudaEventCreateWithFlags(&pending.event,
                cudaEventDisableTiming | cudaEventBlockingSync), "create RLE transfer event");
            dfcuda::checked(cudaEventRecord(pending.event, runtime->readback), "record RLE transfer event");
            pending.active = true;
            transfer = std::move(pending);
            *token = transfer.token;
            return DF_CUDA_OK;
        } catch (...) {
            cudaStreamSynchronize(runtime->readback);
            if (pending.pin) { try { pending.pin->unregister(); } catch (...) {} pending.pin.reset(); }
            if (pending.event != nullptr) cudaEventDestroy(pending.event);
            throw;
        }
    }

    int wait_transfer(std::uint64_t token) {
        std::lock_guard<std::mutex> lock(mutex);
        if (!transfer.active || transfer.token != token)
            throw dfcuda::Error(DF_CUDA_INVALID_ARGUMENT, "invalid transfer token");
        std::unique_ptr<dfcuda::Error> failure;
        try {
            runtime->activate();
            dfcuda::checked(cudaEventSynchronize(transfer.event), "wait for RLE transfer");
        } catch (const dfcuda::Error &error) { failure = std::make_unique<dfcuda::Error>(error); }
        catch (...) {
            cudaStreamSynchronize(runtime->readback);
            if (transfer.pin) { try { transfer.pin->unregister(); } catch (...) {} transfer.pin.reset(); }
            if (transfer.event) cudaEventDestroy(transfer.event);
            transfer = {};
            throw;
        }
        cudaStreamSynchronize(runtime->readback);
        try { if (transfer.pin) transfer.pin->unregister(); }
        catch (const dfcuda::Error &error) { if (!failure) failure = std::make_unique<dfcuda::Error>(error); }
        if (transfer.event) cudaEventDestroy(transfer.event);
        transfer = {};
        if (failure) throw *failure;
        return DF_CUDA_OK;
    }

    int release_output(std::uint64_t token) {
        std::lock_guard<std::mutex> lock(mutex);
        if (!output.active || output.token != token)
            throw dfcuda::Error(DF_CUDA_INVALID_ARGUMENT, "invalid output lease");
        if (transfer.active) throw dfcuda::Error(DF_CUDA_INVALID_ARGUMENT, "transfer is still outstanding");
        output.active = false;
        if (output.block + 1 < blocks.size()) return DF_CUDA_OK;
        output.plane = Plane{};
        output.token = 0;
        if (!queue.empty()) { history.push_back(std::move(queue.front())); queue.pop_front(); }
        const auto keep = std::max<std::size_t>(topology_depth(), post->z_radius()) + 1;
        while (history.size() > keep) history.pop_front();
        ++layer;
        if (layer >= config.total_layers) {
            ++tank; layer = 0; queue.clear(); history.clear();
        } else append_queue_tail();
        return DF_CUDA_OK;
    }

    void drain_transfer_noexcept() noexcept {
        if (!transfer.active) return;
        if (runtime && runtime->device >= 0) cudaSetDevice(runtime->device);
        if (transfer.event) cudaEventSynchronize(transfer.event);
        if (runtime && runtime->readback) cudaStreamSynchronize(runtime->readback);
        if (transfer.pin) { try { transfer.pin->unregister(); } catch (...) {} transfer.pin.reset(); }
        if (transfer.event) cudaEventDestroy(transfer.event);
        transfer = {};
    }
};

namespace dfcuda_native {
DfCudaJob *create(const DfCudaConfig *config, const float *xyz, std::uint64_t float_count,
                  const std::uint32_t *tanks, std::uint64_t tank_count,
                  const DfCudaBlock *blocks, std::uint64_t block_count) {
    if (config == nullptr) throw dfcuda::Error(DF_CUDA_INVALID_ARGUMENT, "null CUDA configuration");
    if (config->abi_version != DF_CUDA_ABI_VERSION || config->struct_size < sizeof(DfCudaConfig))
        throw dfcuda::Error(DF_CUDA_INVALID_ARGUMENT, "unsupported CUDA ABI configuration");
    if (config->width == 0 || config->height == 0 || config->total_layers == 0 || config->tank_count == 0)
        throw dfcuda::Error(DF_CUDA_INVALID_ARGUMENT, "CUDA dimensions and tank count must be positive");
    if (float_count % 9 != 0 || (float_count != 0 && xyz == nullptr))
        throw dfcuda::Error(DF_CUDA_INVALID_ARGUMENT, "invalid triangle input range");
    const auto triangle_count = float_count / 9;
    if (triangle_count > std::numeric_limits<std::uint32_t>::max() ||
        config->model_triangle_count > triangle_count)
        throw dfcuda::Error(DF_CUDA_INVALID_ARGUMENT, "invalid model triangle count");
    if (config->tank_count > 1 && triangle_count != 0 && tank_count == 0)
        throw dfcuda::Error(DF_CUDA_INVALID_ARGUMENT, "multi-tank geometry requires triangle assignments");
    if (tank_count != 0 && (tanks == nullptr || tank_count != triangle_count))
        throw dfcuda::Error(DF_CUDA_INVALID_ARGUMENT, "triangle tank assignments do not match geometry");
    for (std::uint64_t i = 0; i < tank_count; ++i)
        if (tanks[i] >= config->tank_count)
            throw dfcuda::Error(DF_CUDA_INVALID_ARGUMENT, "triangle tank assignment is out of range");
    if (block_count != 0 && blocks == nullptr)
        throw dfcuda::Error(DF_CUDA_INVALID_ARGUMENT, "null RLE block list");
    if (block_count > std::numeric_limits<std::size_t>::max() / sizeof(DfCudaBlock))
        throw dfcuda::Error(DF_CUDA_OUT_OF_MEMORY, "RLE block count overflows host address space");
    for (std::uint64_t i = 0; i < block_count; ++i) {
        if (blocks[i].width == 0 || blocks[i].start_column > config->width ||
            blocks[i].width > config->width - blocks[i].start_column)
            throw dfcuda::Error(DF_CUDA_INVALID_ARGUMENT, "RLE block lies outside the frame");
        if (i != 0) {
            const auto &previous = blocks[i - 1];
            if (blocks[i].start_column < previous.start_column ||
                previous.width > blocks[i].start_column - previous.start_column)
                throw dfcuda::Error(DF_CUDA_INVALID_ARGUMENT, "RLE blocks overlap or are unordered");
        }
    }
    if (!finite_value(config->build_width_mm) || !finite_value(config->build_depth_mm) ||
        !finite_value(config->layer_height_mm) || config->build_width_mm <= 0.0f ||
        config->build_depth_mm <= 0.0f || config->layer_height_mm <= 0.0f)
        throw dfcuda::Error(DF_CUDA_INVALID_ARGUMENT, "build dimensions and layer height must be finite and positive");
    if (!finite_value(config->minimum_aa_alpha_percent) || !finite_value(config->z_blend_minimum_alpha_percent) ||
        !finite_value(config->z_blend_maximum_alpha_percent) || !finite_value(config->xy_sigma_x) ||
        !finite_value(config->xy_sigma_y) || !finite_value(config->z_sigma) ||
        !finite_value(config->dither_gamma) || !finite_value(config->generic_z_center_weight_scale))
        throw dfcuda::Error(DF_CUDA_INVALID_ARGUMENT, "CUDA numeric settings must be finite");
    if (config->raster_mode > DF_CUDA_PERTURBATION || config->sample_pattern > DF_CUDA_BASE2 ||
        config->dense_raster_semantics > 2 || config->dither_bit_depth > 8)
        throw dfcuda::Error(DF_CUDA_INVALID_ARGUMENT, "unsupported CUDA raster configuration");
    return new DfCudaJob(*config, xyz, float_count, tanks, tank_count, blocks, block_count);
}
int next_output(DfCudaJob *job, DfCudaOutput *output) { return job->next_output(output); }
int read_runs_async(DfCudaJob *job, std::uint64_t output_token, std::uint64_t first_run,
                    std::uint64_t run_count, DfCudaRun *destination,
                    std::uint64_t capacity, std::uint64_t *token) {
    return job->read_runs_async(output_token, first_run, run_count, destination, capacity, token);
}
int wait_transfer(DfCudaJob *job, std::uint64_t token) { return job->wait_transfer(token); }
int release_output(DfCudaJob *job, std::uint64_t token) { return job->release_output(token); }
void cancel(DfCudaJob *job) noexcept {
    if (job != nullptr && job->runtime) job->runtime->cancelled.store(true, std::memory_order_relaxed);
}
void destroy(DfCudaJob *job) noexcept { delete job; }
}
