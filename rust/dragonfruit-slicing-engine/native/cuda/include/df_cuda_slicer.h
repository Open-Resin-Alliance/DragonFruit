#ifndef DF_CUDA_SLICER_H
#define DF_CUDA_SLICER_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define DF_CUDA_ABI_VERSION 1u
#define DF_CUDA_ERROR_MESSAGE_BYTES 512u

typedef struct DfCudaJob DfCudaJob;

typedef enum DfCudaStatus {
    DF_CUDA_OK = 0,
    DF_CUDA_END = 1,
    DF_CUDA_INVALID_ARGUMENT = 2,
    DF_CUDA_UNAVAILABLE = 3,
    DF_CUDA_OUT_OF_MEMORY = 4,
    DF_CUDA_EXECUTION_ERROR = 5,
    DF_CUDA_CANCELLED = 6,
    DF_CUDA_NUMERICAL_ERROR = 7
} DfCudaStatus;

typedef enum DfCudaRasterMode {
    DF_CUDA_BINARY = 0,
    DF_CUDA_COVERAGE = 1,
    DF_CUDA_BLUR = 2,
    DF_CUDA_PERTURBATION = 3
} DfCudaRasterMode;

typedef enum DfCudaSamplePattern {
    DF_CUDA_UNIFORM = 0,
    DF_CUDA_HALTON = 1,
    DF_CUDA_BASE2 = 2
} DfCudaSamplePattern;

/* Numeric job settings only. Printer codecs and metadata stay with the caller. */
typedef struct DfCudaConfig {
    uint32_t abi_version;
    uint32_t struct_size;
    uint32_t width;
    uint32_t height;
    uint32_t total_layers;
    uint32_t tank_count;
    uint32_t model_triangle_count;
    uint32_t raster_mode;
    uint32_t aa_samples;
    uint32_t sample_pattern;
    uint32_t duplicate_terminal_z;
    uint32_t mirror_x;
    uint32_t mirror_y;
    uint32_t aa_on_supports;
    uint32_t xy_blur_radius;
    uint32_t xy_blur_gaussian;
    uint32_t z_blur_radius;
    uint32_t z_blur_gaussian;
    uint32_t dither_bit_depth;
    uint32_t custom_lut_count;
    uint32_t compute_area_stats;
    /* 0 preferred RLE, 1 dense/generic, 2 direct legacy RLE-PNG binary. */
    uint32_t dense_raster_semantics;
    uint32_t look_back;
    uint32_t reserved;
    float build_width_mm;
    float build_depth_mm;
    float layer_height_mm;
    float minimum_aa_alpha_percent;
    float z_blend_minimum_alpha_percent;
    float z_blend_maximum_alpha_percent;
    double xy_sigma_x;
    double xy_sigma_y;
    double z_sigma;
    double dither_gamma;
    double generic_z_center_weight_scale;
    uint8_t custom_lut[256];
} DfCudaConfig;

typedef struct DfCudaBlock {
    uint32_t start_column;
    uint32_t width;
} DfCudaBlock;

/* Exactly eight bytes; reserved bytes are written as zero by the GPU. */
typedef struct DfCudaRun {
    uint32_t length;
    uint8_t value;
    uint8_t reserved[3];
} DfCudaRun;

typedef struct DfCudaAreaStats {
    uint64_t total_solid_pixels;
    double total_solid_area_mm2;
    double largest_area_mm2;
    double smallest_area_mm2;
    int32_t min_x;
    int32_t min_y;
    int32_t max_x;
    int32_t max_y;
    uint32_t area_count;
    uint32_t reserved;
} DfCudaAreaStats;

typedef struct DfCudaOutput {
    uint64_t token;
    uint64_t run_count;
    uint64_t max_transfer_runs;
    uint32_t layer_index;
    uint32_t tank_index;
    uint32_t block_index;
    uint32_t start_column;
    uint32_t width;
    uint32_t height;
    DfCudaAreaStats area_stats;
} DfCudaOutput;

typedef struct DfCudaError {
    int32_t code;
    char message[DF_CUDA_ERROR_MESSAGE_BYTES];
} DfCudaError;

/* Input remains caller-owned and immutable until job destruction. Uploads pin
 * bounded ranges of these original allocations; no host staging copy is made. */
int32_t df_cuda_create(const DfCudaConfig *config,
                      const float *triangles_xyz, uint64_t float_count,
                      const uint32_t *triangle_tanks, uint64_t tank_index_count,
                      const DfCudaBlock *blocks, uint64_t block_count,
                      DfCudaJob **out_job, DfCudaError *error);

/* One output lease at a time. END means every layer/tank/block was delivered. */
int32_t df_cuda_next_output(DfCudaJob *job, DfCudaOutput *output, DfCudaError *error);

/* Pins the caller's final destination range and queues VRAM-to-host DMA. The
 * allocation may not move, resize, be read, or be freed until wait returns and
 * unregisters it. Only one outstanding transfer per job is permitted. */
int32_t df_cuda_read_runs_async(DfCudaJob *job, uint64_t output_token,
                               uint64_t first_run, uint64_t run_count,
                               DfCudaRun *destination, uint64_t destination_capacity,
                               uint64_t *transfer_token, DfCudaError *error);
int32_t df_cuda_wait_transfer(DfCudaJob *job, uint64_t transfer_token, DfCudaError *error);
int32_t df_cuda_release_output(DfCudaJob *job, uint64_t output_token, DfCudaError *error);

/* Cancel is thread-safe and does not call CUDA. Destroy joins native work and
 * drains/unregisters transfers before returning ownership of input buffers. */
void df_cuda_cancel(DfCudaJob *job);
void df_cuda_destroy(DfCudaJob *job);

#ifdef __cplusplus
}
#endif

#endif
