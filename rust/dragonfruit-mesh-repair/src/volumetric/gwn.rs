//! Generalized winding number (Jacobson et al. 2013) with Barnes–Hut
//! acceleration (Barill et al., "Fast Winding Numbers for Soups and Clouds").
//!
//! The winding number of a query point degrades smoothly on broken input:
//! a closed mesh gives ~1 inside / ~0 outside, and a leaky region still winds
//! to ~1 deep inside. Sign classification thresholds at 0.5. All angular
//! accumulation is in f64 — the atan2 solid-angle form is precision-sensitive
//! even when positions are f32.

use crate::core::mesh::{IndexedMesh, Vec3};

const INV_4PI: f64 = 1.0 / (4.0 * std::f64::consts::PI);

#[inline]
fn to_f64(v: Vec3) -> [f64; 3] {
    [v.x as f64, v.y as f64, v.z as f64]
}

#[inline]
fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

#[inline]
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

#[inline]
fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

#[inline]
fn norm(a: [f64; 3]) -> f64 {
    dot(a, a).sqrt()
}

/// Signed solid angle of triangle `(a, b, c)` seen from `p`, via the
/// Van Oosterom–Strackee formula. Result in steradians, sign follows the
/// triangle's winding.
#[inline]
pub fn tri_solid_angle(a: Vec3, b: Vec3, c: Vec3, p: Vec3) -> f64 {
    let pq = to_f64(p);
    let av = sub(to_f64(a), pq);
    let bv = sub(to_f64(b), pq);
    let cv = sub(to_f64(c), pq);
    let la = norm(av);
    let lb = norm(bv);
    let lc = norm(cv);
    let num = dot(av, cross(bv, cv));
    let den = la * lb * lc + dot(av, bv) * lc + dot(bv, cv) * la + dot(cv, av) * lb;
    if num == 0.0 && den == 0.0 {
        // Query point on the triangle plane at a vertex/edge singularity;
        // contribution is ill-defined but bounded — treat as zero rather
        // than propagating NaN into the accumulated winding.
        return 0.0;
    }
    2.0 * num.atan2(den)
}

/// Exact (O(triangles)) generalized winding number of `p` with respect to
/// `mesh`. Reference implementation — validate the tree against this.
pub fn winding_number_naive(mesh: &IndexedMesh, p: Vec3) -> f64 {
    let mut sum = 0.0f64;
    for tri in &mesh.triangles {
        sum += tri_solid_angle(
            mesh.positions[tri[0] as usize],
            mesh.positions[tri[1] as usize],
            mesh.positions[tri[2] as usize],
            p,
        );
    }
    sum * INV_4PI
}

struct WNode {
    /// Area-weighted centroid of the node's triangles.
    centroid: [f64; 3],
    /// Dipole moment Σ Aᵢ·nᵢ (unnormalized area-weighted normals).
    dipole: [f64; 3],
    /// Second-order moment M[k][j] = Σ Aᵢ·(xᵢ−p̄)ₖ·nᵢⱼ about `centroid`.
    quad: [[f64; 3]; 3],
    /// Third moment T[k][l][j] = Σ Aᵢ·dₖ·dₗ·nᵢⱼ (d = xᵢ−p̄), symmetric in
    /// (k,l). Needed because M ≈ 0 on locally flat patches (Σ A·d = 0 by
    /// centroid construction), so the *curvature* correction lives entirely
    /// in this Hessian term — same reason Barill et al. default to a
    /// second-order Taylor expansion. Dipole alone at β=2 shows ~1e-2 error
    /// near the surface; with this term the far-field residual is O((r/d)⁴).
    third: [[[f64; 3]; 3]; 3],
    /// Max distance from `centroid` to any vertex of the node's triangles.
    radius: f64,
    /// Total unsigned area — the mixing weight for parent centroids
    /// (|dipole| would cancel on opposing orientations).
    area: f64,
    /// Leaf: triangle range [start, start+count) into `tris`. count == 0
    /// marks an internal node.
    start: u32,
    count: u32,
    left: u32,
    right: u32,
}

/// Barnes–Hut tree over a triangle soup for fast winding-number queries.
/// Far nodes (dist > β·radius) are approximated by their dipole; near nodes
/// recurse down to exact per-triangle solid angles.
pub struct WindingTree {
    nodes: Vec<WNode>,
    /// Triangle vertex triples, reordered so each leaf owns a contiguous run.
    tris: Vec<[Vec3; 3]>,
    root: u32,
    beta: f64,
}

const LEAF_SIZE: usize = 8;

impl WindingTree {
    pub fn build(mesh: &IndexedMesh) -> Self {
        Self::build_with_beta(mesh, 2.0)
    }

    pub fn build_with_beta(mesh: &IndexedMesh, beta: f64) -> Self {
        let mut items: Vec<([Vec3; 3], Vec3)> = mesh
            .triangles
            .iter()
            .map(|t| {
                let a = mesh.positions[t[0] as usize];
                let b = mesh.positions[t[1] as usize];
                let c = mesh.positions[t[2] as usize];
                ([a, b, c], a.add(b).add(c).scale(1.0 / 3.0))
            })
            .collect();
        let mut nodes = Vec::with_capacity(items.len() / LEAF_SIZE * 2 + 2);
        let mut tris = Vec::with_capacity(items.len());
        let root = Self::build_rec(&mut nodes, &mut tris, &mut items);
        Self {
            nodes,
            tris,
            root,
            beta,
        }
    }

    fn build_rec(
        nodes: &mut Vec<WNode>,
        tris: &mut Vec<[Vec3; 3]>,
        items: &mut [([Vec3; 3], Vec3)],
    ) -> u32 {
        if items.len() <= LEAF_SIZE {
            let start = tris.len() as u32;
            for (t, _) in items.iter() {
                tris.push(*t);
            }
            let (centroid, dipole, quad, third, radius, area) =
                leaf_moments(&tris[start as usize..]);
            let idx = nodes.len() as u32;
            nodes.push(WNode {
                centroid,
                dipole,
                quad,
                third,
                radius,
                area,
                start,
                count: items.len() as u32,
                left: 0,
                right: 0,
            });
            return idx;
        }
        // Median split on the axis with the widest centroid spread — same
        // strategy as core::bvh.
        let mut cmin = Vec3::new(f32::INFINITY, f32::INFINITY, f32::INFINITY);
        let mut cmax = Vec3::new(f32::NEG_INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY);
        for (_, c) in items.iter() {
            cmin = cmin.min(*c);
            cmax = cmax.max(*c);
        }
        let ext = cmax.sub(cmin);
        let axis = if ext.x >= ext.y && ext.x >= ext.z {
            0
        } else if ext.y >= ext.z {
            1
        } else {
            2
        };
        let mid = items.len() / 2;
        items.select_nth_unstable_by(mid, |a, b| {
            let (av, bv) = match axis {
                0 => (a.1.x, b.1.x),
                1 => (a.1.y, b.1.y),
                _ => (a.1.z, b.1.z),
            };
            av.partial_cmp(&bv).unwrap_or(std::cmp::Ordering::Equal)
        });
        let (l_items, r_items) = items.split_at_mut(mid);
        let left = Self::build_rec(nodes, tris, l_items);
        let right = Self::build_rec(nodes, tris, r_items);

        // Combine child moments bottom-up: area-weighted centroid mix, dipole
        // sum, second-order moment re-centered from each child's centroid;
        // radius covers both children's spheres.
        let (lc, ld, lq, lt, lr, la) = {
            let n = &nodes[left as usize];
            (n.centroid, n.dipole, n.quad, n.third, n.radius, n.area)
        };
        let (rc, rd, rq, rt, rr, ra) = {
            let n = &nodes[right as usize];
            (n.centroid, n.dipole, n.quad, n.third, n.radius, n.area)
        };
        let total_a = la + ra;
        let centroid = if total_a > 0.0 {
            [
                (lc[0] * la + rc[0] * ra) / total_a,
                (lc[1] * la + rc[1] * ra) / total_a,
                (lc[2] * la + rc[2] * ra) / total_a,
            ]
        } else {
            [
                (lc[0] + rc[0]) * 0.5,
                (lc[1] + rc[1]) * 0.5,
                (lc[2] + rc[2]) * 0.5,
            ]
        };
        let dipole = [ld[0] + rd[0], ld[1] + rd[1], ld[2] + rd[2]];
        // Re-center each child's moments from its centroid to the parent's:
        //   M' = M + off·Nᵀ
        //   T'[k][l][j] = T[k][l][j] + off_k·M[l][j] + off_l·M[k][j]
        //                 + off_k·off_l·N[j]         (off = c_child − c_parent)
        let mut quad = [[0.0f64; 3]; 3];
        let mut third = [[[0.0f64; 3]; 3]; 3];
        for (cc, cd, cq, ct) in [(lc, ld, lq, lt), (rc, rd, rq, rt)] {
            let off = sub(cc, centroid);
            for k in 0..3 {
                for j in 0..3 {
                    quad[k][j] += cq[k][j] + off[k] * cd[j];
                }
            }
            for k in 0..3 {
                for l in 0..3 {
                    for j in 0..3 {
                        third[k][l][j] += ct[k][l][j]
                            + off[k] * cq[l][j]
                            + off[l] * cq[k][j]
                            + off[k] * off[l] * cd[j];
                    }
                }
            }
        }
        let radius = f64::max(
            norm(sub(lc, centroid)) + lr,
            norm(sub(rc, centroid)) + rr,
        );
        let idx = nodes.len() as u32;
        nodes.push(WNode {
            centroid,
            dipole,
            quad,
            third,
            radius,
            area: total_a,
            start: 0,
            count: 0,
            left,
            right,
        });
        idx
    }

    /// Generalized winding number of `p`. Thread-safe (&self), so callers
    /// parallelize over query points with rayon.
    pub fn winding(&self, p: Vec3) -> f64 {
        self.eval(self.root, p) * INV_4PI
    }

    fn eval(&self, node: u32, p: Vec3) -> f64 {
        let n = &self.nodes[node as usize];
        let r = sub(n.centroid, to_f64(p));
        let d = norm(r);
        if d > self.beta * n.radius && d > 1e-12 {
            // Far field: second-order Taylor of K(x) = (x−q)/|x−q|³ about
            // the centroid, contracted with the node's moments:
            //   Σ Aᵢnᵢ·K(xᵢ) ≈ N·K(p̄)                        (dipole)
            //     + tr(M)/d³ − 3·(rᵀMr)/d⁵                    (gradient · M)
            //     + ½[−3(2·C1 + C3)/d⁵ + 15·C4/d⁷]            (hessian · T)
            // with C1 = Σₖₗ rₗ·T[k][l][k], C3 = Σₖⱼ rⱼ·T[k][k][j],
            //      C4 = Σⱼₖₗ rⱼrₖrₗ·T[k][l][j].
            let d2 = d * d;
            let d3 = d2 * d;
            let d5 = d3 * d2;
            let d7 = d5 * d2;
            let first = dot(r, n.dipole) / d3;

            let tr = n.quad[0][0] + n.quad[1][1] + n.quad[2][2];
            let mut rmr = 0.0;
            for k in 0..3 {
                for j in 0..3 {
                    rmr += r[k] * n.quad[k][j] * r[j];
                }
            }
            let second = tr / d3 - 3.0 * rmr / d5;

            let mut c1 = 0.0;
            let mut c3 = 0.0;
            let mut c4 = 0.0;
            for k in 0..3 {
                for l in 0..3 {
                    c1 += r[l] * n.third[k][l][k];
                    c3 += r[l] * n.third[k][k][l];
                    for j in 0..3 {
                        c4 += r[j] * r[k] * r[l] * n.third[k][l][j];
                    }
                }
            }
            let hessian = 0.5 * (-3.0 * (2.0 * c1 + c3) / d5 + 15.0 * c4 / d7);
            return first + second + hessian;
        }
        if n.count > 0 {
            let mut sum = 0.0;
            for t in &self.tris[n.start as usize..(n.start + n.count) as usize] {
                sum += tri_solid_angle(t[0], t[1], t[2], p);
            }
            sum
        } else {
            self.eval(n.left, p) + self.eval(n.right, p)
        }
    }
}

/// (area-weighted centroid, dipole, second moment, third moment, radius,
/// unsigned area) of a triangle run. Triangles are treated as point elements
/// at their centroids for the higher moments; the residual is higher-order
/// than the expansion itself for leaf-sized runs.
#[allow(clippy::type_complexity)]
fn leaf_moments(
    tris: &[[Vec3; 3]],
) -> ([f64; 3], [f64; 3], [[f64; 3]; 3], [[[f64; 3]; 3]; 3], f64, f64) {
    let mut area_sum = 0.0f64;
    let mut centroid = [0.0f64; 3];
    let mut dipole = [0.0f64; 3];
    for t in tris {
        let a = to_f64(t[0]);
        let b = to_f64(t[1]);
        let c = to_f64(t[2]);
        // Area-weighted normal = ½ (b−a)×(c−a); its magnitude is the area.
        let an = cross(sub(b, a), sub(c, a));
        let an = [an[0] * 0.5, an[1] * 0.5, an[2] * 0.5];
        let area = norm(an);
        let tc = [
            (a[0] + b[0] + c[0]) / 3.0,
            (a[1] + b[1] + c[1]) / 3.0,
            (a[2] + b[2] + c[2]) / 3.0,
        ];
        area_sum += area;
        centroid[0] += tc[0] * area;
        centroid[1] += tc[1] * area;
        centroid[2] += tc[2] * area;
        dipole[0] += an[0];
        dipole[1] += an[1];
        dipole[2] += an[2];
    }
    if area_sum > 0.0 {
        centroid[0] /= area_sum;
        centroid[1] /= area_sum;
        centroid[2] /= area_sum;
    } else if !tris.is_empty() {
        let a = to_f64(tris[0][0]);
        centroid = a;
    }
    // Second pass: higher moments about the (now known) centroid, and the
    // bounding radius.
    let mut quad = [[0.0f64; 3]; 3];
    let mut third = [[[0.0f64; 3]; 3]; 3];
    let mut radius = 0.0f64;
    for t in tris {
        let a = to_f64(t[0]);
        let b = to_f64(t[1]);
        let c = to_f64(t[2]);
        let an = cross(sub(b, a), sub(c, a));
        let an = [an[0] * 0.5, an[1] * 0.5, an[2] * 0.5];
        let tc = [
            (a[0] + b[0] + c[0]) / 3.0,
            (a[1] + b[1] + c[1]) / 3.0,
            (a[2] + b[2] + c[2]) / 3.0,
        ];
        let d = sub(tc, centroid);
        for k in 0..3 {
            for j in 0..3 {
                quad[k][j] += d[k] * an[j];
            }
        }
        for k in 0..3 {
            for l in 0..3 {
                for j in 0..3 {
                    third[k][l][j] += d[k] * d[l] * an[j];
                }
            }
        }
        for v in t {
            radius = radius.max(norm(sub(to_f64(*v), centroid)));
        }
    }
    (centroid, dipole, quad, third, radius, area_sum)
}
