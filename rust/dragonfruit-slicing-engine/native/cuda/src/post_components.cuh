#ifndef DF_CUDA_POST_COMPONENTS_CUH
#define DF_CUDA_POST_COMPONENTS_CUH

// Only a band and its last-row frontier are resident. Each foreground pixel
// contributes four undirected edges, which cover exact 8-connectivity. Parent
// links always decrease and CAS attaches only a root: concurrent edge unions
// cannot form cycles or lose a connection, and need no host convergence loop.
__device__ std::uint32_t component_root(PostNode *nodes, std::uint32_t index) {
    auto parent = atomicCAS(&nodes[index].parent, 0u, 0u);
    while (parent != index) {
        const auto grandparent = atomicCAS(&nodes[parent].parent, 0u, 0u);
        atomicCAS(&nodes[index].parent, parent, grandparent);
        index = parent;
        parent = atomicCAS(&nodes[index].parent, 0u, 0u);
    }
    return index;
}

__device__ void component_join(PostNode *nodes, std::uint32_t a, std::uint32_t b) {
    for (;;) {
        a = component_root(nodes, a);
        b = component_root(nodes, b);
        if (a == b) return;
        const auto lo = min(a, b), hi = max(a, b);
        if (atomicCAS(&nodes[hi].parent, hi, lo) == hi) return;
    }
}

__device__ void component_add(std::uint32_t *destination, std::uint32_t value) {
    auto old = atomicCAS(destination, 0u, 0u);
    for (;;) {
        const auto previous = atomicCAS(destination, old, sat_add(old, value));
        if (previous == old) return;
        old = previous;
    }
}

__global__ void component_initialize(PlaneView output, std::uint32_t first_row,
                                     std::uint32_t rows, PostNode *nodes,
                                     const std::uint32_t *frontier_pixels) {
    const auto band_pixels = static_cast<std::size_t>(output.width) * rows;
    const auto count = band_pixels + output.width;
    for (std::size_t i = blockIdx.x * blockDim.x + threadIdx.x; i < count;
         i += static_cast<std::size_t>(gridDim.x) * blockDim.x) {
        const auto pixels = i < output.width ? frontier_pixels[i]
            : static_cast<std::uint32_t>(output.data[
                static_cast<std::size_t>(first_row) * output.width + i - output.width] != 0);
        const auto index = static_cast<std::uint32_t>(i);
        nodes[i] = {pixels == 0 ? UINT32_MAX : index, pixels, UINT32_MAX};
    }
}

__global__ void component_edges(PlaneView output, std::uint32_t first_row,
                                std::uint32_t rows, PostNode *nodes,
                                const std::uint32_t *frontier_labels) {
    const auto count = static_cast<std::size_t>(output.width) * rows;
    const auto *pixels = output.data + static_cast<std::size_t>(first_row) * output.width;
    for (std::size_t i = blockIdx.x * blockDim.x + threadIdx.x; i < count;
         i += static_cast<std::size_t>(gridDim.x) * blockDim.x) {
        if (pixels[i] == 0) continue;
        const auto x = static_cast<std::uint32_t>(i % output.width);
        const auto label = static_cast<std::uint32_t>(i + output.width);
        if (x != 0 && pixels[i - 1] != 0) component_join(nodes, label, label - 1);
        if (i >= output.width) {
            const auto previous = i - output.width;
            if (x != 0 && pixels[previous - 1] != 0)
                component_join(nodes, label, label - output.width - 1);
            if (pixels[previous] != 0) component_join(nodes, label, label - output.width);
            if (x + 1 < output.width && pixels[previous + 1] != 0)
                component_join(nodes, label, label - output.width + 1);
        } else {
            const auto lo = x == 0 ? 0 : x - 1;
            const auto hi = x + 1 < output.width ? x + 1 : x;
            for (auto previous = lo; previous <= hi; ++previous) {
                const auto other = frontier_labels[previous];
                if (other != UINT32_MAX) component_join(nodes, label, other);
            }
        }
    }
}

// Unions have completed before this launch. Non-root counts remain immutable;
// only final roots receive additions, so each band's pixels and each carried
// component's saturated count are accumulated exactly once.
__global__ void component_compress(PostNode *nodes, std::size_t count) {
    for (std::size_t i = blockIdx.x * blockDim.x + threadIdx.x; i < count;
         i += static_cast<std::size_t>(gridDim.x) * blockDim.x) {
        if (atomicCAS(&nodes[i].parent, 0u, 0u) == UINT32_MAX) continue;
        const auto index = static_cast<std::uint32_t>(i);
        const auto root = component_root(nodes, index);
        if (root != index) {
            component_add(&nodes[root].pixels, nodes[i].pixels);
            atomicExch(&nodes[i].parent, root);
        }
    }
}

__global__ void component_frontier(PlaneView output, std::uint32_t last_row,
                                   std::uint32_t rows, PostNode *nodes) {
    const auto *pixels = output.data + static_cast<std::size_t>(last_row) * output.width;
    const auto bottom = static_cast<std::size_t>(rows) * output.width;
    for (std::size_t x = blockIdx.x * blockDim.x + threadIdx.x; x < output.width;
         x += static_cast<std::size_t>(gridDim.x) * blockDim.x) {
        if (pixels[x] == 0) continue;
        const auto root = nodes[bottom + x].parent;
        atomicMin(&nodes[root].next, static_cast<std::uint32_t>(x));
    }
}

// A component not touching the bottom row cannot reconnect in any later band.
// Carry each remaining root once, indexed by its least bottom-row column; all
// bottom pixels retain that root identity, including disconnected row spans.
__global__ void component_collect(PostNode *nodes, std::size_t count,
                                  std::uint32_t width, bool last_band,
                                  std::uint32_t *frontier_labels,
                                  std::uint32_t *frontier_pixels, PostComponents *state) {
    __shared__ std::uint32_t totals[threads], areas[threads], largest[threads], smallest[threads];
    std::uint32_t total = 0, area_count = 0, hi = 0, lo = UINT32_MAX;
    const auto bottom = count - width;
    for (std::size_t i = blockIdx.x * blockDim.x + threadIdx.x; i < count;
         i += static_cast<std::size_t>(gridDim.x) * blockDim.x) {
        const auto parent = nodes[i].parent;
        if (parent == UINT32_MAX) continue;
        if (parent == i) {
            if (last_band || nodes[i].next == UINT32_MAX) {
                total = sat_add(total, nodes[i].pixels);
                area_count = sat_add(area_count, 1);
                hi = max(hi, nodes[i].pixels);
                lo = min(lo, nodes[i].pixels);
            } else frontier_pixels[nodes[i].next] = nodes[i].pixels;
        }
        if (!last_band && i >= bottom) frontier_labels[i - bottom] = nodes[parent].next;
    }
    totals[threadIdx.x] = total; areas[threadIdx.x] = area_count;
    largest[threadIdx.x] = hi; smallest[threadIdx.x] = lo;
    __syncthreads();
    for (unsigned stride = threads / 2; stride != 0; stride /= 2) {
        if (threadIdx.x < stride) {
            totals[threadIdx.x] = sat_add(totals[threadIdx.x], totals[threadIdx.x + stride]);
            areas[threadIdx.x] = sat_add(areas[threadIdx.x], areas[threadIdx.x + stride]);
            largest[threadIdx.x] = max(largest[threadIdx.x], largest[threadIdx.x + stride]);
            smallest[threadIdx.x] = min(smallest[threadIdx.x], smallest[threadIdx.x + stride]);
        }
        __syncthreads();
    }
    if (threadIdx.x == 0 && areas[0] != 0) {
        component_add(&state->total_pixels, totals[0]);
        component_add(&state->area_count, areas[0]);
        atomicMax(&state->largest_pixels, largest[0]);
        atomicMin(&state->smallest_pixels, smallest[0]);
    }
}

#endif
