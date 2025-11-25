/**
 * GPU Picking System - Utilities
 * 
 * ID encoding/decoding and majority vote logic for the picking system.
 */

import * as THREE from 'three';
import { PICK_ID, RENDER_TARGET } from './constants';

/**
 * Encode a pick ID into an RGB color.
 * Uses 24 bits (8 per channel) for up to 16.7 million unique IDs.
 * 
 * @param id - Pick ID (0 to 16,777,215)
 * @returns THREE.Color with encoded ID
 */
export function encodePickId(id: number): THREE.Color {
  // Clamp to valid range
  const safeId = Math.max(0, Math.min(id, 0xFFFFFF));
  
  // Extract RGB components (0-255 each)
  const r = (safeId >> 16) & 0xFF;
  const g = (safeId >> 8) & 0xFF;
  const b = safeId & 0xFF;
  
  // Convert to 0-1 range for THREE.Color
  return new THREE.Color(r / 255, g / 255, b / 255);
}

/**
 * Decode an RGB color back to a pick ID.
 * 
 * @param r - Red component (0-255)
 * @param g - Green component (0-255)
 * @param b - Blue component (0-255)
 * @returns Decoded pick ID
 */
export function decodePickId(r: number, g: number, b: number): number {
  return (r << 16) | (g << 8) | b;
}

/**
 * Decode a pick ID from a pixel in a Uint8Array buffer.
 * 
 * @param buffer - RGBA pixel buffer
 * @param pixelIndex - Index of the pixel (0-based)
 * @returns Decoded pick ID
 */
export function decodePickIdFromBuffer(buffer: Uint8Array, pixelIndex: number): number {
  const offset = pixelIndex * 4; // RGBA = 4 bytes per pixel
  return decodePickId(buffer[offset], buffer[offset + 1], buffer[offset + 2]);
}

/**
 * Perform majority vote on a 3x3 pixel patch.
 * Returns the most common pick ID, with tie-breakers:
 * 1. Center pixel wins ties
 * 2. Previous winner wins ties (stability)
 * 
 * @param buffer - RGBA pixel buffer (9 pixels = 36 bytes for 3x3)
 * @param previousWinner - Previous pick ID for tie-breaking
 * @returns Winning pick ID
 */
export function majorityVote(buffer: Uint8Array, previousWinner: number = PICK_ID.NONE): number {
  const size = RENDER_TARGET.SIZE; // 3
  const totalPixels = size * size; // 9
  
  // Count occurrences of each ID
  const counts = new Map<number, number>();
  const ids: number[] = [];
  
  for (let i = 0; i < totalPixels; i++) {
    const id = decodePickIdFromBuffer(buffer, i);
    ids.push(id);
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  
  // Find the maximum count
  let maxCount = 0;
  for (const count of counts.values()) {
    if (count > maxCount) maxCount = count;
  }
  
  // Get all IDs with the maximum count
  const winners: number[] = [];
  for (const [id, count] of counts.entries()) {
    if (count === maxCount) winners.push(id);
  }
  
  // Single winner - return it
  if (winners.length === 1) {
    return winners[0];
  }
  
  // Tie-breaker 1: Center pixel (index 4 in a 3x3 grid)
  const centerId = ids[4];
  if (winners.includes(centerId)) {
    return centerId;
  }
  
  // Tie-breaker 2: Previous winner (stability)
  if (winners.includes(previousWinner)) {
    return previousWinner;
  }
  
  // Fallback: return first winner (arbitrary but deterministic)
  return winners[0];
}

/**
 * Create a picking material for an object.
 * This material renders the object with a flat color representing its pick ID.
 * 
 * @param pickId - The pick ID to encode
 * @returns MeshBasicMaterial configured for picking
 */
export function createPickingMaterial(pickId: number): THREE.MeshBasicMaterial {
  const color = encodePickId(pickId);
  
  return new THREE.MeshBasicMaterial({
    color,
    // No lighting - flat color only
    fog: false,
    // Ensure proper depth testing
    depthTest: true,
    depthWrite: true,
    // No transparency
    transparent: false,
    // Single side for performance
    side: THREE.FrontSide,
  });
}

/**
 * Create a picking material that ignores depth (for gizmo handles).
 * These should always be pickable even when behind geometry.
 * 
 * @param pickId - The pick ID to encode
 * @returns MeshBasicMaterial configured for picking without depth test
 */
export function createPickingMaterialNoDepth(pickId: number): THREE.MeshBasicMaterial {
  const color = encodePickId(pickId);
  
  return new THREE.MeshBasicMaterial({
    color,
    fog: false,
    depthTest: false,
    depthWrite: false,
    transparent: false,
    side: THREE.FrontSide,
  });
}

/**
 * Check if a pick ID is in the gizmo range.
 */
export function isGizmoPickId(pickId: number): boolean {
  return pickId >= PICK_ID.GIZMO_START && pickId <= PICK_ID.GIZMO_END;
}

/**
 * Check if a pick ID is a dynamic ID (supports, joints, etc.).
 */
export function isDynamicPickId(pickId: number): boolean {
  return pickId >= PICK_ID.DYNAMIC_START;
}

/**
 * Generate the next available dynamic pick ID.
 * This is managed by the PickingContext, but this helper validates the range.
 */
export function validateDynamicPickId(id: number): boolean {
  return id >= PICK_ID.DYNAMIC_START && id <= 0xFFFFFF;
}
