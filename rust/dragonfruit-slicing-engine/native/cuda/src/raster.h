#ifndef DF_CUDA_RASTER_H
#define DF_CUDA_RASTER_H

#include "common.h"
#include "post.h"
#include <optional>

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

struct RasterSpan {
    float a, b;
    std::uint32_t start, end;
};

struct RasterPair { float a, b; };
struct RasterOrphan { float x; std::int32_t wind; };
struct RasterState {
    std::uint32_t cursor, count, open_count, orphan_count, pair_count;
    std::int32_t winding, minimum_winding, maximum_winding;
    float merge_a, merge_b;
    std::uint32_t merge_live;
};

class Rasterizer {
public:
    Rasterizer(Runtime &, const DfCudaConfig &, const float *host_xyz,
               std::size_t float_count, const std::uint32_t *host_tanks,
               std::size_t tank_index_count);
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
    std::uint32_t triangle_count_ = 0;
    std::uint32_t ssaa_factor_ = 1;
    std::uint32_t model_first_layer_ = 0, model_last_layer_ = 0;
    std::optional<Plane> cached_supports_;
    std::uint32_t cached_support_layer_ = 0;
    std::optional<Postprocessor> source_statistics_;
    Buffer<RasterTriangle> triangles_;
    Buffer<std::uint32_t> index_;
    Buffer<RasterIndexBlock> index_blocks_;
    Buffer<std::uint8_t> temporary_;
    Buffer<std::uint32_t> keys_, keys_out_, ids_, candidates_, counts_;
    Buffer<std::uint64_t> event_keys_, event_keys_out_;
    Buffer<RasterEdge> events_, events_out_, row_edges_, collapsed_;
    Buffer<RasterSpan> spans_, positive_, negative_, previous_;
    Buffer<RasterPair> pairs_, pairs_out_;
    Buffer<RasterOrphan> orphans_, orphans_out_;
    Buffer<float> float_keys_, float_keys_out_, open_, endpoints_, endpoints_out_, row_accum_;
    Buffer<std::int32_t> row_delta_, row_prefix_;
    Buffer<RasterState> state_;
    Buffer<std::uint64_t> evidence_;
    std::uint32_t build_spans(RasterEdge *, std::uint32_t, std::uint32_t,
                             bool, std::uint32_t);
    std::uint32_t repair(RasterEdge *, std::uint32_t, std::uint32_t,
                         bool, std::int32_t, Buffer<RasterSpan> &);
};

} // namespace dfcuda
#endif
