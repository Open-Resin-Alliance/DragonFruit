#ifndef DF_CUDA_POST_H
#define DF_CUDA_POST_H

#include "common.h"

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

struct PostSpan { std::uint32_t start, end, component; };
struct PostNode { std::uint32_t parent, pixels, active, next; };
struct PostComponents {
    std::uint32_t previous_count, node_count, parity;
    std::uint32_t total_pixels, area_count, largest_pixels, smallest_pixels;
};
struct PostBasic {
    unsigned long long pixels;
    std::uint32_t min_x, min_y, max_x, max_y;
};

class Postprocessor {
public:
    Postprocessor(Runtime &runtime, const DfCudaConfig &config);
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
    void refresh_bounds(Plane &plane);
    Runtime &runtime_;
    const DfCudaConfig &config_;
    std::uint32_t xy_radius_ = 0;
    std::uint32_t z_radius_ = 0;
    std::uint32_t z_weights_[9]{};
    bool gaussian_xy_ = false;
    bool tail_enabled_ = false;
    bool dither_enabled_ = false;
    Buffer<PostTables> tables_;
    Buffer<std::uint32_t> horizontal_;
    Buffer<WindowPlane> window_;
    Buffer<PostBasic> basic_;
    Buffer<PostSpan> spans_a_, spans_b_;
    Buffer<PostNode> nodes_;
    Buffer<std::uint32_t> root_pixels_;
    Buffer<PostComponents> components_;
    Buffer<std::uint32_t> numerical_error_;
};

} // namespace dfcuda

#endif
