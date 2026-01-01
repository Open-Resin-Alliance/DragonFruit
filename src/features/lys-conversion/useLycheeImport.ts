/**
 * Lychee Import Manager
 * 
 * Handles the two-step import flow:
 * 1. Load JSON (Lychee scene data) → extract object transforms
 * 2. Prompt for STL → apply transforms from JSON → create supports
 * 
 * This keeps all Lychee-specific logic compartmentalized.
 */

import { useState, useCallback, useRef } from 'react';
import * as THREE from 'three';
import { LysConverter } from './LysConverter';
import { loadFromLychee } from '@/supports/state';
import { loadStlGeometry, type GeometryWithBounds } from '@/hooks/useStlGeometry';
import { getSettings } from '@/supports/Settings';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LycheeVector { x: number; y: number; z: number }

interface LycheeObjectTransform {
  center: LycheeVector;
  position: LycheeVector;
  scale: LycheeVector;
  rotation?: LycheeVector;
}

interface PendingImport {
  json: any;
  objectTransform: LycheeObjectTransform;
}

export interface LycheeImportResult {
  modelId: string;
  geometry: GeometryWithBounds;
  transform: {
    position: THREE.Vector3;
    rotation: THREE.Euler;
    scale: THREE.Vector3;
  };
  supportCount: number;
}

export type ImportPhase = 'idle' | 'awaiting_stl' | 'processing';

// ---------------------------------------------------------------------------
// Transform Extraction
// ---------------------------------------------------------------------------

function extractObjectTransform(json: any): LycheeObjectTransform | null {
  const objects = json?.objects?.present?.byId;
  if (!objects) return null;

  // Find target object (o15 or first with supports)
  let targetObj = objects['o15'];
  if (!targetObj) {
    for (const key in objects) {
      if (objects[key].supportsBase?.length > 0) {
        targetObj = objects[key];
        break;
      }
    }
  }

  if (!targetObj) return null;

  console.log('[LycheeImport] Found target object:', {
    id: targetObj.id,
    center: targetObj.center,
    position: targetObj.position,
    scale: targetObj.scale
  });

  return {
    center: targetObj.center || { x: 0, y: 0, z: 0 },
    position: targetObj.position || { x: 0, y: 0, z: 0 },
    scale: targetObj.scale || { x: 1, y: 1, z: 1 },
    rotation: targetObj.rotation
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useLycheeImport() {
  const [phase, setPhase] = useState<ImportPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const pendingImportRef = useRef<PendingImport | null>(null);
  const stlInputRef = useRef<HTMLInputElement | null>(null);

  /**
   * Step 1: Process the Lychee JSON file
   * Extracts transform data and moves to awaiting_stl phase
   */
  const processJsonFile = useCallback(async (file: File): Promise<boolean> => {
    try {
      setError(null);
      const text = await file.text();
      const json = JSON.parse(text);

      const transform = extractObjectTransform(json);
      if (!transform) {
        setError('No valid object found in Lychee file');
        return false;
      }

      // Store for later
      pendingImportRef.current = { json, objectTransform: transform };
      setPhase('awaiting_stl');

      console.log('[LycheeImport] JSON processed. Transform:', transform);
      console.log('[LycheeImport] Awaiting STL file...');

      return true;
    } catch (err) {
      console.error('[LycheeImport] Failed to parse JSON:', err);
      setError('Failed to parse Lychee JSON file');
      return false;
    }
  }, []);

  /**
   * Step 2: Process the STL file
   * Applies transforms from JSON and creates supports
   */
  const processStlFile = useCallback(async (
    file: File,
    onModelLoaded: (result: LycheeImportResult) => void
  ): Promise<boolean> => {
    const pending = pendingImportRef.current;
    if (!pending) {
      setError('No pending import. Load JSON first.');
      return false;
    }

    try {
      setPhase('processing');
      setError(null);

      // Load STL geometry
      const url = URL.createObjectURL(file);
      const geometry = await loadStlGeometry(url);

      // Calculate transform from Lychee data
      const { center, position, scale } = pending.objectTransform;

      // Lychee stores:
      // - center: object's geometric center in local space
      // - position: world translation (includes lift)
      // - scale: uniform or non-uniform scale

      // For the model transform, we need to:
      // 1. Apply scale
      // 2. Position such that the model's center aligns with Lychee's expectations

      // The Z position in Lychee includes lift from the build plate
      // position.z is the lift amount (e.g. 5mm)
      
      // Our loaded geometry is normalized:
      // - X/Y: Centered (0,0 is Geometric Center)
      // - Z: Bottom-aligned (0 is Bottom)
      
      // Lychee Transform: World = (Local + Center) * Scale + Position
      // This implies the Geometric Center in World Space is:
      // CenterWorld = Center * Scale + Position
      
      // We apply the full transform offset to align our normalized geometry.
      // Final = Position + Center * Scale
      
      const finalPosition = new THREE.Vector3(
        position.x + center.x * scale.x,
        position.y + center.y * scale.y,
        position.z + center.z * scale.z
      );

      const finalScale = new THREE.Vector3(scale.x, scale.y, scale.z);
      const finalRotation = new THREE.Euler(0, 0, 0);

      // Create a temporary mesh for raycasting (Surface Alignment)
      // CRITICAL: Must replicate the exact transform structure used by StlMesh:
      //   - Group: position=finalPosition, rotation=finalRotation, scale=finalScale
      //   - Mesh (child): position=-geometry.center (offset to center the geometry)
      // We use a Group+Mesh hierarchy to match exactly.
      
      const ghostGroup = new THREE.Group();
      ghostGroup.position.copy(finalPosition);
      ghostGroup.scale.copy(finalScale);
      ghostGroup.rotation.copy(finalRotation);
      
      const mesh = new THREE.Mesh(
        geometry.geometry, 
        new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
      );
      
      // Apply the center offset (same as StlMesh does)
      const centerOffset = geometry.center;
      mesh.position.set(-centerOffset.x, -centerOffset.y, -centerOffset.z);
      
      ghostGroup.add(mesh);
      ghostGroup.updateMatrixWorld(true);
      
      // CRITICAL: Update bounding sphere for Raycaster optimization
      mesh.geometry.computeBoundingSphere();

      // Convert supports
      console.log('[LycheeImport] Converting supports...');
      
      // Fetch current global settings to use for conversion
      const currentSettings = getSettings();
      const converted = LysConverter.convert(pending.json, currentSettings, mesh);
      
      loadFromLychee(converted);

      const result: LycheeImportResult = {
        modelId: crypto.randomUUID(),
        geometry,
        transform: {
          position: finalPosition,
          rotation: finalRotation,
          scale: finalScale
        },
        supportCount: converted.trunks.length
      };

      console.log('[LycheeImport] Import complete:', {
        position: finalPosition.toArray(),
        scale: finalScale.toArray(),
        supports: converted.trunks.length
      });

      // Cleanup
      pendingImportRef.current = null;
      setPhase('idle');

      onModelLoaded(result);
      return true;

    } catch (err) {
      console.error('[LycheeImport] Failed to process STL:', err);
      setError('Failed to load STL file');
      setPhase('awaiting_stl'); // Stay in awaiting state so user can retry
      return false;
    }
  }, []);

  /**
   * Cancel the pending import
   */
  const cancelImport = useCallback(() => {
    pendingImportRef.current = null;
    setPhase('idle');
    setError(null);
  }, []);

  /**
   * Get the pending transform info (for UI display)
   */
  const getPendingTransform = useCallback((): LycheeObjectTransform | null => {
    return pendingImportRef.current?.objectTransform || null;
  }, []);

  return {
    phase,
    error,
    processJsonFile,
    processStlFile,
    cancelImport,
    getPendingTransform,
    stlInputRef
  };
}
