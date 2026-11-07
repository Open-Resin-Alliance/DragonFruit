#include "rle.h"

#include <cub/block/block_reduce.cuh>
#include <cub/block/block_scan.cuh>
#include <type_traits>

namespace dfcuda {
namespace {

constexpr std::uint32_t kThreads = 256;
constexpr std::uint32_t kItems = 16;
constexpr std::uint32_t kTilePixels = kThreads * kItems;
constexpr std::uint32_t kMaxGridTiles = 32768;
constexpr std::uint64_t kNoStart = std::numeric_limits<std::uint64_t>::max();

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
                            std::uint64_t first_tile, RleTileMetadata *metadata) {
    const std::uint64_t tile = first_tile + blockIdx.x;
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
        return;
    }

    RleTileMetadata local{kNoStart, 0, 0, 0};
    for (std::uint32_t item = 0; item < kItems; ++item) {
        const std::uint64_t position = begin + threadIdx.x + item * kThreads;
        if (position < end && is_start(plane, start_column, width, position)) {
            if (local.count == 0) local.first_start = position;
            local.last_start = position;
            ++local.count;
        }
    }
    using Reduce = cub::BlockReduce<RleTileMetadata, kThreads>;
    __shared__ typename Reduce::TempStorage storage;
    const RleTileMetadata result = Reduce(storage).Reduce(local, MergeMetadata{});
    if (threadIdx.x == 0) metadata[tile] = result;
}

/* offsets[t] is the number of globally canonical starts before tile t.
 * upper_bound locates the tile containing a run, skipping zero-count tiles. */
__device__ std::uint64_t run_tile(const std::uint64_t *offsets,
                                std::uint64_t tile_count, std::uint64_t run) {
    std::uint64_t lo = 0;
    std::uint64_t hi = tile_count + 1;
    while (lo < hi) {
        const std::uint64_t mid = lo + (hi - lo) / 2;
        if (offsets[mid] <= run) lo = mid + 1;
        else hi = mid;
    }
    return lo - 1;
}

__device__ std::uint64_t next_tile_start(const RleTileMetadata *metadata,
                                       const std::uint64_t *offsets,
                                       std::uint64_t tile_count,
                                       std::uint64_t tile,
                                       std::uint64_t total_pixels) {
    const std::uint64_t next_run = offsets[tile + 1];
    if (next_run == offsets[tile_count]) return total_pixels;
    return metadata[run_tile(offsets, tile_count, next_run)].first_start;
}

/* Only the bounded output range is materialized. Tile starts use a 16 KiB
 * shared array and a block-local scan, never a full-frame prefix/output. */
__global__ void pack_tiles(PlaneView plane, std::uint32_t start_column,
                           std::uint32_t width, std::uint64_t total_pixels,
                           const RleTileMetadata *metadata,
                           const std::uint64_t *offsets, std::uint64_t tile_count,
                           std::uint64_t first_tile, std::uint64_t first_run,
                           std::uint64_t end_run, DfCudaRun *destination) {
    const std::uint64_t tile = first_tile + blockIdx.x;
    const std::uint64_t tile_run = offsets[tile];
    const std::uint64_t tile_end_run = offsets[tile + 1];
    if (tile_end_run <= first_run || tile_run >= end_run || tile_run == tile_end_run) return;

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
            const std::uint64_t next = next_tile_start(metadata, offsets, tile_count,
                                                      tile, total_pixels);
            DfCudaRun run{};
            run.length = static_cast<std::uint32_t>(next - start);
            run.value = block_pixel(plane, start_column, width, start);
            destination[tile_run - first_run] = run;
        }
        return;
    }

    std::uint32_t flags[kItems];
    std::uint32_t ranks[kItems];
    for (std::uint32_t item = 0; item < kItems; ++item) {
        const std::uint64_t position = begin + threadIdx.x * kItems + item;
        flags[item] = position < end && is_start(plane, start_column, width, position);
    }
    using Scan = cub::BlockScan<std::uint32_t, kThreads>;
    __shared__ typename Scan::TempStorage storage;
    __shared__ std::uint32_t starts[kTilePixels];
    __shared__ std::uint32_t tile_runs;
    __shared__ std::uint64_t next_start;
    std::uint32_t aggregate;
    Scan(storage).ExclusiveSum(flags, ranks, aggregate);
    if (threadIdx.x == 0) {
        tile_runs = aggregate;
        next_start = next_tile_start(metadata, offsets, tile_count, tile, total_pixels);
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

std::size_t host_tile(std::vector<std::uint64_t> const &offsets,
                      std::uint64_t run) {
    return static_cast<std::size_t>(
        std::upper_bound(offsets.begin(), offsets.end(), run) - offsets.begin() - 1);
}

} // namespace

RleReader::RleReader(Runtime &runtime, const DfCudaConfig &config)
    : runtime_(runtime), frame_width_(config.width), frame_height_(config.height) {
    runtime_.activate();
    transfer_runs_ = runtime_.transfer_bytes() / sizeof(DfCudaRun);
    if (transfer_runs_ == 0) {
        throw Error(DF_CUDA_INVALID_ARGUMENT, "CUDA transfer budget cannot hold one RLE run");
    }
    tiles_.initialize(runtime_.memory, runtime_.pack);
    offsets_.initialize(runtime_.memory, runtime_.pack);
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

void RleReader::download_metadata() {
    checked(cudaEventRecord(packed_, runtime_.pack), "record RLE count completion");
    checked(cudaStreamWaitEvent(runtime_.readback, packed_, 0), "wait for RLE counts");
    const std::size_t total = checked_bytes(host_tiles_.size(), sizeof(RleTileMetadata));
    auto *host = reinterpret_cast<std::uint8_t *>(host_tiles_.data());
    const auto *device = reinterpret_cast<const std::uint8_t *>(tiles_.data());
    for (std::size_t offset = 0; offset < total;) {
        runtime_.check_cancelled();
        const std::size_t bytes = std::min(runtime_.transfer_bytes(), total - offset);
        HostPin pin(host + offset, bytes);
        try {
            checked(cudaMemcpyAsync(host + offset, device + offset, bytes,
                                    cudaMemcpyDeviceToHost, runtime_.readback),
                    "download RLE control metadata");
            checked(cudaEventRecord(read_back_, runtime_.readback),
                    "record RLE metadata readback");
            checked(cudaEventSynchronize(read_back_), "wait for RLE control metadata");
        } catch (...) {
            cudaStreamSynchronize(runtime_.readback);
            throw;
        }
        pin.unregister();
        offset += bytes;
    }
    checked(cudaStreamWaitEvent(runtime_.pack, read_back_, 0),
            "join RLE metadata source lifetime");
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
    const std::uint64_t tile_count = total_pixels_ / kTilePixels +
                                      (total_pixels_ % kTilePixels != 0);
    if (tile_count >= std::numeric_limits<std::size_t>::max()) {
        throw Error(DF_CUDA_OUT_OF_MEMORY, "RLE tile metadata size overflow");
    }
    const auto count = static_cast<std::size_t>(tile_count);
    checked_bytes(count, sizeof(RleTileMetadata));
    checked_bytes(count + 1, sizeof(std::uint64_t));
    tiles_.resize(count);
    offsets_.resize(count + 1);
    host_tiles_.resize(count);
    host_offsets_.resize(count + 1);
    host_offsets_[0] = 0;
    if (total_pixels_ == 0) {
        ready_ = true;
        return;
    }

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
    try {
        for (std::uint64_t tile = 0; tile < tile_count;) {
            runtime_.check_cancelled();
            const auto batch = static_cast<std::uint32_t>(
                std::min<std::uint64_t>(kMaxGridTiles, tile_count - tile));
            count_tiles<<<batch, kThreads, 0, runtime_.pack>>>(
                plane_, start_column_, block_width_, total_pixels_, roi_first, roi_last,
                tile, tiles_.data());
            checked(cudaGetLastError(), "count GPU RLE transitions");
            tile += batch;
        }
        download_metadata();
    } catch (...) {
        /* Metadata DMA must finish before its host allocation can change, even
         * when cancellation/registration/event creation interrupts the loop. */
        cudaStreamSynchronize(runtime_.readback);
        cudaStreamSynchronize(runtime_.pack);
        throw;
    }

    std::uint64_t previous_last = 0;
    bool have_start = false;
    for (std::size_t tile = 0; tile < count; ++tile) {
        const auto &metadata = host_tiles_[tile];
        const std::uint64_t begin = static_cast<std::uint64_t>(tile) * kTilePixels;
        const std::uint64_t end = total_pixels_ - begin < kTilePixels
                                      ? total_pixels_ : begin + kTilePixels;
        if (metadata.count > end - begin || metadata.reserved != 0 ||
            (metadata.count != 0 && (metadata.first_start < begin ||
             metadata.last_start >= end || metadata.first_start > metadata.last_start))) {
            throw Error(DF_CUDA_NUMERICAL_ERROR, "invalid GPU RLE transition metadata");
        }
        if (metadata.count > total_pixels_ - host_offsets_[tile]) {
            throw Error(DF_CUDA_NUMERICAL_ERROR, "GPU RLE run counter overflow");
        }
        host_offsets_[tile + 1] = host_offsets_[tile] + metadata.count;
        if (metadata.count == 0) continue;
        if (!have_start && metadata.first_start != 0) {
            throw Error(DF_CUDA_NUMERICAL_ERROR, "GPU RLE is missing the initial run");
        }
        if (have_start && metadata.first_start - previous_last >
                              std::numeric_limits<std::uint32_t>::max()) {
            throw Error(DF_CUDA_NUMERICAL_ERROR, "RLE run length exceeds the eight-byte ABI");
        }
        previous_last = metadata.last_start;
        have_start = true;
    }
    if (!have_start || total_pixels_ - previous_last >
                           std::numeric_limits<std::uint32_t>::max()) {
        throw Error(DF_CUDA_NUMERICAL_ERROR, "RLE terminal run length exceeds the eight-byte ABI");
    }
    /* Within a tile all distances are <=4096; the metadata checks above cover
     * every longer cross-tile/terminal run before any uint32 length is packed. */
    runtime_.upload_bytes(offsets_.data(), host_offsets_.data(),
                          checked_bytes(host_offsets_.size(), sizeof(std::uint64_t)));
    run_count_ = host_offsets_.back();
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
    const std::uint64_t end_run = first_run + run_count;
    const std::uint64_t tile_count = host_tiles_.size();
    const std::uint64_t first_tile = host_tile(host_offsets_, first_run);
    const std::uint64_t last_tile = host_tile(host_offsets_, end_run - 1);
    try {
        for (std::uint64_t tile = first_tile; tile <= last_tile;) {
            runtime_.check_cancelled();
            const auto batch = static_cast<std::uint32_t>(
                std::min<std::uint64_t>(kMaxGridTiles, last_tile - tile + 1));
            pack_tiles<<<batch, kThreads, 0, runtime_.pack>>>(
                plane_, start_column_, block_width_, total_pixels_, tiles_.data(),
                offsets_.data(), tile_count, tile, first_run, end_run, runs_.data());
            checked(cudaGetLastError(), "compact requested GPU RLE runs");
            tile += batch;
        }
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
