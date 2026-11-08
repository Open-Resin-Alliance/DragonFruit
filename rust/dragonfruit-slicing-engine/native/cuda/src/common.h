#ifndef DF_CUDA_COMMON_H
#define DF_CUDA_COMMON_H

#include "df_cuda_slicer.h"
#include "trace.h"
#include <cuda_runtime.h>
#include <algorithm>
#include <atomic>
#include <cstddef>
#include <condition_variable>
#include <cstdint>
#include <limits>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace dfcuda {

class Error : public std::runtime_error {
public:
    Error(DfCudaStatus status, const std::string &message)
        : std::runtime_error(message), status(status) {}
    DfCudaStatus status;
};

inline void checked(cudaError_t status, const char *operation) {
    if (status != cudaSuccess) {
        throw Error(status == cudaErrorMemoryAllocation ? DF_CUDA_OUT_OF_MEMORY
                                                        : DF_CUDA_EXECUTION_ERROR,
                    std::string(operation) + ": " + cudaGetErrorString(status));
    }
}

inline std::size_t checked_bytes(std::size_t count, std::size_t element_size) {
    if (element_size != 0 && count > std::numeric_limits<std::size_t>::max() / element_size) {
        throw Error(DF_CUDA_OUT_OF_MEMORY, "CUDA allocation size overflow");
    }
    return count * element_size;
}

struct Allocation {
    void *pointer = nullptr;
    std::size_t capacity = 0;
};

/* Cached allocations stay charged and become reusable only after their
 * last-use stream event completes, including on cancellation. acquire() joins
 * only the private allocator stream, so its pointer is ready on every consumer
 * stream. Unsupported devices retain the synchronous legacy allocator. */
class Memory {
public:
    Memory() = default;
    ~Memory();
    Memory(const Memory &) = delete;
    Memory &operator=(const Memory &) = delete;
    void attach_trace(Trace &trace) noexcept { trace_ = &trace; }
    void initialize();
    Allocation acquire(std::size_t bytes);
    void retire(Allocation allocation, cudaStream_t last_use) noexcept;
    std::size_t budget();
    std::size_t owned_bytes() const;
    std::size_t live_bytes() const;
    void clear() noexcept;
private:
    struct Cached {
        Allocation allocation;
        cudaEvent_t completion = nullptr;
        bool waiting = false;
    };
    mutable std::mutex mutex_;
    std::condition_variable retirement_changed_;
    Trace *trace_ = nullptr;
    std::vector<Cached> cached_;
    cudaMemPool_t pool_ = nullptr;
    cudaStream_t allocator_stream_ = nullptr;
    cudaError_t failure_ = cudaSuccess;
    Allocation failed_allocation_;
    std::size_t owned_ = 0;
    std::size_t budget_ = 0;
    std::size_t trace_retirement_waits_ = 0;
    void retune_locked();
    cudaError_t allocate_locked(void **pointer, std::size_t bytes) noexcept;
    cudaError_t release_locked(Allocation &allocation) noexcept;
};

template<class T> class Buffer {
public:
    Buffer() = default;
    Buffer(Memory &memory, std::size_t count, cudaStream_t stream)
        : memory_(&memory), stream_(stream) { resize(count); }
    ~Buffer() { clear(); }
    Buffer(const Buffer &) = delete;
    Buffer &operator=(const Buffer &) = delete;
    Buffer(Buffer &&other) noexcept { swap(other); }
    Buffer &operator=(Buffer &&other) noexcept {
        if (this != &other) { clear(); swap(other); }
        return *this;
    }
    void initialize(Memory &memory, cudaStream_t stream) {
        if (memory_ != nullptr && memory_ != &memory) {
            throw Error(DF_CUDA_INVALID_ARGUMENT, "device buffer belongs to another job");
        }
        memory_ = &memory;
        stream_ = stream;
    }
    void resize(std::size_t count) {
        const auto bytes = checked_bytes(count, sizeof(T));
        if (bytes > allocation_.capacity) {
            if (memory_ == nullptr) {
                throw Error(DF_CUDA_INVALID_ARGUMENT, "uninitialized device buffer");
            }
            clear_allocation();
            allocation_ = memory_->acquire(bytes);
        }
        size_ = count;
    }
    T *data() const noexcept { return static_cast<T *>(allocation_.pointer); }
    std::size_t size() const noexcept { return size_; }
    std::size_t capacity() const noexcept { return allocation_.capacity / sizeof(T); }
    std::size_t bytes() const noexcept { return checked_size(); }
    void mark_used(cudaStream_t stream) noexcept { stream_ = stream; }
    void clear() noexcept { clear_allocation(); size_ = 0; }
private:
    Memory *memory_ = nullptr;
    Allocation allocation_;
    std::size_t size_ = 0;
    cudaStream_t stream_ = nullptr;
    std::size_t checked_size() const noexcept { return size_ * sizeof(T); }
    void clear_allocation() noexcept {
        if (memory_ != nullptr && allocation_.pointer != nullptr) {
            memory_->retire(allocation_, stream_);
        }
        allocation_ = {};
    }
    void swap(Buffer &other) noexcept {
        std::swap(memory_, other.memory_);
        std::swap(allocation_, other.allocation_);
        std::swap(size_, other.size_);
        std::swap(stream_, other.stream_);
    }
};

class Runtime {
private:
    struct State {
        Trace trace;
        Memory memory;
        std::atomic<bool> cancelled{false};
    };
    std::unique_ptr<State> owned_state_;
public:
    Runtime();
    Runtime(Runtime &root, std::size_t workspace_limit);
    ~Runtime();
    Runtime(const Runtime &) = delete;
    Runtime &operator=(const Runtime &) = delete;
    void activate() const;
    void check_cancelled() const;
    void upload_bytes(void *device_destination, const void *host_source, std::size_t bytes);
    std::size_t transfer_bytes() const noexcept { return transfer_bytes_; }
    std::size_t workspace_budget() const noexcept { return workspace_limit_; }
    int device = -1;
    Memory &memory;
    Trace &trace;
    cudaStream_t upload = nullptr;
    cudaStream_t compute = nullptr;
    cudaStream_t pack = nullptr;
    cudaStream_t readback = nullptr;
    std::atomic<bool> &cancelled;
private:
    std::size_t transfer_bytes_ = 0;
    std::size_t workspace_limit_ = 0;
};

class HostPin {
public:
    HostPin(void *pointer, std::size_t bytes);
    ~HostPin();
    HostPin(const HostPin &) = delete;
    HostPin &operator=(const HostPin &) = delete;
    void unregister();
private:
    void *pointer_ = nullptr;
};

struct PlaneView {
    std::uint8_t *data = nullptr;
    std::uint32_t x0 = 0;
    std::uint32_t y0 = 0;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
};

#ifdef __CUDACC__
__host__ __device__
#endif
inline std::uint8_t pixel(PlaneView plane, std::uint32_t x, std::uint32_t y) {
    if (x < plane.x0 || y < plane.y0 || x - plane.x0 >= plane.width || y - plane.y0 >= plane.height) {
        return 0;
    }
    return plane.data[static_cast<std::size_t>(y - plane.y0) * plane.width + x - plane.x0];
}

struct Bounds {
    std::int32_t x0 = 0;
    std::int32_t y0 = 0;
    std::int32_t x1 = -1;
    std::int32_t y1 = -1;
    bool empty() const noexcept { return x1 < x0 || y1 < y0; }
};

/* Generic legacy 3DAA blurs inside an explicit local work frame and ROI.
 * Unconfigured frames retain the globally sampled preferred-RLE semantics. */
struct WorkFrame {
    std::uint32_t x0 = 0;
    std::uint32_t y0 = 0;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    Bounds blur_bounds;
    bool configured = false;
    bool apply_blur = false;
};

struct Plane {
    Buffer<std::uint8_t> pixels;
    std::uint32_t x0 = 0;
    std::uint32_t y0 = 0;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    DfCudaAreaStats raster_area_stats{};
    bool raster_stats_valid = false;
    Bounds nonzero_bounds;
    Bounds topology_bounds;
    bool bounds_valid = false;
    WorkFrame work_frame;
    Plane() = default;
    Plane(Runtime &runtime, std::uint32_t x, std::uint32_t y,
          std::uint32_t w, std::uint32_t h)
        : pixels(runtime.memory, checked_bytes(w, h), runtime.compute),
          x0(x), y0(y), width(w), height(h) {}
    Plane(const Plane &) = delete;
    Plane &operator=(const Plane &) = delete;
    Plane(Plane &&) noexcept = default;
    Plane &operator=(Plane &&) noexcept = default;
    PlaneView view() const noexcept {
        return empty() ? PlaneView{} : PlaneView{pixels.data(), x0, y0, width, height};
    }
    bool empty() const noexcept { return pixels.data() == nullptr || width == 0 || height == 0; }
    std::size_t bytes() const noexcept { return pixels.bytes(); }
};

struct WindowPlane {
    PlaneView plane;
    std::int32_t layer_distance;
};

enum class RasterSelection {
    AllForTank,
    ModelForTank,
    BinarySupports
};

inline DfCudaAreaStats empty_stats() noexcept {
    DfCudaAreaStats stats{};
    return stats;
}

} // namespace dfcuda

#endif
