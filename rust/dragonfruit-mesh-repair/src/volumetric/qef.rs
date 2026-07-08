//! Quadric error function solver for dual contouring.
//!
//! Minimizes `E(x) = Σ (nᵢ·(x − pᵢ))²` over a cell's hermite samples via the
//! normal equations `AᵀA·x = Aᵀb`, solved with a truncated eigendecomposition
//! of the symmetric 3×3 `AᵀA` (hand-rolled Jacobi — no linear-algebra
//! dependency). Small eigenvalues are truncated and the null space is biased
//! toward the mass point, so under-constrained cells (flat or noisy hermite
//! data) degrade gracefully to surface-nets behavior instead of shooting the
//! vertex off to infinity. Accumulation is f64; positions are f32.

use crate::core::mesh::Vec3;

/// Eigendecomposition of a symmetric 3×3 matrix by cyclic Jacobi rotations.
/// Returns (eigenvalues, eigenvectors as columns). Eigenvalues are not
/// sorted; magnitudes are what the QEF truncation cares about.
pub fn jacobi_eigen_sym3(m: [[f64; 3]; 3]) -> ([f64; 3], [[f64; 3]; 3]) {
    let mut a = m;
    // v starts as identity; accumulates the rotations.
    let mut v = [[0.0f64; 3]; 3];
    v[0][0] = 1.0;
    v[1][1] = 1.0;
    v[2][2] = 1.0;

    for _sweep in 0..32 {
        let off = a[0][1] * a[0][1] + a[0][2] * a[0][2] + a[1][2] * a[1][2];
        if off < 1e-30 {
            break;
        }
        for &(p, q) in &[(0usize, 1usize), (0, 2), (1, 2)] {
            if a[p][q].abs() < 1e-300 {
                continue;
            }
            // Classic Jacobi rotation eliminating a[p][q].
            let theta = (a[q][q] - a[p][p]) / (2.0 * a[p][q]);
            let t = theta.signum() / (theta.abs() + (theta * theta + 1.0).sqrt());
            let c = 1.0 / (t * t + 1.0).sqrt();
            let s = t * c;

            let app = a[p][p];
            let aqq = a[q][q];
            let apq = a[p][q];
            a[p][p] = c * c * app - 2.0 * s * c * apq + s * s * aqq;
            a[q][q] = s * s * app + 2.0 * s * c * apq + c * c * aqq;
            a[p][q] = 0.0;
            a[q][p] = 0.0;
            let r = 3 - p - q; // the remaining index
            let arp = a[r][p];
            let arq = a[r][q];
            a[r][p] = c * arp - s * arq;
            a[p][r] = a[r][p];
            a[r][q] = s * arp + c * arq;
            a[q][r] = a[r][q];

            for row in v.iter_mut() {
                let vp = row[p];
                let vq = row[q];
                row[p] = c * vp - s * vq;
                row[q] = s * vp + c * vq;
            }
        }
    }
    ([a[0][0], a[1][1], a[2][2]], v)
}

/// Accumulating QEF for one cell (or one sheet within a cell).
#[derive(Clone, Default)]
pub struct QefSolver {
    ata: [[f64; 3]; 3],
    atb: [f64; 3],
    mass: [f64; 3],
    n: usize,
}

impl QefSolver {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a hermite sample: plane through `p` with (unit) normal `n`.
    pub fn add(&mut self, p: Vec3, normal: Vec3) {
        let nx = normal.x as f64;
        let ny = normal.y as f64;
        let nz = normal.z as f64;
        let b = nx * p.x as f64 + ny * p.y as f64 + nz * p.z as f64;
        let nv = [nx, ny, nz];
        for k in 0..3 {
            for j in 0..3 {
                self.ata[k][j] += nv[k] * nv[j];
            }
            self.atb[k] += nv[k] * b;
        }
        self.mass[0] += p.x as f64;
        self.mass[1] += p.y as f64;
        self.mass[2] += p.z as f64;
        self.n += 1;
    }

    pub fn sample_count(&self) -> usize {
        self.n
    }

    /// Mean of the added sample points.
    pub fn mass_point(&self) -> Vec3 {
        if self.n == 0 {
            return Vec3::ZERO;
        }
        let inv = 1.0 / self.n as f64;
        Vec3::new(
            (self.mass[0] * inv) as f32,
            (self.mass[1] * inv) as f32,
            (self.mass[2] * inv) as f32,
        )
    }

    /// Solve for the minimizing position, truncating eigenvalues below
    /// `0.1 · λmax` (null space collapses to the mass point) and clamping the
    /// result into `[cell_min, cell_max]` — DC vertices must not escape their
    /// cell or downstream sheet/stitching assumptions break.
    pub fn solve(&self, cell_min: Vec3, cell_max: Vec3) -> Vec3 {
        let m = self.mass_point();
        if self.n == 0 {
            return m;
        }
        let (vals, vecs) = jacobi_eigen_sym3(self.ata);
        let max_abs = vals.iter().fold(0.0f64, |acc, v| acc.max(v.abs()));
        if max_abs <= 0.0 {
            return clamp_vec(m, cell_min, cell_max);
        }
        // Residual r = Aᵀb − AᵀA·m ; offset = V·Λ⁺·Vᵀ·r keeps the solution
        // relative to the mass point.
        let mp = [m.x as f64, m.y as f64, m.z as f64];
        let mut r = [0.0f64; 3];
        for k in 0..3 {
            r[k] = self.atb[k]
                - (self.ata[k][0] * mp[0] + self.ata[k][1] * mp[1] + self.ata[k][2] * mp[2]);
        }
        // Vᵀ·r
        let mut vr = [0.0f64; 3];
        for k in 0..3 {
            vr[k] = vecs[0][k] * r[0] + vecs[1][k] * r[1] + vecs[2][k] * r[2];
        }
        // Λ⁺ with relative truncation.
        for k in 0..3 {
            if vals[k].abs() > 0.1 * max_abs {
                vr[k] /= vals[k];
            } else {
                vr[k] = 0.0;
            }
        }
        // V·(Λ⁺Vᵀr)
        let mut off = [0.0f64; 3];
        for k in 0..3 {
            off[k] = vecs[k][0] * vr[0] + vecs[k][1] * vr[1] + vecs[k][2] * vr[2];
        }
        let x = Vec3::new(
            (mp[0] + off[0]) as f32,
            (mp[1] + off[1]) as f32,
            (mp[2] + off[2]) as f32,
        );
        clamp_vec(x, cell_min, cell_max)
    }
}

#[inline]
fn clamp_vec(p: Vec3, lo: Vec3, hi: Vec3) -> Vec3 {
    Vec3::new(
        p.x.clamp(lo.x, hi.x),
        p.y.clamp(lo.y, hi.y),
        p.z.clamp(lo.z, hi.z),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jacobi_recovers_known_eigenvalues() {
        // Diagonal matrix: eigenvalues are the diagonal.
        let (vals, _) = jacobi_eigen_sym3([[3.0, 0.0, 0.0], [0.0, 2.0, 0.0], [0.0, 0.0, 1.0]]);
        let mut sorted = vals;
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        assert!((sorted[0] - 1.0).abs() < 1e-12);
        assert!((sorted[1] - 2.0).abs() < 1e-12);
        assert!((sorted[2] - 3.0).abs() < 1e-12);
    }

    #[test]
    fn jacobi_eigenvectors_diagonalize() {
        let m = [[4.0, 1.0, 0.5], [1.0, 3.0, 0.25], [0.5, 0.25, 2.0]];
        let (vals, v) = jacobi_eigen_sym3(m);
        // Check M·vₖ = λₖ·vₖ for each column k.
        for k in 0..3 {
            for row in 0..3 {
                let mv: f64 = (0..3).map(|j| m[row][j] * v[j][k]).sum();
                assert!(
                    (mv - vals[k] * v[row][k]).abs() < 1e-9,
                    "column {k} row {row}: {mv} vs {}",
                    vals[k] * v[row][k]
                );
            }
        }
    }

    #[test]
    fn qef_corner_from_three_planes() {
        // Three orthogonal planes meeting at (1, 2, 3).
        let mut q = QefSolver::new();
        q.add(Vec3::new(1.0, 0.0, 0.0), Vec3::new(1.0, 0.0, 0.0));
        q.add(Vec3::new(0.0, 2.0, 0.0), Vec3::new(0.0, 1.0, 0.0));
        q.add(Vec3::new(0.0, 0.0, 3.0), Vec3::new(0.0, 0.0, 1.0));
        let x = q.solve(Vec3::new(-10.0, -10.0, -10.0), Vec3::new(10.0, 10.0, 10.0));
        assert!((x.x - 1.0).abs() < 1e-4 && (x.y - 2.0).abs() < 1e-4 && (x.z - 3.0).abs() < 1e-4);
    }

    #[test]
    fn qef_underconstrained_plane_stays_at_mass_point() {
        // All normals parallel: solution constrained along the normal only;
        // tangential null space must collapse to the mass point.
        let n = Vec3::new(0.0, 0.0, 1.0);
        let mut q = QefSolver::new();
        q.add(Vec3::new(0.0, 0.0, 1.0), n);
        q.add(Vec3::new(1.0, 0.0, 1.0), n);
        q.add(Vec3::new(0.0, 1.0, 1.0), n);
        let x = q.solve(Vec3::new(-10.0, -10.0, -10.0), Vec3::new(10.0, 10.0, 10.0));
        let m = q.mass_point();
        assert!((x.z - 1.0).abs() < 1e-5, "z pinned by the plane");
        assert!((x.x - m.x).abs() < 1e-5 && (x.y - m.y).abs() < 1e-5, "xy at mass point");
    }

    #[test]
    fn qef_result_clamped_into_cell() {
        let mut q = QefSolver::new();
        // Nearly parallel planes intersecting far outside the cell.
        q.add(Vec3::new(0.0, 0.0, 0.0), Vec3::new(1.0, 0.0, 0.0));
        q.add(Vec3::new(0.1, 0.0, 0.0), Vec3::new(0.9999, 0.0141, 0.0));
        let x = q.solve(Vec3::ZERO, Vec3::new(1.0, 1.0, 1.0));
        assert!(x.x >= 0.0 && x.x <= 1.0 && x.y >= 0.0 && x.y <= 1.0 && x.z >= 0.0 && x.z <= 1.0);
    }
}
