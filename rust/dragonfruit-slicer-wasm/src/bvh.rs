// Bounding Volume Hierarchy (BVH) for spatial acceleration
// Speeds up triangle-plane intersection queries by culling triangles
// that cannot possibly intersect a given Z-plane

use crate::solid_slicer::Tri;

/// Axis-Aligned Bounding Box
#[derive(Debug, Clone, Copy)]
pub struct AABB {
    pub min_x: f32,
    pub min_y: f32,
    pub min_z: f32,
    pub max_x: f32,
    pub max_y: f32,
    pub max_z: f32,
}

impl AABB {
    /// Create AABB from a single triangle
    pub fn from_triangle(tri: &Tri) -> Self {
        let min_x = tri.a.x.min(tri.b.x).min(tri.c.x);
        let max_x = tri.a.x.max(tri.b.x).max(tri.c.x);
        let min_y = tri.a.y.min(tri.b.y).min(tri.c.y);
        let max_y = tri.a.y.max(tri.b.y).max(tri.c.y);
        // tri already has z_min and z_max precomputed
        Self {
            min_x,
            min_y,
            min_z: tri.z_min,
            max_x,
            max_y,
            max_z: tri.z_max,
        }
    }

    /// Merge two AABBs
    pub fn merge(&self, other: &AABB) -> Self {
        Self {
            min_x: self.min_x.min(other.min_x),
            min_y: self.min_y.min(other.min_y),
            min_z: self.min_z.min(other.min_z),
            max_x: self.max_x.max(other.max_x),
            max_y: self.max_y.max(other.max_y),
            max_z: self.max_z.max(other.max_z),
        }
    }

    /// Check if a Z-plane intersects this bounding box
    #[inline]
    pub fn intersects_z_plane(&self, z: f32) -> bool {
        z >= self.min_z && z <= self.max_z
    }

    /// Surface area heuristic for BVH building (used to find best split)
    pub fn surface_area(&self) -> f32 {
        let dx = self.max_x - self.min_x;
        let dy = self.max_y - self.min_y;
        let dz = self.max_z - self.min_z;
        2.0 * (dx * dy + dy * dz + dz * dx)
    }

    /// Get the longest axis (0=X, 1=Y, 2=Z)
    pub fn longest_axis(&self) -> usize {
        let dx = self.max_x - self.min_x;
        let dy = self.max_y - self.min_y;
        let dz = self.max_z - self.min_z;

        if dx >= dy && dx >= dz {
            0
        } else if dy >= dz {
            1
        } else {
            2
        }
    }
}

/// BVH Node - either internal node with children or leaf with triangles
pub struct BVHNode {
    pub bounds: AABB,
    pub left: Option<Box<BVHNode>>,
    pub right: Option<Box<BVHNode>>,
    pub triangle_indices: Vec<usize>,
}

impl BVHNode {
    /// Create a leaf node from triangle indices
    fn leaf(triangles: &[Tri], indices: Vec<usize>) -> Self {
        let bounds = if indices.is_empty() {
            AABB {
                min_x: 0.0,
                min_y: 0.0,
                min_z: 0.0,
                max_x: 0.0,
                max_y: 0.0,
                max_z: 0.0,
            }
        } else {
            let mut bounds = AABB::from_triangle(&triangles[indices[0]]);
            for &idx in &indices[1..] {
                let tri_bounds = AABB::from_triangle(&triangles[idx]);
                bounds = bounds.merge(&tri_bounds);
            }
            bounds
        };

        Self {
            bounds,
            left: None,
            right: None,
            triangle_indices: indices,
        }
    }

    /// Create internal node with two children
    fn internal(left: BVHNode, right: BVHNode) -> Self {
        let bounds = left.bounds.merge(&right.bounds);
        Self {
            bounds,
            left: Some(Box::new(left)),
            right: Some(Box::new(right)),
            triangle_indices: Vec::new(),
        }
    }

    /// Build BVH tree recursively using Surface Area Heuristic (SAH)
    pub fn build(triangles: &[Tri], mut indices: Vec<usize>, max_leaf_size: usize) -> Self {
        // Base case: small enough to be a leaf
        if indices.len() <= max_leaf_size {
            return Self::leaf(triangles, indices);
        }

        // Compute bounding box for all triangles in this node
        let mut bounds = AABB::from_triangle(&triangles[indices[0]]);
        for &idx in &indices[1..] {
            let tri_bounds = AABB::from_triangle(&triangles[idx]);
            bounds = bounds.merge(&tri_bounds);
        }

        // Find best split axis (longest dimension)
        let split_axis = bounds.longest_axis();

        // Sort triangles by centroid along split axis
        indices.sort_by(|&a, &b| {
            let tri_a = &triangles[a];
            let tri_b = &triangles[b];

            let centroid_a = match split_axis {
                0 => (tri_a.a.x + tri_a.b.x + tri_a.c.x) / 3.0,
                1 => (tri_a.a.y + tri_a.b.y + tri_a.c.y) / 3.0,
                _ => (tri_a.z_min + tri_a.z_max) / 2.0, // Z: use midpoint of bounds
            };

            let centroid_b = match split_axis {
                0 => (tri_b.a.x + tri_b.b.x + tri_b.c.x) / 3.0,
                1 => (tri_b.a.y + tri_b.b.y + tri_b.c.y) / 3.0,
                _ => (tri_b.z_min + tri_b.z_max) / 2.0,
            };

            centroid_a.partial_cmp(&centroid_b).unwrap_or(std::cmp::Ordering::Equal)
        });

        // Split at midpoint
        let mid = indices.len() / 2;
        let left_indices = indices[..mid].to_vec();
        let right_indices = indices[mid..].to_vec();

        // Recursively build children
        let left = Self::build(triangles, left_indices, max_leaf_size);
        let right = Self::build(triangles, right_indices, max_leaf_size);

        Self::internal(left, right)
    }

    /// Query all triangle indices that might intersect a Z-plane
    pub fn query_z_plane(&self, z: f32, out: &mut Vec<usize>) {
        // Early out if this node's bounds don't intersect the plane
        if !self.bounds.intersects_z_plane(z) {
            return;
        }

        // If this is a leaf, add all triangle indices
        if self.left.is_none() && self.right.is_none() {
            out.extend_from_slice(&self.triangle_indices);
            return;
        }

        // Otherwise, recurse into children
        if let Some(ref left) = self.left {
            left.query_z_plane(z, out);
        }
        if let Some(ref right) = self.right {
            right.query_z_plane(z, out);
        }
    }

    /// Get statistics about the BVH tree (for debugging/profiling)
    pub fn stats(&self) -> BVHStats {
        let mut stats = BVHStats {
            total_nodes: 1,
            leaf_nodes: 0,
            internal_nodes: 0,
            max_depth: 0,
            total_triangles_in_leaves: 0,
            max_triangles_per_leaf: 0,
        };

        if self.left.is_none() && self.right.is_none() {
            // Leaf node
            stats.leaf_nodes = 1;
            stats.total_triangles_in_leaves = self.triangle_indices.len();
            stats.max_triangles_per_leaf = self.triangle_indices.len();
        } else {
            // Internal node
            stats.internal_nodes = 1;

            if let Some(ref left) = self.left {
                let left_stats = left.stats();
                stats.total_nodes += left_stats.total_nodes;
                stats.leaf_nodes += left_stats.leaf_nodes;
                stats.internal_nodes += left_stats.internal_nodes;
                stats.max_depth = stats.max_depth.max(left_stats.max_depth + 1);
                stats.total_triangles_in_leaves += left_stats.total_triangles_in_leaves;
                stats.max_triangles_per_leaf = stats.max_triangles_per_leaf.max(left_stats.max_triangles_per_leaf);
            }

            if let Some(ref right) = self.right {
                let right_stats = right.stats();
                stats.total_nodes += right_stats.total_nodes;
                stats.leaf_nodes += right_stats.leaf_nodes;
                stats.internal_nodes += right_stats.internal_nodes;
                stats.max_depth = stats.max_depth.max(right_stats.max_depth + 1);
                stats.total_triangles_in_leaves += right_stats.total_triangles_in_leaves;
                stats.max_triangles_per_leaf = stats.max_triangles_per_leaf.max(right_stats.max_triangles_per_leaf);
            }
        }

        stats
    }
}

#[derive(Debug, Clone)]
pub struct BVHStats {
    pub total_nodes: usize,
    pub leaf_nodes: usize,
    pub internal_nodes: usize,
    pub max_depth: usize,
    pub total_triangles_in_leaves: usize,
    pub max_triangles_per_leaf: usize,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::solid_slicer::{Tri, Vec3};

    #[test]
    fn test_aabb_from_triangle() {
        let tri = Tri {
            a: Vec3 { x: 0.0, y: 0.0, z: 0.0 },
            b: Vec3 { x: 1.0, y: 0.0, z: 1.0 },
            c: Vec3 { x: 0.0, y: 1.0, z: 0.5 },
            z_min: 0.0,
            z_max: 1.0,
        };

        let aabb = AABB::from_triangle(&tri);
        assert_eq!(aabb.min_x, 0.0);
        assert_eq!(aabb.max_x, 1.0);
        assert_eq!(aabb.min_y, 0.0);
        assert_eq!(aabb.max_y, 1.0);
        assert_eq!(aabb.min_z, 0.0);
        assert_eq!(aabb.max_z, 1.0);
    }

    #[test]
    fn test_aabb_intersects_z_plane() {
        let aabb = AABB {
            min_x: 0.0,
            min_y: 0.0,
            min_z: 1.0,
            max_x: 10.0,
            max_y: 10.0,
            max_z: 5.0,
        };

        assert!(aabb.intersects_z_plane(1.0)); // At min
        assert!(aabb.intersects_z_plane(3.0)); // Middle
        assert!(aabb.intersects_z_plane(5.0)); // At max
        assert!(!aabb.intersects_z_plane(0.5)); // Below
        assert!(!aabb.intersects_z_plane(5.5)); // Above
    }

    #[test]
    fn test_bvh_build_and_query() {
        // Create simple test triangles at different Z heights
        let triangles = vec![
            Tri {
                a: Vec3 { x: 0.0, y: 0.0, z: 0.0 },
                b: Vec3 { x: 1.0, y: 0.0, z: 0.5 },
                c: Vec3 { x: 0.0, y: 1.0, z: 0.3 },
                z_min: 0.0,
                z_max: 0.5,
            },
            Tri {
                a: Vec3 { x: 0.0, y: 0.0, z: 5.0 },
                b: Vec3 { x: 1.0, y: 0.0, z: 5.5 },
                c: Vec3 { x: 0.0, y: 1.0, z: 5.3 },
                z_min: 5.0,
                z_max: 5.5,
            },
            Tri {
                a: Vec3 { x: 0.0, y: 0.0, z: 10.0 },
                b: Vec3 { x: 1.0, y: 0.0, z: 10.5 },
                c: Vec3 { x: 0.0, y: 1.0, z: 10.3 },
                z_min: 10.0,
                z_max: 10.5,
            },
        ];

        let indices: Vec<usize> = (0..triangles.len()).collect();
        let bvh = BVHNode::build(&triangles, indices, 1);

        // Query at Z=0.25 should find first triangle
        let mut results = Vec::new();
        bvh.query_z_plane(0.25, &mut results);
        assert!(results.contains(&0));
        assert!(!results.contains(&1));
        assert!(!results.contains(&2));

        // Query at Z=5.25 should find second triangle
        let mut results = Vec::new();
        bvh.query_z_plane(5.25, &mut results);
        assert!(!results.contains(&0));
        assert!(results.contains(&1));
        assert!(!results.contains(&2));

        // Query at Z=10.25 should find third triangle
        let mut results = Vec::new();
        bvh.query_z_plane(10.25, &mut results);
        assert!(!results.contains(&0));
        assert!(!results.contains(&1));
        assert!(results.contains(&2));
    }
}
