'use client';

import React from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
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
  shaderType,
  matcapVariant,
  flatUseVertexColors,
  toonSteps,
  materialRoughness,
  xrayOpacity,
  heatmapBlend,
  heatmapContrast,
  heatmapColors,
  hoverTintStrength,
  selectedTintStrength,
}: {
  shape: 'cube' | 'sphere' | 'knot';
  meshColor: string;
  shaderType: MeshShaderType;
  matcapVariant: MatcapVariant;
  flatUseVertexColors: boolean;
  toonSteps: number;
  materialRoughness: number;
  xrayOpacity: number;
  heatmapBlend: number;
  heatmapContrast: number;
  heatmapColors?: string[];
  hoverTintStrength: number;
  selectedTintStrength: number;
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
        <mesh geometry={geom}>
          <MeshShaderMaterial
            shaderType={'soft_clay'}
            isSelected={false}
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
      <mesh geometry={geom}>
        <MeshShaderMaterial
          shaderType={shaderType}
          isSelected={false}
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
        />
      </mesh>
    )
  );
}

function StlPreviewMesh({
  url,
  meshColor,
  shaderType,
  matcapVariant,
  flatUseVertexColors,
  toonSteps,
  materialRoughness,
  xrayOpacity,
  heatmapBlend,
  heatmapContrast,
  heatmapColors,
  hoverTintStrength,
  selectedTintStrength,
}: {
  url: string;
  meshColor: string;
  shaderType: MeshShaderType;
  matcapVariant: MatcapVariant;
  flatUseVertexColors: boolean;
  toonSteps: number;
  materialRoughness: number;
  xrayOpacity: number;
  heatmapBlend: number;
  heatmapContrast: number;
  heatmapColors?: string[];
  hoverTintStrength: number;
  selectedTintStrength: number;
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
        <mesh geometry={geom}>
          <MeshShaderMaterial
            shaderType={'soft_clay'}
            isSelected={false}
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
      <mesh geometry={geom}>
        <MeshShaderMaterial
          shaderType={shaderType}
          isSelected={false}
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
        />
      </mesh>
    )
  );
}

function PreviewContent({
  shaderType,
  matcapVariant,
  flatUseVertexColors,
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
  hoverTintStrength,
  selectedTintStrength,
}: {
  shaderType: MeshShaderType;
  matcapVariant: MatcapVariant;
  flatUseVertexColors: boolean;
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
  hoverTintStrength: number;
  selectedTintStrength: number;
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
            shaderType={shaderType}
            matcapVariant={matcapVariant}
            flatUseVertexColors={flatUseVertexColors}
            toonSteps={toonSteps}
            materialRoughness={materialRoughness}
            xrayOpacity={xrayOpacity}
            heatmapBlend={heatmapBlend}
            heatmapContrast={heatmapContrast}
            heatmapColors={heatmapColors}
            hoverTintStrength={hoverTintStrength}
            selectedTintStrength={selectedTintStrength}
          />
        ) : (
          <BuiltinPreviewMesh
            shape={builtinShape}
            meshColor={meshColor}
            shaderType={shaderType}
            matcapVariant={matcapVariant}
            flatUseVertexColors={flatUseVertexColors}
            toonSteps={toonSteps}
            materialRoughness={materialRoughness}
            xrayOpacity={xrayOpacity}
            heatmapBlend={heatmapBlend}
            heatmapContrast={heatmapContrast}
            heatmapColors={heatmapColors}
            hoverTintStrength={hoverTintStrength}
            selectedTintStrength={selectedTintStrength}
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
  hoverTintStrength,
  selectedTintStrength,
}: {
  shaderType: MeshShaderType;
  matcapVariant: MatcapVariant;
  flatUseVertexColors: boolean;
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
  hoverTintStrength: number;
  selectedTintStrength: number;
}) {
  const cameraDistance = previewModel === 'knot' ? 8.2 : 5.6;

  return (
    <div className="w-full h-full relative">
      <Canvas
        gl={{ alpha: true, antialias: true }}
        camera={{ position: [0, -cameraDistance, 0], fov: 35 }}
        dpr={[1, 2]}
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
          hoverTintStrength={hoverTintStrength}
          selectedTintStrength={selectedTintStrength}
        />
      </Canvas>
    </div>
  );
}
