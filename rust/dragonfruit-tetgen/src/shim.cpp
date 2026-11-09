// A C entry point onto TetGen, which is C++ and exposes a class-based interface Rust cannot call
// directly. Everything here is a thin translation: no policy, no defaults of its own, so the
// behaviour stays TetGen's and the wrapper above is the only place that decides anything.
//
// Pointers are opaque `void*` because `tetgenio` has no C-compatible name; the Rust side treats them
// as handles and only ever passes them back to these functions.

#include "tetgen.h"

#include <cstring>
#include <string>

extern "C" {

/// A fresh, empty `tetgenio`. Freed with `tg_io_delete`.
void *tg_io_new() {
  tetgenio *io = new tetgenio();
  io->initialize();
  return io;
}

void tg_io_delete(void *io) {
  if (!io) return;
  delete static_cast<tetgenio *>(io);
}

/// Replace the input's points. Coordinates are copied into TetGen's own storage, which it frees in
/// its destructor, so the caller's array need not outlive the call.
void tg_io_set_points(void *io, const double *xyz, int count) {
  tetgenio *in = static_cast<tetgenio *>(io);
  in->numberofpoints = count;
  in->pointlist = new REAL[count * 3];
  std::memcpy(in->pointlist, xyz, sizeof(double) * static_cast<size_t>(count) * 3);
}

/// Replace the input's facets with one polygon per triangle, which is what makes it a piecewise
/// linear complex rather than a bag of points.
///
/// A PLC is what a constrained tetrahedralisation reads, and it is the difference that matters:
/// given only the points, the decomposition has nothing to conform to, so a tetrahedron can reach
/// straight across a concavity and the surface ends up with slivers spanning it. Given the
/// triangles, the decomposition is constrained to contain them.
///
/// Zero-based, like `tetgenio`'s output and unlike its file formats, which are one-based. Checked
/// rather than assumed: adding one here made every polygon reference the next vertex along and had
/// TetGen report the last vertex of an eight-corner cube as invalid.
void tg_io_set_facets(void *io, const int *tris, int count) {
  tetgenio *in = static_cast<tetgenio *>(io);
  in->numberoffacets = count;
  in->facetlist = new tetgenio::facet[count];
  for (int f = 0; f < count; ++f) {
    tetgenio::facet &facet = in->facetlist[f];
    facet.numberofpolygons = 1;
    facet.polygonlist = new tetgenio::polygon[1];
    facet.numberofholes = 0;
    facet.holelist = nullptr;
    tetgenio::polygon &poly = facet.polygonlist[0];
    poly.numberofvertices = 3;
    poly.vertexlist = new int[3];
    for (int k = 0; k < 3; ++k) {
      poly.vertexlist[k] = tris[f * 3 + k];
    }
  }
  in->numberofholes = 0;
  in->holelist = nullptr;
}

/// Run TetGen. Returns 0 on success and non-zero if it threw.
///
/// TetGen signals many of its own failures by calling `terminate()` rather than throwing, which
/// cannot be caught; `switches` is therefore chosen by the caller to avoid the modes that reject
/// input, and the return value covers the cases it does raise.
int tg_tetrahedralize(const char *switches, void *in, void *out) {
  try {
    tetrahedralize(switches, static_cast<tetgenio *>(in), static_cast<tetgenio *>(out));
    return 0;
  } catch (...) {
    return 1;
  }
}

int tg_io_num_points(void *io) {
  return io ? static_cast<tetgenio *>(io)->numberofpoints : 0;
}

/// The output's points, in its own order. TetGen may add points, so this is not the input list.
void tg_io_get_points(void *io, double *dst) {
  if (!io) return;
  tetgenio *out = static_cast<tetgenio *>(io);
  std::memcpy(dst, out->pointlist,
              sizeof(double) * static_cast<size_t>(out->numberofpoints) * 3);
}

int tg_io_num_tetrahedra(void *io) {
  return io ? static_cast<tetgenio *>(io)->numberoftetrahedra : 0;
}

/// Tetrahedra as flat vertex indices, four per entry.
///
/// TetGen's *library* output is already zero-based into its own `pointlist`; only its file formats
/// are one-based, so no adjustment happens here. Verified on a four-point input, where a one-based
/// reading would need an index that does not exist. TetGen may carry a higher `numberofcorners`;
/// only the first four are copied, which are the corners of a linear tetrahedron.
void tg_io_get_tetrahedra(void *io, int *dst) {
  if (!io) return;
  tetgenio *out = static_cast<tetgenio *>(io);
  const int corners = out->numberofcorners > 0 ? out->numberofcorners : 4;
  for (int t = 0; t < out->numberoftetrahedra; ++t) {
    for (int k = 0; k < 4; ++k) {
      dst[t * 4 + k] = out->tetrahedronlist[t * corners + k];
    }
  }
}

int tg_io_num_trifaces(void *io) {
  return io ? static_cast<tetgenio *>(io)->numberoftrifaces : 0;
}

void tg_io_get_trifaces(void *io, int *dst) {
  if (!io) return;
  tetgenio *out = static_cast<tetgenio *>(io);
  for (int f = 0; f < out->numberoftrifaces; ++f) {
    for (int k = 0; k < 3; ++k) {
      dst[f * 3 + k] = out->trifacelist[f * 3 + k];
    }
  }
}

}  // extern "C"
