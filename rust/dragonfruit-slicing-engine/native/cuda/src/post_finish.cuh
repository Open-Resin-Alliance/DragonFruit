#ifndef DF_CUDA_POST_FINISH_CUH
#define DF_CUDA_POST_FINISH_CUH

#include "post_dither.cuh"

namespace dfcuda {

void Postprocessor::finish(Plane &output, const Plane *raw_supports) {
    runtime_.activate();
    runtime_.check_cancelled();
    if (config_.dense_raster_semantics == 2) return;
    if (!output.empty()) {
        if (dither_enabled_) {
            output.raster_stats_valid = false;
            output.bounds_valid = false;
            numerical_error_.resize(1);
            checked(cudaMemsetAsync(numerical_error_.data(), 0, sizeof(std::uint32_t), runtime_.compute),
                    "clearing CUDA regional exposure status");
            // Count nominal tiles without width+15 overflow, then merge an
            // incomplete strip into its last full neighbor. The kernel extends
            // that neighbor to the ACTUAL frame edge, including the corner.
            const auto tiles_x = config_.width / 16 + (config_.width % 16 != 0);
            const auto tiles_y = config_.height / 16 + (config_.height % 16 != 0);
            const auto regions_x = tiles_x > 1 && config_.width % 16 != 0 ? tiles_x - 1 : tiles_x;
            const auto regions_y = tiles_y > 1 && config_.height % 16 != 0 ? tiles_y - 1 : tiles_y;
            const auto first_x = std::min(output.x0 / 16, regions_x - 1);
            const auto first_y = std::min(output.y0 / 16, regions_y - 1);
            const auto last_x = std::min((output.x0 + output.width - 1) / 16, regions_x - 1);
            const auto last_y = std::min((output.y0 + output.height - 1) / 16, regions_y - 1);
            const auto columns = last_x - first_x + 1;
            const auto rows = static_cast<std::size_t>(last_y - first_y + 1);
            if (rows != 0 && static_cast<std::size_t>(columns) >
                std::numeric_limits<std::size_t>::max() / rows) {
                throw Error(DF_CUDA_OUT_OF_MEMORY, "CUDA regional quantizer count overflow");
            }
            const auto region_count = static_cast<std::size_t>(columns) * rows;
            dither_regions<<<blocks_for(region_count), threads, 0, runtime_.compute>>>(
                output.view(), tables_.data(), config_.width, config_.height,
                regions_x, regions_y, first_x, first_y, columns, region_count,
                numerical_error_.data());
            checked(cudaGetLastError(), "launching CUDA regional exposure quantizer");
            output.pixels.mark_used(runtime_.compute);
            tables_.mark_used(runtime_.compute);
            numerical_error_.mark_used(runtime_.compute);
            const auto error = download_control(runtime_, numerical_error_);
            runtime_.check_cancelled();
            if (error != 0) {
                throw Error(DF_CUDA_NUMERICAL_ERROR, "regional exposure bound exceeded");
            }
        } else if (tail_enabled_) {
            output.raster_stats_valid = false;
            output.bounds_valid = false;
            map_lut<<<blocks_for(output.bytes()), threads, 0, runtime_.compute>>>(output.view(), tables_.data());
            checked(cudaGetLastError(), "launching CUDA cure LUT");
            output.pixels.mark_used(runtime_.compute);
            tables_.mark_used(runtime_.compute);
        }
    }
    if (raw_supports == nullptr || raw_supports->empty() ||
        (raw_supports->bounds_valid &&
         (raw_supports->nonzero_bounds.x1 < raw_supports->nonzero_bounds.x0 ||
          raw_supports->nonzero_bounds.y1 < raw_supports->nonzero_bounds.y0))) return;
    output.raster_stats_valid = false;
    output.bounds_valid = false;
    bool present = false;
    std::uint32_t x0 = 0, y0 = 0, x1 = 0, y1 = 0;
    union_bounds(output.view(), present, x0, y0, x1, y1);
    union_bounds(raw_supports->view(), present, x0, y0, x1, y1);
    if (!output.empty() && output.x0 == x0 && output.y0 == y0 &&
        output.width == x1 - x0 && output.height == y1 - y0) {
        // Each thread reads/writes its own model byte; support is immutable.
        merge_supports<<<blocks_for(output.bytes()), threads, 0, runtime_.compute>>>(
            output.view(), output.view(), raw_supports->view());
        checked(cudaGetLastError(), "launching CUDA raw support max merge");
        output.pixels.mark_used(runtime_.compute);
    } else {
        Plane combined(runtime_, x0, y0, x1 - x0, y1 - y0);
        merge_supports<<<blocks_for(combined.bytes()), threads, 0, runtime_.compute>>>(
            combined.view(), output.view(), raw_supports->view());
        checked(cudaGetLastError(), "launching CUDA support ROI union");
        output.pixels.mark_used(runtime_.compute);
        combined.pixels.mark_used(runtime_.compute);
        output = std::move(combined);
    }
}

} // namespace dfcuda

#endif
