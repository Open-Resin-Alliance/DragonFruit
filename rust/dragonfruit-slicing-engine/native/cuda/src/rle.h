#ifndef DF_CUDA_RLE_H
#define DF_CUDA_RLE_H

#include "common.h"

namespace dfcuda {

/* One record per 4096 logical block pixels, not one record per pixel/run.
 * First/last transition positions are control metadata, never pixel copies. */
struct RleTileMetadata {
    std::uint64_t first_start;
    std::uint64_t last_start;
    std::uint32_t count;
    std::uint32_t reserved;
};

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
    PlaneView plane_{};
    std::uint32_t start_column_ = 0;
    std::uint32_t block_width_ = 0;
    bool ready_ = false;
    Buffer<RleTileMetadata> tiles_;
    Buffer<std::uint64_t> offsets_;
    Buffer<DfCudaRun> runs_;
    std::vector<RleTileMetadata> host_tiles_;
    std::vector<std::uint64_t> host_offsets_;
    cudaEvent_t plane_ready_ = nullptr;
    cudaEvent_t packed_ = nullptr;
    cudaEvent_t read_back_ = nullptr;

    void download_metadata();
};

} // namespace dfcuda

#endif
