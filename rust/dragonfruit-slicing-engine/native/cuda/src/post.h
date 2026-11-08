#ifndef DF_CUDA_POST_H
#define DF_CUDA_POST_H

#include "common.h"
#include <memory>

namespace dfcuda {

struct PostTables {
    std::uint32_t x_weights[65];
    std::uint32_t y_weights[65];
    std::uint32_t z_weights[9];
    std::uint8_t lut[256];
    std::uint8_t palette[128];
    double source_energy[256];
    double palette_energy[128];
    std::uint32_t palette_count;
};

struct SharedPostTables {
    SharedPostTables(Runtime &runtime, const PostTables &tables);
    const PostTables *data() const noexcept { return device_.data(); }
    std::uint32_t z_weight(std::uint32_t distance) const noexcept { return z_weights_[distance]; }
private:
    Buffer<PostTables> device_;
    std::uint32_t z_weights_[9]{};
};
using SharedPostTablesPtr = std::shared_ptr<const SharedPostTables>;

struct PostNode { std::uint32_t parent, pixels, next; };
struct PostComponents {
    std::uint32_t total_pixels, area_count, largest_pixels, smallest_pixels;
};
struct PostBasic {
    unsigned long long pixels;
    std::uint32_t min_x, min_y, max_x, max_y;
};

class Postprocessor {
public:
    Postprocessor(Runtime &runtime, const DfCudaConfig &config);
    Postprocessor(Runtime &runtime, const DfCudaConfig &config, SharedPostTablesPtr tables);
    ~Postprocessor();
    SharedPostTablesPtr shared_tables() const noexcept { return tables_; }
    std::size_t minimum_workspace_bytes() const;
    // Reserve above minimum_workspace_bytes(); horizontal scratch is retained
    // separately from the worker's raster/component workspace.
    std::size_t additional_horizontal_workspace_bytes(std::size_t worker_workspace) const;
    Postprocessor(const Postprocessor &) = delete;
    Postprocessor &operator=(const Postprocessor &) = delete;
    Plane spatial(Plane input);
    Plane blend_z(const WindowPlane *sources, std::size_t count);
    void finish(Plane &output, const Plane *raw_supports);
    DfCudaAreaStats statistics(const Plane &output);
    void prepare_legacy(Plane &model, const Plane *raw_supports, bool apply_model_aa);
    std::uint32_t xy_radius() const noexcept { return xy_radius_; }
    std::uint32_t z_radius() const noexcept { return z_radius_; }
private:
    void initialize();
    std::size_t small_workspace_bytes() const noexcept;
    std::size_t horizontal_workspace_bytes(std::size_t worker_workspace) const;
    void refresh_bounds(Plane &plane);
    Runtime &runtime_;
    const DfCudaConfig &config_;
    std::uint32_t xy_radius_ = 0;
    std::uint32_t z_radius_ = 0;
    bool gaussian_xy_ = false;
    bool tail_enabled_ = false;
    bool dither_enabled_ = false;
    SharedPostTablesPtr tables_;
    Buffer<std::uint32_t> horizontal_;
    Buffer<PostBasic> basic_;
    Buffer<PostNode> nodes_;
    Buffer<std::uint32_t> frontier_labels_, frontier_pixels_;
    Buffer<PostComponents> components_;
    Buffer<std::uint32_t> numerical_error_;
};

} // namespace dfcuda

#endif
