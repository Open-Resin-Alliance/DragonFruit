cmake_minimum_required(VERSION 3.24)
# Compiler selection happens at project(), before FindCUDAToolkit. Cargo also
# pins the Visual Studio cuda= toolset and uses a fresh toolchain-specific tree.
if(DEFINED CUDAToolkit_ROOT AND NOT DEFINED CMAKE_CUDA_COMPILER)
    set(CMAKE_CUDA_COMPILER "${CUDAToolkit_ROOT}/bin/nvcc.exe" CACHE FILEPATH "CUDA 12.9 compiler")
endif()

project(dragonfruit_cuda_slicer LANGUAGES CXX CUDA)

if(NOT WIN32)
    message(FATAL_ERROR "The CUDA slicing backend currently targets Windows")
endif()

if(NOT CMAKE_CUDA_COMPILER_VERSION VERSION_GREATER_EQUAL 12.9 OR
   CMAKE_CUDA_COMPILER_VERSION VERSION_GREATER_EQUAL 12.10)
    message(FATAL_ERROR "CUDA 12.9 is required to retain Pascal support; selected ${CMAKE_CUDA_COMPILER_VERSION} at ${CMAKE_CUDA_COMPILER}")
endif()

if(MSVC AND (CMAKE_CXX_COMPILER_VERSION VERSION_LESS 19.20 OR
             NOT CMAKE_CXX_COMPILER_VERSION VERSION_LESS 19.40))
    message(FATAL_ERROR "CUDA 12.9 requires MSVC 19.2x or 19.3x; selected ${CMAKE_CXX_COMPILER_VERSION}. The Cargo native build uses VS2022 with an installed 19.3x toolset.")
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
    src/trace.cpp
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
    $<$<AND:$<COMPILE_LANGUAGE:CXX>,$<CXX_COMPILER_ID:MSVC>>:/utf-8>
    $<$<AND:$<COMPILE_LANGUAGE:CUDA>,$<CXX_COMPILER_ID:MSVC>>:-Xcompiler=/fp:strict>
    $<$<AND:$<COMPILE_LANGUAGE:CUDA>,$<CXX_COMPILER_ID:MSVC>>:-Xcompiler=/utf-8>
)

target_compile_definitions(df_cuda_slicer PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
install(TARGETS df_cuda_slicer ARCHIVE DESTINATION lib)
install(FILES include/df_cuda_slicer.h DESTINATION include)
