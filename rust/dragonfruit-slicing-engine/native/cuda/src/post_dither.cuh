#ifndef DF_CUDA_POST_DITHER_CUH
#define DF_CUDA_POST_DITHER_CUH

namespace dfcuda {
namespace {

__device__ std::uint32_t nearest_energy(const PostTables *tables, double energy) {
    std::uint32_t lo = 0, hi = tables->palette_count - 1;
    while (lo < hi) {
        const auto mid = lo + (hi - lo) / 2;
        if (tables->palette_energy[mid] < energy) lo = mid + 1;
        else hi = mid;
    }
    if (lo != 0 && fabs(energy - tables->palette_energy[lo - 1]) <=
                       fabs(energy - tables->palette_energy[lo])) --lo;
    return lo;
}

// Regions are phased at IMAGE-global multiples of 16, never at ROI/encoder
// block starts. An incomplete right/bottom strip belongs to the last full
// region on that axis; their corner is merged in both axes. A dimension below
// 16 uses its real in-frame extent. There is no padded-zero error denominator.
//
// Nearest-palette error carry is retained over every flexible pixel of a
// region. Exact post-LUT zero and solid pixels stay exact without discarding
// carry. If |carry| <= gap_max/2 before a flexible pixel and its source E is in
// [0,1], nearest projection onto a palette containing 0 and 1 leaves the same
// bound afterward (also when desired E lies outside [0,1]). Thus the regional
// exposure discrepancy telescopes to final carry, <=gap_max/2<=0.5. For every
// 16x16 interior/merged region this is <=0.5/256<0.01 per pixel. Small actual
// regions are checked against their own N; a failed greedy bound is reported,
// NOT asserted to prove that all possible palette sums are unrepresentable.
__global__ void dither_regions(PlaneView output, const PostTables *tables,
                               std::uint32_t frame_width, std::uint32_t frame_height,
                               std::uint32_t regions_x, std::uint32_t regions_y,
                               std::uint32_t first_x, std::uint32_t first_y,
                               std::uint32_t columns, std::size_t region_count,
                               std::uint32_t *numerical_error) {
    for (std::size_t region = blockIdx.x * blockDim.x + threadIdx.x; region < region_count;
         region += static_cast<std::size_t>(gridDim.x) * blockDim.x) {
        const auto rx = first_x + static_cast<std::uint32_t>(region % columns);
        const auto ry = first_y + static_cast<std::uint32_t>(region / columns);
        const auto x0 = rx * 16, y0 = ry * 16;
        const auto x1 = rx + 1 == regions_x ? frame_width : x0 + 16;
        const auto y1 = ry + 1 == regions_y ? frame_height : y0 + 16;
        const auto actual_pixels = static_cast<std::uint64_t>(x1 - x0) * (y1 - y0);
        double carry = 0.0;
        // Fixed global row-major order makes output independent of CUDA block
        // scheduling. No RNG, local seed, codec column block or layer batching
        // can alter this recurrence.
        for (auto y = y0; y < y1; ++y) {
            for (auto x = x0; x < x1; ++x) {
                if (x < output.x0 || y < output.y0 || x - output.x0 >= output.width ||
                    y - output.y0 >= output.height) continue; // exact void; carry unchanged
                auto &value = output.data[static_cast<std::size_t>(y - output.y0) * output.width + x - output.x0];
                const auto energy = tables->source_energy[value];
                if (energy == 0.0) { value = 0; continue; }
                if (energy == 1.0) { value = 255; continue; }
                const auto desired = energy + carry;
                const auto index = nearest_energy(tables, desired);
                value = tables->palette[index];
                carry = desired - tables->palette_energy[index];
            }
        }
        // Leave ample headroom for double arithmetic in normal regions. Tiny
        // inputs use the actual residual, rather than rejecting solely from a
        // worst-case palette gap bound. The C boundary translates this control
        // flag into a reported numerical failure and a whole-job CPU restart.
        if (!isfinite(carry) || fabs(carry) > 0.01 * static_cast<double>(actual_pixels)) {
            atomicExch(numerical_error, 1u);
        }
    }
}

} // namespace
} // namespace dfcuda

#endif
