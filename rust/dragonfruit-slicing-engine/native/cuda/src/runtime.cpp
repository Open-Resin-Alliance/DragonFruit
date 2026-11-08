#include "common.h"

#include <cstdio>
#ifdef _WIN32
#define NOMINMAX
#include <windows.h>
#endif

namespace dfcuda {
namespace {
constexpr std::size_t minimum_vram = 6000000000ULL;
constexpr std::size_t maximum_transfer = 64ULL * 1024 * 1024;

void cleanup_status(cudaError_t status, const char *operation) noexcept {
    if (status != cudaSuccess) {
        std::fprintf(stderr, "[CUDA cleanup] %s: %s\n", operation, cudaGetErrorString(status));
    }
}

std::size_t host_transfer_budget() {
#ifdef _WIN32
    MEMORYSTATUSEX state{};
    state.dwLength = sizeof(state);
    if (!GlobalMemoryStatusEx(&state)) {
        throw Error(DF_CUDA_UNAVAILABLE, "cannot determine available host memory for pinned DMA");
    }
    const auto budget = static_cast<std::size_t>(state.ullAvailPhys / 8);
    const auto bytes = std::min(maximum_transfer, budget) & ~std::size_t(4095);
    if (bytes == 0) {
        throw Error(DF_CUDA_OUT_OF_MEMORY, "insufficient host memory for a pinned transfer range");
    }
    return bytes;
#else
    throw Error(DF_CUDA_UNAVAILABLE, "this CUDA backend currently targets Windows");
#endif
}

void destroy_stream(cudaStream_t &stream) noexcept {
    if (stream != nullptr) {
        cleanup_status(cudaStreamDestroy(stream), "cudaStreamDestroy");
        stream = nullptr;
    }
}
} // namespace

Memory::~Memory() {
    clear();
    destroy_stream(allocator_stream_);
    if (pool_ != nullptr) { cleanup_status(cudaMemPoolDestroy(pool_), "destroy job memory pool"); }
}

void Memory::initialize() {
    std::lock_guard<std::mutex> lock(mutex_);
    int driver_version = 0, runtime_version = 0, device = -1, pools_supported = 0;
    checked(cudaDriverGetVersion(&driver_version), "query CUDA driver version");
    checked(cudaRuntimeGetVersion(&runtime_version), "query CUDA runtime version");
    checked(cudaGetDevice(&device), "query allocator device");
    if (driver_version >= 11020 && runtime_version >= 11020) {
        checked(cudaDeviceGetAttribute(&pools_supported, cudaDevAttrMemoryPoolsSupported, device),
                "query stream-ordered allocation support");
    }
    if (pools_supported != 0) {
        cudaMemPoolProps properties{};
        properties.allocType = cudaMemAllocationTypePinned;
        properties.handleTypes = cudaMemHandleTypeNone;
        properties.location.type = cudaMemLocationTypeDevice;
        properties.location.id = device;
        checked(cudaMemPoolCreate(&pool_, &properties), "create job memory pool");
        checked(cudaStreamCreateWithFlags(&allocator_stream_, cudaStreamNonBlocking),
                "create allocator stream");
        // All pool operations use this stream, and frees follow completed
        // last-use events. Never let the pool insert a worker-stream wait.
        int reuse_dependencies = 0;
        checked(cudaMemPoolSetAttribute(pool_, cudaMemPoolReuseFollowEventDependencies, &reuse_dependencies),
                "disable pool event-dependency reuse");
        checked(cudaMemPoolSetAttribute(pool_, cudaMemPoolReuseAllowOpportunistic, &reuse_dependencies),
                "disable pool opportunistic reuse");
        checked(cudaMemPoolSetAttribute(pool_, cudaMemPoolReuseAllowInternalDependencies, &reuse_dependencies),
                "disable pool internal-dependency reuse");
        // Retain only backing that actual demand has grown. Pointer-ready
        // joins must not release/reacquire pool backing on every allocation.
        std::uint64_t release_threshold = std::numeric_limits<std::uint64_t>::max();
        checked(cudaMemPoolSetAttribute(pool_, cudaMemPoolAttrReleaseThreshold, &release_threshold),
                "set job pool release threshold");
    }
    if (trace_ != nullptr) {
        trace_->event("memory.allocator.selected",
            "backend=%s driver_version=%d runtime_version=%d memory_pools_supported=%d allocation_timing=%s",
            pool_ != nullptr ? "stream_ordered" : "legacy", driver_version, runtime_version, pools_supported,
            pool_ != nullptr ? "api_and_allocator_stream_join" : "api");
    }
    retune_locked();
}

void Memory::retune_locked() {
    checked(failure_, "CUDA allocator readiness failed");
    std::size_t free_bytes = 0;
    std::size_t total_bytes = 0;
    checked(cudaMemGetInfo(&free_bytes, &total_bytes), "cudaMemGetInfo");
    std::uint64_t unused = 0;
    if (pool_ != nullptr) {
        std::uint64_t reserved = 0, used = 0;
        checked(cudaMemPoolGetAttribute(pool_, cudaMemPoolAttrReservedMemCurrent, &reserved),
                "query job pool reserved memory");
        checked(cudaMemPoolGetAttribute(pool_, cudaMemPoolAttrUsedMemCurrent, &used),
                "query job pool used memory");
        unused = reserved > used ? reserved - used : 0;
    }
    // Reconstruct free + charged allocations + pool-reserved-unused bytes.
    // Adding all reserved bytes would count owned allocations twice. Clamp
    // each addition before arithmetic so the 90-percent formula cannot wrap.
    auto available = std::min(total_bytes, free_bytes);
    available += std::min(owned_, total_bytes - available);
    available += static_cast<std::size_t>(std::min<std::uint64_t>(unused, total_bytes - available));
    budget_ = (available / 10) * 9 + ((available % 10) * 9) / 10;
}

cudaError_t Memory::allocate_locked(void **pointer, std::size_t bytes) noexcept {
    auto status = pool_ != nullptr
        ? cudaMallocFromPoolAsync(pointer, bytes, pool_, allocator_stream_)
        : cudaMalloc(pointer, bytes);
    if (status != cudaSuccess) { return status; }
    owned_ += bytes;
    if (pool_ != nullptr) {
        // Existing callers may immediately use the pointer on ANY job stream.
        // Joining this nonblocking stream waits for no worker compute.
        status = cudaStreamSynchronize(allocator_stream_);
        if (status != cudaSuccess) {
            failure_ = status;
            Allocation failed{*pointer, bytes};
            cleanup_status(release_locked(failed), "release allocation after readiness failure");
            failed_allocation_ = failed;
            *pointer = nullptr;
        }
    }
    return status;
}

cudaError_t Memory::release_locked(Allocation &allocation) noexcept {
    if (allocation.pointer == nullptr) { return cudaSuccess; }
    const auto bytes = allocation.capacity;
    const bool tracing = trace_ != nullptr && trace_->enabled();
    auto call = tracing ? trace_->allocation_begin(true, bytes) : Trace::AllocationCall{};
    auto status = pool_ != nullptr ? cudaFreeAsync(allocation.pointer, allocator_stream_)
                                   : cudaFree(allocation.pointer);
    if (status == cudaSuccess) {
        // An accepted asynchronous free consumes the pointer even if its join
        // reports an error. Never retry that pointer or charge it twice.
        owned_ -= bytes;
        allocation = {};
        if (pool_ != nullptr) { status = cudaStreamSynchronize(allocator_stream_); }
    }
    if (status != cudaSuccess && failure_ == cudaSuccess) { failure_ = status; }
    if (call.active) call.elapsed = Trace::Clock::now() - call.start;
    if (tracing) trace_->allocation_done(true, bytes, call, static_cast<int>(status), owned_);
    return status;
}

std::size_t Memory::budget() {
    std::lock_guard<std::mutex> lock(mutex_);
    retune_locked();
    return budget_;
}

std::size_t Memory::owned_bytes() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return owned_;
}

std::size_t Memory::live_bytes() const {
    std::lock_guard<std::mutex> lock(mutex_);
    auto live = owned_;
    for (const auto &cached : cached_) live -= cached.allocation.capacity;
    return live;
}

Allocation Memory::acquire(std::size_t bytes) {
    if (bytes == 0) { return {}; }
    const bool tracing = trace_ != nullptr && trace_->enabled();
    const auto wait_begin = tracing ? trace_->mutex_begin(bytes) : Trace::Clock::time_point{};
    std::unique_lock<std::mutex> lock(mutex_);
    const auto mutex_wait = tracing ? Trace::Clock::now() - wait_begin : Trace::Clock::duration{};
    bool evicted = false;
    for (;;) {
        retune_locked();
        if (bytes > budget_) {
            throw Error(DF_CUDA_OUT_OF_MEMORY, "required CUDA buffer exceeds the 90-percent VRAM budget");
        }

        std::size_t best = cached_.size();
        if (owned_ <= budget_) {
            for (std::size_t i = 0; i < cached_.size(); ++i) {
                // Exact-size reuse preserves scratch/plane reservations. A
                // waiter's event is pinned until it reacquires this mutex.
                if (cached_[i].waiting || cached_[i].allocation.capacity != bytes) { continue; }
                const auto state = cached_[i].completion != nullptr
                    ? cudaEventQuery(cached_[i].completion) : cudaSuccess;
                if (state == cudaErrorNotReady) { continue; }
                checked(state, "query retired allocation");
                best = i;
                break;
            }
        }
        if (best != cached_.size() || (owned_ <= budget_ && bytes <= budget_ - owned_)) {
            // Eviction is demand-driven. Trim once after a batch, not after
            // every pointer-ready join; untouched exact-size cache stays charged.
            if (evicted && pool_ != nullptr) {
                checked(cudaMemPoolTrimTo(pool_, 0), "trim evicted job pool backing");
            }
            if (best != cached_.size()) {
                auto result = cached_[best].allocation;
                if (cached_[best].completion != nullptr) {
                    checked(cudaEventDestroy(cached_[best].completion), "destroy allocation completion event");
                }
                cached_.erase(cached_.begin() + static_cast<std::ptrdiff_t>(best));
                if (tracing) trace_->allocation_request(bytes, true, owned_, mutex_wait);
                return result;
            }
            void *pointer = nullptr;
            auto call = tracing ? trace_->allocation_begin(false, bytes) : Trace::AllocationCall{};
            const auto status = allocate_locked(&pointer, bytes);
            if (call.active) call.elapsed = Trace::Clock::now() - call.start;
            if (tracing) trace_->allocation_done(false, bytes, call, static_cast<int>(status), owned_);
            checked(status, pool_ != nullptr ? "allocate and ready job pool memory" : "cudaMalloc");
            if (tracing) trace_->allocation_request(bytes, false, owned_, mutex_wait);
            return {pointer, bytes};
        }

        if (cached_.empty()) {
            throw Error(DF_CUDA_OUT_OF_MEMORY, "live CUDA working set exceeds available VRAM");
        }
        std::size_t candidate = cached_.size(), pending = cached_.size();
        for (std::size_t i = 0; i < cached_.size(); ++i) {
            if (cached_[i].waiting) { continue; }
            const auto state = cached_[i].completion != nullptr
                ? cudaEventQuery(cached_[i].completion) : cudaSuccess;
            if (state == cudaSuccess) { candidate = i; break; }
            if (state != cudaErrorNotReady) { checked(state, "query cached allocation"); }
            if (pending == cached_.size()) { pending = i; }
        }
        if (candidate == cached_.size()) {
            if (pending == cached_.size()) {
                retirement_changed_.wait(lock);
                continue;
            }
            const auto completion = cached_[pending].completion;
            const auto capacity = cached_[pending].allocation.capacity;
            cached_[pending].waiting = true;
            const bool log_wait = tracing && trace_retirement_waits_ < 8;
            if (log_wait) {
                ++trace_retirement_waits_;
                trace_->event("memory.retirement.wait.begin", "bytes=%zu", capacity);
            }
            // Budget pressure may require this specific retirement. Do not
            // hold the shared allocator lock while its worker is computing.
            lock.unlock();
            const auto state = cudaEventSynchronize(completion);
            lock.lock();
            if (state != cudaSuccess && failure_ == cudaSuccess) { failure_ = state; }
            for (auto &cached : cached_) {
                if (cached.completion == completion) { cached.waiting = false; break; }
            }
            retirement_changed_.notify_all();
            if (log_wait) trace_->event("memory.retirement.wait.done", "bytes=%zu", capacity);
            checked(state, "wait for retired allocation");
            continue;
        }
        auto &retired = cached_[candidate];
        if (retired.completion != nullptr) {
            checked(cudaEventDestroy(retired.completion), "destroy retired allocation event");
            retired.completion = nullptr;
        }
        const auto status = release_locked(retired.allocation);
        if (retired.allocation.pointer == nullptr) {
            cached_.erase(cached_.begin() + static_cast<std::ptrdiff_t>(candidate));
        }
        checked(status, "evict cached device allocation");
        evicted = true;
    }
}

void Memory::retire(Allocation allocation, cudaStream_t last_use) noexcept {
    if (allocation.pointer == nullptr) { return; }
    cudaEvent_t completion = nullptr;
    auto drained = cudaSuccess;
    auto status = cudaEventCreateWithFlags(&completion, cudaEventDisableTiming | cudaEventBlockingSync);
    if (status == cudaSuccess) { status = cudaEventRecord(completion, last_use); }
    if (status == cudaSuccess) {
        try {
            std::lock_guard<std::mutex> lock(mutex_);
            cached_.push_back({allocation, completion});
            retirement_changed_.notify_all();
            return;
        } catch (...) {
            drained = cudaEventSynchronize(completion);
            cleanup_status(drained, "wait before uncached allocation release");
        }
    } else {
        cleanup_status(status, "retire device allocation");
        drained = cudaStreamSynchronize(last_use);
        cleanup_status(drained, "drain allocation last-use stream");
    }
    if (completion != nullptr) { cleanup_status(cudaEventDestroy(completion), "destroy failed retirement event"); }
    std::lock_guard<std::mutex> lock(mutex_);
    if (drained == cudaSuccess) {
        cleanup_status(release_locked(allocation), "free uncached device allocation");
    } else if (failure_ == cudaSuccess) {
        // A failed last-use join gives no permission to free on another stream.
        // Stop new allocation/reuse and retain ownership until job teardown.
        failure_ = drained;
    }
    if (allocation.pointer != nullptr) {
        if (failed_allocation_.pointer == nullptr) {
            failed_allocation_ = allocation;
        } else {
            try { cached_.push_back({allocation, nullptr}); }
            catch (...) {
                std::fprintf(stderr, "[CUDA cleanup] cannot retain failed allocation (%zu bytes) for teardown\n",
                             allocation.capacity);
            }
        }
    }
}

void Memory::clear() noexcept {
    std::lock_guard<std::mutex> lock(mutex_);
    const bool released = !cached_.empty() || failed_allocation_.pointer != nullptr;
    std::size_t retained = 0;
    for (auto &cached : cached_) {
        if (cached.completion != nullptr) {
            cleanup_status(cudaEventSynchronize(cached.completion), "drain cached allocation");
            cleanup_status(cudaEventDestroy(cached.completion), "destroy cached allocation event");
            cached.completion = nullptr;
        }
        cleanup_status(release_locked(cached.allocation), "free cached allocation");
        if (cached.allocation.pointer != nullptr) cached_[retained++] = cached;
    }
    cached_.resize(retained);
    cleanup_status(release_locked(failed_allocation_), "free failed allocation");
    if (released && pool_ != nullptr) { cleanup_status(cudaMemPoolTrimTo(pool_, 0), "trim cleared job pool"); }
}

Runtime::Runtime()
    : owned_state_(std::make_unique<State>()), memory(owned_state_->memory),
      trace(owned_state_->trace), cancelled(owned_state_->cancelled) {
    memory.attach_trace(trace);
    trace.event("runtime.begin", "");
    try {
        int count = 0;
        const auto count_status = cudaGetDeviceCount(&count);
        if (count_status != cudaSuccess || count == 0) {
            throw Error(DF_CUDA_UNAVAILABLE, count_status == cudaSuccess
                ? "no CUDA device is available" : std::string("CUDA is unavailable: ") + cudaGetErrorString(count_status));
        }
        trace.event("device.enumeration.ready", "count=%d", count);
        std::size_t best_free = 0;
        std::size_t selected_total = 0;
        int selected_major = 0, selected_minor = 0, selected_multiprocessors = 0;
        for (int ordinal = 0; ordinal < count; ++ordinal) {
            trace.event("device.inspect.begin", "device=%d", ordinal);
            cudaDeviceProp properties{};
            if (cudaGetDeviceProperties(&properties, ordinal) != cudaSuccess
                || properties.major < 6 || properties.totalGlobalMem < minimum_vram) {
                continue;
            }
            if (cudaSetDevice(ordinal) != cudaSuccess) { continue; }
            std::size_t free_bytes = 0;
            std::size_t total_bytes = 0;
            if (cudaMemGetInfo(&free_bytes, &total_bytes) != cudaSuccess) { continue; }
            if (device < 0 || free_bytes > best_free) {
                device = ordinal; best_free = free_bytes;
                if (trace.enabled()) {
                    selected_total = properties.totalGlobalMem;
                    selected_major = properties.major;
                    selected_minor = properties.minor;
                    selected_multiprocessors = properties.multiProcessorCount;
                }
            }
        }
        if (device < 0) {
            throw Error(DF_CUDA_UNAVAILABLE, "CUDA requires a Pascal-or-newer GPU with at least 6 GB VRAM");
        }
        trace.event("device.selected", "device=%d free_bytes=%zu total_bytes=%zu cc=%d.%d multiprocessors=%d",
            device, best_free, selected_total, selected_major, selected_minor, selected_multiprocessors);
        activate();
        memory.initialize();
        transfer_bytes_ = host_transfer_budget();
        workspace_limit_ = memory.budget();
        checked(cudaStreamCreateWithFlags(&upload, cudaStreamNonBlocking), "create upload stream");
        checked(cudaStreamCreateWithFlags(&compute, cudaStreamNonBlocking), "create compute stream");
        checked(cudaStreamCreateWithFlags(&pack, cudaStreamNonBlocking), "create RLE packing stream");
        checked(cudaStreamCreateWithFlags(&readback, cudaStreamNonBlocking), "create readback stream");
        trace.event("runtime.ready", "device=%d vram_budget_bytes=%zu transfer_cap_bytes=%zu",
                    device, workspace_limit_, transfer_bytes_);
    } catch (...) {
        trace.failure(std::current_exception());
        destroy_stream(readback); destroy_stream(pack); destroy_stream(compute); destroy_stream(upload);
        throw;
    }
}

Runtime::Runtime(Runtime &root, std::size_t workspace_limit)
    : device(root.device), memory(root.memory), trace(root.trace), cancelled(root.cancelled),
      transfer_bytes_(root.transfer_bytes()), workspace_limit_(workspace_limit) {
    activate();
    try {
        checked(cudaStreamCreateWithFlags(&upload, cudaStreamNonBlocking), "create worker upload stream");
        checked(cudaStreamCreateWithFlags(&compute, cudaStreamNonBlocking), "create worker compute stream");
        checked(cudaStreamCreateWithFlags(&pack, cudaStreamNonBlocking), "create worker pack stream");
        checked(cudaStreamCreateWithFlags(&readback, cudaStreamNonBlocking), "create worker readback stream");
    } catch (...) {
        trace.failure(std::current_exception());
        destroy_stream(readback); destroy_stream(pack); destroy_stream(compute); destroy_stream(upload);
        throw;
    }
}

Runtime::~Runtime() {
    if (device >= 0) { cleanup_status(cudaSetDevice(device), "activate device for cleanup"); }
    for (auto stream : {upload, compute, pack, readback}) {
        if (stream != nullptr) { cleanup_status(cudaStreamSynchronize(stream), "drain CUDA stream"); }
    }
    if (owned_state_) memory.clear();
    destroy_stream(readback); destroy_stream(pack); destroy_stream(compute); destroy_stream(upload);
}

void Runtime::activate() const { checked(cudaSetDevice(device), "activate CUDA job device"); }

void Runtime::check_cancelled() const {
    if (cancelled.load(std::memory_order_relaxed)) {
        throw Error(DF_CUDA_CANCELLED, "cancelled");
    }
}

HostPin::HostPin(void *pointer, std::size_t bytes) : pointer_(pointer) {
    if (pointer == nullptr || bytes == 0) {
        throw Error(DF_CUDA_INVALID_ARGUMENT, "empty pinned host range");
    }
    checked(cudaHostRegister(pointer, bytes, cudaHostRegisterDefault), "register original host range");
}

HostPin::~HostPin() {
    if (pointer_ != nullptr) { cleanup_status(cudaHostUnregister(pointer_), "unregister host range during cleanup"); }
}

void HostPin::unregister() {
    if (pointer_ == nullptr) { return; }
    checked(cudaHostUnregister(pointer_), "unregister completed host range");
    pointer_ = nullptr;
}

void Runtime::upload_bytes(void *device_destination, const void *host_source, std::size_t bytes) {
    activate();
    if (bytes == 0) { return; }
    if (device_destination == nullptr || host_source == nullptr) {
        throw Error(DF_CUDA_INVALID_ARGUMENT, "null input upload buffer");
    }
    cudaEvent_t completion = nullptr;
    checked(cudaEventCreateWithFlags(&completion, cudaEventDisableTiming | cudaEventBlockingSync), "create upload event");
    try {
        const auto *source = static_cast<const std::uint8_t *>(host_source);
        auto *destination = static_cast<std::uint8_t *>(device_destination);
        for (std::size_t offset = 0; offset < bytes;) {
            check_cancelled();
            const auto length = std::min(transfer_bytes_, bytes - offset);
            HostPin pin(const_cast<std::uint8_t *>(source + offset), length);
            try {
                checked(cudaMemcpyAsync(destination + offset, source + offset, length,
                                        cudaMemcpyHostToDevice, upload), "upload original geometry range");
                checked(cudaEventRecord(completion, upload), "record input upload completion");
                checked(cudaEventSynchronize(completion), "wait for original input DMA");
                pin.unregister();
            } catch (...) {
                cleanup_status(cudaStreamSynchronize(upload), "drain failed input DMA before unpinning");
                throw;
            }
            offset += length;
        }
        checked(cudaEventDestroy(completion), "destroy completed upload event");
    } catch (...) {
        cleanup_status(cudaEventDestroy(completion), "destroy failed upload event");
        throw;
    }
}

} // namespace dfcuda
