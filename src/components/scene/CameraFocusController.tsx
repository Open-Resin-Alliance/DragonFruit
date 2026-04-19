import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { IslandMarker } from '@/volumeAnalysis/IslandScan/islandOverlayLogic';

type CameraFocusControllerProps = {
  selectedIslandId: number | null;
  islandMarkers: IslandMarker[];
};

/**
 * Animates camera to focus on selected island.
 * Smoothly transitions camera position and target to center the island in view.
 */
export function CameraFocusController({ selectedIslandId, islandMarkers }: CameraFocusControllerProps) {
  const { camera, controls, invalidate } = useThree();
  const animatingRef = useRef(false);

  useEffect(() => {
    if (!selectedIslandId || !islandMarkers.length || !controls) return;

    // Find the selected island marker
    const marker = islandMarkers.find(m => m.id === selectedIslandId);
    if (!marker) return;

    // Get OrbitControls instance
    const orbitControls = controls as unknown as OrbitControlsImpl;
    if (!orbitControls.target) return;

    // Calculate island center position
    const islandCenter = new THREE.Vector3(marker.centerX, marker.centerY, marker.baseZ);
    
    // Calculate optimal camera distance based on island size
    const pixelSize = 0.1; // Approximate pixel size in mm
    const estimatedRadius = Math.sqrt(marker.pixelCount) * pixelSize;
    const optimalDistance = Math.max(estimatedRadius * 4, 20); // At least 20mm away

    // Try multiple viewing angles to find the best one
    const candidateDirections: THREE.Vector3[] = [];
    
    // Calculate viewing direction based on island geometry
    if (marker.geometry && marker.geometry.attributes.normal) {
      // Calculate average normal from island geometry
      const normals = marker.geometry.attributes.normal;
      const avgNormal = new THREE.Vector3(0, 0, 0);
      let count = 0;
      
      for (let i = 0; i < normals.count; i++) {
        avgNormal.x += normals.getX(i);
        avgNormal.y += normals.getY(i);
        avgNormal.z += normals.getZ(i);
        count++;
      }
      
      if (count > 0) {
        avgNormal.divideScalar(count);
        avgNormal.normalize();
        
        // Islands are on the bottom of overhangs, so the normal points downward
        // We want to look UP at the island, so we use the normal directly (not negated)
        let viewDirection = avgNormal.clone();
        
        // Ensure we're looking upward - if normal is pointing up, flip it
        if (viewDirection.z > 0) {
          viewDirection.negate();
        }
        
        candidateDirections.push(viewDirection.clone());
        
        // Add angled variations for better visibility
        const angle1 = viewDirection.clone();
        angle1.z = Math.max(angle1.z, -0.7); // Less steep
        angle1.normalize();
        candidateDirections.push(angle1);
        
        const angle2 = viewDirection.clone();
        angle2.z = -0.5; // Even less steep
        angle2.normalize();
        candidateDirections.push(angle2);
      }
    }
    
    // Fallback directions: look up from below at various angles
    candidateDirections.push(new THREE.Vector3(0, 0, -1)); // Straight up
    candidateDirections.push(new THREE.Vector3(0.5, 0, -0.866).normalize()); // 30° angle
    candidateDirections.push(new THREE.Vector3(0, 0.5, -0.866).normalize()); // 30° angle, different axis
    candidateDirections.push(new THREE.Vector3(-0.5, 0, -0.866).normalize());
    candidateDirections.push(new THREE.Vector3(0, -0.5, -0.866).normalize());
    
    // Test each candidate position to see if island would be in view
    let targetCameraPos: THREE.Vector3 | null = null;
    let bestScore = -Infinity;
    
    console.log('[CameraFocus] Testing', candidateDirections.length, 'candidate directions for island', marker.id);
    console.log('[CameraFocus] Island center:', islandCenter);
    
    for (let i = 0; i < candidateDirections.length; i++) {
      const direction = candidateDirections[i];
      const testPos = new THREE.Vector3(
        islandCenter.x + direction.x * optimalDistance,
        islandCenter.y + direction.y * optimalDistance,
        islandCenter.z + direction.z * optimalDistance
      );
      
      // Calculate score for this position
      let score = 0;
      
      // Prefer positions below the island (looking up)
      if (testPos.z < islandCenter.z) {
        score += 100;
      }
      
      // Prefer positions that aren't too steep
      const viewVector = new THREE.Vector3().subVectors(islandCenter, testPos).normalize();
      const steepness = Math.abs(viewVector.z);
      score += (1 - steepness) * 50; // Prefer less steep angles
      
      // Check if looking at the island from this position
      const distanceToIsland = testPos.distanceTo(islandCenter);
      if (distanceToIsland > optimalDistance * 0.5 && distanceToIsland < optimalDistance * 2) {
        score += 50; // Good distance
      }
      
      console.log(`[CameraFocus] Candidate ${i}: pos=${testPos.toArray().map(v => v.toFixed(1))}, dir=${direction.toArray().map(v => v.toFixed(2))}, score=${score.toFixed(1)}`);
      
      if (score > bestScore) {
        bestScore = score;
        targetCameraPos = testPos;
      }
    }
    
    console.log('[CameraFocus] Best score:', bestScore, 'Position:', targetCameraPos?.toArray().map(v => v.toFixed(1)));
    
    // Final fallback: position below and to the side
    if (!targetCameraPos) {
      targetCameraPos = new THREE.Vector3(
        islandCenter.x + optimalDistance * 0.5,
        islandCenter.y + optimalDistance * 0.5,
        islandCenter.z - optimalDistance * 0.7
      );
      console.log('[CameraFocus] Using fallback position:', targetCameraPos.toArray().map(v => v.toFixed(1)));
    }

    // Animate camera and controls
    animatingRef.current = true;
    
    const startCameraPos = camera.position.clone();
    const startTarget = orbitControls.target.clone();
    const duration = 800; // ms
    const startTime = performance.now();

    const animate = () => {
      if (!animatingRef.current) return;

      const elapsed = performance.now() - startTime;
      const t = Math.min(elapsed / duration, 1);
      
      // Ease-in-out function for smooth animation
      const eased = t < 0.5 
        ? 2 * t * t 
        : -1 + (4 - 2 * t) * t;

      // Interpolate camera position
      camera.position.lerpVectors(startCameraPos, targetCameraPos, eased);
      
      // Interpolate controls target
      orbitControls.target.lerpVectors(startTarget, islandCenter, eased);
      orbitControls.update();
      // Demand-mode safety: rAF-driven animation mutates refs, needs explicit invalidate.
      invalidate();

      if (t < 1) {
        requestAnimationFrame(animate);
      } else {
        animatingRef.current = false;
      }
    };

    animate();

    return () => {
      animatingRef.current = false;
    };
  }, [selectedIslandId, islandMarkers, camera, controls]);

  return null;
}
