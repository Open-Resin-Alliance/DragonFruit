'use client';

import React from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import type { ThreeEvent } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { MeshShaderMaterial, type MatcapVariant, type MeshShaderType } from '@/features/shaders/mesh';
import { OpaqueWireOverlayMaterial } from '@/features/shaders/mesh/opaqueWireMesh';
import { STLLoader } from 'three-stdlib';
import { useLoader } from '@react-three/fiber';

function ZUpPreviewCamera({ distance }: { distance: number }) {
  const { camera } = useThree();

  React.useEffect(() => {
    camera.up.set(0, 0, 1);
    camera.position.set(0, -distance, 0);
    camera.lookAt(0, 0, 0);
    if ('updateProjectionMatrix' in camera && typeof camera.updateProjectionMatrix === 'function') {
      camera.updateProjectionMatrix();
    }
  }, [camera, distance]);

  return null;
}

function CameraHeadlight({ intensity }: { intensity: number }) {
  const { camera, invalidate } = useThree();
  const lightRef = React.useRef<THREE.PointLight | null>(null);
  const prevCameraPosRef = React.useRef<THREE.Vector3>(new THREE.Vector3(Number.NaN, Number.NaN, Number.NaN));

  useFrame(() => {
    if (!lightRef.current) return;
    if (prevCameraPosRef.current.equals(camera.position)) return;
    prevCameraPosRef.current.copy(camera.position);
    lightRef.current.position.copy(camera.position);
    invalidate();
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

function applyUniformVertexColor(geometry: THREE.BufferGeometry, color: THREE.Color) {
  const position = geometry.getAttribute('position');
  const count = position.count;

  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3 + 0] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

function normalizeGeometryToUnitSize(geometry: THREE.BufferGeometry) {
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox;
  if (!bbox) return;

  const size = new THREE.Vector3();
  bbox.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z);
  if (!Number.isFinite(maxDim) || maxDim <= 0) return;

  geometry.center();
  const scale = 1.5 / maxDim;
  geometry.scale(scale, scale, scale);
}

function BuiltinPreviewMesh({
  shape,
  meshColor,
  useVertexColors,
  shaderType,
  matcapVariant,
  flatUseVertexColors,
  toonSteps,
  materialRoughness,
  xrayOpacity,
  heatmapBlend,
  heatmapContrast,
  heatmapColors,
  hoverTintColor,
  selectedTintColor,
  hoverTintStrength,
  selectedTintStrength,
  isSelected,
  isHovered,
  onHoverChange,
  onPress,
}: {
  shape: 'cube' | 'sphere' | 'knot';
  meshColor: string;
  useVertexColors: boolean;
  shaderType: MeshShaderType;
  matcapVariant: MatcapVariant;
  flatUseVertexColors: boolean;
  toonSteps: number;
  materialRoughness: number;
  xrayOpacity: number;
  heatmapBlend: number;
  heatmapContrast: number;
  heatmapColors?: string[];
  hoverTintColor?: string;
  selectedTintColor?: string;
  hoverTintStrength: number;
  selectedTintStrength: number;
  isSelected: boolean;
  isHovered: boolean;
  onHoverChange?: (hovered: boolean) => void;
  onPress?: () => void;
}) {
  const geom = React.useMemo(() => {
    let g: THREE.BufferGeometry;
    switch (shape) {
      case 'cube':
        g = new THREE.BoxGeometry(1.6, 1.6, 1.6, 1, 1, 1);
        break;
      case 'knot':
        g = new THREE.TorusKnotGeometry(1, 0.35, 160, 24);
        break;
      case 'sphere':
      default:
        g = new THREE.SphereGeometry(1.1, 48, 32);
        break;
    }
    g.computeVertexNormals();
    applyUniformVertexColor(g, new THREE.Color(meshColor));
    return g;
  }, [shape]);

  React.useEffect(() => {
    applyUniformVertexColor(geom, new THREE.Color(meshColor));
    geom.attributes.color.needsUpdate = true;
  }, [geom, meshColor]);

  return (
    shaderType === 'opaque_wire_mesh' ? (
      <group>
        <mesh
          geometry={geom}
          onPointerOver={(event: ThreeEvent<PointerEvent>) => {
            event.stopPropagation();
            onHoverChange?.(true);
          }}
          onPointerOut={(event: ThreeEvent<PointerEvent>) => {
            event.stopPropagation();
            onHoverChange?.(false);
          }}
          onClick={(event: ThreeEvent<MouseEvent>) => {
            event.stopPropagation();
            onPress?.();
          }}
        >
          <MeshShaderMaterial
            shaderType={'soft_clay'}
            isSelected={isSelected}
            isHovered={isHovered}
            useVertexColors={useVertexColors}
            hoverTintColor={hoverTintColor}
            selectedTintColor={selectedTintColor}
            meshColor={meshColor}
            matcapVariant={matcapVariant}
            flatUseVertexColors={flatUseVertexColors}
            toonSteps={toonSteps}
            materialRoughness={materialRoughness}
            clippingPlanes={[]}
            xrayOpacity={xrayOpacity}
            heatmapBlend={heatmapBlend}
            heatmapContrast={heatmapContrast}
            heatmapColors={heatmapColors}
            hoverTintStrength={hoverTintStrength}
            selectedTintStrength={selectedTintStrength}
          />
        </mesh>
        <mesh geometry={geom} renderOrder={1}>
          <OpaqueWireOverlayMaterial clippingPlanes={[]} />
        </mesh>
      </group>
    ) : (
      <mesh
        geometry={geom}
        onPointerOver={(event: ThreeEvent<PointerEvent>) => {
          event.stopPropagation();
          onHoverChange?.(true);
        }}
        onPointerOut={(event: ThreeEvent<PointerEvent>) => {
          event.stopPropagation();
          onHoverChange?.(false);
        }}
        onClick={(event: ThreeEvent<MouseEvent>) => {
          event.stopPropagation();
          onPress?.();
        }}
      >
        <MeshShaderMaterial
          shaderType={shaderType}
          isSelected={isSelected}
          isHovered={isHovered}
          useVertexColors={useVertexColors}
          hoverTintColor={hoverTintColor}
          selectedTintColor={selectedTintColor}
          meshColor={meshColor}
          matcapVariant={matcapVariant}
          flatUseVertexColors={flatUseVertexColors}
          toonSteps={toonSteps}
          materialRoughness={materialRoughness}
          clippingPlanes={[]}
          xrayOpacity={xrayOpacity}
          heatmapBlend={heatmapBlend}
          heatmapContrast={heatmapContrast}
          heatmapColors={heatmapColors}
          hoverTintStrength={hoverTintStrength}
          selectedTintStrength={selectedTintStrength}
        />
      </mesh>
    )
  );
}

function StlPreviewMesh({
  url,
  meshColor,
  useVertexColors,
  shaderType,
  matcapVariant,
  flatUseVertexColors,
  toonSteps,
  materialRoughness,
  xrayOpacity,
  heatmapBlend,
  heatmapContrast,
  heatmapColors,
  hoverTintColor,
  selectedTintColor,
  hoverTintStrength,
  selectedTintStrength,
  isSelected,
  isHovered,
  onHoverChange,
  onPress,
}: {
  url: string;
  meshColor: string;
  useVertexColors: boolean;
  shaderType: MeshShaderType;
  matcapVariant: MatcapVariant;
  flatUseVertexColors: boolean;
  toonSteps: number;
  materialRoughness: number;
  xrayOpacity: number;
  heatmapBlend: number;
  heatmapContrast: number;
  heatmapColors?: string[];
  hoverTintColor?: string;
  selectedTintColor?: string;
  hoverTintStrength: number;
  selectedTintStrength: number;
  isSelected: boolean;
  isHovered: boolean;
  onHoverChange?: (hovered: boolean) => void;
  onPress?: () => void;
}) {
  const baseGeom = useLoader(STLLoader, url);
  const geom = React.useMemo(() => {
    const g = baseGeom.clone();
    g.computeVertexNormals();
    normalizeGeometryToUnitSize(g);
    applyUniformVertexColor(g, new THREE.Color(meshColor));
    return g;
  }, [baseGeom]);

  React.useEffect(() => {
    applyUniformVertexColor(geom, new THREE.Color(meshColor));
    geom.attributes.color.needsUpdate = true;
  }, [geom, meshColor]);

  return (
    shaderType === 'opaque_wire_mesh' ? (
      <group>
        <mesh
          geometry={geom}
          onPointerOver={(event: ThreeEvent<PointerEvent>) => {
            event.stopPropagation();
            onHoverChange?.(true);
          }}
          onPointerOut={(event: ThreeEvent<PointerEvent>) => {
            event.stopPropagation();
            onHoverChange?.(false);
          }}
          onClick={(event: ThreeEvent<MouseEvent>) => {
            event.stopPropagation();
            onPress?.();
          }}
        >
          <MeshShaderMaterial
            shaderType={'soft_clay'}
            isSelected={isSelected}
            isHovered={isHovered}
            useVertexColors={useVertexColors}
            hoverTintColor={hoverTintColor}
            selectedTintColor={selectedTintColor}
            meshColor={meshColor}
            matcapVariant={matcapVariant}
            flatUseVertexColors={flatUseVertexColors}
            toonSteps={toonSteps}
            materialRoughness={materialRoughness}
            clippingPlanes={[]}
            xrayOpacity={xrayOpacity}
            heatmapBlend={heatmapBlend}
            heatmapContrast={heatmapContrast}
            heatmapColors={heatmapColors}
            hoverTintStrength={hoverTintStrength}
            selectedTintStrength={selectedTintStrength}
          />
        </mesh>
        <mesh geometry={geom} renderOrder={1}>
          <OpaqueWireOverlayMaterial clippingPlanes={[]} />
        </mesh>
      </group>
    ) : (
      <mesh
        geometry={geom}
        onPointerOver={(event: ThreeEvent<PointerEvent>) => {
          event.stopPropagation();
          onHoverChange?.(true);
        }}
        onPointerOut={(event: ThreeEvent<PointerEvent>) => {
          event.stopPropagation();
          onHoverChange?.(false);
        }}
        onClick={(event: ThreeEvent<MouseEvent>) => {
          event.stopPropagation();
          onPress?.();
        }}
      >
        <MeshShaderMaterial
          shaderType={shaderType}
          isSelected={isSelected}
          isHovered={isHovered}
          useVertexColors={useVertexColors}
          hoverTintColor={hoverTintColor}
          selectedTintColor={selectedTintColor}
          meshColor={meshColor}
          matcapVariant={matcapVariant}
          flatUseVertexColors={flatUseVertexColors}
          toonSteps={toonSteps}
          materialRoughness={materialRoughness}
          clippingPlanes={[]}
          xrayOpacity={xrayOpacity}
          heatmapBlend={heatmapBlend}
          heatmapContrast={heatmapContrast}
          heatmapColors={heatmapColors}
          hoverTintStrength={hoverTintStrength}
          selectedTintStrength={selectedTintStrength}
        />
      </mesh>
    )
  );
}

function PreviewContent({
  shaderType,
  matcapVariant,
  flatUseVertexColors,
  useVertexColors,
  toonSteps,
  meshColor,
  materialRoughness,
  previewModel,
  ambientIntensity,
  directionalIntensity,
  xrayOpacity,
  heatmapBlend,
  heatmapContrast,
  heatmapColors,
  hoverTintColor,
  selectedTintColor,
  hoverTintStrength,
  selectedTintStrength,
  isSelected,
  isHovered,
  onHoverChange,
  onPress,
}: {
  shaderType: MeshShaderType;
  matcapVariant: MatcapVariant;
  flatUseVertexColors: boolean;
  useVertexColors: boolean;
  toonSteps: number;
  meshColor: string;
  materialRoughness: number;
  previewModel: string;
  ambientIntensity: number;
  directionalIntensity: number;
  xrayOpacity: number;
  heatmapBlend: number;
  heatmapContrast: number;
  heatmapColors?: string[];
  hoverTintColor?: string;
  selectedTintColor?: string;
  hoverTintStrength: number;
  selectedTintStrength: number;
  isSelected: boolean;
  isHovered: boolean;
  onHoverChange?: (hovered: boolean) => void;
  onPress?: () => void;
}) {
  const isStl = previewModel.startsWith('stl:');
  const stlUrl = isStl ? previewModel.slice('stl:'.length) : null;
  const builtinShape: 'cube' | 'sphere' | 'knot' =
    previewModel === 'sphere' ? 'sphere' : previewModel === 'knot' ? 'knot' : 'cube';

  const headlightIntensity = 1.0;

  return (
    <group>
      <ambientLight intensity={ambientIntensity} />
      <directionalLight position={[0, 0, 12]} intensity={directionalIntensity} />
      <directionalLight position={[0, 0, -12]} intensity={directionalIntensity * 0.15} />
      <hemisphereLight args={['#ffffff', '#444444', ambientIntensity * 0.6]} />
      <CameraHeadlight intensity={headlightIntensity} />

      <group>
        {isStl && stlUrl ? (
          <StlPreviewMesh
            url={stlUrl}
            meshColor={meshColor}
            useVertexColors={useVertexColors}
            shaderType={shaderType}
            matcapVariant={matcapVariant}
            flatUseVertexColors={flatUseVertexColors}
            toonSteps={toonSteps}
            materialRoughness={materialRoughness}
            xrayOpacity={xrayOpacity}
            heatmapBlend={heatmapBlend}
            heatmapContrast={heatmapContrast}
            heatmapColors={heatmapColors}
            hoverTintColor={hoverTintColor}
            selectedTintColor={selectedTintColor}
            hoverTintStrength={hoverTintStrength}
            selectedTintStrength={selectedTintStrength}
            isSelected={isSelected}
            isHovered={isHovered}
            onHoverChange={onHoverChange}
            onPress={onPress}
          />
        ) : (
          <BuiltinPreviewMesh
            shape={builtinShape}
            meshColor={meshColor}
            useVertexColors={useVertexColors}
            shaderType={shaderType}
            matcapVariant={matcapVariant}
            flatUseVertexColors={flatUseVertexColors}
            toonSteps={toonSteps}
            materialRoughness={materialRoughness}
            xrayOpacity={xrayOpacity}
            heatmapBlend={heatmapBlend}
            heatmapContrast={heatmapContrast}
            heatmapColors={heatmapColors}
            hoverTintColor={hoverTintColor}
            selectedTintColor={selectedTintColor}
            hoverTintStrength={hoverTintStrength}
            selectedTintStrength={selectedTintStrength}
            isSelected={isSelected}
            isHovered={isHovered}
            onHoverChange={onHoverChange}
            onPress={onPress}
          />
        )}
      </group>
    </group>
  );
}

export function MeshShaderPreviewCanvas({
  shaderType,
  matcapVariant,
  flatUseVertexColors,
  useVertexColors = true,
  toonSteps,
  meshColor,
  materialRoughness,
  previewModel,
  ambientIntensity,
  directionalIntensity,
  xrayOpacity,
  heatmapBlend,
  heatmapContrast,
  heatmapColors,
  hoverTintColor,
  selectedTintColor,
  hoverTintStrength,
  selectedTintStrength,
  isSelected = false,
  isHovered = false,
  onHoverChange,
  onPress,
  onCanvasPress,
}: {
  shaderType: MeshShaderType;
  matcapVariant: MatcapVariant;
  flatUseVertexColors: boolean;
  useVertexColors?: boolean;
  toonSteps: number;
  meshColor: string;
  materialRoughness: number;
  previewModel: string;
  ambientIntensity: number;
  directionalIntensity: number;
  xrayOpacity: number;
  heatmapBlend: number;
  heatmapContrast: number;
  heatmapColors?: string[];
  hoverTintColor?: string;
  selectedTintColor?: string;
  hoverTintStrength: number;
  selectedTintStrength: number;
  isSelected?: boolean;
  isHovered?: boolean;
  onHoverChange?: (hovered: boolean) => void;
  onPress?: () => void;
  onCanvasPress?: () => void;
}) {
  const cameraDistance = previewModel === 'knot' ? 7.2 : 5.6;

  return (
    <div className="w-full h-full relative">
      <Canvas
        gl={{ alpha: true, antialias: true }}
        camera={{ position: [0, -cameraDistance, 0], fov: 35 }}
        dpr={[1, 2]}
        frameloop="demand"
        onPointerMissed={() => {
          onHoverChange?.(false);
          onCanvasPress?.();
        }}
      >
        <ZUpPreviewCamera distance={cameraDistance} />
        <OrbitControls
          enablePan={false}
          enableZoom={false}
          enableRotate
          autoRotate
          autoRotateSpeed={0.6}
          enableDamping
          dampingFactor={0.08}
          rotateSpeed={0.9}
        />
        <PreviewContent
          shaderType={shaderType}
          matcapVariant={matcapVariant}
          flatUseVertexColors={flatUseVertexColors}
          useVertexColors={useVertexColors}
          toonSteps={toonSteps}
          meshColor={meshColor}
          materialRoughness={materialRoughness}
          previewModel={previewModel}
          ambientIntensity={ambientIntensity}
          directionalIntensity={directionalIntensity}
          xrayOpacity={xrayOpacity}
          heatmapBlend={heatmapBlend}
          heatmapContrast={heatmapContrast}
          heatmapColors={heatmapColors}
          hoverTintColor={hoverTintColor}
          selectedTintColor={selectedTintColor}
          hoverTintStrength={hoverTintStrength}
          selectedTintStrength={selectedTintStrength}
          isSelected={isSelected}
          isHovered={isHovered}
          onHoverChange={onHoverChange}
          onPress={onPress}
        />
      </Canvas>
    </div>
  );
}
