// Included inside raster.cu's anonymous namespace, after make_span.
constexpr std::uint32_t crossing_threads = 256;

struct CrossingKey {
    __host__ __device__ std::uint32_t operator()(const RasterEdge &edge) const {
        return raster_crossing_detail::x_key(edge.x);
    }
};

// One CTA owns each phase lane for this admitted band. Its two disjoint lane
// slices retain exact history across launches; neither slice scales with rows.
// Tiles/runs are strided, so crossing_threads never caps crossing cardinality.
__global__ void band_crossings(const RasterBandRow *rows, std::uint32_t row_count,
    std::uint32_t first_row, std::uint32_t total_rows, std::uint32_t lanes,
    std::uint32_t steps, bool perturb, RasterCrossingLane *lane_state,
    RasterEdge *active_edges, RasterEdge *scratch_edges, const RasterEdge *events,
    RasterEdge *band_edges) {
    using Scan = cub::BlockScan<std::uint32_t, crossing_threads>;
    __shared__ typename Scan::TempStorage scan;
    const auto lane = blockIdx.x;
    auto &state = lane_state[lane];
    auto *active = active_edges + state.offset;
    auto *scratch = scratch_edges + state.offset;
    auto previous_count = state.count;
    for (auto row = raster_crossing_detail::first_lane_row(first_row, lane, lanes);
         row < row_count; row += lanes) {
        const auto y = first_row + row;
        if (y >= total_rows) continue; // padded terminal physical row
        const auto r = rows[row];
        std::uint32_t retained = 0;
        // Expire before appending, preserving previous sorted-row order.
        // The shared scan is reused only after every thread has consumed it.
        for (std::uint32_t first = 0; first < previous_count; first += crossing_threads) {
            const auto i = first + threadIdx.x;
            const auto edge = i < previous_count ? active[i] : RasterEdge{};
            const std::uint32_t keep = i < previous_count
                && raster_crossing_detail::alive(edge.end_exclusive, y);
            std::uint32_t rank, kept;
            Scan(scan).ExclusiveSum(keep, rank, kept);
            if (keep) scratch[retained + rank] = edge;
            retained += kept;
            __syncthreads();
        }
        for (auto i = threadIdx.x; i < r.starting; i += crossing_threads)
            scratch[retained + i] = events[r.event_offset + i];
        __syncthreads();
        const auto n = retained + r.starting; // exactly the planned r.n
        if (perturb) {
            // Same closed form and unfused operations as the old row_keys.
            const float phase = div(add(static_cast<float>(y % steps), 0.5f), static_cast<float>(steps));
            const float sample = add(static_cast<float>(y / steps), phase);
            for (auto i = threadIdx.x; i < n; i += crossing_threads) {
                auto &edge = scratch[i];
                edge.x = add(edge.base_x, mul(sub(sample, edge.base_y), edge.dx_dy));
            }
        }
        __syncthreads();
        auto *source = scratch;
        auto *destination = active;
        // Stable bottom-up parallel merging: every thread scatters to unique
        // ranks in the other slice, followed by a CTA-wide publication barrier.
        // Equal keys retain history first, then this row's event insertion order.
        for (std::uint32_t width = 1; width < n; width *= 2) {
            const auto run = width * 2;
            for (auto i = threadIdx.x; i < n; i += crossing_threads) {
                const auto begin = i / run * run;
                const auto middle = min(begin + width, n), end = min(begin + run, n);
                const auto at = raster_crossing_detail::merge_destination(source, i, begin, middle, end, CrossingKey{});
                destination[at] = source[i];
            }
            __syncthreads();
            auto *swap = source; source = destination; destination = swap;
        }
        for (auto i = threadIdx.x; i < n; i += crossing_threads) {
            auto edge = source[i];
            band_edges[r.offset + i] = edge;
            // Advance only AFTER retaining the current sorted row. No FMA or
            // closed-form replacement is valid for non-perturbation history.
            if (!perturb) edge.x = add(edge.x, edge.dx_dy);
            active[i] = edge;
        }
        __syncthreads();
        previous_count = n;
    }
    if (!threadIdx.x) state.count = previous_count;
}

struct BandPointers {
    RasterBandRow *rows;
    RasterEdge *edges, *collapsed;
    RasterSpan *spans, *positive, *negative, *previous;
    RasterPair *pairs, *pairs_out;
    RasterOrphan *orphans, *orphans_out;
    float *open, *endpoints, *endpoints_out, *float_keys;
    std::uint64_t *flags, *prefix, *next_exit, *winding, *winding_prefix;
    std::uint32_t *frontier;
    RasterState *state;
    std::uint32_t items;
};

__host__ __device__ std::uint64_t band_value(std::uint32_t row, std::uint32_t value) {
    return (static_cast<std::uint64_t>(row) << 32) | value;
}
struct BandSum {
    __host__ __device__ std::uint64_t operator()(std::uint64_t a, std::uint64_t b) const {
        return a >> 32 == b >> 32 ? (b & 0xffffffff00000000ull) | static_cast<std::uint32_t>(a + b) : b;
    }
};
struct BandMin {
    __host__ __device__ std::uint64_t operator()(std::uint64_t a, std::uint64_t b) const {
        return a >> 32 == b >> 32 ? (b & 0xffffffff00000000ull)
            | (static_cast<std::uint32_t>(a) < static_cast<std::uint32_t>(b) ? static_cast<std::uint32_t>(a) : static_cast<std::uint32_t>(b)) : b;
    }
};
struct BandOffset {
    const RasterBandRow *rows;
    std::uint32_t row_count, items, multiplier;
    bool end;
    __host__ __device__ std::uint32_t operator()(std::uint32_t i) const {
        const auto r = rows[i % row_count];
        return (r.offset + (end ? r.n : 0) + i / row_count * items) * multiplier;
    }
};

__global__ void band_winds(BandPointers p) {
    const auto r = p.rows[blockIdx.y];
    for (auto i = blockIdx.x * blockDim.x + threadIdx.x; i < r.n; i += blockDim.x * gridDim.x)
        p.winding[r.offset + i] = band_value(blockIdx.y,
            static_cast<std::uint32_t>(isfinite(p.edges[r.offset + i].x) ? p.edges[r.offset + i].wind : 0));
}

__global__ void band_naive(BandPointers p, std::uint32_t width, bool snap) {
    auto &r = p.rows[blockIdx.y];
    for (auto i = blockIdx.x * blockDim.x + threadIdx.x; i < r.n; i += blockDim.x * gridDim.x) {
        const auto at = r.offset + i;
        const auto w = static_cast<std::int32_t>(p.winding_prefix[at]);
        atomicMin(&r.minimum, w); atomicMax(&r.maximum, w);
        RasterSpan s;
        const bool valid = i + 1 < r.n && w != 0 && isfinite(p.edges[at].x)
            && isfinite(p.edges[at + 1].x) && make_span(p.edges[at].x, p.edges[at + 1].x, width, snap, s);
        p.flags[at] = band_value(blockIdx.y, valid);
        if (valid) p.positive[at] = s; // transient, before repair candidates
    }
}

__global__ void band_compact(BandPointers p) {
    auto &r = p.rows[blockIdx.y];
    for (auto i = blockIdx.x * blockDim.x + threadIdx.x; i < r.n; i += blockDim.x * gridDim.x) {
        const auto at = r.offset + i;
        if (static_cast<std::uint32_t>(p.flags[at]))
            p.spans[r.offset + static_cast<std::uint32_t>(p.prefix[at]) - 1] = p.positive[at];
    }
    if (!blockIdx.x && !threadIdx.x) {
        r.count = r.n ? static_cast<std::uint32_t>(p.prefix[r.offset + r.n - 1]) : 0;
        r.defective = r.n && (static_cast<std::int32_t>(p.winding_prefix[r.offset + r.n - 1]) != 0
            || (r.minimum < 0 && r.maximum > 0));
    }
}

// Only defective rows execute these stack walks. Each launch advances at most
// serial_items crossings/pairs; padding is sorted by parallel CUB primitives.
__global__ void band_repair_step(BandPointers p, std::uint32_t stage, std::int32_t orientation,
                                  std::uint32_t width, bool snap) {
    auto &r = p.rows[blockIdx.x];
    if (!r.defective || threadIdx.x) return;
    const auto offset = r.offset + blockIdx.z * p.items;
    if (!orientation) orientation = blockIdx.z ? -1 : 1;
    auto &s = p.state[blockIdx.x + blockIdx.z * gridDim.x];
    auto *edges = p.collapsed + r.offset;
    auto *pairs = p.pairs + offset;
    auto *orphans = p.orphans + offset;
    auto *open = p.open + offset;
    if (stage == 0) {
        const auto end = min(r.n, s.cursor + serial_items);
        for (; s.cursor < end; ++s.cursor) {
            const auto e = p.edges[r.offset + s.cursor];
            const bool cancel = s.count && isfinite(e.x) && isfinite(edges[s.count - 1].x)
                && edges[s.count - 1].wind + e.wind == 0 && sub(e.x, edges[s.count - 1].x) < 1.0f;
            if (cancel) --s.count; else edges[s.count++] = e;
        }
    } else if (stage == 1) {
        const auto n = r.collapsed_count;
        const auto end = min(n, s.cursor + serial_items);
        while (s.cursor < end) {
            const auto e = edges[s.cursor];
            if (!isfinite(e.x)) { s.cursor = n; break; }
            int w = e.wind * orientation;
            if (w == -1 && !s.open_count && s.cursor + 2 < n) {
                const auto entry = edges[s.cursor + 1];
                const auto exit = static_cast<std::uint32_t>(p.next_exit[offset + s.cursor + 2]);
                if (isfinite(entry.x) && entry.wind * orientation == 1 && entry.x > e.x
                    && exit < n && sub(entry.x, e.x) < sub(edges[exit].x, entry.x)) {
                    s.cursor += 2; continue;
                }
            }
            while (w > 0) { open[s.open_count++] = e.x; --w; }
            while (w < 0) {
                ++w;
                if (s.open_count) {
                    const float x = open[--s.open_count];
                    if (e.x > x) pairs[s.pair_count++] = {x, e.x};
                } else orphans[s.orphan_count++] = {e.x, -1};
            }
            ++s.cursor;
        }
    } else if (stage == 2) {
        const auto n = s.orphan_count + s.open_count;
        const auto end = min(n / 2, s.cursor + serial_items);
        for (; s.cursor < end; ++s.cursor) {
            const auto a = p.orphans_out[offset + s.cursor * 2];
            const auto b = p.orphans_out[offset + s.cursor * 2 + 1];
            std::uint32_t lo = 0, hi = r.matches[orientation < 0] * 2;
            const auto *endpoints = p.endpoints_out + static_cast<std::size_t>(offset) * 2;
            while (lo < hi) {
                const auto mid = lo + (hi - lo) / 2;
                if (endpoints[mid] <= a.x) lo = mid + 1; else hi = mid;
            }
            const bool crosses = lo < r.matches[orientation < 0] * 2 && endpoints[lo] < b.x;
            if (!(a.wind < 0 && b.wind > 0) && !crosses && b.x > a.x)
                pairs[s.pair_count++] = {a.x, b.x};
        }
    } else {
        auto *output = (orientation > 0 ? p.positive : p.negative) + r.offset;
        const auto n = r.repaired[orientation < 0];
        const auto end = min(n, s.cursor + serial_items);
        for (; s.cursor < end; ++s.cursor) {
            const auto pair = p.pairs_out[offset + s.cursor];
            if (!s.merge_live) { s.merge_a = pair.a; s.merge_b = pair.b; s.merge_live = 1; }
            else if (pair.a <= s.merge_b) s.merge_b = fmaxf(s.merge_b, pair.b);
            else {
                RasterSpan span;
                if (make_span(s.merge_a, s.merge_b, width, snap, span)) output[s.count++] = span;
                s.merge_a = pair.a; s.merge_b = pair.b;
            }
        }
        if (s.cursor == n && s.merge_live) {
            RasterSpan span;
            if (make_span(s.merge_a, s.merge_b, width, snap, span)) output[s.count++] = span;
            s.merge_live = 0;
        }
    }
}

__global__ void band_repair_prepare(BandPointers p, std::uint32_t stage, std::int32_t orientation) {
    auto &r = p.rows[blockIdx.y];
    const auto offset = r.offset + blockIdx.z * p.items;
    const auto row = blockIdx.y + blockIdx.z * gridDim.y;
    if (!orientation) orientation = blockIdx.z ? -1 : 1;
    auto &s = p.state[row];
    if (!r.defective) {
        // Sorting padded healthy segments does not consume uninitialized data.
        for (auto i = blockIdx.x * blockDim.x + threadIdx.x; i < r.n; i += blockDim.x * gridDim.x) {
            p.flags[offset + i] = band_value(row, UINT_MAX);
            p.float_keys[offset + i] = CUDART_INF_F;
            p.orphans[offset + i] = {CUDART_INF_F, 0};
            p.pairs[offset + i] = {CUDART_INF_F, CUDART_INF_F};
            p.endpoints[static_cast<std::size_t>(offset) * 2 + i * 2] = CUDART_INF_F;
            p.endpoints[static_cast<std::size_t>(offset) * 2 + i * 2 + 1] = CUDART_INF_F;
        }
        return;
    }
    if (stage == 0) {
        const auto n = r.collapsed_count;
        for (auto i = blockIdx.x * blockDim.x + threadIdx.x; i < r.n; i += blockDim.x * gridDim.x) {
            p.flags[offset + i] = band_value(row, i < n && isfinite(p.collapsed[r.offset + i].x)
                && p.collapsed[r.offset + i].wind * orientation < 0 ? i : UINT_MAX);
        }
    } else if (stage == 1) {
        for (auto i = blockIdx.x * blockDim.x + threadIdx.x; i < r.n; i += blockDim.x * gridDim.x) {
            RasterOrphan orphan{CUDART_INF_F, 0};
            if (i < s.orphan_count) orphan = p.orphans[offset + i];
            else if (i < s.orphan_count + s.open_count) orphan = {p.open[offset + i - s.orphan_count], 1};
            p.orphans[offset + i] = orphan;
            p.float_keys[offset + i] = orphan.x;
            const auto pair = i < s.pair_count ? p.pairs[offset + i] : RasterPair{CUDART_INF_F, CUDART_INF_F};
            p.endpoints[static_cast<std::size_t>(offset) * 2 + i * 2] = pair.a;
            p.endpoints[static_cast<std::size_t>(offset) * 2 + i * 2 + 1] = pair.b;
        }
        // No other thread reads cursor or matches in this launch.
        if (!blockIdx.x && !threadIdx.x) { r.matches[orientation < 0] = s.pair_count; s.cursor = 0; }
    } else if (stage == 2) {
        for (auto i = blockIdx.x * blockDim.x + threadIdx.x; i < r.n; i += blockDim.x * gridDim.x) {
            const auto pair = i < s.pair_count ? p.pairs[offset + i] : RasterPair{CUDART_INF_F, CUDART_INF_F};
            p.pairs[offset + i] = pair;
            p.float_keys[offset + i] = pair.a;
        }
        if (!blockIdx.x && !threadIdx.x) r.repaired[orientation < 0] = s.pair_count;
    } else if (!blockIdx.x && !threadIdx.x) {
        if (stage == 4) r.collapsed_count = s.count;
        else r.repaired[orientation < 0] = s.count;
    }
}

__device__ const RasterSpan *band_candidate(BandPointers p, const RasterBandRow &r, unsigned orientation) {
    return (r.defective ? (orientation ? p.negative : p.positive) : p.spans) + r.offset;
}
__device__ std::uint32_t band_count(const RasterBandRow &r, unsigned orientation) {
    return r.defective ? r.repaired[orientation] : r.count;
}
__device__ std::uint64_t band_overlap(RasterSpan s, const RasterSpan *previous, std::uint32_t n) {
    std::uint32_t lo = 0, hi = n;
    while (lo < hi) {
        const auto mid = lo + (hi - lo) / 2;
        if (previous[mid].end < s.start) lo = mid + 1; else hi = mid;
    }
    std::uint64_t result = 0;
    for (auto j = lo; j < n && previous[j].start <= s.end; ++j) {
        const auto left = max(s.start, previous[j].start), right = min(s.end, previous[j].end);
        if (right >= left) result += static_cast<std::uint64_t>(right) - left + 1;
    }
    return result;
}
__global__ void band_evidence(BandPointers p) {
    auto &r = p.rows[blockIdx.y];
    for (unsigned orientation = 0; orientation < 2; ++orientation) {
        const auto *candidate = band_candidate(p, r, orientation);
        const auto n = band_count(r, orientation);
        for (auto i = blockIdx.x * blockDim.x + threadIdx.x; i < n; i += blockDim.x * gridDim.x) {
            const auto span = candidate[i];
            atomicAdd(reinterpret_cast<unsigned long long *>(&r.area[orientation]),
                      static_cast<unsigned long long>(span.end) - span.start + 1);
            for (unsigned prev = 0; prev < 2; ++prev) {
                const auto *previous = blockIdx.y ? band_candidate(p, p.rows[blockIdx.y - 1], prev) : p.previous;
                const auto previous_n = blockIdx.y ? band_count(p.rows[blockIdx.y - 1], prev) : p.frontier[0];
                atomicAdd(reinterpret_cast<unsigned long long *>(&r.overlap[orientation * 2 + prev]),
                          static_cast<unsigned long long>(band_overlap(span, previous, previous_n)));
            }
        }
    }
}
__global__ void band_frontier(BandPointers p, std::uint32_t rows, std::uint32_t first) {
    for (auto i = first; i < min(rows, first + serial_items); ++i) {
        auto &r = p.rows[i];
        const auto prev = i ? p.rows[i - 1].selected : 0;
        const auto positive = r.overlap[prev], negative = r.overlap[2 + prev];
        const bool choose = positive != negative ? positive > negative
            : r.matches[0] != r.matches[1] ? r.matches[0] > r.matches[1] : r.area[0] <= r.area[1];
        r.selected = r.defective && !choose ? 1 : 0;
    }
}
__global__ void band_save_frontier(BandPointers p, std::uint32_t rows) {
    const auto &r = p.rows[rows - 1];
    const auto n = band_count(r, r.selected);
    for (auto i = blockIdx.x * blockDim.x + threadIdx.x; i < n; i += blockDim.x * gridDim.x)
        p.previous[i] = band_candidate(p, r, r.selected)[i];
    if (!blockIdx.x && !threadIdx.x) p.frontier[0] = n;
}

__device__ void saturated_source_add(unsigned long long *value, unsigned long long amount) {
    auto old = atomicCAS(value, 0ull, 0ull);
    for (;;) {
        const auto next = min(old + amount, static_cast<unsigned long long>(UINT_MAX));
        const auto observed = atomicCAS(value, old, next);
        if (observed == old) break;
        old = observed;
    }
}
__global__ void band_source(BandPointers p, PostBasic *basic, std::uint32_t first_row, std::uint32_t divisor) {
    const auto &r = p.rows[blockIdx.y];
    const auto n = band_count(r, r.selected);
    const auto *spans = band_candidate(p, r, r.selected);
    for (auto i = blockIdx.x * blockDim.x + threadIdx.x; i < n; i += blockDim.x * gridDim.x) {
        const auto s = spans[i];
        saturated_source_add(&basic->pixels, static_cast<unsigned long long>(s.end) - s.start + 1);
        atomicMin(&basic->min_x, s.start); atomicMax(&basic->max_x, s.end);
        atomicMin(&basic->min_y, (first_row + blockIdx.y) / divisor);
        atomicMax(&basic->max_y, (first_row + blockIdx.y) / divisor);
    }
}

__global__ void band_pixels(BandPointers p, PlaneView output, PlaneView occupancy,
                             std::uint32_t rows, std::uint32_t first_row, std::uint32_t divisor,
                             std::uint32_t steps, std::uint32_t factor, bool coverage, bool raw_supports,
                             const RasterCarry *carry_in, RasterCarry *carry_out,
                             std::size_t first, std::size_t total) {
    const auto i = first + blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= total) return;
    const auto x = static_cast<std::uint32_t>(i % output.width);
    const auto output_row = static_cast<std::uint32_t>(i / output.width);
    const auto y = first_row / divisor + output_row;
    const auto sample_start = max(y * divisor, first_row) - first_row;
    const auto sample_end = min(rows, (y + 1) * divisor - first_row);
    const auto carry = !output_row && first_row % divisor ? carry_in[x] : RasterCarry{};
    float fractional = carry.fractional;
    std::uint64_t interior = carry.interior, lit = carry.lit;
    bool hit = carry.hit != 0;
    const auto left = x * factor, finish = (x + 1) * factor;
    for (auto sample = sample_start; sample < sample_end; ++sample) {
        const auto &r = p.rows[sample];
        const auto *spans = band_candidate(p, r, r.selected);
        const auto n = band_count(r, r.selected);
        std::uint32_t lo = 0, hi = n;
        while (lo < hi) {
            const auto mid = lo + (hi - lo) / 2;
            if (spans[mid].end < left) lo = mid + 1; else hi = mid;
        }
        for (auto at = lo; at < n && spans[at].start < finish; ++at) {
            const auto s = spans[at];
            hit = true;
            if (!coverage) {
                const auto a = max(left, s.start), b = min(finish, s.end + 1);
                if (a < b) lit += b - a;
            } else {
                const auto a = static_cast<std::uint32_t>(floorf(s.a));
                const auto b = static_cast<std::uint32_t>(ceilf(s.b)) - 1;
                if (a == b) fractional = add(fractional, mul(clampf(sub(s.b, s.a), 0.0f, 1.0f), 255.0f));
                else if (x == a) fractional = add(fractional, mul(clampf(sub(add(static_cast<float>(a), 1.0f), s.a), 0.0f, 1.0f), 255.0f));
                else if (x == b) fractional = add(fractional, mul(clampf(sub(s.b, static_cast<float>(b)), 0.0f, 1.0f), 255.0f));
                else interior += 255;
            }
        }
    }
    if ((first_row + sample_end) % divisor) {
        // Input/output carry buffers are distinct: the first and final partial
        // rows in one broad launch may execute concurrently for the same X.
        carry_out[x] = {fractional, hit ? 1u : 0u, interior, lit};
        return;
    }
    std::uint32_t value;
    if (coverage) {
        const auto total_value = interior ? add(fractional, static_cast<float>(interior)) : fractional;
        value = total_value <= 0.0f ? 0 : static_cast<std::uint32_t>(clampf(roundf(div(total_value, static_cast<float>(steps))), 0.0f, 255.0f));
    } else {
        const auto maximum = static_cast<std::uint64_t>(factor) * factor;
        value = static_cast<std::uint32_t>(min((lit * 255 + maximum / 2) / maximum, static_cast<std::uint64_t>(255)));
        if (raw_supports && value < 255) value = 0;
    }
    output.data[static_cast<std::size_t>(y - output.y0) * output.width + x] = static_cast<std::uint8_t>(value);
    if (occupancy.data) occupancy.data[static_cast<std::size_t>(y - occupancy.y0) * occupancy.width + x] = hit ? 255 : 0;
}
