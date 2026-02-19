"use client";

import React, { useEffect } from 'react';
import * as THREE from 'three';
import { useThree, useFrame } from '@react-three/fiber';
import { AxisLabels } from '@/components/scene/AxisLabels';

export function LoggingHelper({ mode }: { mode?: string }) {
  React.useEffect(() => {
    console.log('[SceneCanvas] Mode in Canvas:', mode);
  }, [mode]);
  return null;
}

export function EnableLocalClipping() {
  const { gl } = useThree();
  useEffect(() => {
    gl.localClippingEnabled = true;
  }, [gl]);
  return null;
}

export function CameraProvider({ cameraRef }: { cameraRef: React.MutableRefObject<THREE.Camera | null> }) {
  const { camera } = useThree();
  React.useEffect(() => {
    cameraRef.current = camera;
  }, [camera, cameraRef]);
  return null;
}

export function CameraClipPlaneStabilizer() {
  const { camera, controls } = useThree();

  useFrame(() => {
    const perspective = camera as THREE.PerspectiveCamera;
    if ((perspective as any).isPerspectiveCamera !== true) return;

    const orbitTarget = (controls as any)?.target as THREE.Vector3 | undefined;
    if (!orbitTarget) return;

    const dist = perspective.position.distanceTo(orbitTarget);
    if (!Number.isFinite(dist) || dist <= 0) return;

    // Depth precision fix:
    // A too-small near plane combined with a too-large far plane causes depth-buffer precision
    // issues that can make the model fail to occlude small geometry when zoomed in.
    // Keep near reasonably small but not extreme, and keep far tight.
    const desiredNear = Math.max(0.02, Math.min(0.5, dist / 200));
    const desiredFar = Math.min(5000, Math.max(200, dist * 50));

    if (Math.abs(perspective.near - desiredNear) > 1e-6 || Math.abs(perspective.far - desiredFar) > 1e-3) {
      perspective.near = desiredNear;
      perspective.far = desiredFar;
      perspective.updateProjectionMatrix();
    }
  });

  return null;
}

function CameraHeadlight({ intensity }: { intensity: number }) {
  const { camera } = useThree();
  const lightRef = React.useRef<THREE.PointLight | null>(null);

  useFrame(() => {
    if (!lightRef.current) return;
    lightRef.current.position.copy(camera.position);
  });

  return (
    <pointLight
      ref={lightRef}
      intensity={intensity}
      decay={0}
      distance={0}
      color="#ffffff"
    />
  );
}

export function Lights({
  ambientIntensity,
  directionalIntensity,
  headlightIntensity,
}: {
  ambientIntensity: number;
  directionalIntensity: number;
  headlightIntensity: number;
}) {
  const clampedHeadlightIntensity = Math.max(0, headlightIntensity);

  return (
    <>
      <ambientLight intensity={ambientIntensity} />
      <directionalLight position={[0, 0, 12]} intensity={directionalIntensity} color="#ffd8ef" />
      <directionalLight position={[0, 0, -12]} intensity={directionalIntensity * 0.15} color="#90a7ff" />
      <hemisphereLight args={['#f6e8ff', '#3e415c', ambientIntensity * 0.6]} />
      <CameraHeadlight intensity={clampedHeadlightIntensity} />
    </>
  );
}

export function SceneMoodOverlay() {
  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background: 'radial-gradient(120% 95% at 50% 46%, rgba(0,0,0,0) 56%, rgba(255, 55, 170, 0.18) 100%)',
          mixBlendMode: 'screen',
          opacity: 0.75,
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background: 'linear-gradient(180deg, rgba(255, 55, 170, 0.08) 0%, rgba(111, 51, 255, 0.05) 40%, rgba(0,0,0,0) 100%)',
          mixBlendMode: 'screen',
          opacity: 0.8,
        }}
      />
    </>
  );
}

export function Helpers({
  gridWidthMm,
  gridDepthMm,
}: {
  gridWidthMm?: number;
  gridDepthMm?: number;
}) {
  const nullRaycast = () => null;
  const axesRef = React.useRef<THREE.AxesHelper | null>(null);

  const width = Number.isFinite(gridWidthMm) && (gridWidthMm as number) > 0 ? (gridWidthMm as number) : 200;
  const depth = Number.isFinite(gridDepthMm) && (gridDepthMm as number) > 0 ? (gridDepthMm as number) : 200;
  const baseSize = Math.max(width, depth);
  const divisions = Math.max(20, Math.min(240, Math.round(baseSize / 5)));
  const scaleX = width / baseSize;
  const scaleZ = depth / baseSize;
  const frontMarkerWidth = 24;
  const frontMarkerDepth = 6.8;
  const frontYOffset = depth * 0.5 + frontMarkerDepth * 0.46;

  const frontTexture = React.useMemo(() => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return null;

    canvas.width = 256;
    canvas.height = 72;

    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = 'rgba(92,92,92,0.62)';
    context.beginPath();
    context.moveTo(20, 12);
    context.lineTo(236, 12);
    context.lineTo(216, 60);
    context.lineTo(40, 60);
    context.closePath();
    context.fill();

    context.strokeStyle = 'rgba(158,158,158,0.9)';
    context.lineWidth = 3;
    context.stroke();

    context.fillStyle = 'rgba(220,220,220,0.95)';
    context.font = 'bold 34px Arial';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('FRONT', canvas.width / 2, canvas.height / 2 + 1);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }, []);

  React.useEffect(() => {
    return () => {
      frontTexture?.dispose();
    };
  }, [frontTexture]);

  React.useEffect(() => {
    if (!axesRef.current) return;

    axesRef.current.renderOrder = 3;
    axesRef.current.traverse((obj) => {
      const material = (obj as THREE.LineSegments).material;
      if (!material) return;

      if (Array.isArray(material)) {
        material.forEach((m) => {
          m.depthTest = true;
          m.depthWrite = false;
        });
        return;
      }

      material.depthTest = true;
      material.depthWrite = false;
    });
  }, []);

  return (
    <>
      {/* Grid on XY plane (horizontal) - rotate 90° around X */}
      <gridHelper
        args={[baseSize, divisions, '#333333', '#333333']}
        position={[0, 0, -0.01]}
        rotation={[Math.PI / 2, 0, 0]}
        scale={[scaleX, 1, scaleZ]}
        raycast={nullRaycast}
      />
      {/* Axes: X=red, Y=green, Z=blue(up) */}
      <axesHelper
        ref={axesRef}
        args={[100]}
        position={[0, 0, 0.01]}
        raycast={nullRaycast}
      />
      <AxisLabels size={100} />

      {/* FRONT orientation marker locked to build plate front edge */}
      <group position={[0, -frontYOffset, 0.001]}>
        {frontTexture && (
          <mesh raycast={nullRaycast}>
            <planeGeometry args={[frontMarkerWidth, frontMarkerDepth]} />
            <meshBasicMaterial
              map={frontTexture}
              transparent
              opacity={0.92}
              depthWrite={false}
              polygonOffset
              polygonOffsetFactor={-1}
              polygonOffsetUnits={-1}
              side={THREE.FrontSide}
              toneMapped={false}
            />
          </mesh>
        )}
      </group>
    </>
  );
}
