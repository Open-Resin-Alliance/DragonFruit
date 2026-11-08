    struct Worker {
        std::unique_ptr<dfcuda::Runtime> execution;
        std::unique_ptr<dfcuda::Rasterizer> renderer;
        std::unique_ptr<dfcuda::Postprocessor> processor;
        std::size_t slot = 0;
        std::thread thread;
    };
    struct CachedLayer {
        std::uint32_t layer = 0;
        LayerInput raw;
        LayerSource source;
        Plane final_plane;
        DfCudaAreaStats final_stats{};
        Bounds topology;
        bool raw_queued = false, raw_ready = false;
        bool model_queued = false, model_ready = false;
        bool final_queued = false, final_ready = false;
        std::size_t readers = 0;
    };
    enum class Stage { Raw, Model, Final };
    struct Task {
        Stage stage = Stage::Raw;
        std::uint32_t tank = 0;
        std::shared_ptr<CachedLayer> center;
        std::vector<Bounds> prior, future;
        std::vector<std::shared_ptr<CachedLayer>> neighbors;
    };

    std::mutex pool_mutex, shutdown_mutex;
    std::condition_variable pool_changed, work_ready;
    std::vector<std::unique_ptr<Worker>> workers;
    std::thread coordinator;
    std::deque<Task> ready_tasks;
    std::deque<std::shared_ptr<CachedLayer>> cached_layers;
    std::optional<DfCudaError> first_failure;
    std::uint64_t generation = 0;
    std::uint32_t requested_tank = 0, pipeline_tank = 0, ordered_layer = 0;
    std::size_t outstanding = 0, prefetch = 0;
    bool joined = false;
    bool trace_first_done[3] = {false, false, false};
    static const char *stage_name(Stage stage) noexcept {
        return stage == Stage::Raw ? "raw" : stage == Stage::Model ? "model" : "final";
    }

    static std::size_t add_bytes(std::size_t a, std::size_t b) {
        if (a > std::numeric_limits<std::size_t>::max() - b)
            throw dfcuda::Error(DF_CUDA_OUT_OF_MEMORY, "CUDA pool working-set size overflow");
        return a + b;
    }
    std::size_t z_depth() const noexcept {
        return config.raster_mode == DF_CUDA_PERTURBATION ? post->z_radius() : 0;
    }
    std::size_t raw_depth() const noexcept {
        return generic_legacy() ? config.look_back : 0;
    }
    std::shared_ptr<CachedLayer> cached(std::uint32_t index) const {
        if (cached_layers.empty() || index < cached_layers.front()->layer) return {};
        const auto offset = static_cast<std::size_t>(index - cached_layers.front()->layer);
        return offset < cached_layers.size() ? cached_layers[offset] : nullptr;
    }
    std::uint32_t window_end(std::uint32_t center, std::size_t radius) const noexcept {
        return static_cast<std::uint32_t>(std::min<std::uint64_t>(config.total_layers - 1,
            static_cast<std::uint64_t>(center) + radius));
    }
    std::uint32_t window_start(std::uint32_t center, std::size_t radius) const noexcept {
        return center > radius ? static_cast<std::uint32_t>(center - radius) : 0;
    }
    void changed_locked() noexcept {
        ++generation;
        pool_changed.notify_all();
        work_ready.notify_all();
    }
    void cancel_pool_locked(const char *origin) noexcept {
        if (runtime->trace.enabled() && !runtime->cancelled.load(std::memory_order_acquire))
            runtime->trace.event("cancel.request", "origin=%s layer=%u tank=%u first_failure=%u outstanding=%zu queued=%zu",
                origin, ordered_layer, pipeline_tank, first_failure ? 1U : 0U, outstanding, ready_tasks.size());
        runtime->cancelled.store(true, std::memory_order_release);
        pool_changed.notify_all();
        work_ready.notify_all();
    }
    void cancel_pool(const char *origin) noexcept {
        // Serialize the predicate with CV waiters; no CUDA work or API lock.
        std::lock_guard<std::mutex> lock(pool_mutex);
        cancel_pool_locked(origin);
    }
    // Called only inside a catch: materialize the ABI error before logging or
    // draining streams, rather than recapturing a nullable exception pointer.
    static DfCudaError capture_pool_failure() noexcept {
        DfCudaError error{};
        const auto record = [&](DfCudaStatus status, const char *message) noexcept {
            error.code = status;
            std::snprintf(error.message, sizeof(error.message), "%s", message);
        };
        try {
            throw;
        } catch (const dfcuda::Error &failure) {
            record(failure.status, failure.what());
        } catch (const std::bad_alloc &failure) {
            record(DF_CUDA_OUT_OF_MEMORY, failure.what());
        } catch (const std::exception &failure) {
            record(DF_CUDA_EXECUTION_ERROR, failure.what());
        } catch (...) {
            record(DF_CUDA_EXECUTION_ERROR, "unknown native CUDA pool exception");
        }
        return error;
    }
    void fail_locked(const DfCudaError &failure) noexcept {
        if (!first_failure && !runtime->cancelled.load(std::memory_order_acquire))
            first_failure = failure;
        runtime->trace.failure(failure.code, failure.message);
        cancel_pool_locked("pool_failure");
        changed_locked();
    }
    void check_failure_locked() const {
        if (first_failure)
            throw dfcuda::Error(static_cast<DfCudaStatus>(first_failure->code), first_failure->message);
        runtime->check_cancelled();
    }
    void check_job() {
        std::lock_guard<std::mutex> lock(pool_mutex);
        check_failure_locked();
    }

    void initialize_pool() {
        // The root has uploaded/projected/indexed immutable geometry exactly once.
        runtime->trace.event("job.geometry.wait.begin", "");
        dfcuda::checked(cudaStreamSynchronize(runtime->compute), "publish shared CUDA geometry");
        runtime->trace.event("job.geometry.ready", "triangles=%llu width=%u height=%u",
            static_cast<unsigned long long>(host_float_count / 9), config.width, config.height);
        const auto plane = std::max<std::size_t>(1, raster->max_plane_bytes());
        geometry = raster->shared_geometry();
        const auto raster_minimum = raster->minimum_workspace_bytes();
        // Keep only the immutable assets, not the builder's upload/sort scratch.
        raster.reset();
        const auto post_minimum = post->minimum_workspace_bytes();
        const auto layers = std::min<std::size_t>(config.total_layers,
            add_bytes(add_bytes(2 * z_depth(), raw_depth()), 1));
        const auto pixels = dfcuda::checked_bytes(config.width, config.height);
        const auto tiles = pixels / 4096 + (pixels % 4096 != 0);
        const auto rle_reserve = add_bytes(runtime->transfer_bytes(),
            add_bytes(dfcuda::checked_bytes(tiles, sizeof(dfcuda::RleTileMetadata)),
                      dfcuda::checked_bytes(tiles + 1, sizeof(std::uint64_t))));
        const bool support_planes = has_split() && config.aa_on_supports == 0 &&
            (generic_legacy() || (config.dense_raster_semantics == 1 &&
             (config.raster_mode == DF_CUDA_BLUR || dense_coverage())));
        const auto slot_bytes = dfcuda::checked_bytes(plane, support_planes ? 2 : 1);
        const auto shared_live_bytes = runtime->memory.live_bytes();
        const auto fixed = add_bytes(shared_live_bytes,
            add_bytes(rle_reserve, add_bytes(dfcuda::checked_bytes(layers, slot_bytes), plane)));
        const bool source_statistics = dense_coverage() && config.compute_area_stats != 0;
        const bool post_components = config.compute_area_stats != 0 &&
            (config.raster_mode == DF_CUDA_PERTURBATION || post->xy_radius() != 0 ||
             support_planes || (config.dense_raster_semantics == 0 &&
             config.raster_mode == DF_CUDA_COVERAGE && config.aa_samples > 1));
        const auto component_minimum = config.compute_area_stats == 0 ? 0
            : dfcuda::checked_bytes(config.width, 256);
        const auto post_fixed = post_minimum - component_minimum;
        const auto needed_post_minimum = post_components ? post_minimum : post_fixed;
        auto workspace = std::max(raster_minimum, needed_post_minimum);
        const bool multiple_raw = generic_legacy() ||
            (dense_coverage() && support_planes);
        const auto temporary_planes = multiple_raw ? 3 :
            ((post->xy_radius() != 0 || source_statistics) ? 1 : 0);
        const auto transient = dfcuda::checked_bytes(plane, temporary_planes);
        // Raster's W includes its source-stat helper only in modes that use it.
        // A cached-raster-stat final does not allocate a second component band.
        auto worker_bytes = [&](std::size_t w) {
            return add_bytes(add_bytes(w, add_bytes(post_components ? w / 8 : 0, post_fixed)),
                             transient);
        };
        auto per_worker = worker_bytes(workspace);
        const auto per_ahead = add_bytes(slot_bytes, plane);
        const auto budget = runtime->memory.budget();
        cudaDeviceProp properties{};
        dfcuda::checked(cudaGetDeviceProperties(&properties, runtime->device), "read CUDA pool capabilities");
        // Resident compute grids, not CPU cores, bound independent submission slots.
        const auto grid_limit = properties.major == 6 && properties.minor != 0 ? 32U : 128U;
        const auto gpu_slots = properties.concurrentKernels
            ? std::min<unsigned>(grid_limit, std::max(2, properties.multiProcessorCount * 2)) : 1U;
        const auto cap = std::min<std::size_t>(gpu_slots, config.total_layers);
        std::size_t count = 0;
        for (std::size_t n = 1; n <= cap; ++n) {
            const auto needed = add_bytes(fixed, add_bytes(dfcuda::checked_bytes(n, per_worker),
                dfcuda::checked_bytes(n - 1, per_ahead)));
            if (needed > budget) break;
            count = n;
        }
        if (count == 0)
            throw dfcuda::Error(DF_CUDA_OUT_OF_MEMORY,
                "available VRAM cannot retain the required CUDA topology/Z window and ordered output");
        auto base = add_bytes(fixed, dfcuda::checked_bytes(count, per_worker));
        // Preserve one useful lead per admitted slot, then divide the remaining
        // allowance between wider raster/component bands and bounded layer lead.
        const auto required_lead = dfcuda::checked_bytes(count - 1, per_ahead);
        const auto spare = budget - add_bytes(base, required_lead);
        const auto extra_workspace = spare / (3 * count);
        workspace = add_bytes(workspace, extra_workspace);
        per_worker = worker_bytes(workspace);
        base = add_bytes(fixed, dfcuda::checked_bytes(count, per_worker));
        prefetch = std::min<std::size_t>({2 * count, config.total_layers - 1,
                                         (budget - base) / per_ahead});
        const auto admission_bytes = add_bytes(base, dfcuda::checked_bytes(prefetch, per_ahead));
        runtime->trace.event("pool.plan",
            "slots=%zu workspace_limit_bytes=%zu fixed_bytes=%zu admitted_bytes=%zu budget_bytes=%zu lead=%zu"
            " shared_live_bytes=%zu plane_estimate_bytes=%zu slot_plane_bytes=%zu worker_reserve_bytes=%zu"
            " rle_reserve_bytes=%zu raster_minimum_bytes=%zu post_minimum_bytes=%zu raw_depth=%zu z_depth=%zu gpu_slot_cap=%u",
            count, workspace, fixed, admission_bytes, budget, prefetch, shared_live_bytes,
            plane, slot_bytes, per_worker, rle_reserve, raster_minimum, needed_post_minimum,
            raw_depth(), z_depth(), gpu_slots);
        workers.reserve(count);
        for (std::size_t i = 0; i < count; ++i) {
            runtime->trace.event("workerinit.start", "slot=%zu workspace_limit_bytes=%zu", i, workspace);
            auto worker = std::make_unique<Worker>();
            worker->slot = i;
            worker->execution = std::make_unique<dfcuda::Runtime>(*runtime, workspace);
            worker->renderer = std::make_unique<dfcuda::Rasterizer>(
                *worker->execution, config, geometry);
            worker->processor = std::make_unique<dfcuda::Postprocessor>(
                *worker->execution, config, post->shared_tables());
            runtime->trace.event("workerinit.ready", "slot=%zu", i);
            workers.push_back(std::move(worker));
        }
        try {
            for (auto &worker : workers) {
                auto *private_worker = worker.get();
                worker->thread = std::thread([this, private_worker] { worker_loop(*private_worker); });
            }
            runtime->trace.event("pool.workers.started", "slots=%zu", workers.size());
            coordinator = std::thread([this] { coordinate(); });
        } catch (...) {
            runtime->trace.failure(std::current_exception());
            cancel_pool("worker_startup_failure");
            if (coordinator.joinable()) coordinator.join();
            for (auto &worker : workers) if (worker->thread.joinable()) worker->thread.join();
            throw;
        }
    }

    bool raw_context_ready(std::uint32_t center) const {
        const auto first = window_start(center, raw_depth());
        const auto last = window_end(center, raw_depth());
        for (std::uint64_t i = first; i <= last; ++i) {
            const auto source = cached(static_cast<std::uint32_t>(i));
            if (!source || !source->raw_ready) return false;
        }
        return true;
    }
    bool model_context_ready(std::uint32_t center) const {
        const auto first = window_start(center, z_depth());
        const auto last = window_end(center, z_depth());
        for (std::uint64_t i = first; i <= last; ++i) {
            const auto source = cached(static_cast<std::uint32_t>(i));
            if (!source || !source->model_ready) return false;
        }
        return true;
    }
    void retire_consumed_locked() {
        const auto first_model = window_start(ordered_layer, z_depth());
        for (const auto &entry : cached_layers) {
            if (entry->layer < first_model && entry->readers == 0 && entry->model_ready)
                entry->source.model = Plane{};
            if (entry->layer < ordered_layer && entry->readers == 0 && entry->final_ready)
                entry->source.supports = Plane{};
        }
        const auto first_metadata = window_start(first_model, raw_depth());
        while (!cached_layers.empty() && cached_layers.front()->layer < first_metadata)
            cached_layers.pop_front();
    }
    bool queue_ready_locked() {
        if (pipeline_tank != requested_tank) {
            if (outstanding != 0) return false;
            cached_layers.clear();
            pipeline_tank = requested_tank;
            changed_locked();
        }
        if (pipeline_tank >= config.tank_count) return false;
        retire_consumed_locked();
        const auto final_end = window_end(ordered_layer, prefetch);
        const auto model_end = window_end(final_end, z_depth());
        const auto raw_end = window_end(model_end, raw_depth());
        const auto first = cached_layers.empty() ? ordered_layer : cached_layers.back()->layer + 1;
        for (std::uint64_t i = first; i <= raw_end; ++i) {
            auto entry = std::make_shared<CachedLayer>();
            entry->layer = static_cast<std::uint32_t>(i);
            cached_layers.push_back(std::move(entry));
        }
        if (outstanding >= workers.size()) return false;
        Task task;
        task.tank = pipeline_tank;
        for (const auto &entry : cached_layers) {
            if (entry->layer < ordered_layer || entry->layer > final_end || entry->final_queued ||
                !model_context_ready(entry->layer)) continue;
            task.stage = Stage::Final;
            task.center = entry;
            const auto begin = window_start(entry->layer, z_depth());
            const auto end = window_end(entry->layer, z_depth());
            for (std::uint64_t i = begin; i <= end; ++i)
                task.neighbors.push_back(cached(static_cast<std::uint32_t>(i)));
            ready_tasks.push_back(std::move(task));
            entry->final_queued = true;
            for (const auto &source : ready_tasks.back().neighbors) ++source->readers;
            ++outstanding;
            work_ready.notify_one();
            return true;
        }
        for (const auto &entry : cached_layers) {
            if (entry->layer > model_end || entry->model_queued || !raw_context_ready(entry->layer)) continue;
            task.stage = Stage::Model;
            task.center = entry;
            const auto begin = window_start(entry->layer, raw_depth());
            const auto end = window_end(entry->layer, raw_depth());
            for (std::uint64_t i = begin; i < entry->layer; ++i)
                task.prior.push_back(cached(static_cast<std::uint32_t>(i))->topology);
            for (std::uint64_t i = static_cast<std::uint64_t>(entry->layer) + 1; i <= end; ++i)
                task.future.push_back(cached(static_cast<std::uint32_t>(i))->topology);
            ready_tasks.push_back(std::move(task));
            entry->model_queued = true;
            ++outstanding;
            work_ready.notify_one();
            return true;
        }
        for (const auto &entry : cached_layers) {
            if (entry->raw_queued) continue;
            task.stage = Stage::Raw;
            task.center = entry;
            ready_tasks.push_back(std::move(task));
            entry->raw_queued = true;
            ++outstanding;
            work_ready.notify_one();
            return true;
        }
        return false;
    }
    void coordinate() noexcept {
        try {
            runtime->activate();
            runtime->trace.event("scheduler.started", "slots=%zu lead=%zu", workers.size(), prefetch);
            std::unique_lock<std::mutex> lock(pool_mutex);
            while (!runtime->cancelled.load(std::memory_order_acquire)) {
                // The plan sizes slots from a startup budget snapshot. Its
                // unused workspace ceilings are not live allocations: a later
                // budget dip must not cancel an idle, otherwise viable pool.
                // Memory enforces the current 90-percent limit on each acquire.
                while (queue_ready_locked()) {}
                const auto observed = generation;
                pool_changed.wait(lock, [&] {
                    return runtime->cancelled.load(std::memory_order_acquire) || generation != observed;
                });
            }
        } catch (...) {
            const auto failure = capture_pool_failure();
            std::lock_guard<std::mutex> lock(pool_mutex);
            fail_locked(failure);
        }
    }
    void worker_loop(Worker &worker) noexcept {
        try {
            worker.execution->activate();
            for (;;) {
                Task task;
                {
                    std::unique_lock<std::mutex> lock(pool_mutex);
                    work_ready.wait(lock, [&] {
                        return runtime->cancelled.load(std::memory_order_acquire) || !ready_tasks.empty();
                    });
                    if (runtime->cancelled.load(std::memory_order_acquire)) return;
                    task = std::move(ready_tasks.front());
                    ready_tasks.pop_front();
                }
                LayerInput raw;
                LayerSource source;
                Plane final_plane;
                DfCudaAreaStats stats{};
                std::optional<DfCudaError> failure;
                const bool ordered_trace = worker.execution->trace.enabled() && task.center->layer == 0 && task.tank == 0;
                if (ordered_trace) worker.execution->trace.event("stage.start",
                    "stage=%s slot=%zu layer=%u tank=%u", stage_name(task.stage), worker.slot,
                    task.center->layer, task.tank);
                try {
                    if (task.stage == Stage::Raw) {
                        raw = render_input(*worker.execution, *worker.renderer, *worker.processor,
                                           task.center->layer, task.tank);
                    } else if (task.stage == Stage::Model) {
                        // Transfer retirement ownership before by-value calls can
                        // unwind an input while this worker's GPU reads are pending.
                        task.center->raw.combined.pixels.mark_used(worker.execution->compute);
                        task.center->raw.supports.pixels.mark_used(worker.execution->compute);
                        source = prepare_input(*worker.renderer, *worker.processor,
                            std::move(task.center->raw), task.center->layer, task.prior, task.future);
                    } else {
                        auto &center = task.center->source;
                        if (z_depth() != 0) {
                            std::vector<dfcuda::WindowPlane> windows;
                            windows.reserve(task.neighbors.size());
                            for (const auto &neighbor : task.neighbors) {
                                const auto distance = static_cast<std::int64_t>(neighbor->layer) - task.center->layer;
                                windows.push_back({neighbor->source.model.view(), static_cast<std::int32_t>(distance)});
                            }
                            final_plane = worker.processor->blend_z(windows.data(), windows.size());
                        } else {
                            final_plane = std::move(center.model);
                        }
                        const Plane *supports = center.supports.empty() ? nullptr : &center.supports;
                        if (!dense_coverage() && config.dense_raster_semantics != 2)
                            worker.processor->finish(final_plane, supports);
                        stats = dense_coverage() && center.source_stats_valid
                            ? center.source_stats : worker.processor->statistics(final_plane);
                    }
                    // Retained input references and immutable geometry/tables outlive
                    // this private-stream boundary; publication never relies on root compute.
                    dfcuda::checked(cudaStreamSynchronize(worker.execution->compute), "complete CUDA pool stage");
                    if (ordered_trace) worker.execution->trace.event("stage.done",
                        "stage=%s slot=%zu layer=%u tank=%u", stage_name(task.stage), worker.slot,
                        task.center->layer, task.tank);
                } catch (...) {
                    failure = capture_pool_failure();
                    worker.execution->trace.event("stage.failed", "stage=%s slot=%zu layer=%u tank=%u",
                        stage_name(task.stage), worker.slot, task.center->layer, task.tank);
                    worker.execution->trace.failure(failure->code, failure->message);
                    for (auto stream : {worker.execution->upload, worker.execution->compute,
                                        worker.execution->pack, worker.execution->readback})
                        if (stream) cudaStreamSynchronize(stream);
                }
                {
                    std::lock_guard<std::mutex> lock(pool_mutex);
                    if (failure) fail_locked(*failure);
                    if (!runtime->cancelled.load(std::memory_order_acquire)) {
                        const auto stage_index = static_cast<std::size_t>(task.stage);
                        if (runtime->trace.enabled() && !trace_first_done[stage_index]) {
                            trace_first_done[stage_index] = true;
                            runtime->trace.event("stage.first_any.done", "stage=%s slot=%zu layer=%u tank=%u",
                                stage_name(task.stage), worker.slot, task.center->layer, task.tank);
                        }
                        if (task.stage == Stage::Raw) {
                            task.center->topology = raw.topology;
                            task.center->raw = std::move(raw);
                            task.center->raw_ready = true;
                        } else if (task.stage == Stage::Model) {
                            task.center->source = std::move(source);
                            task.center->model_ready = true;
                        } else {
                            task.center->final_plane = std::move(final_plane);
                            task.center->final_stats = stats;
                            task.center->final_ready = true;
                        }
                    }
                    for (const auto &neighbor : task.neighbors) --neighbor->readers;
                    --outstanding;
                    changed_locked();
                }
            }
        } catch (...) {
            const auto failure = capture_pool_failure();
            std::lock_guard<std::mutex> lock(pool_mutex);
            fail_locked(failure);
        }
    }
    void stop_and_drain() noexcept {
        std::lock_guard<std::mutex> shutdown_lock(shutdown_mutex);
        cancel_pool("shutdown_drain");
        if (!joined) {
            if (coordinator.joinable()) coordinator.join();
            for (auto &worker : workers) if (worker->thread.joinable()) worker->thread.join();
            joined = true;
        }
        std::lock_guard<std::mutex> api_lock(mutex);
        if (runtime->device >= 0) cudaSetDevice(runtime->device);
        drain_transfer_noexcept();
        for (auto stream : {runtime->upload, runtime->compute, runtime->pack, runtime->readback})
            if (stream) cudaStreamSynchronize(stream);
        // Worker runtimes survive every buffer/reference: their stream handles are
        // still valid when Buffer retirement records its final ownership event.
        ready_tasks.clear();
        cached_layers.clear();
        output.plane = Plane{};
        output.active = false;
        output.token = 0;
    }
