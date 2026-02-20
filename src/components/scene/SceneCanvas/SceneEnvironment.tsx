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
          background: 'radial-gradient(120% 95% at 50% 46%, rgba(0,0,0,0) 56%, color-mix(in srgb, var(--scene-gradient-radial, #ff37aa), transparent 82%) 100%)',
          mixBlendMode: 'screen',
          opacity: 0.75,
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background: 'linear-gradient(180deg, color-mix(in srgb, var(--scene-gradient-linear-start, #ff37aa), transparent 92%) 0%, color-mix(in srgb, var(--scene-gradient-linear-mid, #6f33ff), transparent 95%) 40%, rgba(0,0,0,0) 100%)',
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
  originMinX,
  originMinY,
  buildPlateOpacity,
}: {
  gridWidthMm?: number;
  gridDepthMm?: number;
  originMinX?: number;
  originMinY?: number;
  buildPlateOpacity?: number;
}) {
  const nullRaycast = () => null;

  const width = Number.isFinite(gridWidthMm) && (gridWidthMm as number) > 0 ? (gridWidthMm as number) : 200;
  const depth = Number.isFinite(gridDepthMm) && (gridDepthMm as number) > 0 ? (gridDepthMm as number) : 200;
  const resolvedOriginMinX = Number.isFinite(originMinX) ? (originMinX as number) : -width * 0.5;
  const resolvedOriginMinY = Number.isFinite(originMinY) ? (originMinY as number) : -depth * 0.5;
  const buildVolumeCenterX = resolvedOriginMinX + width * 0.5;
  const buildVolumeCenterY = resolvedOriginMinY + depth * 0.5;
  const baseSize = Math.max(width, depth);
  const baseDivisions = Math.max(20, Math.min(240, Math.round(baseSize / 5)));
  const divisions = Math.max(8, Math.round(baseDivisions / 3));
  const scaleX = width / baseSize;
  const scaleZ = depth / baseSize;
  const buildPlateOversizeEachSideMm = 4;
  const buildPlateThicknessMm = 4;
  const buildPlateCornerRadiusMm = 3;
  const clampedBuildPlateOpacity = THREE.MathUtils.clamp(buildPlateOpacity ?? 1, 0, 1);
  const gridMajorColor = '#4f5560';
  const gridMinorColor = '#2c3138';
  const frontMarkerColor = React.useMemo(() => {
    return new THREE.Color(gridMajorColor).lerp(new THREE.Color('#ffffff'), 0.36).getStyle();
  }, [gridMajorColor]);
  const buildPlateWidth = width + buildPlateOversizeEachSideMm * 2;
  const buildPlateDepth = depth + buildPlateOversizeEachSideMm * 2;
  const buildPlateCenterZ = -buildPlateThicknessMm * 0.5 - 0.08;
  const frontTabDepth = buildPlateOversizeEachSideMm + 0.2;
  const frontTabBackWidth = Math.min(buildPlateWidth - 12, 24);
  const frontTabFrontWidth = Math.min(frontTabBackWidth - 3, 16);
  const frontMarkerInsetMm = 0.5;
  const frontMarkerAspect = 256 / 72;
  const markerAvailableDepth = Math.max(2.8, frontTabDepth - frontMarkerInsetMm * 2);
  const markerAvailableWidth = Math.max(12, frontTabBackWidth - frontMarkerInsetMm * 2);
  const frontMarkerDepth = Math.min(markerAvailableDepth, markerAvailableWidth / frontMarkerAspect);
  const frontMarkerWidth = frontMarkerDepth * frontMarkerAspect;
  const axisBaseZ = 0.16;
  const axisLength = 44;
  const axisShaftRadius = 0.42;
  const axisHeadRadius = 1.3;
  const axisHeadLength = 3.8;
  const axisLabelLift = 0.9;
  // Seat marker over the front tab so it reads as part of the build plate geometry.
  const frontMarkerY = -buildPlateDepth * 0.5 - frontTabDepth * 0.1;

  const frontTexture = React.useMemo(() => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return null;

    canvas.width = 256;
    canvas.height = 72;

    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = frontMarkerColor;
    context.font = '700 70px Arial';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('FRONT', canvas.width / 2, canvas.height / 2 + 1);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }, [frontMarkerColor]);

  const xAxisGradient = React.useMemo(() => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return null;

    canvas.width = 16;
    canvas.height = 256;

    const gradient = context.createLinearGradient(0, canvas.height, 0, 0);
    gradient.addColorStop(0, '#8d232f');
    gradient.addColorStop(1, '#ff7a7a');
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    return texture;
  }, []);

  const yAxisGradient = React.useMemo(() => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return null;

    canvas.width = 16;
    canvas.height = 256;

    const gradient = context.createLinearGradient(0, canvas.height, 0, 0);
    gradient.addColorStop(0, '#1e6b35');
    gradient.addColorStop(1, '#74ff95');
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    return texture;
  }, []);

  const zAxisGradient = React.useMemo(() => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return null;

    canvas.width = 16;
    canvas.height = 256;

    const gradient = context.createLinearGradient(0, canvas.height, 0, 0);
    gradient.addColorStop(0, '#21428d');
    gradient.addColorStop(1, '#74a3ff');
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    return texture;
  }, []);

  React.useEffect(() => {
    return () => {
      frontTexture?.dispose();
    };
  }, [frontTexture]);

  React.useEffect(() => {
    return () => {
      xAxisGradient?.dispose();
      yAxisGradient?.dispose();
      zAxisGradient?.dispose();
    };
  }, [xAxisGradient, yAxisGradient, zAxisGradient]);

  const buildPlateGeometry = React.useMemo(() => {
    const halfW = buildPlateWidth * 0.5;
    const halfD = buildPlateDepth * 0.5;
    const r = Math.max(0.2, Math.min(buildPlateCornerRadiusMm, halfW - 0.2, halfD - 0.2));
    const tabBackHalf = frontTabBackWidth * 0.5;
    const tabFrontHalf = frontTabFrontWidth * 0.5;
    const tabFrontY = -halfD - frontTabDepth;

    const shape = new THREE.Shape();
    shape.moveTo(-halfW + r, -halfD);
    shape.lineTo(-tabBackHalf, -halfD);
    shape.lineTo(-tabFrontHalf, tabFrontY);
    shape.lineTo(tabFrontHalf, tabFrontY);
    shape.lineTo(tabBackHalf, -halfD);
    shape.lineTo(halfW - r, -halfD);
    shape.quadraticCurveTo(halfW, -halfD, halfW, -halfD + r);
    shape.lineTo(halfW, halfD - r);
    shape.quadraticCurveTo(halfW, halfD, halfW - r, halfD);
    shape.lineTo(-halfW + r, halfD);
    shape.quadraticCurveTo(-halfW, halfD, -halfW, halfD - r);
    shape.lineTo(-halfW, -halfD + r);
    shape.quadraticCurveTo(-halfW, -halfD, -halfW + r, -halfD);

    const geom = new THREE.ExtrudeGeometry(shape, {
      depth: buildPlateThicknessMm,
      bevelEnabled: false,
      curveSegments: 18,
      steps: 1,
    });

    // Center thickness around local Z=0 so top sits at +thickness/2 and bottom at -thickness/2.
    geom.translate(0, 0, -buildPlateThicknessMm * 0.5);
    geom.computeVertexNormals();
    return geom;
  }, [
    buildPlateCornerRadiusMm,
    buildPlateDepth,
    buildPlateThicknessMm,
    buildPlateWidth,
    frontTabBackWidth,
    frontTabDepth,
    frontTabFrontWidth,
  ]);

  React.useEffect(() => {
    return () => {
      buildPlateGeometry.dispose();
    };
  }, [buildPlateGeometry]);

  return (
    <>
      {/* Primitive mock build plate under grid */}
      <mesh
        position={[buildVolumeCenterX, buildVolumeCenterY, buildPlateCenterZ]}
        raycast={nullRaycast}
        visible={clampedBuildPlateOpacity > 0.001}
      >
        <primitive object={buildPlateGeometry} attach="geometry" />
        <meshStandardMaterial
          color="#3a4048"
          transparent
          opacity={0.94 * clampedBuildPlateOpacity}
          side={THREE.FrontSide}
          depthWrite
        />
      </mesh>

      {/* Grid on XY plane (horizontal) - rotate 90° around X */}
      <gridHelper
        args={[baseSize, divisions, gridMajorColor, gridMinorColor]}
        position={[buildVolumeCenterX, buildVolumeCenterY, -0.01]}
        rotation={[Math.PI / 2, 0, 0]}
        scale={[scaleX, 1, scaleZ]}
        raycast={nullRaycast}
      />
      {/* Axes: short, thicker arrows hovering slightly above Z0 to avoid grid clipping */}
      <group position={[resolvedOriginMinX, resolvedOriginMinY, axisBaseZ]}>
        {/* X axis */}
        <mesh position={[axisLength * 0.5, 0, 0]} rotation={[0, 0, -Math.PI * 0.5]} raycast={nullRaycast}>
          <cylinderGeometry args={[axisShaftRadius, axisShaftRadius, axisLength, 12]} />
          <meshBasicMaterial map={xAxisGradient ?? undefined} toneMapped={false} />
        </mesh>
        <mesh position={[axisLength + axisHeadLength * 0.5, 0, 0]} rotation={[0, 0, -Math.PI * 0.5]} raycast={nullRaycast}>
          <coneGeometry args={[axisHeadRadius, axisHeadLength, 12]} />
          <meshBasicMaterial map={xAxisGradient ?? undefined} toneMapped={false} />
        </mesh>

        {/* Y axis */}
        <mesh position={[0, axisLength * 0.5, 0]} raycast={nullRaycast}>
          <cylinderGeometry args={[axisShaftRadius, axisShaftRadius, axisLength, 12]} />
          <meshBasicMaterial map={yAxisGradient ?? undefined} toneMapped={false} />
        </mesh>
        <mesh position={[0, axisLength + axisHeadLength * 0.5, 0]} raycast={nullRaycast}>
          <coneGeometry args={[axisHeadRadius, axisHeadLength, 12]} />
          <meshBasicMaterial map={yAxisGradient ?? undefined} toneMapped={false} />
        </mesh>

        {/* Z axis */}
        <mesh position={[0, 0, axisLength * 0.5]} rotation={[Math.PI * 0.5, 0, 0]} raycast={nullRaycast}>
          <cylinderGeometry args={[axisShaftRadius, axisShaftRadius, axisLength, 12]} />
          <meshBasicMaterial map={zAxisGradient ?? undefined} toneMapped={false} />
        </mesh>
        <mesh position={[0, 0, axisLength + axisHeadLength * 0.5]} rotation={[Math.PI * 0.5, 0, 0]} raycast={nullRaycast}>
          <coneGeometry args={[axisHeadRadius, axisHeadLength, 12]} />
          <meshBasicMaterial map={zAxisGradient ?? undefined} toneMapped={false} />
        </mesh>

        <group position={[0, 0, axisLabelLift]}>
          <AxisLabels size={axisLength + 6} />
        </group>
      </group>

      {/* FRONT orientation marker locked to grid front edge and constrained within build plate bounds */}
      <group position={[buildVolumeCenterX, buildVolumeCenterY + frontMarkerY, 0.001]}>
        {frontTexture && (
          <mesh raycast={nullRaycast}>
            <planeGeometry args={[frontMarkerWidth, frontMarkerDepth]} />
            <meshBasicMaterial
              map={frontTexture}
              transparent
              opacity={1}
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
