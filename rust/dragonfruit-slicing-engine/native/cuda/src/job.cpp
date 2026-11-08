#include "df_cuda_slicer.h"
#include "common.h"
#include "raster.h"
#include "post.h"
#include "rle.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <exception>
#include <limits>
#include <memory>
#include <mutex>
#include <new>
#include <thread>
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
    dfcuda::RasterGeometryPtr geometry;
    std::unique_ptr<dfcuda::Rasterizer> raster;
    std::unique_ptr<dfcuda::Postprocessor> post;
    std::unique_ptr<dfcuda::RleReader> rle;
    std::mutex mutex;
    std::uint32_t tank = 0, layer = 0;
    std::uint64_t next_token = 1, next_transfer = 1;
    OutputLease output;
    Transfer transfer;
    std::uint64_t trace_runs = 0, trace_transfer_runs = 0, trace_transfers = 0;

#include "job_pool.inc"

    DfCudaJob(const DfCudaConfig &cfg, const float *xyz, std::uint64_t float_count,
              const std::uint32_t *tanks, std::uint64_t tank_count,
              const DfCudaBlock *block_data, std::uint64_t block_count)
        : config(cfg), host_xyz(xyz), host_float_count(float_count),
          host_tanks(tanks), host_tank_count(tank_count),
          blocks(),
          runtime(std::make_unique<dfcuda::Runtime>()) {
        try {
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
            runtime->trace.event("job.geometry.begin",
                "triangles=%llu model_triangles=%u width=%u height=%u layers=%u tanks=%u mode=%u samples=%u semantics=%u blocks=%zu",
                static_cast<unsigned long long>(triangle_count), config.model_triangle_count,
                config.width, config.height, config.total_layers, config.tank_count,
                config.raster_mode, config.aa_samples, config.dense_raster_semantics, blocks.size());
            raster = std::make_unique<dfcuda::Rasterizer>(*runtime, config, host_xyz,
                static_cast<std::size_t>(host_float_count), host_tanks,
                static_cast<std::size_t>(host_tank_count));
            runtime->trace.event("job.tables.begin", "");
            post = std::make_unique<dfcuda::Postprocessor>(*runtime, config);
            runtime->trace.event("job.tables.ready", "xy_radius=%u z_radius=%u", post->xy_radius(), post->z_radius());
            runtime->trace.event("job.rle.init.begin", "");
            rle = std::make_unique<dfcuda::RleReader>(*runtime, config);
            runtime->trace.event("job.rle.init.ready", "max_transfer_runs=%llu",
                static_cast<unsigned long long>(rle->max_transfer_runs()));
            initialize_pool();
        } catch (...) {
            runtime->trace.failure(std::current_exception());
            throw;
        }
    }
    ~DfCudaJob() noexcept { stop_and_drain(); }
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
    bool stats_non_empty(const Plane &plane) const noexcept {
        return plane.raster_stats_valid ? plane.raster_area_stats.total_solid_pixels != 0 : !plane.empty();
    }

    LayerInput render_input(dfcuda::Runtime &execution, dfcuda::Rasterizer &renderer,
                            dfcuda::Postprocessor &processor,
                            std::uint32_t layer_index, std::uint32_t tank_index) {
        execution.check_cancelled();
        LayerInput input;
        const bool generic = generic_legacy();
        const bool dense_blur = config.dense_raster_semantics == 1 &&
            config.raster_mode == DF_CUDA_BLUR && has_split() && config.aa_on_supports == 0;
        const bool dense_cov_split = dense_coverage() && has_split() && config.aa_on_supports == 0;
        if (dense_blur) {
            input.combined = renderer.render(layer_index, tank_index, RasterSelection::ModelForTank);
            input.model_non_empty = stats_non_empty(input.combined);
            input.source_stats_valid = input.combined.raster_stats_valid;
            input.source_stats = input.combined.raster_area_stats;
            input.topology = input.combined.bounds_valid ? input.combined.topology_bounds : Bounds{};
            input.supports = renderer.render(layer_index, tank_index, RasterSelection::BinarySupports);
            return input;
        }
        input.combined = renderer.render(layer_index, tank_index, RasterSelection::AllForTank);
        input.model_non_empty = stats_non_empty(input.combined);
        input.source_stats_valid = input.combined.raster_stats_valid;
        input.source_stats = input.combined.raster_area_stats;
        input.topology = input.combined.bounds_valid ? input.combined.topology_bounds : Bounds{};
        if ((generic || dense_cov_split) && has_split() && config.aa_on_supports == 0)
            input.supports = renderer.render(layer_index, tank_index, RasterSelection::BinarySupports);
        if (generic) {
            // The CPU pump gates topology from the ORIGINAL all-geometry raw
            // source count, before support removal. Do not re-rasterize a model
            // merely to obtain a different gate or discard raw support pixels.
            input.model_non_empty = input.source_stats.total_solid_pixels != 0;
            const bool apply_model_aa = renderer.applies_model_aa(layer_index);
            processor.prepare_legacy(input.combined, &input.supports,
                apply_model_aa && input.model_non_empty);
            input.topology = input.combined.bounds_valid ? input.combined.topology_bounds : Bounds{};
        }
        return input;
    }

    LayerSource prepare_input(dfcuda::Rasterizer &renderer, dfcuda::Postprocessor &processor,
                              LayerInput input, std::uint32_t layer_index,
                              const std::vector<Bounds> &prior,
                              const std::vector<Bounds> &future_bounds) {
        LayerSource source;
        source.layer = layer_index;
        source.topology = input.topology;
        source.model_non_empty = input.model_non_empty;
        source.source_stats_valid = input.source_stats_valid;
        source.source_stats = input.source_stats;
        const bool apply_model_aa = renderer.applies_model_aa(layer_index);
        if (generic_legacy()) {
            bool prior_has_topology = false;
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
                expand_bounds(blur_seed, processor.xy_radius(), config.width, config.height));
            if (!empty_bounds(active)) {
                dfcuda::WorkFrame frame;
                frame.x0 = static_cast<std::uint32_t>(active.x0);
                frame.y0 = static_cast<std::uint32_t>(active.y0);
                frame.width = static_cast<std::uint32_t>(active.x1 - active.x0 + 1);
                frame.height = static_cast<std::uint32_t>(active.y1 - active.y0 + 1);
                frame.blur_bounds = should_blur ? expand_bounds(blur_seed, processor.xy_radius(),
                                                                  config.width, config.height) : Bounds{};
                frame.configured = true;
                frame.apply_blur = should_blur;
                input.combined.work_frame = frame;
            }
            source.model = processor.spatial(std::move(input.combined));
            source.supports = std::move(input.supports);
            return source;
        }
        if (config.dense_raster_semantics == 1 && config.raster_mode == DF_CUDA_COVERAGE) {
            source.model = std::move(input.combined);
            source.supports = std::move(input.supports);
            return source;
        }
        source.model = processor.spatial(std::move(input.combined));
        source.supports = std::move(input.supports);
        return source;
    }

    void finalize_current() {
        std::unique_lock<std::mutex> lock(pool_mutex);
        runtime->trace.event("ordered.final.wait.begin", "layer=%u tank=%u", layer, tank);
        pool_changed.wait(lock, [&] {
            const auto center = pipeline_tank == tank ? cached(layer) : nullptr;
            return runtime->cancelled.load(std::memory_order_acquire) ||
                   (center && center->final_ready);
        });
        check_failure_locked();
        auto center = cached(layer);
        output.stats = center->final_stats;
        output.plane = std::move(center->final_plane);
        output.layer = center->layer;
        output.tank = tank;
        output.block = 0;
        runtime->trace.event("ordered.final.wait.done", "layer=%u tank=%u", output.layer, output.tank);
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
    void reset_output_rle() {
        const auto &block = blocks[output.block];
        const bool log_count = runtime->trace.enabled() &&
            (output.block == 0 || output.block + 1 == blocks.size() ||
             ((output.block + 1) & output.block) == 0);
        if (log_count) runtime->trace.event("rle.count.begin",
            "layer=%u tank=%u block=%u start_column=%u width=%u height=%u",
            output.layer, output.tank, output.block, block.start_column, block.width, config.height);
        rle->reset(output.plane.view(), block.start_column, block.width);
        if (runtime->trace.enabled()) trace_runs += rle->count();
        if (log_count) {
            runtime->trace.event("rle.count.ready", "layer=%u tank=%u block=%u run_count=%llu bytes=%llu",
                output.layer, output.tank, output.block,
                static_cast<unsigned long long>(rle->count()),
                static_cast<unsigned long long>(rle->count() * sizeof(DfCudaRun)));
        }
    }

    int next_output(DfCudaOutput *descriptor) {
        std::lock_guard<std::mutex> lock(mutex);
        runtime->activate();
        check_job();
        if (descriptor == nullptr) throw dfcuda::Error(DF_CUDA_INVALID_ARGUMENT, "null output descriptor");
        if (transfer.active) throw dfcuda::Error(DF_CUDA_INVALID_ARGUMENT, "transfer is still outstanding");
        if (output.active) throw dfcuda::Error(DF_CUDA_INVALID_ARGUMENT, "output lease is still outstanding");
        if (output.token != 0 && output.layer == layer && output.block + 1 < blocks.size()) {
            ++output.block;
            output.token = next_token++;
            if (output.token == 0) output.token = next_token++;
            reset_output_rle();
            output.plane.pixels.mark_used(runtime->pack);
            check_job();
            output.active = true;
            fill_descriptor(descriptor);
            return DF_CUDA_OK;
        }
        if (tank < config.tank_count) {
            finalize_current();
            reset_output_rle();
            output.plane.pixels.mark_used(runtime->pack);
            check_job();
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
        runtime->activate(); check_job();
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
        const bool log_readback = runtime->trace.enabled() && ((trace_transfers + 1) & trace_transfers) == 0;
        if (log_readback) runtime->trace.event("readback.begin",
            "layer=%u tank=%u block=%u first_run=%llu run_count=%llu bytes=%zu",
            output.layer, output.tank, output.block,
            static_cast<unsigned long long>(first_run), static_cast<unsigned long long>(run_count), bytes);
        Transfer pending;
        pending.token = next_transfer++;
        if (pending.token == 0) pending.token = next_transfer++;
        try {
            if (bytes != 0) pending.pin = std::make_unique<dfcuda::HostPin>(destination, bytes);
            rle->enqueue(first_run, run_count, destination);
            dfcuda::checked(cudaEventCreateWithFlags(&pending.event,
                cudaEventDisableTiming | cudaEventBlockingSync), "create RLE transfer event");
            dfcuda::checked(cudaEventRecord(pending.event, runtime->readback), "record RLE transfer event");
            check_job();
            pending.active = true;
            transfer = std::move(pending);
            *token = transfer.token;
            if (runtime->trace.enabled()) {
                trace_transfer_runs += run_count;
                ++trace_transfers;
            }
            if (log_readback) runtime->trace.event("readback.queued", "transfer_token=%llu",
                static_cast<unsigned long long>(transfer.token));
            return DF_CUDA_OK;
        } catch (...) {
            runtime->trace.failure(std::current_exception());
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
        const bool log_wait = runtime->trace.enabled() && (trace_transfers & (trace_transfers - 1)) == 0;
        if (log_wait) runtime->trace.event("readback.wait.begin", "transfer_token=%llu",
            static_cast<unsigned long long>(token));
        std::unique_ptr<dfcuda::Error> failure;
        try {
            runtime->activate();
            dfcuda::checked(cudaEventSynchronize(transfer.event), "wait for RLE transfer");
        } catch (const dfcuda::Error &error) {
            runtime->trace.failure(static_cast<int>(error.status), error.what());
            failure = std::make_unique<dfcuda::Error>(error);
        }
        catch (...) {
            runtime->trace.failure(std::current_exception());
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
        check_job();
        if (log_wait) {
            runtime->trace.event("readback.wait.done", "transfer_token=%llu", static_cast<unsigned long long>(token));
        }
        return DF_CUDA_OK;
    }

    int release_output(std::uint64_t token) {
        std::lock_guard<std::mutex> lock(mutex);
        runtime->activate();
        check_job();
        if (!output.active || output.token != token)
            throw dfcuda::Error(DF_CUDA_INVALID_ARGUMENT, "invalid output lease");
        if (transfer.active) throw dfcuda::Error(DF_CUDA_INVALID_ARGUMENT, "transfer is still outstanding");
        output.active = false;
        if (output.block + 1 < blocks.size()) return DF_CUDA_OK;
        if (runtime->trace.enabled()) runtime->trace.event("firstoutput.released",
            "layer=%u tank=%u blocks=%zu run_count=%llu rle_bytes=%llu transfers=%llu transferred_bytes=%llu",
            output.layer, output.tank, blocks.size(), static_cast<unsigned long long>(trace_runs),
            static_cast<unsigned long long>(trace_runs * sizeof(DfCudaRun)),
            static_cast<unsigned long long>(trace_transfers),
            static_cast<unsigned long long>(trace_transfer_runs * sizeof(DfCudaRun)));
        output.plane = Plane{};
        output.token = 0;
        ++layer;
        if (layer >= config.total_layers) { ++tank; layer = 0; }
        {
            std::lock_guard<std::mutex> pool_lock(pool_mutex);
            ordered_layer = layer;
            requested_tank = tank;
            changed_locked();
        }
        runtime->trace.finish();
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
    if (job != nullptr) job->cancel_pool("host_cancel_request");
}
void abort(DfCudaJob *job) noexcept { if (job != nullptr) job->stop_and_drain(); }
void report_failure(DfCudaJob *job, int status, const char *message) noexcept {
    if (job != nullptr) job->runtime->trace.failure(status, message);
    else dfcuda::Trace::unowned_failure(status, message);
}
void destroy(DfCudaJob *job) noexcept { delete job; }
}
