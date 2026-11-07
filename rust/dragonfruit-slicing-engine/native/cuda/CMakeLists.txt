cmake_minimum_required(VERSION 3.24)
project(dragonfruit_cuda_slicer LANGUAGES CXX CUDA)

if(NOT WIN32)
    message(FATAL_ERROR "The CUDA slicing backend currently targets Windows")
endif()

if(NOT CMAKE_CUDA_COMPILER_VERSION VERSION_GREATER_EQUAL 12.9 OR
   CMAKE_CUDA_COMPILER_VERSION VERSION_GREATER_EQUAL 12.10)
    message(FATAL_ERROR "CUDA 12.9 is required to retain Pascal support")
endif()

find_package(CUDAToolkit 12.9 REQUIRED)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CUDA_STANDARD 17)
set(CMAKE_CUDA_STANDARD_REQUIRED ON)

# CUDA 12.9 is the last major toolkit family targeting Pascal. Embed native
# images rather than making Pascal depend on runtime PTX compilation.
if(NOT DEFINED DF_CUDA_ARCHITECTURES)
    set(DF_CUDA_ARCHITECTURES "60-real;61-real;70-real;75-real;80-real;86-real;89-real;90-real;100-real")
endif()

add_library(df_cuda_slicer STATIC
    src/runtime.cpp
    src/job.cpp
    src/shim.cpp
    src/raster.cu
    src/post.cu
    src/rle.cu
)
target_include_directories(df_cuda_slicer PUBLIC include PRIVATE src)
target_link_libraries(df_cuda_slicer PUBLIC CUDA::cudart)
set_target_properties(df_cuda_slicer PROPERTIES
    CUDA_RUNTIME_LIBRARY Shared
    CUDA_ARCHITECTURES "${DF_CUDA_ARCHITECTURES}"
    CUDA_SEPARABLE_COMPILATION OFF
    POSITION_INDEPENDENT_CODE ON
    MSVC_RUNTIME_LIBRARY "MultiThreadedDLL"
)

# Binary edge ties and integer blur/LUT contracts must not acquire contraction,
# flush-to-zero or reciprocal approximations as an optimization side effect.
target_compile_options(df_cuda_slicer PRIVATE
    $<$<COMPILE_LANGUAGE:CUDA>:--fmad=false>
    $<$<COMPILE_LANGUAGE:CUDA>:--ftz=false>
    $<$<COMPILE_LANGUAGE:CUDA>:--prec-div=true>
    $<$<COMPILE_LANGUAGE:CUDA>:--prec-sqrt=true>
    $<$<AND:$<COMPILE_LANGUAGE:CXX>,$<CXX_COMPILER_ID:MSVC>>:/fp:strict>
    $<$<AND:$<COMPILE_LANGUAGE:CUDA>,$<CXX_COMPILER_ID:MSVC>>:-Xcompiler=/fp:strict>
)

target_compile_definitions(df_cuda_slicer PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
install(TARGETS df_cuda_slicer ARCHIVE DESTINATION lib)
install(FILES include/df_cuda_slicer.h DESTINATION include)
