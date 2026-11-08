#ifndef DF_CUDA_RASTER_CROSSINGS_H
#define DF_CUDA_RASTER_CROSSINGS_H

#include <cstdint>
#include <cstring>

#ifdef __CUDACC__
#define DF_RASTER_CROSSING_HD __host__ __device__
#else
#define DF_RASTER_CROSSING_HD
#endif

namespace dfcuda { namespace raster_crossing_detail {

// Match the old stable radix keys, including one shared non-finite key and
// canonical positive zero. Kept CUDA-independent for host ordering checks.
DF_RASTER_CROSSING_HD inline std::uint32_t x_key(float x) {
    std::uint32_t bits;
#ifdef __CUDA_ARCH__
    bits = __float_as_uint(x);
#else
    std::memcpy(&bits, &x, sizeof(bits));
#endif
    if ((bits & 0x7f800000u) == 0x7f800000u) return UINT32_MAX;
    if ((bits & 0x7fffffffu) == 0) bits = 0;
    return (bits & 0x80000000u) ? ~bits : bits ^ 0x80000000u;
}

DF_RASTER_CROSSING_HD inline bool alive(std::uint32_t end_exclusive, std::uint32_t row) {
    return end_exclusive > row;
}

// Relative first row visited by a lane, including bands beginning mid-phase.
DF_RASTER_CROSSING_HD inline std::uint32_t first_lane_row(
    std::uint32_t first_row, std::uint32_t lane, std::uint32_t lanes) {
    const auto phase = first_row % lanes;
    return lane >= phase ? lane - phase : lanes - (phase - lane);
}

// Scatter one element of two sorted adjacent runs to its unique stable rank.
// A left-run element precedes equal right-run elements; a right-run element
// follows all equal left-run elements. No global event ID breaks row ties.
template<class T, class Key>
DF_RASTER_CROSSING_HD std::uint32_t merge_destination(const T *values,
    std::uint32_t i, std::uint32_t begin, std::uint32_t middle,
    std::uint32_t end, Key key) {
    const auto value = key(values[i]);
    const bool left = i < middle;
    std::uint32_t lo = left ? middle : begin, hi = left ? end : middle;
    while (lo < hi) {
        const auto probe = lo + (hi - lo) / 2;
        const auto other = key(values[probe]);
        if (other < value || (!left && other == value)) lo = probe + 1;
        else hi = probe;
    }
    return left ? i + lo - middle : i - middle + lo;
}

} } // namespace dfcuda::raster_crossing_detail

#undef DF_RASTER_CROSSING_HD
#endif
