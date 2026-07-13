#include "df_vdb_shim.hpp"

#include <openvdb/openvdb.h>
#include <openvdb/tools/MeshToVolume.h>
#include <openvdb/tools/VolumeToMesh.h>
#include <openvdb/tools/GridOperators.h>  // MeanCurvature

#include <cstdlib>
#include <cstring>
#include <vector>
#include <mutex>
#include <algorithm>
#include <cmath>

namespace {

std::once_flag g_vdb_init;

// Build a per-voxel spatial-adaptivity mask from level-set mean curvature.
// VolumeToMesh treats the mask value in [0,1] as a *local* adaptivity
// multiplier: 1 => fully simplify (flat), 0 => keep full detail (creases).
openvdb::FloatGrid::Ptr build_curvature_adaptivity(
    const openvdb::FloatGrid& ls, float strength, float voxel_size)
{
    // Mean curvature grid (1/world-units) over the narrow band.
    openvdb::tools::MeanCurvature<openvdb::FloatGrid> op(ls);
    openvdb::FloatGrid::Ptr curv = op.process();  // scalar mean curvature

    openvdb::FloatGrid::Ptr mask = openvdb::FloatGrid::create(/*background=*/1.0f);
    mask->setTransform(ls.transformPtr()->copy());
    auto maskAcc = mask->getAccessor();

    // Curvature has units 1/length; multiply by voxel_size to make it scale-free,
    // then map high curvature -> low adaptivity (0) and flat -> high (1).
    for (auto it = curv->cbeginValueOn(); it; ++it) {
        const float k = std::fabs(it.getValue()) * voxel_size;
        float adapt = 1.0f - strength * k;
        adapt = std::min(1.0f, std::max(0.0f, adapt));
        maskAcc.setValue(it.getCoord(), adapt);
    }
    return mask;
}

} // namespace

extern "C" int df_vdb_remesh(const float* verts, size_t nverts,
                             const uint32_t* tris, size_t ntris,
                             const DfVdbParams* params, DfVdbResult* out)
{
    if (!verts || !tris || !params || !out || nverts == 0 || ntris == 0) return 0;
    std::memset(out, 0, sizeof(*out));

    try {
        std::call_once(g_vdb_init, [] { openvdb::initialize(); });

        // --- pack input soup into OpenVDB point/triangle vectors ---
        std::vector<openvdb::Vec3s> points(nverts);
        for (size_t i = 0; i < nverts; ++i)
            points[i] = openvdb::Vec3s(verts[3*i+0], verts[3*i+1], verts[3*i+2]);

        std::vector<openvdb::Vec3I> triangles(ntris);
        for (size_t i = 0; i < ntris; ++i)
            triangles[i] = openvdb::Vec3I(tris[3*i+0], tris[3*i+1], tris[3*i+2]);

        const float vs = params->voxel_size > 0.f ? params->voxel_size : 1.0f;
        openvdb::math::Transform::Ptr xform =
            openvdb::math::Transform::createLinearTransform(vs);

        // meshToVolume tolerates non-manifold / self-intersecting input: it
        // computes an unsigned distance field then flood-fills the sign, which
        // is exactly the robustness we want here.
        openvdb::tools::QuadAndTriangleDataAdapter<openvdb::Vec3s, openvdb::Vec3I>
            adapter(points, triangles);

        const float exBand = params->exterior_band > 0.f ? params->exterior_band : 3.0f;
        const float inBand = params->interior_band > 0.f ? params->interior_band : 3.0f;

        openvdb::FloatGrid::Ptr grid =
            openvdb::tools::meshToVolume<openvdb::FloatGrid>(
                adapter, *xform, exBand, inBand, /*conversionFlags=*/0);
        if (!grid) return 0;

        // --- extract a mesh (adaptive, optionally curvature-aware) ---
        openvdb::tools::VolumeToMesh mesher(
            /*isovalue=*/0.0, /*adaptivity=*/params->adaptivity,
            /*relaxDisorientedTriangles=*/true);

        if ((params->flags & DF_VDB_CURVATURE_ADAPTIVE) &&
            params->curvature_adaptivity > 0.f) {
            mesher.setSpatialAdaptivity(
                build_curvature_adaptivity(*grid, params->curvature_adaptivity, vs));
        }
        mesher(*grid);

        // --- flatten pointList + polygonPools (quads -> 2 tris) into output ---
        const size_t np = mesher.pointListSize();
        std::vector<float> ov;  ov.reserve(np * 3);
        for (size_t i = 0; i < np; ++i) {
            const openvdb::Vec3s& p = mesher.pointList()[i];
            ov.push_back(p.x()); ov.push_back(p.y()); ov.push_back(p.z());
        }

        std::vector<uint32_t> ot;
        const auto& pools = mesher.polygonPoolList();
        for (size_t i = 0; i < mesher.polygonPoolListSize(); ++i) {
            const auto& pool = pools[i];
            for (size_t t = 0; t < pool.numTriangles(); ++t) {
                const openvdb::Vec3I& v = pool.triangle(t);
                ot.push_back(v[0]); ot.push_back(v[1]); ot.push_back(v[2]);
            }
            for (size_t q = 0; q < pool.numQuads(); ++q) {
                const openvdb::Vec4I& v = pool.quad(q);
                // OpenVDB winds quads (0,1,2,3); split into (0,1,2)+(0,2,3).
                ot.push_back(v[0]); ot.push_back(v[1]); ot.push_back(v[2]);
                ot.push_back(v[0]); ot.push_back(v[2]); ot.push_back(v[3]);
            }
        }

        if (ov.empty() || ot.empty()) return 0;

        out->nverts = np;
        out->ntris  = ot.size() / 3;
        out->verts  = static_cast<float*>(std::malloc(ov.size() * sizeof(float)));
        out->tris   = static_cast<uint32_t*>(std::malloc(ot.size() * sizeof(uint32_t)));
        if (!out->verts || !out->tris) { df_vdb_free(out); return 0; }
        std::memcpy(out->verts, ov.data(), ov.size() * sizeof(float));
        std::memcpy(out->tris,  ot.data(), ot.size() * sizeof(uint32_t));
        out->ok = 1;
        return 1;
    } catch (...) {
        df_vdb_free(out);
        return 0;
    }
}

extern "C" void df_vdb_free(DfVdbResult* r)
{
    if (!r) return;
    std::free(r->verts);
    std::free(r->tris);
    r->verts = nullptr; r->tris = nullptr;
    r->nverts = 0; r->ntris = 0; r->ok = 0;
}
