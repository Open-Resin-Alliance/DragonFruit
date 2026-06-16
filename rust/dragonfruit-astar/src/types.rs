//! Shared types for the Rust A* pathfinder.
//!
//! Serialisation format for IPC:
//!
//! ```text
//! Request (JSON):
//! {
//!   "model_id": "uuid",
//!   "start_x": f32, "start_y": f32, "start_z": f32,
//!   "goal_z": f32,
//!   "step_mm": f32,
//!   "max_expansions": u32,
//!   "clearance_mm": f32,
//!   "max_lateral_mm": f32,
//!   "min_angle_from_vertical_deg": f32,
//!   "shaft_radius": f32,
//!   "endpoint_only_collision": bool,
//!   "use_warm_start": bool
//! }
//!
//! Response (binary, little-endian):
//!   reached:          u8  (0 or 1)
//!   stagnated:        u8
//!   hit_expansion_limit: u8
//!   expansions:       u32
//!   path_len:         u32
//!   path:             [f32; path_len * 3]  (x, y, z per waypoint)
//! ```

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Vec3
// ---------------------------------------------------------------------------

/// 3D vector matching the JS `Vec3` type.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Vec3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

impl Vec3 {
    pub const fn new(x: f32, y: f32, z: f32) -> Self {
        Self { x, y, z }
    }
}

// ---------------------------------------------------------------------------
// AStarOptions
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AStarOptions {
    /// Grid step size in mm (default 0.5).
    #[serde(default = "default_step_mm")]
    pub step_mm: f32,

    /// Maximum node expansions before giving up.
    #[serde(default = "default_max_expansions")]
    pub max_expansions: u32,

    /// Clearance = shaft radius + safety margin.
    pub clearance_mm: f32,

    /// Maximum lateral XY displacement from socket.
    #[serde(default = "default_max_lateral_mm")]
    pub max_lateral_mm: f32,

    /// Minimum angle from vertical for shaft segments (degrees).
    #[serde(default = "default_min_angle_deg")]
    pub min_angle_from_vertical_deg: f32,

    /// Shaft radius for safety margin.
    #[serde(default)]
    pub shaft_radius: f32,

    /// When true, only check endpoint cells for collision (not full segment
    /// sweep).  Used for hover preview to reduce BVH/SDF queries.
    #[serde(default)]
    pub endpoint_only_collision: bool,

    /// Whether to use the warm-start state from a previous search.
    #[serde(default)]
    pub use_warm_start: bool,
}

fn default_step_mm() -> f32 { 0.5 }
fn default_max_expansions() -> u32 { 600 }
fn default_max_lateral_mm() -> f32 { 72.0 }
fn default_min_angle_deg() -> f32 { 15.0 }

// ---------------------------------------------------------------------------
// AStarRequest (JSON IPC)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AStarRequest {
    /// Model ID for warm-start state lookup.
    pub model_id: String,

    /// Start position (socket) in world-space mm.
    pub start_x: f32,
    pub start_y: f32,
    pub start_z: f32,

    /// Goal Z (root top) in world-space mm.
    pub goal_z: f32,

    #[serde(flatten)]
    pub options: AStarOptions,
}

// ---------------------------------------------------------------------------
// AStarResult
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct AStarResult {
    /// Waypoints from socket down toward rootTopZ (excludes start, includes goal).
    pub path: Vec<Vec3>,

    /// Number of node expansions used.
    pub expansions: u32,

    /// Whether the path reached the goal region.
    pub reached: bool,

    /// True if the search was terminated early due to lack of Z progress.
    pub stagnated: bool,

    /// True if the search exhausted its expansion budget.
    pub hit_expansion_limit: bool,
}

impl AStarResult {
    /// Serialise to the binary IPC format.
    pub fn to_bytes(&self) -> Vec<u8> {
        let path_floats = self.path.len() * 3;
        let mut buf = Vec::with_capacity(7 + path_floats * 4);

        buf.push(self.reached as u8);
        buf.push(self.stagnated as u8);
        buf.push(self.hit_expansion_limit as u8);
        buf.extend_from_slice(&self.expansions.to_le_bytes());
        buf.extend_from_slice(&(self.path.len() as u32).to_le_bytes());

        for p in &self.path {
            buf.extend_from_slice(&p.x.to_le_bytes());
            buf.extend_from_slice(&p.y.to_le_bytes());
            buf.extend_from_slice(&p.z.to_le_bytes());
        }

        buf
    }
}
