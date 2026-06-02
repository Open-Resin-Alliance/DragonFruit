import React, { useMemo, useRef, useEffect } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { useSupportPainterState, supportPainterStore } from '../supportPainterStore';

export function FailureDiagnosticsOverlay() {
  const { failedCandidates, activeFailureIndex, selectedRegionId } = useSupportPainterState();

  // Filter failures by the currently selected region if there is one
  const visibleFailures = useMemo(() => {
    if (selectedRegionId) {
      return failedCandidates.filter(c => c.regionId === selectedRegionId);
    }
    return failedCandidates;
  }, [failedCandidates, selectedRegionId]);

  const activeFailure = useMemo(() => {
    if (activeFailureIndex === null || failedCandidates.length === 0) return null;
    
    // Find active candidate in the global list
    const candidate = failedCandidates[activeFailureIndex];
    if (!candidate) return null;
    
    // Only return if it matches selection filter
    if (selectedRegionId && candidate.regionId !== selectedRegionId) return null;
    
    return candidate;
  }, [failedCandidates, activeFailureIndex, selectedRegionId]);

  if (visibleFailures.length === 0) {
    return null;
  }

  return (
    <group renderOrder={9998}>
      {/* 1. All failure candidate dot markers */}
      {visibleFailures.map((c) => {
        const isActive = activeFailure && activeFailure.id === c.id;
        if (isActive) return null; // Render active separately below

        return (
          <mesh
            key={c.id}
            position={[c.pos.x, c.pos.y, c.pos.z]}
            onClick={(e) => {
              e.stopPropagation();
              const idx = failedCandidates.findIndex(fc => fc.id === c.id);
              if (idx !== -1) {
                supportPainterStore.setActiveFailureIndex(idx);
              }
            }}
          >
            <sphereGeometry args={[0.6, 8, 8]} />
            <meshBasicMaterial
              color="#ff3333"
              transparent
              opacity={0.6}
              depthTest={false}
              depthWrite={false}
            />
          </mesh>
        );
      })}

      {/* 2. Active failure crosshair and pulsing target ring */}
      {activeFailure && (
        <>
          <ActiveFailureCrosshair pos={activeFailure.pos} />
          <PulsingTargetRing pos={activeFailure.pos} normal={activeFailure.normal} />
          <FailureCameraFocusController
            pos={activeFailure.pos}
            normal={activeFailure.normal}
          />
        </>
      )}
    </group>
  );
}

function ActiveFailureCrosshair({ pos }: { pos: { x: number; y: number; z: number } }) {
  const crosshairPoints = useMemo(() => {
    const size = 2.5; // 2.5mm length crosshair lines
    return [
      new THREE.Vector3(-size, 0, 0), new THREE.Vector3(size, 0, 0),
      new THREE.Vector3(0, -size, 0), new THREE.Vector3(0, size, 0),
      new THREE.Vector3(0, 0, -size), new THREE.Vector3(0, 0, size),
    ];
  }, []);

  const positionsFloatArray = useMemo(() => {
    return new Float32Array(crosshairPoints.flatMap(p => [p.x, p.y, p.z]));
  }, [crosshairPoints]);

  return (
    <lineSegments position={[pos.x, pos.y, pos.z]}>
      <bufferGeometry attach="geometry">
        <bufferAttribute
          attach="attributes-position"
          args={[positionsFloatArray, 3]}
        />
      </bufferGeometry>
      <lineBasicMaterial
        attach="material"
        color="#ff1111"
        linewidth={2}
        depthTest={false}
        depthWrite={false}
        transparent
        opacity={0.9}
      />
    </lineSegments>
  );
}

function PulsingTargetRing({
  pos,
  normal,
}: {
  pos: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
}) {
  const meshRef = useRef<THREE.Mesh>(null);

  const quaternion = useMemo(() => {
    const norm = new THREE.Vector3(normal.x, normal.y, normal.z).normalize();
    return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), norm);
  }, [normal]);

  useFrame(({ clock }) => {
    if (!meshRef.current) return;
    const elapsed = clock.getElapsedTime();

    // Pulse cycles every 1.2 seconds: scale from 0.15 to 2.5, fade out opacity
    const cycle = (elapsed % 1.2) / 1.2;

    const scale = 0.15 + cycle * 2.35;
    const opacity = 1.0 - cycle;

    meshRef.current.scale.set(scale, scale, 1.0);
    const mat = meshRef.current.material as THREE.MeshBasicMaterial;
    if (mat) {
      mat.opacity = opacity;
    }
  });

  return (
    <mesh
      ref={meshRef}
      position={[pos.x, pos.y, pos.z]}
      quaternion={quaternion}
    >
      <ringGeometry args={[1.5, 2.0, 32]} />
      <meshBasicMaterial
        color="#ff1111"
        transparent
        depthTest={false}
        depthWrite={false}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

function FailureCameraFocusController({
  pos,
  normal,
}: {
  pos: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
}) {
  const { camera, controls } = useThree();

  const animationRef = useRef<{
    startTime: number;
    startPos: THREE.Vector3;
    endPos: THREE.Vector3;
    startTarget: THREE.Vector3;
    endTarget: THREE.Vector3;
  } | null>(null);

  // Trigger animation on coordinate changes
  useEffect(() => {
    const targetPos = new THREE.Vector3(pos.x, pos.y, pos.z);
    const currentTarget = (controls as any)?.target instanceof THREE.Vector3
      ? ((controls as any).target as THREE.Vector3).clone()
      : new THREE.Vector3(0, 0, 0);

    // Calculate view direction offset from current controls target
    let camDir = new THREE.Vector3().subVectors(camera.position, currentTarget).normalize();
    if (camDir.lengthSq() < 1e-4) {
      camDir.set(0, -0.5, 1).normalize();
    }

    // Zoom distance: 45mm from failure coordinate
    const zoomDistance = 45.0;
    const endPos = targetPos.clone().addScaledVector(camDir, zoomDistance);

    animationRef.current = {
      startTime: performance.now(),
      startPos: camera.position.clone(),
      endPos,
      startTarget: currentTarget,
      endTarget: targetPos,
    };
  }, [pos.x, pos.y, pos.z, camera, controls]);

  useFrame(() => {
    if (!animationRef.current) return;
    const anim = animationRef.current;
    const now = performance.now();
    const duration = 500.0; // 500ms transition
    const t = Math.min(1.0, (now - anim.startTime) / duration);
    const eased = THREE.MathUtils.smootherstep(t, 0.0, 1.0);

    camera.position.lerpVectors(anim.startPos, anim.endPos, eased);
    if (controls && typeof controls === 'object' && 'target' in controls) {
      (controls as any).target.lerpVectors(anim.startTarget, anim.endTarget, eased);
      (controls as any).update?.();
    }

    if (t >= 1.0) {
      animationRef.current = null;
    }
  });

  return null;
}
