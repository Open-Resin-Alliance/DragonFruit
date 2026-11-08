#ifndef DF_CUDA_POOL_PLAN_H
#define DF_CUDA_POOL_PLAN_H

#include <algorithm>
#include <cstddef>
#include <limits>

namespace dfcuda {

struct PoolPlan {
    std::size_t slots = 0;
    std::size_t workspace = 0;
    std::size_t lead = 0;
    std::size_t bytes = 0;
};

// worker_bytes(w) is monotone and includes w plus retained post/transient
// storage. The caller supplies the GPU-derived slot cap, never CPU core count.
// A preferred estimate is not a mandatory allocation: when it cannot fit,
// fund one context from the available budget if its true minimum can fit.
template<class WorkerBytes>
PoolPlan plan_pool(std::size_t budget, std::size_t fixed,
                   std::size_t minimum_workspace, std::size_t preferred_workspace,
                   std::size_t per_ahead, std::size_t gpu_cap,
                   std::size_t total_layers, const WorkerBytes &worker_bytes) {
    if (fixed > budget || gpu_cap == 0 || total_layers == 0) return {};
    const auto available = budget - fixed;
    const auto fits = [&](std::size_t slots, std::size_t workspace, std::size_t lead) {
        if (workspace > available) return false;
        const auto worker = worker_bytes(workspace);
        if (worker > available / slots) return false;
        const auto remaining = available - slots * worker;
        return lead == 0 || per_ahead <= remaining / lead;
    };
    if (!fits(1, minimum_workspace, 0)) return {};
    const auto cap = std::min(gpu_cap, total_layers);
    auto workspace = std::max(minimum_workspace, preferred_workspace);
    std::size_t count = 0;
    for (std::size_t n = 1; n <= cap; ++n) {
        if (!fits(n, workspace, n - 1)) break;
        count = n;
    }
    if (count == 0) {
        count = 1;
        auto low = minimum_workspace, high = available;
        while (low < high) {
            const auto distance = high - low;
            const auto middle = low + distance / 2 + distance % 2;
            if (fits(1, middle, 0)) low = middle;
            else high = middle - 1;
        }
        workspace = low;
    } else {
        const auto base = fixed + count * worker_bytes(workspace);
        const auto required_lead = (count - 1) * per_ahead;
        const auto spare = budget - base - required_lead;
        const auto extra = (spare / count) / 3;
        auto low = workspace, high = workspace + std::min(extra, budget - workspace);
        while (low < high) {
            const auto distance = high - low;
            const auto middle = low + distance / 2 + distance % 2;
            if (fits(count, middle, count - 1)) low = middle;
            else high = middle - 1;
        }
        workspace = low;
    }
    const auto base = fixed + count * worker_bytes(workspace);
    const auto doubled = count > std::numeric_limits<std::size_t>::max() / 2
        ? std::numeric_limits<std::size_t>::max() : 2 * count;
    auto lead = std::min(doubled, total_layers - 1);
    if (per_ahead != 0) lead = std::min(lead, (budget - base) / per_ahead);
    return {count, workspace, lead, base + lead * per_ahead};
}

} // namespace dfcuda
#endif
