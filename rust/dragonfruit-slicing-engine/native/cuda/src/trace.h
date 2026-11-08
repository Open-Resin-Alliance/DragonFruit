#ifndef DF_CUDA_TRACE_H
#define DF_CUDA_TRACE_H

#include <atomic>
#include <chrono>
#include <cstddef>
#include <exception>
#include <cstdint>

namespace dfcuda {

/* HOST wall time only. Logging is a leaf: callers pass already-known scalars,
 * and no trace method may acquire Memory or pool locks. */
class Trace {
public:
    using Clock = std::chrono::steady_clock;
    struct AllocationCall {
        Clock::time_point start{};
        Clock::duration elapsed{};
        bool active = false;
        bool logged = false;
    };
    Trace() noexcept;
    bool enabled() const noexcept { return active_.load(std::memory_order_relaxed); }
    void event(const char *event, const char *format, ...) noexcept;
    void failure(int status, const char *message) noexcept;
    void failure(std::exception_ptr failure) noexcept;
    void finish() noexcept;
    Clock::time_point mutex_begin(std::size_t bytes) noexcept;
    void allocation_request(std::size_t bytes, bool reused, std::size_t owned,
                            Clock::duration mutex_wait) noexcept;
    AllocationCall allocation_begin(bool release, std::size_t bytes) noexcept;
    void allocation_done(bool release, std::size_t bytes, AllocationCall call,
                         int status, std::size_t owned) noexcept;
    static void unowned_failure(int status, const char *message) noexcept;
private:
    bool configured_ = false;
    std::atomic<bool> active_{false};
    bool failed_ = false;
    Clock::time_point start_{};
    std::uint64_t job_ = 0;
    std::size_t requests_ = 0, reuses_ = 0, reused_bytes_ = 0;
    std::size_t mallocs_ = 0, frees_ = 0, allocated_bytes_ = 0, peak_bytes_ = 0;
    std::size_t allocation_details_ = 0, mutex_details_ = 0;
    std::size_t activity_details_ = 0;
    double mutex_total_ms_ = 0.0, mutex_max_ms_ = 0.0;
    void prefix_locked(const char *event) const noexcept;
};

} // namespace dfcuda

#endif
