# dragonfruit-openvdb-sys

Minimal C-ABI wrapper over OpenVDB `meshToVolume` + `volumeToMesh`, used by
`dragonfruit-mesh-repair`'s voxel-remesh fallback to turn arbitrary (including
non-manifold / self-intersecting) triangle soups into watertight, 2-manifold
meshes.

## Vendored dependencies (git submodules)

Everything is built from source and statically linked so the build is identical
on Windows (MSVC), macOS, Linux and the flatpak runner — no system packages.
Blosc/ZLIB/EXR are disabled (we never read/write `.vdb` files), which removes
OpenVDB's heaviest transitive deps.

```sh
git submodule add -b v2021.13.0 https://github.com/oneapi-src/oneTBB.git \
    rust/dragonfruit-openvdb-sys/vendor/tbb
git submodule add -b v3.1.12    https://github.com/AcademySoftwareFoundation/Imath.git \
    rust/dragonfruit-openvdb-sys/vendor/imath
git submodule add -b v12.0.1    https://github.com/AcademySoftwareFoundation/openvdb.git \
    rust/dragonfruit-openvdb-sys/vendor/openvdb
git submodule update --init --recursive
```

## Notes

- First build compiles TBB + Imath + OpenVDB from source (several minutes).
- Static-lib names in `build.rs` (`Imath-3_1`, `tbb`) and `lib`/`lib64` install
  dirs may need a per-platform tweak on first build; everything else is
  version-stable.
- Requires CMake and a C++17 compiler on PATH — already present on every
  DragonFruit build target.
