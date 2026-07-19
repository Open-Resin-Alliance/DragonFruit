#pragma once
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Bit flags for DfVdbParams.flags
#define DF_VDB_CURVATURE_ADAPTIVE 0x1  // build a curvature-driven spatial-adaptivity mask

typedef struct DfVdbParams {
    float voxel_size;           // world units per voxel
    float exterior_band;        // narrow-band half-width outside, in voxels
    float interior_band;        // narrow-band half-width inside, in voxels
    float adaptivity;           // base volumeToMesh adaptivity [0,1]
    float curvature_adaptivity; // 0 = uniform; >0 = strength of curvature term
    int   flags;
} DfVdbParams;

typedef struct DfVdbResult {
    float*    verts;  // xyz triplets, length = 3 * nverts
    size_t    nverts;
    uint32_t* tris;   // vertex indices, length = 3 * ntris
    size_t    ntris;
    int       ok;     // 1 on success, 0 on failure
} DfVdbResult;

// Remesh an arbitrary (incl. non-manifold / self-intersecting) triangle soup
// into a watertight, 2-manifold triangle mesh via an OpenVDB level set.
// Returns 1 on success (out populated, free with df_vdb_free), 0 on failure.
int df_vdb_remesh(const float* verts, size_t nverts,
                  const uint32_t* tris, size_t ntris,
                  const DfVdbParams* params, DfVdbResult* out);

void df_vdb_free(DfVdbResult* r);

#ifdef __cplusplus
}
#endif
