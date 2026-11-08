#ifndef DF_CUDA_RLE_CONTROL_H
#define DF_CUDA_RLE_CONTROL_H

#include <cstddef>
#include <cstdint>

#ifdef __CUDACC__
#define DF_RLE_HD __host__ __device__
#else
#define DF_RLE_HD
#endif

namespace dfcuda {

/* One record per 4096 logical block pixels, never per pixel/run. */
struct RleTileMetadata {
    std::uint64_t first_start;
    std::uint64_t last_start;
    std::uint32_t count;
    std::uint32_t reserved;
};

namespace rle_detail {

constexpr std::uint32_t kThreads = 256;
constexpr std::uint32_t kItems = 16;
constexpr std::uint32_t kTilePixels = kThreads * kItems;
constexpr std::uint64_t kNoStart = UINT64_MAX;
constexpr std::size_t kMaxScanLevels = (sizeof(std::size_t) * 8 + 7) / 8;

/* Inclusive count and last nonempty start + 1. Zero is the empty identity. */
struct Prefix {
    std::uint64_t count;
    std::uint64_t last_end;
};

struct MergePrefix {
    DF_RLE_HD Prefix operator()(Prefix a, Prefix b) const {
        return {a.count + b.count, a.last_end > b.last_end ? a.last_end : b.last_end};
    }
};

enum Status : std::uint32_t {
    InvalidMetadata = 1U,
    CounterOverflow = 2U,
    MissingInitial = 4U,
    RunTooLong = 8U,
    TerminalTooLong = 16U
};

struct Control {
    std::uint64_t count;
    std::uint32_t status;
    std::uint32_t reserved;
};

struct PackRange {
    std::uint64_t first_tile;
    std::uint64_t end_tile;
};

struct ScanLayout {
    std::size_t levels = 0;
    std::size_t entries = 0;
    std::size_t counts[kMaxScanLevels]{};
    std::size_t offsets[kMaxScanLevels]{};
};

DF_RLE_HD inline std::uint64_t tile_count(std::uint64_t pixels) {
    return pixels / kTilePixels + (pixels % kTilePixels != 0);
}

/* Each retained level holds the previous level's CTA totals. The top level
 * fits one CTA, so no additional singleton allocation or CUB device scratch. */
inline ScanLayout scan_layout(std::size_t tiles) {
    ScanLayout result;
    while (tiles > kThreads) {
        tiles = tiles / kThreads + (tiles % kThreads != 0);
        result.counts[result.levels] = tiles;
        result.offsets[result.levels] = result.entries;
        result.entries += tiles;
        ++result.levels;
    }
    return result;
}

DF_RLE_HD inline std::uint32_t metadata_status(const RleTileMetadata &metadata,
                                              std::uint64_t tile,
                                              std::uint64_t total_pixels) {
    const std::uint64_t begin = tile * kTilePixels;
    const std::uint64_t remaining = total_pixels - begin;
    const std::uint64_t size = remaining < kTilePixels ? remaining : kTilePixels;
    return metadata.count > size || metadata.reserved != 0 ||
           (metadata.count != 0 && (metadata.first_start < begin ||
            metadata.last_start >= begin + size ||
            metadata.first_start > metadata.last_start)) ? InvalidMetadata : 0U;
}

DF_RLE_HD inline std::uint32_t run_status(const RleTileMetadata &metadata,
                                         Prefix before, std::uint64_t total_pixels) {
    std::uint32_t status = 0;
    if (before.count > total_pixels || metadata.count > total_pixels - before.count) {
        status |= CounterOverflow;
    }
    if (metadata.count == 0) return status;
    if (before.count == 0) {
        if (metadata.first_start != 0) status |= MissingInitial;
    } else if (metadata.first_start - (before.last_end - 1) >
                   UINT32_MAX) {
        status |= RunTooLong;
    }
    return status;
}

DF_RLE_HD inline std::uint32_t terminal_status(Prefix total,
                                              std::uint64_t total_pixels) {
    return total_pixels != 0 && (total.count == 0 ||
           total_pixels - (total.last_end - 1) >
               UINT32_MAX) ? TerminalTooLong : 0U;
}

/* prefix[t] contains starts strictly before tile t. The upper bound skips
 * repeated counts from empty tiles. Call only for run < prefix[tiles].count. */
DF_RLE_HD inline std::uint64_t run_tile(const Prefix *prefix,
                                       std::uint64_t tiles, std::uint64_t run) {
    std::uint64_t lo = 0;
    std::uint64_t hi = tiles + 1;
    while (lo < hi) {
        const std::uint64_t mid = lo + (hi - lo) / 2;
        if (prefix[mid].count <= run) lo = mid + 1;
        else hi = mid;
    }
    return lo - 1;
}

DF_RLE_HD inline PackRange pack_range(const Prefix *prefix, std::uint64_t tiles,
                                      std::uint64_t first_run, std::uint64_t end_run) {
    return {run_tile(prefix, tiles, first_run), run_tile(prefix, tiles, end_run - 1) + 1};
}

/* Preserve a CTA's tile-index residue while jumping entire empty intervals.
 * Thus every nonempty tile has exactly one owner even across long zero gaps. */
DF_RLE_HD inline std::uint64_t next_owned_tile(const Prefix *prefix,
                                              std::uint64_t tiles,
                                              std::uint64_t tile,
                                              std::uint64_t end_tile,
                                              std::uint64_t stride) {
    while (tile < end_tile && prefix[tile].count == prefix[tile + 1].count) {
        if (prefix[tile].count == prefix[tiles].count) return end_tile;
        const std::uint64_t next = run_tile(prefix, tiles, prefix[tile].count);
        const std::uint64_t distance = next - tile;
        tile += (distance / stride + (distance % stride != 0)) * stride;
    }
    return tile;
}

} // namespace rle_detail
} // namespace dfcuda

#undef DF_RLE_HD
#endif
