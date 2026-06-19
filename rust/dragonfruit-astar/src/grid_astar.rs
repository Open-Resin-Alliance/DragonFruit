//! 26-connected grid A* pathfinder.
//!
//! Direct port of `GridAStar.ts` to Rust, with SDF integration via the
//! pre-computed sparse grid from `dragonfruit-sdf`.

use std::sync::OnceLock;

use dragonfruit_sdf::grid::{cell_key, cell_key_inverse, SparseSdfGrid};
use dragonfruit_sdf::heightmap::ClearanceHeightmap;

use crate::indexed_heap::{HeapEntry, IndexedHeap};
use crate::types::{AStarOptions, AStarResult, Vec3};
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// Neighbor definitions (matches JS GridAStar.ts exactly)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
struct Neighbor {
    dx: i32,
    dy: i32,
    dz: i32,
    /// sqrt(dx² + dy² + dz²)
    step_cost_factor: f32,
    /// sqrt(dx² + dy²)
    lateral_cells: f32,
    /// lateral / drop for downward moves; f32::INFINITY otherwise
    lateral_per_drop: f32,
}

fn build_neighbors() -> Vec<Neighbor> {
    let mut out = Vec::with_capacity(29);

    // 26-connected (dx, dy, dz in [-1, 0, 1], exclude (0,0,0))
    for dx in -1..=1i32 {
        for dy in -1..=1i32 {
            for dz in -1..=1i32 {
                if dx == 0 && dy == 0 && dz == 0 {
                    continue;
                }
                let cost = ((dx * dx + dy * dy + dz * dz) as f32).sqrt();
                out.push(Neighbor {
                    dx, dy, dz,
                    step_cost_factor: cost,
                    lateral_cells: ((dx * dx + dy * dy) as f32).sqrt(),
                    lateral_per_drop: if dz < 0 {
                        ((dx * dx + dy * dy) as f32).sqrt() / (-dz as f32).abs()
                    } else {
                        f32::INFINITY
                    },
                });
            }
        }
    }

    // Long pure-down strides
    for &dz in &[-2, -4, -8] {
        out.push(Neighbor {
            dx: 0, dy: 0, dz,
            step_cost_factor: dz.abs() as f32,
            lateral_cells: 0.0,
            lateral_per_drop: 0.0,
        });
    }

    out
}

static NEIGHBORS: OnceLock<Vec<Neighbor>> = OnceLock::new();
static PURE_DOWN_PRIORITY_INDICES: OnceLock<Vec<usize>> = OnceLock::new();

fn neighbors() -> &'static Vec<Neighbor> {
    NEIGHBORS.get_or_init(build_neighbors)
}

fn pure_down_indices() -> &'static Vec<usize> {
    PURE_DOWN_PRIORITY_INDICES.get_or_init(|| {
        let mut indices: Vec<(usize, i32)> = neighbors()
            .iter()
            .enumerate()
            .filter(|(_, n)| n.dx == 0 && n.dy == 0 && n.dz < 0)
            .map(|(i, n)| (i, n.dz))
            .collect();
        indices.sort_by_key(|(_, dz)| dz.abs());
        indices.reverse(); // longest stride first
        indices.into_iter().map(|(i, _)| i).collect()
    })
}

const STRAIGHT_DESCENT_CLEARANCE_FACTOR: f32 = 1.3;
const STAGNATION_LIMIT: u32 = 400;

// ---------------------------------------------------------------------------
// SDF wrapper — provides distanceAt, isBlocked, segmentBlocked
// ---------------------------------------------------------------------------

struct SdfAccess<'a> {
    grid: &'a SparseSdfGrid,
    heightmap: Option<&'a ClearanceHeightmap>,
}

impl<'a> SdfAccess<'a> {
    fn new(grid: &'a SparseSdfGrid, heightmap: Option<&'a ClearanceHeightmap>) -> Self {
        Self { grid, heightmap }
    }

    /// Signed distance at a world-space point (model-local mm).
    #[inline]
    fn distance_at(&self, wx: f32, wy: f32, wz: f32) -> f32 {
        let cs = self.grid.cell_size;
        let qx = (wx / cs).round() as i32;
        let qy = (wy / cs).round() as i32;
        let qz = (wz / cs).round() as i32;
        self.grid.get(qx, qy, qz).unwrap_or(f32::INFINITY)
    }

    /// Returns true if the cell at (wx, wy, wz) is closer than `clearance` mm.
    #[inline]
    fn is_blocked(&self, wx: f32, wy: f32, wz: f32, clearance: f32) -> bool {
        self.distance_at(wx, wy, wz) < clearance
    }

    /// Adaptive sphere-traced segment collision check.
    /// Returns true if any point along A→B is within `clearance` of the surface.
    fn segment_blocked(
        &self,
        ax: f32, ay: f32, az: f32,
        bx: f32, by: f32, bz: f32,
        clearance: f32,
    ) -> bool {
        let dx = bx - ax;
        let dy = by - ay;
        let dz = bz - az;
        let len = (dx * dx + dy * dy + dz * dz).sqrt();
        if len < 0.01 {
            return self.distance_at(ax, ay, az) < clearance;
        }

        let inv_len = 1.0 / len;
        let ux = dx * inv_len;
        let uy = dy * inv_len;
        let uz = dz * inv_len;

        let cs = self.grid.cell_size;
        let min_step = cs * 0.9;

        let mut t = 0.0f32;
        let max_iter = (8u32).max((len / min_step).ceil() as u32 + 2);

        for _ in 0..max_iter {
            let px = ax + ux * t;
            let py = ay + uy * t;
            let pz = az + uz * t;
            let d = self.distance_at(px, py, pz);
            if d < clearance {
                return true;
            }
            let safe_advance = d - clearance;
            let step = if safe_advance > min_step { safe_advance } else { min_step };
            t += step;
            if t >= len {
                break;
            }
        }

        self.distance_at(bx, by, bz) < clearance
    }

    /// O(1) heightmap-based column clearance check.
    fn column_is_clear(&self, wx: f32, wy: f32, wz: f32) -> bool {
        if let Some(hm) = self.heightmap {
            hm.column_is_clear(wx, wy, wz)
        } else {
            // Fall back to full segment check
            !self.segment_blocked(wx, wy, wz, wx, wy, 0.0, 0.001)
        }
    }

    /// O(1) heightmap-based blocked-Z lookup.
    fn get_blocked_z(&self, wx: f32, wy: f32) -> f32 {
        if let Some(hm) = self.heightmap {
            hm.get(wx, wy)
        } else {
            f32::NEG_INFINITY
        }
    }
}

// ---------------------------------------------------------------------------
// Node state
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct NodeState {
    g: f32,
    came_from: Option<u64>,
    closed: bool,
}

// ---------------------------------------------------------------------------
// Per-neighbor edge validation cache
// ---------------------------------------------------------------------------

type EdgeBlockedCache = HashMap<(u64, u64), bool>;

// ---------------------------------------------------------------------------
// Choose straight-descent index
// ---------------------------------------------------------------------------

fn choose_straight_descent_index(
    sdf: &SdfAccess,
    cqx: i32, cqy: i32, cqz: i32,
    cwx: f32, cwy: f32, cwz: f32,
    gqz: i32,
    clearance: f32,
    step: f32,
    node_state: &HashMap<u64, NodeState>,
    edge_blocked_cache: &mut EdgeBlockedCache,
) -> Option<usize> {
    let min_clearance = clearance * STRAIGHT_DESCENT_CLEARANCE_FACTOR;

    for &ni in pure_down_indices().iter() {
        let n = &neighbors()[ni];
        let mut nz = cqz + n.dz;
        if nz < gqz {
            nz = gqz;
        }
        if nz == cqz {
            continue;
        }

        let n_key = cell_key(cqx, cqy, nz);
        if let Some(state) = node_state.get(&n_key) {
            if state.closed {
                continue;
            }
        }

        let wz = nz as f32 * step;
        if sdf.is_blocked(cwx, cwy, wz, min_clearance) {
            continue;
        }

        // Edge validation
        if is_edge_blocked(
            sdf,
            cell_key(cqx, cqy, cqz),
            n_key,
            cwx, cwy, cwz,
            cwx, cwy, wz,
            clearance,
            edge_blocked_cache,
        ) {
            continue;
        }

        return Some(ni);
    }

    None
}

// ---------------------------------------------------------------------------
// Edge blocked check (with cache)
// ---------------------------------------------------------------------------

fn is_edge_blocked(
    sdf: &SdfAccess,
    from_key: u64,
    to_key: u64,
    fx: f32, fy: f32, fz: f32,
    tx: f32, ty: f32, tz: f32,
    clearance: f32,
    cache: &mut EdgeBlockedCache,
) -> bool {
    let cache_key = (from_key, to_key);
    if let Some(&blocked) = cache.get(&cache_key) {
        return blocked;
    }

    let blocked = sdf.segment_blocked(fx, fy, fz, tx, ty, tz, clearance);
    cache.insert(cache_key, blocked);
    blocked
}

// ---------------------------------------------------------------------------
// Node distance cache
// ---------------------------------------------------------------------------

type NodeDistanceCache = HashMap<u64, f32>;

fn get_node_distance(
    sdf: &SdfAccess,
    key: u64,
    wx: f32, wy: f32, wz: f32,
    cache: &mut NodeDistanceCache,
) -> f32 {
    if let Some(&d) = cache.get(&key) {
        return d;
    }
    let d = sdf.distance_at(wx, wy, wz);
    cache.insert(key, d);
    d
}

// ---------------------------------------------------------------------------
// Heightmap-aware heuristic
// ---------------------------------------------------------------------------

fn compute_heuristic(
    sdf: &SdfAccess,
    qx: i32, qy: i32, qz: i32,
    step: f32,
    goal_z: f32,
) -> f32 {
    let wx = qx as f32 * step;
    let wy = qy as f32 * step;
    let wz = qz as f32 * step;

    if sdf.heightmap.is_some() {
        let blocked_z = sdf.get_blocked_z(wx, wy);
        if !blocked_z.is_finite() || wz > blocked_z {
            // Column is clear — straight drop is viable
            return (wz - goal_z).max(0.0);
        }
        // At/below blocked Z — need lateral routing. Minimum: vertical + one diagonal cell.
        return (wz - goal_z).max(0.0) + step * 1.414;
    }

    // Fallback: simple vertical distance
    (qz as f32 * step - goal_z).max(0.0)
}

// ---------------------------------------------------------------------------
// Decode cell key
// ---------------------------------------------------------------------------

fn decode_key(key: u64) -> (i32, i32, i32) {
    cell_key_inverse(key)
}

// ---------------------------------------------------------------------------
// Main A* entry point
// ---------------------------------------------------------------------------

/// Run the 26-connected grid A* pathfinder.
///
/// `sdf` — the pre-computed sparse SDF grid for the model
/// `heightmap` — optional clearance heightmap for heuristic/straight-descent
/// `start_pos` — socket position in world-space mm
/// `goal_z` — root top Z in world-space mm
/// `opts` — search options
/// `warm_open_entries` — optional warm-start open set from a previous search
/// `warm_g_scores` — optional warm-start g-scores
/// `warm_came_from` — optional warm-start cameFrom map
pub fn run_astar(
    sdf: &SparseSdfGrid,
    heightmap: Option<&ClearanceHeightmap>,
    start_pos: Vec3,
    goal_z: f32,
    opts: &AStarOptions,
    warm_open_entries: Option<Vec<HeapEntry>>,
    warm_g_scores: Option<HashMap<u64, f32>>,
    warm_came_from: Option<HashMap<u64, u64>>,
) -> AStarResult {
    let step = opts.step_mm;
    let max_exp = opts.max_expansions;
    let clearance = opts.clearance_mm;
    let max_lateral = opts.max_lateral_mm;
    let max_lateral_sq = max_lateral * max_lateral;
    let endpoint_only = opts.endpoint_only_collision;
    let use_warm_start = opts.use_warm_start;

    let sdf_access = SdfAccess::new(sdf, heightmap);

    // Quantise start
    let sqx = (start_pos.x / step).round() as i32;
    let sqy = (start_pos.y / step).round() as i32;
    let sqz = (start_pos.z / step).round() as i32;
    let gqz = (goal_z / step).round() as i32;
    let start_key = cell_key(sqx, sqy, sqz);

    // Angle constraint
    let min_angle_rad = (opts.min_angle_from_vertical_deg as f64).to_radians() as f32;
    let max_lateral_per_drop = min_angle_rad.tan();

    // Max climb: allow up to 3 cells upward for overhang routing
    let max_climb_cells = 3i32;

    // Neighbor static costs
    let nbrs = neighbors();
    let mut neighbor_static_costs = vec![0.0f32; nbrs.len()];
    for (i, n) in nbrs.iter().enumerate() {
        let move_cost = n.step_cost_factor * step;
        let verticality_penalty = n.lateral_cells * step * 0.4;
        let lateral_penalty = n.lateral_cells * step * 0.4;
        let shallow_penalty = if n.lateral_per_drop.is_finite() {
            n.lateral_per_drop * n.lateral_per_drop * step * 0.8
        } else {
            0.0
        };
        neighbor_static_costs[i] = move_cost + verticality_penalty + lateral_penalty + shallow_penalty;
    }

    // Per-neighbor cost functions
    let neighbor_move_cost = |ni: usize, _from_x: i32, _from_y: i32, _from_z: i32| -> f32 {
        neighbor_static_costs[ni]
    };

    let neighbor_valid = |ni: usize, from_x: i32, from_y: i32, from_z: i32| -> bool {
        let n = &neighbors()[ni];
        let nx = from_x + n.dx;
        let ny = from_y + n.dy;
        let nz = from_z + n.dz;

        // Lateral bound
        let dx = (nx - sqx) as f32 * step;
        let dy = (ny - sqy) as f32 * step;
        if dx * dx + dy * dy > max_lateral_sq {
            return false;
        }

        // Climb bound
        if n.dz > 0 && nz > sqz + max_climb_cells {
            return false;
        }

        // Angle constraint: lateral per drop must be within limit
        if n.dz < 0 {
            if n.lateral_per_drop > max_lateral_per_drop {
                return false;
            }
        }

        true
    };

    // Initialise state
    let mut node_state: HashMap<u64, NodeState> = HashMap::with_capacity(max_exp as usize * 2);
    let mut open_set: IndexedHeap;
    let mut edge_blocked_cache: EdgeBlockedCache = HashMap::with_capacity(1024);
    let mut node_distance_cache: NodeDistanceCache = HashMap::with_capacity(1024);
    let occupancy_cache: HashMap<u64, bool> = HashMap::new(); // placeholder — no occupancy yet

    let can_warm_start = use_warm_start
        && warm_open_entries.as_ref().map_or(false, |e| !e.is_empty());

    if can_warm_start {
        let warm_entries = warm_open_entries.unwrap();
        let warm_g = warm_g_scores.unwrap_or_default();
        let warm_cf = warm_came_from.unwrap_or_default();

        for (key, g) in &warm_g {
            node_state.entry(*key)
                .and_modify(|s| s.g = *g)
                .or_insert(NodeState { g: *g, came_from: None, closed: false });
        }
        for (key, came_from) in &warm_cf {
            node_state.entry(*key)
                .and_modify(|s| s.came_from = Some(*came_from))
                .or_insert(NodeState { g: f32::INFINITY, came_from: Some(*came_from), closed: false });
        }
        open_set = IndexedHeap::from_entries(warm_entries);
    } else {
        node_state.insert(start_key, NodeState { g: 0.0, came_from: None, closed: false });
        let h = compute_heuristic(&sdf_access, sqx, sqy, sqz, step, goal_z);
        let mut heap = IndexedHeap::new(max_exp as usize);
        heap.push_or_update(HeapEntry { key: start_key, f: h, g: 0.0 });
        open_set = heap;
    }

    let mut expansions: u32 = 0;
    let mut goal_entry: Option<HeapEntry> = None;
    let mut best_z_reached = sqz;
    let mut last_z_progress_at: u32 = 0;

    // Main A* loop
    while !open_set.is_empty() && expansions < max_exp {
        let current = match open_set.pop() {
            Some(e) => e,
            None => break,
        };

        let current_state = match node_state.get(&current.key) {
            Some(s) => s.clone(),
            None => continue,
        };

        if current.g > current_state.g {
            continue;
        }
        if current_state.closed {
            continue;
        }

        // Mark closed
        node_state.get_mut(&current.key).unwrap().closed = true;
        expansions += 1;

        let (cqx, cqy, cqz) = decode_key(current.key);

        // Track Z progress
        if cqz < best_z_reached {
            best_z_reached = cqz;
            last_z_progress_at = expansions;
        }
        if expansions - last_z_progress_at > STAGNATION_LIMIT {
            // Stagnated — no Z progress
            return AStarResult {
                path: vec![],
                expansions,
                reached: false,
                stagnated: true,
                hit_expansion_limit: false,
            };
        }

        let cwx = cqx as f32 * step;
        let cwy = cqy as f32 * step;
        let cwz = cqz as f32 * step;

        // Goal check
        if cqz <= gqz {
            goal_entry = Some(current);
            break;
        }

        // Straight-descent early goal check
        let current_dist = get_node_distance(&sdf_access, current.key, cwx, cwy, cwz, &mut node_distance_cache);
        if current_dist >= clearance {
            let drop_clear = if sdf_access.heightmap.is_some() {
                sdf_access.column_is_clear(cwx, cwy, cwz)
            } else {
                !sdf_access.segment_blocked(cwx, cwy, cwz, cwx, cwy, goal_z, clearance)
            };
            if drop_clear {
                goal_entry = Some(current);
                break;
            }
        }

        // Straight-descent priority
        let straight_descent_only = if current_dist >= clearance {
            choose_straight_descent_index(
                &sdf_access,
                cqx, cqy, cqz,
                cwx, cwy, cwz,
                gqz,
                clearance,
                step,
                &node_state,
                &mut edge_blocked_cache,
            )
        } else {
            None
        };

        // Neighbor expansion
        let nbrs = neighbors();
        for ni in 0..nbrs.len() {
            if let Some(sd_idx) = straight_descent_only {
                if ni != sd_idx {
                    continue;
                }
            }

            let n = &neighbors()[ni];
            let nx = cqx + n.dx;
            let ny = cqy + n.dy;
            let mut nz = cqz + n.dz;
            if n.dz < 0 && nz < gqz {
                nz = gqz;
            }

            if !neighbor_valid(ni, cqx, cqy, cqz) {
                continue;
            }

            let n_key = cell_key(nx, ny, nz);
            if let Some(state) = node_state.get(&n_key) {
                if state.closed {
                    continue;
                }
            }

            let nwx = nx as f32 * step;
            let nwy = ny as f32 * step;
            let nwz = nz as f32 * step;

            // Occupancy check (placeholder)
            if let Some(&occupied) = occupancy_cache.get(&n_key) {
                if occupied {
                    continue;
                }
            }

            // Collision check
            let dist = get_node_distance(&sdf_access, n_key, nwx, nwy, nwz, &mut node_distance_cache);
            if dist < clearance {
                continue;
            }

            // Edge validation
            if !endpoint_only {
                if is_edge_blocked(
                    &sdf_access,
                    current.key, n_key,
                    cwx, cwy, cwz,
                    nwx, nwy, nwz,
                    clearance,
                    &mut edge_blocked_cache,
                ) {
                    continue;
                }
            }

            // Cost computation
            let move_cost = neighbor_move_cost(ni, cqx, cqy, cqz);
            let new_g = current.g + move_cost;

            // Check if better path
            let existing = node_state.get(&n_key);
            if let Some(state) = existing {
                if new_g >= state.g {
                    continue;
                }
            }

            let h = compute_heuristic(&sdf_access, nx, ny, nz, step, goal_z);
            let f = new_g + h;

            node_state.insert(n_key, NodeState {
                g: new_g,
                came_from: Some(current.key),
                closed: false,
            });

            open_set.push_or_update(HeapEntry { key: n_key, f, g: new_g });
        }
    }

    // Reconstruct path
    let reached = goal_entry.is_some();
    let hit_expansion_limit = !reached && expansions >= max_exp;
    let stagnated = !reached && expansions - last_z_progress_at > STAGNATION_LIMIT;

    if !reached {
        return AStarResult {
            path: vec![],
            expansions,
            reached: false,
            stagnated,
            hit_expansion_limit,
        };
    }

    let mut path: Vec<Vec3> = Vec::new();
    let mut key = goal_entry.unwrap().key;

    // Walk back from goal to start
    loop {
        let (qx, qy, qz) = decode_key(key);
        path.push(Vec3::new(qx as f32 * step, qy as f32 * step, qz as f32 * step));

        if key == start_key {
            break;
        }

        match node_state.get(&key) {
            Some(state) if state.came_from.is_some() => {
                key = state.came_from.unwrap();
            }
            _ => break,
        }
    }

    path.reverse();

    // Append the goal position (root top) as the final waypoint
    let last = path.last().map(|p| (p.x, p.y)).unwrap_or((start_pos.x, start_pos.y));
    path.push(Vec3::new(last.0, last.1, goal_z));

    AStarResult {
        path,
        expansions,
        reached: true,
        stagnated: false,
        hit_expansion_limit: false,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use dragonfruit_sdf::SparseSdfGrid;

    fn make_open_sdf() -> SparseSdfGrid {
        // A mostly-empty SDF grid with a few distant cells
        let mut grid = SparseSdfGrid::new(0.5, 4);
        grid.insert(100, 100, 100, 100.0);
        grid
    }

    #[test]
    fn test_straight_descent_open_space() {
        let sdf = make_open_sdf();
        let opts = AStarOptions {
            step_mm: 0.5,
            max_expansions: 100,
            clearance_mm: 0.8,
            max_lateral_mm: 72.0,
            ..Default::default()
        };

        let result = run_astar(
            &sdf,
            None,
            Vec3::new(0.0, 0.0, 80.0),
            0.0,
            &opts,
            None, None, None,
        );

        assert!(result.reached);
        assert!(result.expansions <= 45);
        // Path should go straight down
        assert_eq!(result.path.len(), 2);
        assert_eq!(result.path[0], Vec3::new(0.0, 0.0, 80.0));
        assert_eq!(result.path[1], Vec3::new(0.0, 0.0, 0.0));
    }
}

impl Default for AStarOptions {
    fn default() -> Self {
        Self {
            step_mm: 0.5,
            max_expansions: 600,
            clearance_mm: 0.8,
            max_lateral_mm: 72.0,
            min_angle_from_vertical_deg: 15.0,
            shaft_radius: 0.4,
            endpoint_only_collision: false,
            use_warm_start: false,
        }
    }
}
