/**
 * Joint Geometry Utilities
 * 
 * Mathematical functions for 3D geometry calculations related to joints and shafts.
 * Includes distance, angle, projection, and vector operations.
 */

import { Vec3 } from '../types';

/**
 * Calculates the Euclidean distance between two 3D points.
 * 
 * @param a - First point
 * @param b - Second point
 * @returns Distance in millimeters
 */
export function calculateDistance(a: Vec3, b: Vec3): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Calculates the squared distance between two points (faster, no sqrt).
 * Useful for distance comparisons where exact value isn't needed.
 * 
 * @param a - First point
 * @param b - Second point
 * @returns Squared distance
 */
export function calculateDistanceSquared(a: Vec3, b: Vec3): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Calculates the length (magnitude) of a vector.
 * 
 * @param v - Vector
 * @returns Length of the vector
 */
export function vectorLength(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

/**
 * Normalizes a vector to unit length.
 * 
 * @param v - Vector to normalize
 * @returns Normalized vector (length = 1)
 */
export function normalizeVector(v: Vec3): Vec3 {
  const length = vectorLength(v);
  if (length < 1e-10) {
    return { x: 0, y: 0, z: 1 }; // Default to Z-up if zero vector
  }
  return {
    x: v.x / length,
    y: v.y / length,
    z: v.z / length,
  };
}

/**
 * Calculates the dot product of two vectors.
 * 
 * @param a - First vector
 * @param b - Second vector
 * @returns Dot product
 */
export function dotProduct(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/**
 * Calculates the cross product of two vectors.
 * 
 * @param a - First vector
 * @param b - Second vector
 * @returns Cross product vector
 */
export function crossProduct(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

/**
 * Calculates the angle between two vectors in degrees.
 * 
 * @param a - First vector
 * @param b - Second vector
 * @returns Angle in degrees (0-180)
 */
export function calculateAngleBetweenVectors(a: Vec3, b: Vec3): number {
  const normA = normalizeVector(a);
  const normB = normalizeVector(b);
  
  const dot = dotProduct(normA, normB);
  
  // Clamp to [-1, 1] to handle floating point errors
  const clampedDot = Math.max(-1, Math.min(1, dot));
  
  const angleRad = Math.acos(clampedDot);
  return angleRad * (180 / Math.PI);
}

/**
 * Projects a point onto a line segment and returns the closest point.
 * 
 * @param point - Point to project
 * @param lineStart - Start of the line segment
 * @param lineEnd - End of the line segment
 * @returns Object containing the closest point and parameter t (0-1)
 */
export function projectPointOntoSegment(
  point: Vec3,
  lineStart: Vec3,
  lineEnd: Vec3
): { closestPoint: Vec3; t: number } {
  const segmentVector = {
    x: lineEnd.x - lineStart.x,
    y: lineEnd.y - lineStart.y,
    z: lineEnd.z - lineStart.z,
  };
  
  const pointVector = {
    x: point.x - lineStart.x,
    y: point.y - lineStart.y,
    z: point.z - lineStart.z,
  };
  
  const segmentLengthSq = 
    segmentVector.x * segmentVector.x +
    segmentVector.y * segmentVector.y +
    segmentVector.z * segmentVector.z;
  
  // Handle degenerate case (zero-length segment)
  if (segmentLengthSq < 1e-10) {
    return { closestPoint: lineStart, t: 0 };
  }
  
  // Calculate parameter t
  let t = (
    pointVector.x * segmentVector.x +
    pointVector.y * segmentVector.y +
    pointVector.z * segmentVector.z
  ) / segmentLengthSq;
  
  // Clamp t to [0, 1] to stay within segment
  t = Math.max(0, Math.min(1, t));
  
  // Calculate closest point
  const closestPoint = {
    x: lineStart.x + t * segmentVector.x,
    y: lineStart.y + t * segmentVector.y,
    z: lineStart.z + t * segmentVector.z,
  };
  
  return { closestPoint, t };
}

/**
 * Calculates a point along a line segment given parameter t.
 * 
 * @param start - Start of the segment
 * @param end - End of the segment
 * @param t - Parameter (0 = start, 1 = end)
 * @returns Point at parameter t
 */
export function interpolatePoint(start: Vec3, end: Vec3, t: number): Vec3 {
  return {
    x: start.x + t * (end.x - start.x),
    y: start.y + t * (end.y - start.y),
    z: start.z + t * (end.z - start.z),
  };
}

/**
 * Subtracts vector b from vector a.
 * 
 * @param a - First vector
 * @param b - Second vector
 * @returns Difference vector (a - b)
 */
export function subtractVectors(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.x - b.x,
    y: a.y - b.y,
    z: a.z - b.z,
  };
}

/**
 * Adds two vectors.
 * 
 * @param a - First vector
 * @param b - Second vector
 * @returns Sum vector (a + b)
 */
export function addVectors(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.x + b.x,
    y: a.y + b.y,
    z: a.z + b.z,
  };
}

/**
 * Scales a vector by a scalar value.
 * 
 * @param v - Vector to scale
 * @param scalar - Scale factor
 * @returns Scaled vector
 */
export function scaleVector(v: Vec3, scalar: number): Vec3 {
  return {
    x: v.x * scalar,
    y: v.y * scalar,
    z: v.z * scalar,
  };
}

/**
 * Calculates the direction vector from one point to another (normalized).
 * 
 * @param from - Starting point
 * @param to - Ending point
 * @returns Normalized direction vector
 */
export function calculateDirection(from: Vec3, to: Vec3): Vec3 {
  const direction = subtractVectors(to, from);
  return normalizeVector(direction);
}

/**
 * Checks if two points are approximately equal within a tolerance.
 * 
 * @param a - First point
 * @param b - Second point
 * @param tolerance - Maximum difference for equality (default 0.001mm)
 * @returns True if points are approximately equal
 */
export function arePointsEqual(a: Vec3, b: Vec3, tolerance: number = 0.001): boolean {
  return (
    Math.abs(a.x - b.x) < tolerance &&
    Math.abs(a.y - b.y) < tolerance &&
    Math.abs(a.z - b.z) < tolerance
  );
}

/**
 * Calculates the midpoint between two points.
 * 
 * @param a - First point
 * @param b - Second point
 * @returns Midpoint
 */
export function calculateMidpoint(a: Vec3, b: Vec3): Vec3 {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    z: (a.z + b.z) / 2,
  };
}

/**
 * Distributes N points evenly along a line segment.
 * 
 * @param start - Start of the segment
 * @param end - End of the segment
 * @param count - Number of points to distribute
 * @returns Array of evenly distributed points
 */
export function distributePointsAlongSegment(
  start: Vec3,
  end: Vec3,
  count: number
): Vec3[] {
  if (count <= 0) return [];
  if (count === 1) return [calculateMidpoint(start, end)];
  
  const points: Vec3[] = [];
  
  // Distribute points evenly, excluding start and end
  for (let i = 0; i < count; i++) {
    const t = (i + 1) / (count + 1);
    points.push(interpolatePoint(start, end, t));
  }
  
  return points;
}
