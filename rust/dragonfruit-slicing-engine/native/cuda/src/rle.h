#ifndef DF_CUDA_RLE_H
#define DF_CUDA_RLE_H

#include "common.h"
#include "rle_control.h"

namespace dfcuda {

class RleReader {
public:
    RleReader(Runtime &runtime, const DfCudaConfig &config);
    ~RleReader();
    RleReader(const RleReader &) = delete;
    RleReader &operator=(const RleReader &) = delete;
    RleReader(RleReader &&) = delete;
    RleReader &operator=(RleReader &&) = delete;

    /* The plane must stay immutable/alive until the output is released.
     * Call only after draining the preceding caller-owned transfer lease.
     * compute -> pack ordering is established here before reading the plane. */
    void reset(PlaneView final_plane, std::uint32_t start_column,
               std::uint32_t block_width);
    std::uint64_t count() const noexcept { return run_count_; }
    std::uint64_t max_transfer_runs() const noexcept { return transfer_runs_; }
    /* Full-frame high-water reservation, including all hierarchy/control and
     * the bounded final-run buffer. No device-wide CUB scratch is required. */
    std::size_t workspace_bytes() const noexcept { return workspace_bytes_; }

    /* Destination is the final caller allocation, already registered by the
     * job. No host pixels/runs are allocated or copied. The job records its
     * completion event on runtime.readback after this returns, drains that
     * stream on errors, and unregisters before returning caller ownership.
     * Internal pack waits join every scratch readback before its next write. */
    void enqueue(std::uint64_t first_run, std::uint64_t run_count,
                 DfCudaRun *pinned_destination);

private:
    Runtime &runtime_;
    const std::uint32_t frame_width_;
    const std::uint32_t frame_height_;
    std::uint64_t transfer_runs_ = 0;
    std::uint64_t total_pixels_ = 0;
    std::uint64_t run_count_ = 0;
    std::size_t workspace_bytes_ = 0;
    std::uint32_t grid_limit_ = 1;
    std::uint32_t pack_grid_limit_ = 1;
    PlaneView plane_{};
    std::uint32_t start_column_ = 0;
    std::uint32_t block_width_ = 0;
    bool ready_ = false;
    Buffer<RleTileMetadata> tiles_;
    Buffer<rle_detail::Prefix> prefix_;
    Buffer<rle_detail::Prefix> scan_totals_;
    Buffer<rle_detail::Control> control_;
    Buffer<rle_detail::PackRange> range_;
    Buffer<DfCudaRun> runs_;
    cudaEvent_t plane_ready_ = nullptr;
    cudaEvent_t packed_ = nullptr;
    cudaEvent_t read_back_ = nullptr;

    rle_detail::Control download_control();
};

} // namespace dfcuda

#endif
