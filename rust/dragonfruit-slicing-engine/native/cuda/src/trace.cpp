#include "trace.h"
#include "common.h"

#include <algorithm>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <functional>
#include <mutex>
#include <thread>

namespace dfcuda {
namespace {
std::mutex stderr_mutex;
std::atomic<std::uint64_t> next_job{1};
constexpr std::size_t large_allocation = 1024 * 1024;
constexpr std::size_t allocation_detail_limit = 64;
constexpr std::size_t mutex_detail_limit = 8;
constexpr double slow_call_ms = 10.0;

bool requested() noexcept {
    const auto *value = std::getenv("DF_CUDA_TRACE");
    return value != nullptr && value[0] == '1' && value[1] == '\0';
}
double milliseconds(Trace::Clock::duration duration) noexcept {
    return std::chrono::duration<double, std::milli>(duration).count();
}
void end_line() noexcept {
    std::fputc('\n', stderr);
    std::fflush(stderr);
}
} // namespace

Trace::Trace() noexcept : configured_(requested()), active_(configured_) {
    if (configured_) {
        start_ = Clock::now();
        job_ = next_job.fetch_add(1, std::memory_order_relaxed);
    }
}

void Trace::prefix_locked(const char *event) const noexcept {
    std::fprintf(stderr, "[DF_CUDA_TRACE] HOST job=%llu elapsed_ms=%.3f thread=%zu event=%s",
        static_cast<unsigned long long>(job_), milliseconds(Clock::now() - start_),
        std::hash<std::thread::id>{}(std::this_thread::get_id()), event);
}

void Trace::event(const char *name, const char *format, ...) noexcept {
    if (!enabled()) return;
    try {
        std::lock_guard<std::mutex> lock(stderr_mutex);
        if (!enabled()) return;
        prefix_locked(name);
        if (format != nullptr && format[0] != '\0') {
            std::fputc(' ', stderr);
            va_list arguments;
            va_start(arguments, format);
            std::vfprintf(stderr, format, arguments);
            va_end(arguments);
        }
        end_line();
    } catch (...) {}
}

void Trace::failure(int status, const char *message) noexcept {
    if (!configured_) return;
    try {
        std::lock_guard<std::mutex> lock(stderr_mutex);
        if (failed_) return;
        failed_ = true;
        prefix_locked("native.error");
        // Keep native messages intact in the ABI; bound and flatten only this log.
        std::fprintf(stderr, " status=%d message=", status);
        for (std::size_t i = 0; message != nullptr && message[i] != '\0' && i < 511; ++i) {
            const char c = message[i];
            std::fputc(c == '\n' || c == '\r' ? ' ' : c, stderr);
        }
        end_line();
    } catch (...) {}
}

void Trace::failure(std::exception_ptr error) noexcept {
    if (!configured_ || !error) return;
    try {
        std::rethrow_exception(error);
    } catch (const Error &error) {
        failure(static_cast<int>(error.status), error.what());
    } catch (const std::bad_alloc &error) {
        failure(DF_CUDA_OUT_OF_MEMORY, error.what());
    } catch (const std::exception &error) {
        failure(DF_CUDA_EXECUTION_ERROR, error.what());
    } catch (...) {
        failure(DF_CUDA_EXECUTION_ERROR, "unknown native CUDA exception");
    }
}

void Trace::finish() noexcept {
    if (!enabled()) return;
    try {
        std::lock_guard<std::mutex> lock(stderr_mutex);
        if (!active_.exchange(false, std::memory_order_relaxed)) return;
        prefix_locked("trace.finished");
        std::fprintf(stderr,
            " reason=first_complete_layer requests=%zu reuses=%zu reused_bytes=%zu"
            " cudaMalloc_count=%zu cudaFree_count=%zu allocated_total_bytes=%zu"
            " allocated_peak_bytes=%zu allocator_mutex_total_ms=%.3f allocator_mutex_max_ms=%.3f",
            requests_, reuses_, reused_bytes_, mallocs_, frees_, allocated_bytes_, peak_bytes_,
            mutex_total_ms_, mutex_max_ms_);
        end_line();
    } catch (...) {}
}

Trace::Clock::time_point Trace::mutex_begin(std::size_t bytes) noexcept {
    if (!enabled()) return {};
    if (bytes >= large_allocation) {
        try {
            std::lock_guard<std::mutex> lock(stderr_mutex);
            if (enabled() && mutex_details_ < mutex_detail_limit) {
                ++mutex_details_;
                prefix_locked("memory.acquire.begin");
                std::fprintf(stderr, " bytes=%zu mutex=not_yet_acquired", bytes);
                end_line();
            }
        } catch (...) {}
    }
    return Clock::now();
}

void Trace::allocation_request(std::size_t bytes, bool reused, std::size_t owned,
                               Clock::duration mutex_wait) noexcept {
    if (!enabled()) return;
    const auto wait_ms = milliseconds(mutex_wait);
    try {
        std::lock_guard<std::mutex> lock(stderr_mutex);
        if (!enabled()) return;
        ++requests_;
        if (reused) { ++reuses_; reused_bytes_ += bytes; }
        peak_bytes_ = std::max(peak_bytes_, owned);
        mutex_total_ms_ += wait_ms;
        mutex_max_ms_ = std::max(mutex_max_ms_, wait_ms);
        if (bytes >= large_allocation && activity_details_ < mutex_detail_limit) {
            ++activity_details_;
            prefix_locked("memory.acquire.ready");
            std::fprintf(stderr,
                " bytes=%zu reused=%u requests=%zu reuses=%zu reused_bytes=%zu owned_bytes=%zu"
                " allocated_total_bytes=%zu allocated_peak_bytes=%zu allocator_mutex_wait_ms=%.3f",
                bytes, reused ? 1U : 0U, requests_, reuses_, reused_bytes_, owned,
                allocated_bytes_, peak_bytes_, wait_ms);
            end_line();
        }
        if (wait_ms >= slow_call_ms && mutex_details_ < mutex_detail_limit) {
            ++mutex_details_;
            prefix_locked("memory.mutex.wait.done");
            std::fprintf(stderr, " bytes=%zu host_wait_ms=%.3f reused=%u owned_bytes=%zu",
                         bytes, wait_ms, reused ? 1U : 0U, owned);
            end_line();
        }
    } catch (...) {}
}

Trace::AllocationCall Trace::allocation_begin(bool release, std::size_t bytes) noexcept {
    AllocationCall call;
    if (!enabled()) return call;
    call.active = true;
    if (bytes >= large_allocation) {
        try {
            std::lock_guard<std::mutex> lock(stderr_mutex);
            if (enabled() && allocation_details_ < allocation_detail_limit) {
                ++allocation_details_;
                call.logged = true;
                prefix_locked(release ? "memory.cudaFree.begin" : "memory.cudaMalloc.begin");
                std::fprintf(stderr, " bytes=%zu detail=%zu detail_limit=%zu", bytes,
                             allocation_details_, allocation_detail_limit);
                end_line();
            }
        } catch (...) {}
    }
    call.start = Clock::now();
    return call;
}

void Trace::allocation_done(bool release, std::size_t bytes, AllocationCall call,
                            int status, std::size_t owned) noexcept {
    if (!call.active || !enabled()) return;
    const auto elapsed = milliseconds(call.elapsed);
    try {
        std::lock_guard<std::mutex> lock(stderr_mutex);
        if (!enabled()) return;
        if (status == 0) {
            if (release) ++frees_;
            else { ++mallocs_; allocated_bytes_ += bytes; }
            peak_bytes_ = std::max(peak_bytes_, owned);
        }
        if (call.logged || (elapsed >= slow_call_ms && allocation_details_ < allocation_detail_limit)) {
            if (!call.logged) ++allocation_details_;
            prefix_locked(release ? "memory.cudaFree.done" : "memory.cudaMalloc.done");
            std::fprintf(stderr, " bytes=%zu host_call_ms=%.3f status=%d owned_bytes=%zu peak_bytes=%zu",
                         bytes, elapsed, status, owned, peak_bytes_);
            end_line();
        }
    } catch (...) {}
}

void Trace::unowned_failure(int status, const char *message) noexcept {
    if (!requested()) return;
    Trace trace;
    trace.failure(status, message);
}

} // namespace dfcuda
