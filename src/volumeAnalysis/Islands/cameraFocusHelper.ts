import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { IslandMarker } from '@/volumeAnalysis/IslandScan/islandOverlayLogic';

export interface AnimateFocusOptions {
  selectedIslandId: number;
  islandMarkers: IslandMarker[];
  camera: THREE.Camera;
  controls: any;
  scene: THREE.Scene;
  animatingRef: React.MutableRefObject<boolean>;
  preFocusPositionRef: React.MutableRefObject<THREE.Vector3 | null>;
  preFocusTargetRef: React.MutableRefObject<THREE.Vector3 | null>;
  preFocusZoomRef: React.MutableRefObject<number | null>;
}

export interface AnimateRestoreOptions {
  camera: THREE.Camera;
  controls: any;
  animatingRef: React.MutableRefObject<boolean>;
  preFocusPositionRef: React.MutableRefObject<THREE.Vector3 | null>;
  preFocusTargetRef: React.MutableRefObject<THREE.Vector3 | null>;
  preFocusZoomRef: React.MutableRefObject<number | null>;
  wasManual: boolean;
}

/**
 * Animates the camera zoom and position back to their pre-focus values.
 */
export function animateRestoreCamera({
  camera,
  controls,
  animatingRef,
  preFocusPositionRef,
  preFocusTargetRef,
  preFocusZoomRef,
  wasManual,
}: AnimateRestoreOptions) {
  if (wasManual || !preFocusPositionRef.current || !preFocusTargetRef.current || !controls) {
    // Clear cached refs and do not animate back if selection was cleared manually
    preFocusPositionRef.current = null;
    preFocusTargetRef.current = null;
    preFocusZoomRef.current = null;
    return;
  }

  animatingRef.current = true;
  const orbitControls = controls as unknown as OrbitControlsImpl;

  const startPos = camera.position.clone();
  const startTarget = orbitControls.target.clone();
  const isOrthographic = camera instanceof THREE.OrthographicCamera;
  const startZoom = isOrthographic ? (camera as THREE.OrthographicCamera).zoom : 1;

  const endPos = preFocusPositionRef.current.clone();
  const endTarget = preFocusTargetRef.current.clone();
  const endZoom = isOrthographic ? (preFocusZoomRef.current ?? 1) : 1;

  const duration = 800; // ms
  const startTime = performance.now();

  // Calculate spherical coordinates relative to endTarget for startPos
  const startRel = new THREE.Vector3().subVectors(startPos, endTarget);
  const rStart = startRel.length();
  const phiStart = Math.acos(Math.max(-1, Math.min(1, startRel.z / (rStart || 1))));
  const thetaStart = Math.atan2(startRel.y, startRel.x);

  // Calculate spherical coordinates relative to endTarget for endPos
  const endRel = new THREE.Vector3().subVectors(endPos, endTarget);
  const rEnd = endRel.length();
  const phiEnd = Math.acos(Math.max(-1, Math.min(1, endRel.z / (rEnd || 1))));
  const thetaEnd = Math.atan2(endRel.y, endRel.x);

  let thetaDiff = thetaEnd - thetaStart;
  thetaDiff = Math.atan2(Math.sin(thetaDiff), Math.cos(thetaDiff));

  const animate = () => {
    if (!animatingRef.current) return;

    const elapsed = performance.now() - startTime;
    const t = Math.min(elapsed / duration, 1);
    
    // Ease-in-out function
    const eased = t < 0.5 
      ? 2 * t * t 
      : -1 + (4 - 2 * t) * t;

    const r = THREE.MathUtils.lerp(rStart, rEnd, eased);
    const phi = THREE.MathUtils.lerp(phiStart, phiEnd, eased);
    const theta = thetaStart + thetaDiff * eased;

    const x = endTarget.x + r * Math.sin(phi) * Math.cos(theta);
    const y = endTarget.y + r * Math.sin(phi) * Math.sin(theta);
    const z = endTarget.z + r * Math.cos(phi);

    camera.position.set(x, y, z);

    if (isOrthographic) {
      const ortho = camera as THREE.OrthographicCamera;
      ortho.zoom = THREE.MathUtils.lerp(startZoom, endZoom, eased);
      ortho.updateProjectionMatrix();
    }

    orbitControls.target.lerpVectors(startTarget, endTarget, eased);
    orbitControls.update();

    if (t < 1) {
      requestAnimationFrame(animate);
    } else {
      animatingRef.current = false;
      preFocusPositionRef.current = null;
      preFocusTargetRef.current = null;
      preFocusZoomRef.current = null;
    }
  };

  animate();
}

/**
 * Animates the camera to target and zoom in on the selected island.
 */
export function animateFocusToIsland({
  selectedIslandId,
  islandMarkers,
  camera,
  controls,
  scene,
  animatingRef,
  preFocusPositionRef,
  preFocusTargetRef,
  preFocusZoomRef,
}: AnimateFocusOptions) {
  const orbitControls = controls as unknown as OrbitControlsImpl;
  if (!orbitControls.target) return;

  // Cache the pre-focus camera state when we first select an island
  if (preFocusPositionRef.current === null) {
    preFocusPositionRef.current = camera.position.clone();
    preFocusTargetRef.current = orbitControls.target.clone();
    if (camera instanceof THREE.OrthographicCamera) {
      preFocusZoomRef.current = camera.zoom;
    }
  }

  // Find the selected island marker
  const marker = islandMarkers.find(m => m.id === selectedIslandId);
  if (!marker) return;

  // Calculate island center position
  const islandCenter = new THREE.Vector3(marker.centerX, marker.centerY, marker.baseZ);
  
  // Find target model mesh dynamically and compute world-space bounding box
  const modelBox = new THREE.Box3();
  let hasModelMesh = false;
  scene.traverse((obj) => {
    if (obj instanceof THREE.Mesh && obj.userData?.thumbnailTintTarget === 'modelMesh') {
      if (obj.geometry) {
        if (!obj.geometry.boundingBox) {
          obj.geometry.computeBoundingBox();
        }
        const meshBox = obj.geometry.boundingBox!.clone().applyMatrix4(obj.matrixWorld);
        if (!hasModelMesh) {
          modelBox.copy(meshBox);
          hasModelMesh = true;
        } else {
          modelBox.union(meshBox);
        }
      }
    }
  });

  const modelSize = new THREE.Vector3();
  modelBox.getSize(modelSize);
  const maxDim = hasModelMesh ? Math.max(modelSize.x, modelSize.y, modelSize.z) : 100;

  // Calculate optimal camera distance based on island size and overall model bounding box max dimension
  const pixelSize = 0.1; // Approximate pixel size in mm
  const estimatedRadius = Math.sqrt(marker.pixelCount) * pixelSize;
  const optimalDistance = Math.max(estimatedRadius * 4, maxDim * 0.15, 20);

  // Convert starting position to spherical coordinates relative to islandCenter
  const startRel = new THREE.Vector3().subVectors(camera.position, islandCenter);
  const rStart = startRel.length();
  const phiStart = Math.acos(Math.max(-1, Math.min(1, startRel.z / (rStart || 1))));
  const thetaStart = Math.atan2(startRel.y, startRel.x);

  const isOrthographic = camera instanceof THREE.OrthographicCamera;
  const testDistance = isOrthographic ? Math.max(rStart, 100) : optimalDistance;

  // Try multiple viewing angles to find the best one
  const candidateDirections: THREE.Vector3[] = [];
  
  // Generate candidate directions in a full 360-degree sphere sampling ring-by-ring
  const elevations = [-0.8, -0.4, 0.0, 0.4, 0.8];
  const azimuthAngles = [0, 45, 90, 135, 180, 225, 270, 315];
  for (const zVal of elevations) {
    const rXY = Math.sqrt(Math.max(0, 1.0 - zVal * zVal));
    for (const deg of azimuthAngles) {
      const rad = (deg * Math.PI) / 180;
      candidateDirections.push(new THREE.Vector3(
        Math.cos(rad) * rXY,
        Math.sin(rad) * rXY,
        zVal
      ));
    }
  }
  
  candidateDirections.push(new THREE.Vector3(0, 0, -1)); // Straight up look
  candidateDirections.push(new THREE.Vector3(0, 0, 1));  // Straight down look
  
  // Test each candidate position to see if island would be in view
  let targetCameraPos: THREE.Vector3 | null = null;
  let bestScore = -Infinity;
  
  console.log('[CameraFocus] Testing', candidateDirections.length, 'candidate directions for island', marker.id);
  console.log('[CameraFocus] Island center:', islandCenter);
  
  const raycaster = new THREE.Raycaster();
  const rayDir = new THREE.Vector3();

  for (let i = 0; i < candidateDirections.length; i++) {
    const direction = candidateDirections[i];
    const testPos = new THREE.Vector3(
      islandCenter.x + direction.x * testDistance,
      islandCenter.y + direction.y * testDistance,
      islandCenter.z + direction.z * testDistance
    );
    
    // Calculate score for this position
    let score = 0;
    
    // Strongly prefer low camera angles looking up (worm's eye)
    if (testPos.z < islandCenter.z) {
      score += 500;
    }
    
    // Prefer side views over directly vertical top/bottom poles for better context
    const viewVector = new THREE.Vector3().subVectors(islandCenter, testPos).normalize();
    const steepness = Math.abs(viewVector.z);
    score += (1.0 - steepness) * 50;
    
    // Check if distance is appropriate
    const distanceToIsland = testPos.distanceTo(islandCenter);
    if (distanceToIsland > testDistance * 0.5 && distanceToIsland < testDistance * 2) {
      score += 20;
    }
    
    // Query model meshes dynamically for this run
    const modelMeshes: THREE.Mesh[] = [];
    scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh && obj.userData?.thumbnailTintTarget === 'modelMesh') {
        modelMeshes.push(obj);
      }
    });

    // Occlusion check: raycast along camera projection direction towards islandCenter
    if (modelMeshes.length > 0) {
      rayDir.subVectors(islandCenter, testPos).normalize();
      
      const rayStart = isOrthographic 
        ? testPos.clone().addScaledVector(rayDir, -1000) 
        : testPos;

      raycaster.set(rayStart, rayDir);
      const hits = raycaster.intersectObjects(modelMeshes, true);
      if (hits.length > 0) {
        const hitDist = hits[0].distance;
        const targetDist = rayStart.distanceTo(islandCenter);
        if (hitDist < targetDist - 0.5) {
          score -= 10000; // Penalize heavily if occluded by other parts of the model
        }
      }
    }
    
    if (score > bestScore) {
      bestScore = score;
      targetCameraPos = testPos;
    }
  }
  
  console.log('[CameraFocus] Best score:', bestScore, 'Position:', targetCameraPos?.toArray().map(v => v.toFixed(1)));
  
  // Final fallback: position below and to the side
  if (!targetCameraPos) {
    targetCameraPos = new THREE.Vector3(
      islandCenter.x + testDistance * 0.5,
      islandCenter.y + testDistance * 0.5,
      islandCenter.z - testDistance * 0.7
    );
    console.log('[CameraFocus] Using fallback position:', targetCameraPos.toArray().map(v => v.toFixed(1)));
  }

  // Convert target position to spherical coordinates relative to islandCenter
  const targetRel = new THREE.Vector3().subVectors(targetCameraPos, islandCenter);
  const rTarget = targetRel.length();
  const phiTarget = Math.acos(Math.max(-1, Math.min(1, targetRel.z / (rTarget || 1))));
  const thetaTarget = Math.atan2(targetRel.y, targetRel.x);

  // Compute shortest path for theta (azimuth) rotation
  let thetaDiff = thetaTarget - thetaStart;
  thetaDiff = Math.atan2(Math.sin(thetaDiff), Math.cos(thetaDiff));

  // Orthographic camera zoom tracking
  const startZoom = isOrthographic ? (camera as THREE.OrthographicCamera).zoom : 1;
  let targetZoom = startZoom;
  
  if (isOrthographic) {
    const ortho = camera as THREE.OrthographicCamera;
    const targetHalfHeight = optimalDistance * Math.tan(THREE.MathUtils.degToRad(50 * 0.5)); // 50 degrees fov equivalent
    targetZoom = THREE.MathUtils.clamp(ortho.top / Math.max(1e-6, targetHalfHeight), 0.0001, 200);
  }

  // Animate camera and controls
  animatingRef.current = true;
  
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

    // Spherical coordinate interpolation
    const r = THREE.MathUtils.lerp(rStart, rTarget, eased);
    const phi = THREE.MathUtils.lerp(phiStart, phiTarget, eased);
    const theta = thetaStart + thetaDiff * eased;

    // Convert back to Cartesian relative to islandCenter
    const x = islandCenter.x + r * Math.sin(phi) * Math.cos(theta);
    const y = islandCenter.y + r * Math.sin(phi) * Math.sin(theta);
    const z = islandCenter.z + r * Math.cos(phi);
    
    camera.position.set(x, y, z);

    // Interpolate zoom for Orthographic camera
    if (isOrthographic) {
      const ortho = camera as THREE.OrthographicCamera;
      ortho.zoom = THREE.MathUtils.lerp(startZoom, targetZoom, eased);
      ortho.updateProjectionMatrix();
    }
    
    // Interpolate controls target
    orbitControls.target.lerpVectors(startTarget, islandCenter, eased);
    orbitControls.update();

    if (t < 1) {
      requestAnimationFrame(animate);
    } else {
      animatingRef.current = false;
    }
  };

  animate();
}
