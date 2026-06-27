import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { IslandMarker } from '@/volumeAnalysis/IslandScan/islandOverlayLogic';
import { animateFocusToIsland, animateRestoreCamera } from '@/volumeAnalysis/Islands/cameraFocusHelper';

type CameraFocusControllerProps = {
  selectedIslandId: number | null;
  islandMarkers: IslandMarker[];
  onClearSelection?: () => void;
};

/**
 * Animates camera to focus on selected island.
 * Smoothly transitions camera position and target to center the island in view.
 */
export function CameraFocusController({ selectedIslandId, islandMarkers, onClearSelection }: CameraFocusControllerProps) {
  const { camera, controls, scene } = useThree();
  const animatingRef = useRef(false);

  const lastSelectedIslandIdRef = useRef<number | null>(null);
  const lastCameraRef = useRef<THREE.Camera | null>(null);
  const islandMarkersRef = useRef(islandMarkers);
  islandMarkersRef.current = islandMarkers;

  const preFocusPositionRef = useRef<THREE.Vector3 | null>(null);
  const preFocusTargetRef = useRef<THREE.Vector3 | null>(null);
  const preFocusZoomRef = useRef<number | null>(null);
  const wasClearedByManualInteractionRef = useRef(false);

  const hasMarkers = islandMarkers.length > 0;

  useEffect(() => {
    const cameraChanged = lastCameraRef.current !== camera;
    if (lastSelectedIslandIdRef.current === selectedIslandId && !cameraChanged) return;

    if (!selectedIslandId) {
      if (lastSelectedIslandIdRef.current !== null) {
        animateRestoreCamera({
          camera,
          controls,
          animatingRef,
          preFocusPositionRef,
          preFocusTargetRef,
          preFocusZoomRef,
          wasManual: wasClearedByManualInteractionRef.current,
        });
        wasClearedByManualInteractionRef.current = false;
      }
      lastSelectedIslandIdRef.current = null;
      lastCameraRef.current = camera;
      return;
    }

    if (!hasMarkers || !controls) return;

    lastSelectedIslandIdRef.current = selectedIslandId;
    lastCameraRef.current = camera;

    animateFocusToIsland({
      selectedIslandId,
      islandMarkers: islandMarkersRef.current,
      camera,
      controls,
      scene,
      animatingRef,
      preFocusPositionRef,
      preFocusTargetRef,
      preFocusZoomRef,
    });
  }, [selectedIslandId, hasMarkers, camera, controls, scene]);

  useEffect(() => {
    if (!controls) return;
    const orbitControls = controls as unknown as OrbitControlsImpl;
    const handleChange = () => {
      if (!animatingRef.current && selectedIslandId !== null) {
        wasClearedByManualInteractionRef.current = true;
        onClearSelection?.();
      }
    };
    orbitControls.addEventListener('change', handleChange);
    return () => {
      orbitControls.removeEventListener('change', handleChange);
    };
  }, [controls, selectedIslandId, onClearSelection]);

  return null;
}
