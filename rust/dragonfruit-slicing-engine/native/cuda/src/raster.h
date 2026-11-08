#ifndef DF_CUDA_RASTER_H
#define DF_CUDA_RASTER_H

#include "common.h"
#include "post.h"
#include <optional>
#include <memory>

namespace dfcuda {

struct RasterTriangle {
    float z[3];
    float x[3];
    float y[3];
    float z_min, z_max, dir_x, dir_y;
    std::int32_t wind;
    std::uint32_t tank, first_layer, last_layer;
};

struct RasterIndexBlock {
    std::uint32_t first_layer, last_layer;
};

struct RasterEdge {
    float x, dx_dy;
    std::int32_t wind;
    std::uint32_t end_exclusive;
    float base_x, base_y;
};

struct RasterCrossingLane {
    std::uint32_t offset, count;
};

struct RasterSpan {
    float a, b;
    std::uint32_t start, end;
};

struct RasterPair { float a, b; };
struct RasterOrphan { float x; std::int32_t wind; };
struct RasterState {
    std::uint32_t cursor, count, open_count, orphan_count, pair_count;
    float merge_a, merge_b;
    std::uint32_t merge_live;
};


// Published only after the root builder's compute stream has completed.
// Readers retain the owner; they never mutate buffer last-use streams.
struct RasterGeometry {
    Buffer<RasterTriangle> triangles;
    Buffer<std::uint32_t> index;
    Buffer<RasterIndexBlock> index_blocks;
    std::uint32_t triangle_count = 0, ssaa_factor = 1;
    std::uint32_t model_first_layer = 0, model_last_layer = 0;
    // Channel-major GPU prefix summary, stride total_layers + 1. The final
    // channel holds supports; preceding channels hold each tank's models.
    std::vector<std::uint32_t> candidate_counts;
    std::uint32_t peak_candidates = 0;
    // Full-width scene row storage, including rounded phases and XY/work-frame
    // halo across every tank/model/support/Z union; not an X vertex-hull crop.
    std::size_t max_plane_bytes = 0, minimum_workspace_bytes = 0;
    std::size_t preferred_workspace_bytes = 0;
};
using RasterGeometryPtr = std::shared_ptr<const RasterGeometry>;

struct RasterBandRow {
    std::uint32_t offset, n, count, defective, selected, collapsed_count;
    std::uint32_t event_offset, starting;
    std::int32_t minimum, maximum;
    std::uint32_t repaired[2], matches[2];
    std::uint64_t overlap[4], area[2];
};
struct RasterCarry {
    float fractional;
    std::uint32_t hit;
    std::uint64_t interior, lit;
};
class Rasterizer {
public:
    Rasterizer(Runtime &, const DfCudaConfig &, const float *host_xyz,
               std::size_t float_count, const std::uint32_t *host_tanks,
               std::size_t tank_index_count);
    Rasterizer(Runtime &, const DfCudaConfig &, RasterGeometryPtr);
    RasterGeometryPtr shared_geometry() const { return geometry_; }
    std::size_t max_plane_bytes() const { return geometry_->max_plane_bytes; }
    std::size_t minimum_workspace_bytes() const { return geometry_->minimum_workspace_bytes; }
    // Preparation floor versus scene-useful sizing; neither promises every
    // actual event/band fits. Actual retained capacities enforce the quota.
    std::size_t preferred_workspace_bytes() const { return geometry_->preferred_workspace_bytes; }
    ~Rasterizer() = default;
    Rasterizer(const Rasterizer &) = delete;
    Rasterizer &operator=(const Rasterizer &) = delete;
    Rasterizer(Rasterizer &&) = delete;
    Rasterizer &operator=(Rasterizer &&) = delete;
    Plane render(std::uint32_t layer_index, std::uint32_t tank_index,
                 RasterSelection selection);
    bool applies_model_aa(std::uint32_t layer_index) const;
private:
    Runtime &runtime_;
    DfCudaConfig config_;
    RasterGeometryPtr geometry_;
    std::optional<Plane> cached_supports_;
    std::uint32_t cached_support_layer_ = 0;
    // The statistics-only postprocessor borrows this configuration.
    std::optional<DfCudaConfig> source_statistics_config_;
    std::optional<Postprocessor> source_statistics_;
    Buffer<RasterCrossingLane> crossing_lanes_;
    Buffer<std::uint8_t> temporary_;
    Buffer<std::uint32_t> keys_, keys_out_, ids_, candidates_, counts_;
    Buffer<std::uint64_t> event_keys_, event_keys_out_;
    Buffer<RasterEdge> events_, events_out_, lane_edges_, lane_scratch_, band_edges_, collapsed_;
    Buffer<RasterSpan> spans_, positive_, negative_, previous_;
    Buffer<RasterPair> pairs_, pairs_out_;
    Buffer<RasterOrphan> orphans_, orphans_out_;
    Buffer<float> float_keys_, float_keys_out_, open_, endpoints_, endpoints_out_;
    Buffer<std::uint64_t> winding_, winding_prefix_;
    Buffer<RasterState> state_;
    Buffer<RasterBandRow> band_rows_;
    Buffer<RasterCarry> carry_a_, carry_b_;
    Buffer<std::uint64_t> span_flags_, span_prefix_;
    Buffer<std::uint32_t> frontier_;
    Buffer<std::uint64_t> evidence_;
    void initialize_scratch();
    void plan_workspace(RasterGeometry &);
    std::size_t retained_workspace_bytes() const;
    std::size_t raster_workspace_budget() const;
    // Called only at joined stage boundaries, before any current event/band
    // contents exist. Buffer::clear retires through the owning stream.
    void release_band_workspace();
    void release_event_workspace();
    template<class T> void resize_workspace(Buffer<T> &buffer, std::size_t count) {
        const auto requested = checked_bytes(count, sizeof(T));
        const auto retained = checked_bytes(buffer.capacity(), sizeof(T));
        const auto growth = requested > retained ? requested - retained : 0;
        const auto used = retained_workspace_bytes();
        const auto quota = raster_workspace_budget();
        if (used > quota || growth > quota - used)
            throw Error(DF_CUDA_OUT_OF_MEMORY, "CUDA raster retained buffers exceed worker workspace");
        buffer.resize(count);
    }
    void process_band(const RasterBandRow *host_rows, std::uint32_t rows,
                      std::uint32_t maximum, std::uint32_t first_row,
                      std::uint32_t divisor, bool coverage, bool raw_supports,
                      Plane &, Plane &, PostBasic *);
};

} // namespace dfcuda
#endif
