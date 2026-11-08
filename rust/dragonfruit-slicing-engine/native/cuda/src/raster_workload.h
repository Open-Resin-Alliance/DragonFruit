#ifndef DF_CUDA_RASTER_WORKLOAD_H
#define DF_CUDA_RASTER_WORKLOAD_H

#include <cstddef>
#include <cstdint>

#if defined(__CUDACC__)
#define DF_RASTER_HOST_DEVICE __host__ __device__
#else
#define DF_RASTER_HOST_DEVICE
#endif

namespace dfcuda { namespace raster_workload_detail {

struct CandidateInterval {
    std::uint32_t first, end, channel;
    bool valid;
};

// Model channels are [0,tanks); the final channel holds tank-zero supports.
// This consumes the parsed inclusive interval, not a second floating Z test.
DF_RASTER_HOST_DEVICE inline CandidateInterval candidate_interval(
    std::uint32_t first, std::uint32_t last, std::uint32_t tank,
    std::uint32_t id, std::uint32_t split, std::uint32_t triangles,
    std::uint32_t layers, std::uint32_t tanks) {
    if (first >= layers || first > last || tank >= tanks)
        return {0, 0, 0, false};
    const bool support = split > 0 && split < triangles && id >= split;
    return {first, (last < layers ? last : layers - 1) + 1,
            support ? tanks : tank, true};
}

DF_RASTER_HOST_DEVICE inline std::uint32_t selected_candidates(
    std::uint32_t model, std::uint32_t supports, std::uint32_t tank,
    bool model_only, bool supports_only) {
    if (supports_only) return tank == 0 ? supports : 0;
    return model + (!model_only && tank == 0 ? supports : 0);
}

DF_RASTER_HOST_DEVICE inline std::size_t channel_offset(
    std::uint32_t channel, std::uint32_t layers) {
    return static_cast<std::size_t>(channel) * (static_cast<std::size_t>(layers) + 1);
}

// max(retained, requested), expressed as incremental bytes so every retained
// buffer (including CUB temporary storage) stays charged between layers.
inline std::size_t growth_bytes(std::size_t retained_elements,
                                std::size_t requested_elements,
                                std::size_t element_bytes) {
    return requested_elements > retained_elements
        ? (requested_elements - retained_elements) * element_bytes : 0;
}

inline bool fits_workspace(std::size_t retained, std::size_t growth,
                           std::size_t quota) {
    return retained <= quota && growth <= quota - retained;
}

} } // namespace dfcuda::raster_workload_detail

#undef DF_RASTER_HOST_DEVICE
#endif
