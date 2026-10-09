// Per-vertex ambient occlusion on the GPU, one invocation per vertex.
//
// This mirrors `dragonfruit-mesh-core`'s CPU bake line for line: the same BVH
// layout (`Bvh::gpu_layout`), the same slab/leaf traversal with the plateau
// early-out, the same cosine fan, the same distance falloff. It is checked
// against the CPU values, so anything that drifts here shows up as a mismatch.

struct Params {
    vertex_count: u32,
    root: u32,
    leaf_flag: u32,
    rays: u32,
    reach: f32,
    plateau: f32,
    bias: f32,
    rotate: f32,   // 1 = turn the fan per vertex, as the new CPU recipe does
}

@group(0) @binding(0) var<storage, read> nodes: array<u32>;      // 8 words per node
@group(0) @binding(1) var<storage, read> faces: array<u32>;      // triangle indices, per leaf
@group(0) @binding(2) var<storage, read> positions: array<f32>;  // 3 per vertex
@group(0) @binding(3) var<storage, read> indices: array<u32>;    // 3 per triangle
@group(0) @binding(4) var<storage, read> normals: array<f32>;    // 3 per vertex
@group(0) @binding(5) var<uniform> params: Params;
@group(0) @binding(6) var<storage, read_write> out_ao: array<f32>;

fn node_min(i: u32) -> vec3<f32> {
    let base = i * 8u;
    return vec3<f32>(bitcast<f32>(nodes[base]), bitcast<f32>(nodes[base + 1u]), bitcast<f32>(nodes[base + 2u]));
}

fn node_max(i: u32) -> vec3<f32> {
    let base = i * 8u;
    return vec3<f32>(bitcast<f32>(nodes[base + 3u]), bitcast<f32>(nodes[base + 4u]), bitcast<f32>(nodes[base + 5u]));
}

/// Stands in for "no entry": naga rejects a literal infinity, and the comparison
/// against it is the same test the CPU makes with `is_finite`.
const FAR: f32 = 1e38;

/// Slab test: entry distance, or [`FAR`] when the ray misses or enters past `max`.
fn slab_entry(origin: vec3<f32>, inv_dir: vec3<f32>, node: u32, max_distance: f32) -> f32 {
    let lo3 = min((node_min(node) - origin) * inv_dir, (node_max(node) - origin) * inv_dir);
    let hi3 = max((node_min(node) - origin) * inv_dir, (node_max(node) - origin) * inv_dir);
    let lo = max(max(lo3.x, lo3.y), lo3.z);
    let hi = min(min(hi3.x, hi3.y), hi3.z);
    if hi < max(lo, 0.0) || lo > max_distance {
        return FAR;
    }
    return max(lo, 0.0);
}

/// Moeller-Trumbore, matching `bvh::ray_tri` including its epsilon and its
/// rejection of anything behind the origin.
fn ray_tri(origin: vec3<f32>, dir: vec3<f32>, a: vec3<f32>, b: vec3<f32>, c: vec3<f32>) -> f32 {
    let e1 = b - a;
    let e2 = c - a;
    let p = cross(dir, e2);
    let det = dot(e1, p);
    if abs(det) < 1e-8 {
        return -1.0;
    }
    let inv_det = 1.0 / det;
    let s = origin - a;
    let u = dot(s, p) * inv_det;
    if !(u >= 0.0 && u <= 1.0) {
        return -1.0;
    }
    let q = cross(s, e1);
    let v = dot(dir, q) * inv_det;
    if v < 0.0 || u + v > 1.0 {
        return -1.0;
    }
    let t = dot(e2, q) * inv_det;
    if t >= 0.0 {
        return t;
    }
    return -1.0;
}

/// The per-vertex fan turn: a hash of the quantised position, so it follows the
/// mesh rather than the vertex order. The CPU's version mixes 64-bit cells; this
/// needs only to be deterministic and decorrelated, not identical.
fn rotation_for(position: vec3<f32>, reach: f32) -> f32 {
    let q = max(reach * 1e-3, 1e-30);
    var h: u32 = 0x9e3779b9u;
    for (var axis = 0u; axis < 3u; axis = axis + 1u) {
        let v = select(select(position.x, position.y, axis == 1u), position.z, axis == 2u);
        h = h ^ bitcast<u32>(i32(round(v / q)));
        h = h * 0x85ebca6bu;
        h = h ^ (h >> 13u);
    }
    return f32(h) / 4294967295.0;
}

/// The traversal `Bvh::gpu_layout` documents: nearest hit within `reach`, and any
/// hit at or under the plateau accepted on sight because it weighs full strength.
fn nearest_within(origin: vec3<f32>, dir: vec3<f32>) -> f32 {
    let inv_dir = 1.0 / dir;
    var best = params.reach;
    var found = 0u;
    // 32 entries, not 64: the stack lives in registers, and a 64-word stack is 64
    // registers per thread, which costs occupancy exactly where latency hiding is
    // what the traversal needs. The tree over 768k/8 leaves is ~17 deep.
    var stack: array<u32, 32>;
    var depth = 1u;
    stack[0] = params.root;
    loop {
        if depth == 0u {
            break;
        }
        depth = depth - 1u;
        let node = stack[depth];
        if !(slab_entry(origin, inv_dir, node, best) < FAR) {
            continue;
        }
        let b = nodes[node * 8u + 7u];
        if (b & params.leaf_flag) != 0u {
            let count = b & ~params.leaf_flag;
            let first = nodes[node * 8u + 6u];
            for (var k = 0u; k < count; k = k + 1u) {
                let face = faces[first + k];
                let i0 = indices[face * 3u];
                let i1 = indices[face * 3u + 1u];
                let i2 = indices[face * 3u + 2u];
                let a = vec3<f32>(positions[i0 * 3u], positions[i0 * 3u + 1u], positions[i0 * 3u + 2u]);
                let bb = vec3<f32>(positions[i1 * 3u], positions[i1 * 3u + 1u], positions[i1 * 3u + 2u]);
                let cc = vec3<f32>(positions[i2 * 3u], positions[i2 * 3u + 1u], positions[i2 * 3u + 2u]);
                let t = ray_tri(origin, dir, a, bb, cc);
                if t >= 0.0 {
                    if t <= params.plateau {
                        return t;
                    }
                    if t < best {
                        best = t;
                        found = 1u;
                    }
                }
            }
            continue;
        }
        // Near child first, like the CPU: the far one is likelier to be pruned
        // once the near one has tightened `best`, and the stack is popped last-in
        // first-out, so the far child is pushed first.
        let a_child = nodes[node * 8u + 6u];
        let near = slab_entry(origin, inv_dir, a_child, best);
        let far = slab_entry(origin, inv_dir, b, best);
        if near < far {
            stack[depth] = b;
            stack[depth + 1u] = a_child;
        } else {
            stack[depth] = a_child;
            stack[depth + 1u] = b;
        }
        depth = depth + 2u;
    }
    if found == 1u {
        return best;
    }
    return -1.0;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let index = gid.x + gid.y * 65535u;
    if index >= params.vertex_count {
        return;
    }
    let position = vec3<f32>(positions[index * 3u], positions[index * 3u + 1u], positions[index * 3u + 2u]);
    let n = vec3<f32>(normals[index * 3u], normals[index * 3u + 1u], normals[index * 3u + 2u]);
    let len = length(n);
    if len < 1e-12 {
        out_ao[index] = 1.0;
        return;
    }
    let normal = n / len;

    // The same stable tangent basis the CPU uses.
    var t = vec3<f32>(0.0, 0.0, 1.0);
    if abs(normal.z) > 0.9 {
        t = vec3<f32>(1.0, 0.0, 0.0);
    }
    let bitangent = normalize(cross(normal, t));
    let tangent = cross(bitangent, normal);
    let origin = position + normal * params.bias;

    var hits = 0.0;
    for (var i = 0u; i < params.rays; i = i + 1u) {
        // hemisphere_samples(): golden-ratio azimuth, cosine-weighted radius.
        let u1 = (f32(i) + 0.5) / f32(params.rays);
        let u2 = fract(f32(i) * 0.618034 + params.rotate * rotation_for(position, params.reach));
        let radius = sqrt(u1);
        let phi = 6.283185307179586 * u2;
        let sample = vec3<f32>(radius * cos(phi), radius * sin(phi), sqrt(max(1.0 - u1, 0.0)));
        let d = normalize(tangent * sample.x + bitangent * sample.y + normal * sample.z);
        let hit = nearest_within(origin, d);
        if hit >= 0.0 {
            let span = (hit - params.plateau) / max(params.reach - params.plateau, 1e-6);
            hits = hits + clamp(1.0 - span, 0.0, 1.0);
        }
    }
    out_ao[index] = 1.0 - hits / f32(params.rays);
}
