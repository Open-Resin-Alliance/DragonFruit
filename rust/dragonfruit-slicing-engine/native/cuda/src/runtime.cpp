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

Memory::~Memory() { clear(); }

void Memory::initialize() {
    std::lock_guard<std::mutex> lock(mutex_);
    retune_locked();
}

void Memory::retune_locked() {
    std::size_t free_bytes = 0;
    std::size_t total_bytes = 0;
    checked(cudaMemGetInfo(&free_bytes, &total_bytes), "cudaMemGetInfo");
    const auto available = free_bytes > std::numeric_limits<std::size_t>::max() - owned_
        ? total_bytes : std::min(total_bytes, free_bytes + owned_);
    // Include our charged allocations when reconstructing available memory;
    // otherwise every allocation would shrink the job's own allowance.
    budget_ = (available / 10) * 9 + ((available % 10) * 9) / 10;
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
    std::lock_guard<std::mutex> lock(mutex_);
    retune_locked();
    if (bytes > budget_) {
        throw Error(DF_CUDA_OUT_OF_MEMORY, "required CUDA buffer exceeds the 90-percent VRAM budget");
    }

    std::size_t best = cached_.size();
    for (std::size_t i = 0; i < cached_.size(); ++i) {
        // Exact-size reuse keeps the scheduler's scratch/plane reservations
        // valid: a small image must not inherit a large retired scratch block.
        if (cached_[i].allocation.capacity != bytes) { continue; }
        const auto state = cudaEventQuery(cached_[i].completion);
        if (state == cudaErrorNotReady) { continue; }
        checked(state, "query retired allocation");
        if (best == cached_.size() || cached_[i].allocation.capacity < cached_[best].allocation.capacity) {
            best = i;
        }
    }
    if (best != cached_.size()) {
        auto result = cached_[best].allocation;
        checked(cudaEventDestroy(cached_[best].completion), "destroy allocation completion event");
        cached_.erase(cached_.begin() + static_cast<std::ptrdiff_t>(best));
        return result;
    }

    // Evict completed cached buffers only when room is actually needed. Wait
    // once for a pending retirement when it can satisfy admission, never spin.
    while (owned_ > budget_ || bytes > budget_ - owned_) {
        if (cached_.empty()) {
            throw Error(DF_CUDA_OUT_OF_MEMORY, "live CUDA working set exceeds available VRAM");
        }
        std::size_t candidate = cached_.size();
        for (std::size_t i = 0; i < cached_.size(); ++i) {
            const auto state = cudaEventQuery(cached_[i].completion);
            if (state == cudaSuccess) { candidate = i; break; }
            if (state != cudaErrorNotReady) { checked(state, "query cached allocation"); }
        }
        if (candidate == cached_.size()) {
            candidate = 0;
            checked(cudaEventSynchronize(cached_[candidate].completion), "wait for retired allocation");
        }
        auto retired = cached_[candidate];
        checked(cudaEventDestroy(retired.completion), "destroy retired allocation event");
        cached_.erase(cached_.begin() + static_cast<std::ptrdiff_t>(candidate));
        if (retired.allocation.capacity == bytes) { return retired.allocation; }
        checked(cudaFree(retired.allocation.pointer), "evict cached device allocation");
        owned_ -= retired.allocation.capacity;
        retune_locked();
    }

    void *pointer = nullptr;
    checked(cudaMalloc(&pointer, bytes), "cudaMalloc");
    owned_ += bytes;
    return {pointer, bytes};
}

void Memory::retire(Allocation allocation, cudaStream_t last_use) noexcept {
    if (allocation.pointer == nullptr) { return; }
    cudaEvent_t completion = nullptr;
    auto status = cudaEventCreateWithFlags(&completion, cudaEventDisableTiming | cudaEventBlockingSync);
    if (status == cudaSuccess) { status = cudaEventRecord(completion, last_use); }
    if (status == cudaSuccess) {
        try {
            std::lock_guard<std::mutex> lock(mutex_);
            cached_.push_back({allocation, completion});
            return;
        } catch (...) {
            cleanup_status(cudaEventSynchronize(completion), "wait before uncached allocation release");
        }
    } else {
        cleanup_status(status, "retire device allocation");
        cleanup_status(cudaStreamSynchronize(last_use), "drain allocation last-use stream");
    }
    if (completion != nullptr) { cleanup_status(cudaEventDestroy(completion), "destroy failed retirement event"); }
    const auto freed = cudaFree(allocation.pointer);
    cleanup_status(freed, "free uncached device allocation");
    if (freed == cudaSuccess) {
        std::lock_guard<std::mutex> lock(mutex_);
        owned_ -= allocation.capacity;
    }
}

void Memory::clear() noexcept {
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto &cached : cached_) {
        cleanup_status(cudaEventSynchronize(cached.completion), "drain cached allocation");
        cleanup_status(cudaEventDestroy(cached.completion), "destroy cached allocation event");
        const auto status = cudaFree(cached.allocation.pointer);
        cleanup_status(status, "free cached allocation");
        if (status == cudaSuccess) { owned_ -= cached.allocation.capacity; }
    }
    cached_.clear();
}

Runtime::Runtime()
    : owned_state_(std::make_unique<State>()), memory(owned_state_->memory),
      cancelled(owned_state_->cancelled) {
    int count = 0;
    const auto count_status = cudaGetDeviceCount(&count);
    if (count_status != cudaSuccess || count == 0) {
        throw Error(DF_CUDA_UNAVAILABLE, count_status == cudaSuccess
            ? "no CUDA device is available" : std::string("CUDA is unavailable: ") + cudaGetErrorString(count_status));
    }
    std::size_t best_free = 0;
    for (int ordinal = 0; ordinal < count; ++ordinal) {
        cudaDeviceProp properties{};
        if (cudaGetDeviceProperties(&properties, ordinal) != cudaSuccess
            || properties.major < 6 || properties.totalGlobalMem < minimum_vram) {
            continue;
        }
        if (cudaSetDevice(ordinal) != cudaSuccess) { continue; }
        std::size_t free_bytes = 0;
        std::size_t total_bytes = 0;
        if (cudaMemGetInfo(&free_bytes, &total_bytes) != cudaSuccess) { continue; }
        if (device < 0 || free_bytes > best_free) { device = ordinal; best_free = free_bytes; }
    }
    if (device < 0) {
        throw Error(DF_CUDA_UNAVAILABLE, "CUDA requires a Pascal-or-newer GPU with at least 6 GB VRAM");
    }
    activate();
    try {
        memory.initialize();
        transfer_bytes_ = host_transfer_budget();
        workspace_limit_ = memory.budget();
        checked(cudaStreamCreateWithFlags(&upload, cudaStreamNonBlocking), "create upload stream");
        checked(cudaStreamCreateWithFlags(&compute, cudaStreamNonBlocking), "create compute stream");
        checked(cudaStreamCreateWithFlags(&pack, cudaStreamNonBlocking), "create RLE packing stream");
        checked(cudaStreamCreateWithFlags(&readback, cudaStreamNonBlocking), "create readback stream");
    } catch (...) {
        destroy_stream(readback); destroy_stream(pack); destroy_stream(compute); destroy_stream(upload);
        throw;
    }
}

Runtime::Runtime(Runtime &root, std::size_t workspace_limit)
    : device(root.device), memory(root.memory), cancelled(root.cancelled),
      transfer_bytes_(root.transfer_bytes()), workspace_limit_(workspace_limit) {
    activate();
    try {
        checked(cudaStreamCreateWithFlags(&upload, cudaStreamNonBlocking), "create worker upload stream");
        checked(cudaStreamCreateWithFlags(&compute, cudaStreamNonBlocking), "create worker compute stream");
        checked(cudaStreamCreateWithFlags(&pack, cudaStreamNonBlocking), "create worker pack stream");
        checked(cudaStreamCreateWithFlags(&readback, cudaStreamNonBlocking), "create worker readback stream");
    } catch (...) {
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
