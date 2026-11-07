#include "df_cuda_slicer.h"
#include "common.h"

#include <cstdio>
#include <cstring>
#include <new>
#include <exception>

struct DfCudaJob;

namespace dfcuda_native {
DfCudaJob *create(const DfCudaConfig *, const float *, std::uint64_t,
                  const std::uint32_t *, std::uint64_t,
                  const DfCudaBlock *, std::uint64_t);
int next_output(DfCudaJob *, DfCudaOutput *);
int read_runs_async(DfCudaJob *, std::uint64_t, std::uint64_t, std::uint64_t,
                    DfCudaRun *, std::uint64_t, std::uint64_t *);
int wait_transfer(DfCudaJob *, std::uint64_t);
int release_output(DfCudaJob *, std::uint64_t);
void cancel(DfCudaJob *) noexcept;
void abort(DfCudaJob *) noexcept;
void destroy(DfCudaJob *) noexcept;
}

namespace {

void clear_error(DfCudaError *error) noexcept {
    if (error == nullptr) return;
    error->code = DF_CUDA_OK;
    error->message[0] = '\0';
}

void set_error(DfCudaError *error, DfCudaStatus status, const char *message) noexcept {
    if (error == nullptr) return;
    error->code = static_cast<std::int32_t>(status);
    if (message == nullptr) message = "native CUDA failure";
    std::snprintf(error->message, DF_CUDA_ERROR_MESSAGE_BYTES, "%s", message);
    error->message[DF_CUDA_ERROR_MESSAGE_BYTES - 1] = '\0';
}

DfCudaStatus exception_status(const dfcuda::Error &error) noexcept { return error.status; }

template<class F> int invoke(F &&function, DfCudaError *error, DfCudaJob *job = nullptr) noexcept {
    clear_error(error);
    try {
        return function();
    } catch (const dfcuda::Error &failure) {
        dfcuda_native::abort(job);
        set_error(error, exception_status(failure), failure.what());
        return static_cast<int>(failure.status);
    } catch (const std::bad_alloc &failure) {
        dfcuda_native::abort(job);
        set_error(error, DF_CUDA_OUT_OF_MEMORY, failure.what());
        return DF_CUDA_OUT_OF_MEMORY;
    } catch (const std::exception &failure) {
        dfcuda_native::abort(job);
        set_error(error, DF_CUDA_EXECUTION_ERROR, failure.what());
        return DF_CUDA_EXECUTION_ERROR;
    } catch (...) {
        dfcuda_native::abort(job);
        set_error(error, DF_CUDA_EXECUTION_ERROR, "unknown native CUDA exception");
        return DF_CUDA_EXECUTION_ERROR;
    }
}

} // namespace

extern "C" int32_t df_cuda_create(const DfCudaConfig *config,
                                   const float *triangles_xyz, uint64_t float_count,
                                   const uint32_t *triangle_tanks, uint64_t tank_index_count,
                                   const DfCudaBlock *blocks, uint64_t block_count,
                                   DfCudaJob **out_job, DfCudaError *error) {
    clear_error(error);
    if (out_job == nullptr) {
        set_error(error, DF_CUDA_INVALID_ARGUMENT, "null CUDA job output");
        return DF_CUDA_INVALID_ARGUMENT;
    }
    *out_job = nullptr;
    return invoke([&]() {
        *out_job = dfcuda_native::create(config, triangles_xyz, float_count,
                                         triangle_tanks, tank_index_count, blocks, block_count);
        return DF_CUDA_OK;
    }, error);
}

extern "C" int32_t df_cuda_next_output(DfCudaJob *job, DfCudaOutput *output,
                                        DfCudaError *error) {
    if (job == nullptr) {
        clear_error(error);
        set_error(error, DF_CUDA_INVALID_ARGUMENT, "null CUDA job");
        return DF_CUDA_INVALID_ARGUMENT;
    }
    return invoke([&]() { return dfcuda_native::next_output(job, output); }, error, job);
}

extern "C" int32_t df_cuda_read_runs_async(DfCudaJob *job, uint64_t output_token,
                                            uint64_t first_run, uint64_t run_count,
                                            DfCudaRun *destination, uint64_t destination_capacity,
                                            uint64_t *transfer_token, DfCudaError *error) {
    if (job == nullptr) {
        clear_error(error);
        set_error(error, DF_CUDA_INVALID_ARGUMENT, "null CUDA job");
        return DF_CUDA_INVALID_ARGUMENT;
    }
    return invoke([&]() {
        return dfcuda_native::read_runs_async(job, output_token, first_run, run_count,
                                              destination, destination_capacity, transfer_token);
    }, error, job);
}

extern "C" int32_t df_cuda_wait_transfer(DfCudaJob *job, uint64_t transfer_token,
                                          DfCudaError *error) {
    if (job == nullptr) {
        clear_error(error);
        set_error(error, DF_CUDA_INVALID_ARGUMENT, "null CUDA job");
        return DF_CUDA_INVALID_ARGUMENT;
    }
    return invoke([&]() { return dfcuda_native::wait_transfer(job, transfer_token); }, error, job);
}

extern "C" int32_t df_cuda_release_output(DfCudaJob *job, uint64_t output_token,
                                            DfCudaError *error) {
    if (job == nullptr) {
        clear_error(error);
        set_error(error, DF_CUDA_INVALID_ARGUMENT, "null CUDA job");
        return DF_CUDA_INVALID_ARGUMENT;
    }
    return invoke([&]() { return dfcuda_native::release_output(job, output_token); }, error, job);
}

extern "C" void df_cuda_cancel(DfCudaJob *job) { dfcuda_native::cancel(job); }
extern "C" void df_cuda_destroy(DfCudaJob *job) { dfcuda_native::destroy(job); }
