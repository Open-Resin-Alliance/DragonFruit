#include "rle.h"

#include <cub/block/block_reduce.cuh>
#include <cub/block/block_scan.cuh>
#include <type_traits>

namespace dfcuda {
namespace {

using namespace rle_detail;

static_assert(sizeof(DfCudaRun) == 8, "RLE DMA requires eight-byte runs");
static_assert(alignof(DfCudaRun) == alignof(std::uint32_t), "RLE DMA alignment");
static_assert(offsetof(DfCudaRun, length) == 0, "RLE length offset");
static_assert(offsetof(DfCudaRun, value) == 4, "RLE value offset");
static_assert(offsetof(DfCudaRun, reserved) == 5, "RLE reserved offset");
static_assert(std::is_trivially_copyable<DfCudaRun>::value, "RLE DMA layout");
static_assert(sizeof(RleTileMetadata) == 24, "RLE metadata layout");

__device__ std::uint8_t block_pixel(PlaneView plane, std::uint32_t start_column,
                                  std::uint32_t width, std::uint64_t position) {
    return pixel(plane, start_column + static_cast<std::uint32_t>(position % width),
                 static_cast<std::uint32_t>(position / width));
}

__device__ bool is_start(PlaneView plane, std::uint32_t start_column,
                         std::uint32_t width, std::uint64_t position) {
    return position == 0 ||
           block_pixel(plane, start_column, width, position) !=
               block_pixel(plane, start_column, width, position - 1);
}

struct MergeMetadata {
    __device__ RleTileMetadata operator()(RleTileMetadata a,
                                         RleTileMetadata b) const {
        RleTileMetadata result{};
        result.count = a.count + b.count;
        result.first_start = a.first_start < b.first_start ? a.first_start : b.first_start;
        result.last_start = a.last_start > b.last_start ? a.last_start : b.last_start;
        return result;
    }
};

/* Compare with the predecessor in the logical block stream, including at row
 * and tile boundaries. A zero-only tile needs just its boundary comparison. */
__global__ void count_tiles(PlaneView plane, std::uint32_t start_column,
                            std::uint32_t width, std::uint64_t total_pixels,
                            std::uint64_t roi_first, std::uint64_t roi_last,
                            std::uint64_t tile_count, RleTileMetadata *metadata) {
    using Reduce = cub::BlockReduce<RleTileMetadata, kThreads>;
    __shared__ typename Reduce::TempStorage storage;
    for (std::uint64_t tile = blockIdx.x; tile < tile_count; tile += gridDim.x) {
        const std::uint64_t begin = tile * kTilePixels;
        const std::uint64_t end = total_pixels - begin < kTilePixels
                                      ? total_pixels : begin + kTilePixels;
        if (roi_first == kNoStart || end <= roi_first || begin > roi_last) {
            if (threadIdx.x == 0) {
                RleTileMetadata result{kNoStart, 0, 0, 0};
                if (is_start(plane, start_column, width, begin)) {
                    result.first_start = result.last_start = begin;
                    result.count = 1;
                }
                metadata[tile] = result;
            }
        } else {
            RleTileMetadata local{kNoStart, 0, 0, 0};
            for (std::uint32_t item = 0; item < kItems; ++item) {
                const std::uint64_t position = begin + threadIdx.x + item * kThreads;
                if (position < end && is_start(plane, start_column, width, position)) {
                    if (local.count == 0) local.first_start = position;
                    local.last_start = position;
                    ++local.count;
                }
            }
            const RleTileMetadata result = Reduce(storage).Reduce(local, MergeMetadata{});
            if (threadIdx.x == 0) metadata[tile] = result;
        }
        __syncthreads(); // BlockReduce storage may be reused by the next tile.
    }
}

/* First hierarchy level: validate field bounds before admitting a count into
 * the scan. Valid tile counts sum to <=total_pixels, so uint64 addition cannot
 * wrap even when invalid metadata is encountered elsewhere. */
__global__ void scan_tiles(const RleTileMetadata *metadata, std::uint64_t tile_count,
                           std::uint64_t total_pixels, Prefix *prefix,
                           Prefix *totals, Control *control) {
    using Scan = cub::BlockScan<Prefix, kThreads>;
    __shared__ typename Scan::TempStorage storage;
    const std::uint64_t groups = tile_count / kThreads + (tile_count % kThreads != 0);
    for (std::uint64_t group = blockIdx.x; group < groups; group += gridDim.x) {
        const std::uint64_t tile = group * kThreads + threadIdx.x;
        Prefix value{};
        if (tile < tile_count) {
            const RleTileMetadata entry = metadata[tile];
            const auto status = metadata_status(entry, tile, total_pixels);
            if (status != 0) atomicOr(&control->status, status);
            else if (entry.count != 0) value = {entry.count, entry.last_start + 1};
        }
        Prefix inclusive;
        Prefix aggregate;
        Scan(storage).InclusiveScan(value, inclusive, MergePrefix{}, aggregate);
        if (tile < tile_count) prefix[tile + 1] = inclusive;
        if (threadIdx.x == 0 && totals != nullptr) totals[group] = aggregate;
        __syncthreads();
    }
}

__global__ void scan_level(Prefix *values, std::uint64_t count, Prefix *totals) {
    using Scan = cub::BlockScan<Prefix, kThreads>;
    __shared__ typename Scan::TempStorage storage;
    const std::uint64_t groups = count / kThreads + (count % kThreads != 0);
    for (std::uint64_t group = blockIdx.x; group < groups; group += gridDim.x) {
        const std::uint64_t index = group * kThreads + threadIdx.x;
        const Prefix value = index < count ? values[index] : Prefix{};
        Prefix inclusive;
        Prefix aggregate;
        Scan(storage).InclusiveScan(value, inclusive, MergePrefix{}, aggregate);
        if (index < count) values[index] = inclusive;
        if (threadIdx.x == 0 && totals != nullptr) totals[group] = aggregate;
        __syncthreads();
    }
}

__global__ void add_scan_totals(Prefix *values, std::uint64_t count,
                                const Prefix *totals) {
    for (std::uint64_t index = static_cast<std::uint64_t>(blockIdx.x) * kThreads + threadIdx.x;
         index < count; index += static_cast<std::uint64_t>(gridDim.x) * kThreads) {
        const std::uint64_t group = index / kThreads;
        if (group != 0) values[index] = MergePrefix{}(totals[group - 1], values[index]);
    }
}

__global__ void validate_runs(const RleTileMetadata *metadata, const Prefix *prefix,
                              std::uint64_t tile_count, std::uint64_t total_pixels,
                              Control *control) {
    for (std::uint64_t tile = static_cast<std::uint64_t>(blockIdx.x) * kThreads + threadIdx.x;
         tile < tile_count; tile += static_cast<std::uint64_t>(gridDim.x) * kThreads) {
        const RleTileMetadata entry = metadata[tile];
        if (metadata_status(entry, tile, total_pixels) == 0) {
            const auto status = run_status(entry, prefix[tile], total_pixels);
            if (status != 0) atomicOr(&control->status, status);
        }
    }
    if (blockIdx.x == 0 && threadIdx.x == 0) {
        const Prefix total = prefix[tile_count];
        control->count = total.count;
        const auto status = terminal_status(total, total_pixels);
        if (status != 0) atomicOr(&control->status, status);
    }
}

__device__ std::uint64_t next_tile_start(const RleTileMetadata *metadata,
                                       const Prefix *prefix,
                                       std::uint64_t tile_count,
                                       std::uint64_t tile,
                                       std::uint64_t total_pixels) {
    const std::uint64_t next_run = prefix[tile + 1].count;
    if (next_run == prefix[tile_count].count) return total_pixels;
    return metadata[run_tile(prefix, tile_count, next_run)].first_start;
}

__global__ void select_pack_range(const Prefix *prefix, std::uint64_t tile_count,
                                  std::uint64_t first_run, std::uint64_t end_run,
                                  PackRange *range) {
    *range = pack_range(prefix, tile_count, first_run, end_run);
}

/* A capability-bounded grid strides only the GPU-selected tile interval.
 * Empty intervals are binary-skipped on device, preserving each CTA's residue.
 * Only the requested runs and a reused 16 KiB CTA start table are materialized. */
__global__ void pack_tiles(PlaneView plane, std::uint32_t start_column,
                           std::uint32_t width, std::uint64_t total_pixels,
                           const RleTileMetadata *metadata,
                           const Prefix *prefix, std::uint64_t tile_count,
                           const PackRange *range, std::uint64_t first_run,
                           std::uint64_t end_run, DfCudaRun *destination) {
    using Scan = cub::BlockScan<std::uint32_t, kThreads>;
    __shared__ typename Scan::TempStorage storage;
    __shared__ std::uint32_t starts[kTilePixels];
    __shared__ std::uint32_t tile_runs;
    __shared__ std::uint64_t next_start;
    __shared__ std::uint64_t current_tile;
    const PackRange requested = *range;
    if (threadIdx.x == 0) {
        current_tile = next_owned_tile(prefix, tile_count,
                                      requested.first_tile + blockIdx.x,
                                      requested.end_tile, gridDim.x);
    }
    __syncthreads();
    while (current_tile < requested.end_tile) {
        const std::uint64_t tile = current_tile;
        const std::uint64_t tile_run = prefix[tile].count;
        const std::uint64_t tile_end_run = prefix[tile + 1].count;
        const std::uint32_t first_local = static_cast<std::uint32_t>(
            first_run > tile_run ? first_run - tile_run : 0);
        const std::uint32_t end_local = static_cast<std::uint32_t>(
            end_run < tile_end_run ? end_run - tile_run : tile_end_run - tile_run);
        const std::uint64_t begin = tile * kTilePixels;
        const std::uint64_t end = total_pixels - begin < kTilePixels
                                      ? total_pixels : begin + kTilePixels;
        if (metadata[tile].count == 1) {
            if (threadIdx.x == 0) {
                const std::uint64_t start = metadata[tile].first_start;
                const std::uint64_t next = next_tile_start(metadata, prefix, tile_count,
                                                          tile, total_pixels);
                DfCudaRun run{};
                run.length = static_cast<std::uint32_t>(next - start);
                run.value = block_pixel(plane, start_column, width, start);
                destination[tile_run - first_run] = run;
            }
        } else {
            std::uint32_t flags[kItems];
            std::uint32_t ranks[kItems];
            for (std::uint32_t item = 0; item < kItems; ++item) {
                const std::uint64_t position = begin + threadIdx.x * kItems + item;
                flags[item] = position < end && is_start(plane, start_column, width, position);
            }
            std::uint32_t aggregate;
            Scan(storage).ExclusiveSum(flags, ranks, aggregate);
            if (threadIdx.x == 0) {
                tile_runs = aggregate;
                next_start = next_tile_start(metadata, prefix, tile_count, tile, total_pixels);
            }
            for (std::uint32_t item = 0; item < kItems; ++item) {
                if (flags[item]) starts[ranks[item]] = threadIdx.x * kItems + item;
            }
            __syncthreads();
            for (std::uint32_t local = first_local + threadIdx.x; local < end_local;
                 local += kThreads) {
                const std::uint64_t start = begin + starts[local];
                const std::uint64_t next = local + 1 < tile_runs
                                               ? begin + starts[local + 1] : next_start;
                DfCudaRun run{};
                run.length = static_cast<std::uint32_t>(next - start);
                run.value = block_pixel(plane, start_column, width, start);
                destination[tile_run + local - first_run] = run;
            }
        }
        __syncthreads(); // All readers finish before shared tables/CTA state change.
        if (threadIdx.x == 0) {
            current_tile = next_owned_tile(prefix, tile_count, tile + gridDim.x,
                                          requested.end_tile, gridDim.x);
        }
        __syncthreads();
    }
}

std::uint32_t launch_blocks(std::uint64_t work, std::uint32_t limit) {
    return static_cast<std::uint32_t>(std::min<std::uint64_t>(work, limit));
}

std::size_t workspace_reservation(std::uint64_t pixels, std::uint64_t transfer_runs) {
    if (pixels == 0) return 0;
    const std::uint64_t tiles = tile_count(pixels);
    if (tiles >= std::numeric_limits<std::size_t>::max()) {
        throw Error(DF_CUDA_OUT_OF_MEMORY, "RLE tile metadata size overflow");
    }
    const auto count = static_cast<std::size_t>(tiles);
    const ScanLayout layout = scan_layout(count);
    std::size_t bytes = 0;
    const auto add = [&bytes](std::size_t count, std::size_t size) {
        const auto extra = checked_bytes(count, size);
        if (extra > std::numeric_limits<std::size_t>::max() - bytes) {
            throw Error(DF_CUDA_OUT_OF_MEMORY, "RLE workspace size overflow");
        }
        bytes += extra;
    };
    add(count, sizeof(RleTileMetadata));
    add(count + 1, sizeof(Prefix));
    add(layout.entries, sizeof(Prefix));
    add(1, sizeof(Control));
    add(1, sizeof(PackRange));
    add(static_cast<std::size_t>(std::min(pixels, transfer_runs)), sizeof(DfCudaRun));
    return bytes;
}

} // namespace

RleReader::RleReader(Runtime &runtime, const DfCudaConfig &config)
    : runtime_(runtime), frame_width_(config.width), frame_height_(config.height) {
    runtime_.activate();
    transfer_runs_ = runtime_.transfer_bytes() / sizeof(DfCudaRun);
    if (transfer_runs_ == 0) {
        throw Error(DF_CUDA_INVALID_ARGUMENT, "CUDA transfer budget cannot hold one RLE run");
    }
    workspace_bytes_ = workspace_reservation(
        static_cast<std::uint64_t>(frame_width_) * frame_height_, transfer_runs_);
    cudaDeviceProp properties{};
    checked(cudaGetDeviceProperties(&properties, runtime_.device), "read RLE device capabilities");
    const auto resident_blocks = static_cast<std::uint64_t>(std::max(1, properties.multiProcessorCount)) *
        std::max(1, properties.maxThreadsPerMultiProcessor / static_cast<int>(kThreads));
    grid_limit_ = launch_blocks(resident_blocks, static_cast<std::uint32_t>(properties.maxGridSize[0]));
    int active_pack_blocks = 0;
    checked(cudaOccupancyMaxActiveBlocksPerMultiprocessor(&active_pack_blocks, pack_tiles, kThreads, 0),
            "read RLE pack residency");
    pack_grid_limit_ = launch_blocks(
        static_cast<std::uint64_t>(std::max(1, properties.multiProcessorCount)) *
            std::max(1, active_pack_blocks), grid_limit_);
    tiles_.initialize(runtime_.memory, runtime_.pack);
    prefix_.initialize(runtime_.memory, runtime_.pack);
    scan_totals_.initialize(runtime_.memory, runtime_.pack);
    control_.initialize(runtime_.memory, runtime_.pack);
    range_.initialize(runtime_.memory, runtime_.pack);
    runs_.initialize(runtime_.memory, runtime_.pack);
    try {
        checked(cudaEventCreateWithFlags(&plane_ready_, cudaEventDisableTiming),
                "create RLE plane event");
        checked(cudaEventCreateWithFlags(&packed_, cudaEventDisableTiming),
                "create RLE pack event");
        checked(cudaEventCreateWithFlags(&read_back_, cudaEventDisableTiming),
                "create RLE readback event");
    } catch (...) {
        if (read_back_) cudaEventDestroy(read_back_);
        if (packed_) cudaEventDestroy(packed_);
        if (plane_ready_) cudaEventDestroy(plane_ready_);
        throw;
    }
}

RleReader::~RleReader() {
    /* enqueue joins D2H onto pack; Buffer retirement consequently covers all
     * source reads without synchronizing an otherwise healthy job here. */
    if (read_back_) cudaEventDestroy(read_back_);
    if (packed_) cudaEventDestroy(packed_);
    if (plane_ready_) cudaEventDestroy(plane_ready_);
}

Control RleReader::download_control() {
    Control result{};
    checked(cudaEventRecord(packed_, runtime_.pack), "record RLE count completion");
    checked(cudaStreamWaitEvent(runtime_.readback, packed_, 0), "wait for RLE count/status");
    auto *host = reinterpret_cast<std::uint8_t *>(&result);
    const auto *device = reinterpret_cast<const std::uint8_t *>(control_.data());
    for (std::size_t offset = 0; offset < sizeof(result);) {
        runtime_.check_cancelled();
        const auto bytes = std::min(runtime_.transfer_bytes(), sizeof(result) - offset);
        HostPin pin(host + offset, bytes);
        try {
            checked(cudaMemcpyAsync(host + offset, device + offset, bytes,
                                    cudaMemcpyDeviceToHost, runtime_.readback),
                    "download RLE count/status");
            checked(cudaEventRecord(read_back_, runtime_.readback), "record RLE count/status readback");
            checked(cudaEventSynchronize(read_back_), "wait for RLE count/status");
        } catch (...) {
            cudaStreamSynchronize(runtime_.readback);
            throw;
        }
        pin.unregister();
        offset += bytes;
    }
    checked(cudaStreamWaitEvent(runtime_.pack, read_back_, 0), "join RLE control source lifetime");
    return result;
}

void RleReader::reset(PlaneView final_plane, std::uint32_t start_column,
                      std::uint32_t block_width) {
    runtime_.activate();
    runtime_.check_cancelled();
    ready_ = false;
    run_count_ = 0;
    if (start_column > frame_width_ || block_width > frame_width_ - start_column) {
        throw Error(DF_CUDA_INVALID_ARGUMENT, "RLE block lies outside the frame");
    }
    if (final_plane.x0 > frame_width_ || final_plane.y0 > frame_height_ ||
        final_plane.width > frame_width_ - final_plane.x0 ||
        final_plane.height > frame_height_ - final_plane.y0 ||
        (final_plane.width != 0 && final_plane.height != 0 && final_plane.data == nullptr)) {
        throw Error(DF_CUDA_INVALID_ARGUMENT, "RLE plane has invalid frame bounds or storage");
    }
    plane_ = final_plane;
    start_column_ = start_column;
    block_width_ = block_width;
    total_pixels_ = static_cast<std::uint64_t>(block_width) * frame_height_;
    if (total_pixels_ == 0) {
        ready_ = true;
        return;
    }
    const std::uint64_t tile_count = rle_detail::tile_count(total_pixels_);
    if (tile_count >= std::numeric_limits<std::size_t>::max()) {
        throw Error(DF_CUDA_OUT_OF_MEMORY, "RLE tile metadata size overflow");
    }
    const auto count = static_cast<std::size_t>(tile_count);
    const ScanLayout layout = scan_layout(count);
    tiles_.resize(count);
    prefix_.resize(count + 1);
    scan_totals_.resize(layout.entries);
    control_.resize(1);

    std::uint64_t roi_first = kNoStart;
    std::uint64_t roi_last = 0;
    const std::uint32_t left = std::max(start_column, final_plane.x0);
    const std::uint32_t right = std::min(start_column + block_width,
                                        final_plane.x0 + final_plane.width);
    if (left < right && final_plane.height != 0) {
        roi_first = static_cast<std::uint64_t>(final_plane.y0) * block_width + left - start_column;
        roi_last = static_cast<std::uint64_t>(final_plane.y0 + final_plane.height - 1) *
                       block_width + right - start_column - 1;
    }
    checked(cudaEventRecord(plane_ready_, runtime_.compute), "record final RLE plane readiness");
    checked(cudaStreamWaitEvent(runtime_.pack, plane_ready_, 0), "wait for final RLE plane");
    Control control{};
    try {
        checked(cudaMemsetAsync(control_.data(), 0, sizeof(Control), runtime_.pack),
                "clear RLE count/status");
        checked(cudaMemsetAsync(prefix_.data(), 0, sizeof(Prefix), runtime_.pack),
                "initialize RLE prefix identity");
        count_tiles<<<launch_blocks(tile_count, grid_limit_), kThreads, 0, runtime_.pack>>>(
            plane_, start_column_, block_width_, total_pixels_, roi_first, roi_last,
            tile_count, tiles_.data());
        checked(cudaGetLastError(), "count GPU RLE transitions");
        const auto groups = count / kThreads + (count % kThreads != 0);
        scan_tiles<<<launch_blocks(groups, grid_limit_), kThreads, 0, runtime_.pack>>>(
            tiles_.data(), tile_count, total_pixels_, prefix_.data(),
            layout.levels != 0 ? scan_totals_.data() : nullptr, control_.data());
        checked(cudaGetLastError(), "scan GPU RLE tile metadata");
        for (std::size_t level = 0; level < layout.levels; ++level) {
            runtime_.check_cancelled();
            const auto entries = layout.counts[level];
            const auto blocks = entries / kThreads + (entries % kThreads != 0);
            Prefix *next = level + 1 < layout.levels
                               ? scan_totals_.data() + layout.offsets[level + 1] : nullptr;
            scan_level<<<launch_blocks(blocks, grid_limit_), kThreads, 0, runtime_.pack>>>(
                scan_totals_.data() + layout.offsets[level], entries, next);
            checked(cudaGetLastError(), "scan GPU RLE prefix hierarchy");
        }
        for (std::size_t level = layout.levels; level > 1; --level) {
            runtime_.check_cancelled();
            const auto entries = layout.counts[level - 2];
            const auto blocks = entries / kThreads + (entries % kThreads != 0);
            add_scan_totals<<<launch_blocks(blocks, grid_limit_), kThreads, 0, runtime_.pack>>>(
                scan_totals_.data() + layout.offsets[level - 2], entries,
                scan_totals_.data() + layout.offsets[level - 1]);
            checked(cudaGetLastError(), "propagate GPU RLE prefix hierarchy");
        }
        if (layout.levels != 0) {
            add_scan_totals<<<launch_blocks(groups, grid_limit_), kThreads, 0, runtime_.pack>>>(
                prefix_.data() + 1, tile_count, scan_totals_.data());
            checked(cudaGetLastError(), "complete GPU RLE tile prefix");
        }
        runtime_.check_cancelled();
        validate_runs<<<launch_blocks(groups, grid_limit_), kThreads, 0, runtime_.pack>>>(
            tiles_.data(), prefix_.data(), tile_count, total_pixels_, control_.data());
        checked(cudaGetLastError(), "validate GPU RLE run lengths");
        control = download_control();
    } catch (...) {
        /* Count/status storage and the source plane remain leased until both
         * streams drain, including interrupted registration/event submission. */
        cudaStreamSynchronize(runtime_.readback);
        cudaStreamSynchronize(runtime_.pack);
        throw;
    }
    if (control.status & InvalidMetadata) {
        throw Error(DF_CUDA_NUMERICAL_ERROR, "invalid GPU RLE transition metadata");
    }
    if (control.status & CounterOverflow) {
        throw Error(DF_CUDA_NUMERICAL_ERROR, "GPU RLE run counter overflow");
    }
    if (control.status & MissingInitial) {
        throw Error(DF_CUDA_NUMERICAL_ERROR, "GPU RLE is missing the initial run");
    }
    if (control.status & RunTooLong) {
        throw Error(DF_CUDA_NUMERICAL_ERROR, "RLE run length exceeds the eight-byte ABI");
    }
    if (control.status & TerminalTooLong) {
        throw Error(DF_CUDA_NUMERICAL_ERROR, "RLE terminal run length exceeds the eight-byte ABI");
    }
    /* Intra-tile distances are <=4096; every longer cross-tile/terminal run
     * was validated on device before any uint32 run length can be packed. */
    run_count_ = control.count;
    ready_ = true;
}

void RleReader::enqueue(std::uint64_t first_run, std::uint64_t run_count,
                        DfCudaRun *pinned_destination) {
    runtime_.activate();
    runtime_.check_cancelled();
    if (!ready_ || first_run > run_count_ || run_count > run_count_ - first_run ||
        run_count > transfer_runs_ || (run_count != 0 && pinned_destination == nullptr)) {
        throw Error(DF_CUDA_INVALID_ARGUMENT, "invalid RLE transfer range or destination");
    }
    if (run_count == 0) return;
    if (run_count > std::numeric_limits<std::size_t>::max() / sizeof(DfCudaRun)) {
        throw Error(DF_CUDA_INVALID_ARGUMENT, "RLE transfer byte count overflow");
    }
    runs_.resize(static_cast<std::size_t>(run_count));
    range_.resize(1);
    const std::uint64_t end_run = first_run + run_count;
    const std::uint64_t tile_count = tiles_.size();
    const auto blocks = launch_blocks(std::min(tile_count, run_count), pack_grid_limit_);
    try {
        select_pack_range<<<1, 1, 0, runtime_.pack>>>(
            prefix_.data(), tile_count, first_run, end_run, range_.data());
        checked(cudaGetLastError(), "select requested GPU RLE tile range");
        pack_tiles<<<blocks, kThreads, 0, runtime_.pack>>>(
            plane_, start_column_, block_width_, total_pixels_, tiles_.data(),
            prefix_.data(), tile_count, range_.data(), first_run, end_run, runs_.data());
        checked(cudaGetLastError(), "compact requested GPU RLE runs");
        checked(cudaEventRecord(packed_, runtime_.pack), "record GPU RLE packing");
        checked(cudaStreamWaitEvent(runtime_.readback, packed_, 0), "wait for GPU RLE packing");
        checked(cudaMemcpyAsync(pinned_destination, runs_.data(),
                                checked_bytes(static_cast<std::size_t>(run_count), sizeof(DfCudaRun)),
                                cudaMemcpyDeviceToHost, runtime_.readback),
                "DMA RLE directly into caller allocation");
        checked(cudaEventRecord(read_back_, runtime_.readback), "record GPU RLE readback");
        checked(cudaStreamWaitEvent(runtime_.pack, read_back_, 0),
                "protect GPU RLE scratch until DMA completes");
    } catch (...) {
        /* A failed event/join must not leave scratch leased only to pack while
         * readback is still reading it. The caller separately drains its pin. */
        cudaStreamSynchronize(runtime_.readback);
        cudaStreamSynchronize(runtime_.pack);
        throw;
    }
}

} // namespace dfcuda
