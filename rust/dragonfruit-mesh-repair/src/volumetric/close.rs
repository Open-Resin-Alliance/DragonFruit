//! Morphological close (dilate δ then erode δ) on the band's *sign field*.
//!
//! Bridges gaps narrower than ~2δ voxels and regularizes GWN flicker across
//! open holes where the winding hovers near 0.5. Operates on the boolean
//! `inside` flags only — the unsigned distances stay untouched and remain
//! valid for vertex placement (crossings created purely by closing sit
//! mid-edge and fall back to mass-point placement naturally).
//!
//! Callers must build the band with `halfwidth_voxels >= 3 + radius` so the
//! dilated region stays inside stored corners; the close never grows the
//! corner set. Skip the close on thin-walled shells — it eats gaps thinner
//! than 2δ by design.

use crate::volumetric::band::SparseBand;

/// In-place close with the given radius (in voxels, Chebyshev metric via
/// 26-neighborhood BFS). Radius 0 is a no-op.
pub fn morphological_close(band: &mut SparseBand, radius_voxels: u8) {
    if radius_voxels == 0 || band.is_empty() {
        return;
    }
    dilate(band, radius_voxels, true);
    dilate(band, radius_voxels, false);
}

/// Multi-source BFS from every corner whose `inside == from_state`, flipping
/// reached corners of the opposite state. `from_state == true` dilates the
/// inside region; `false` erodes it (dilates the outside).
///
/// Missing corners are never touched or traversed: deep-interior corners are
/// implicitly inside and far-exterior corners implicitly outside, and the
/// band-halfwidth contract keeps the morphology away from both.
fn dilate(band: &mut SparseBand, radius: u8, from_state: bool) {
    let n = band.keys.len();
    // 0 = unvisited, 1 = frontier/visited.
    let mut visited = vec![false; n];
    let mut frontier: Vec<u32> = Vec::new();
    for i in 0..n {
        if band.inside[i] == from_state {
            visited[i] = true;
            frontier.push(i as u32);
        }
    }
    let mut next: Vec<u32> = Vec::new();
    for _ in 0..radius {
        next.clear();
        for &idx in &frontier {
            let (i, j, k) = band.keys[idx as usize];
            for di in -1..=1i32 {
                for dj in -1..=1i32 {
                    for dk in -1..=1i32 {
                        if di == 0 && dj == 0 && dk == 0 {
                            continue;
                        }
                        let Some(&nidx) = band.index.get(&(i + di, j + dj, k + dk)) else {
                            continue;
                        };
                        let ni = nidx as usize;
                        if !visited[ni] {
                            visited[ni] = true;
                            band.inside[ni] = from_state;
                            next.push(nidx);
                        }
                    }
                }
            }
        }
        std::mem::swap(&mut frontier, &mut next);
        if frontier.is_empty() {
            break;
        }
    }
}
