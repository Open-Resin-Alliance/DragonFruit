import type * as THREE from 'three';
import type { MatcapVariant, MeshShaderType } from './types';
import { SoftClayMaterial } from './softClay';
import { FlatUnlitMaterial } from './flatUnlit';
import { MatcapMaterial } from './matcap';
import { ToonMaterial } from './toon';
import { NormalDebugMaterial } from './normalDebug';
import { WireframeMaterial } from './wireframe';
import { XrayMaterial } from './xray';

export function MeshShaderMaterial({
  shaderType,
  isSelected,
  isHovered = false,
  useVertexColors = true,
  hoverTintColor,
  hoverTintStrength,
  selectedTintStrength,
  meshColor,
  materialRoughness,
  clippingPlanes,
  xrayOpacity,
  matcapVariant,
  flatUseVertexColors,
  toonSteps,
}: {
  shaderType: MeshShaderType;
  isSelected: boolean;
  isHovered?: boolean;
  useVertexColors?: boolean;
  hoverTintColor?: string;
  hoverTintStrength?: number;
  selectedTintStrength?: number;
  meshColor?: string;
  materialRoughness?: number;
  clippingPlanes: THREE.Plane[];
  xrayOpacity?: number;
  matcapVariant?: MatcapVariant;
  flatUseVertexColors?: boolean;
  toonSteps?: number;
}) {
  switch (shaderType) {
    case 'flat_unlit':
      return (
        <FlatUnlitMaterial
          isSelected={isSelected}
          isHovered={isHovered}
          hoverTintColor={hoverTintColor}
          hoverTintStrength={hoverTintStrength}
          selectedTintStrength={selectedTintStrength}
          useVertexColors={useVertexColors && (flatUseVertexColors ?? true)}
          meshColor={meshColor}
          clippingPlanes={clippingPlanes}
        />
      );

    case 'matcap':
      return (
        <MatcapMaterial
          isSelected={isSelected}
          isHovered={isHovered}
          hoverTintColor={hoverTintColor}
          hoverTintStrength={hoverTintStrength}
          selectedTintStrength={selectedTintStrength}
          useVertexColors={useVertexColors}
          meshColor={meshColor}
          variant={matcapVariant}
          clippingPlanes={clippingPlanes}
        />
      );

    case 'toon':
      return (
        <ToonMaterial
          isSelected={isSelected}
          isHovered={isHovered}
          hoverTintColor={hoverTintColor}
          hoverTintStrength={hoverTintStrength}
          selectedTintStrength={selectedTintStrength}
          useVertexColors={useVertexColors}
          meshColor={meshColor}
          toonSteps={toonSteps}
          clippingPlanes={clippingPlanes}
        />
      );

    case 'normal_debug':
      return <NormalDebugMaterial clippingPlanes={clippingPlanes} />;

    case 'wireframe':
      return (
        <WireframeMaterial
          isSelected={isSelected}
          isHovered={isHovered}
          hoverTintColor={hoverTintColor}
          hoverTintStrength={hoverTintStrength}
          selectedTintStrength={selectedTintStrength}
          clippingPlanes={clippingPlanes}
        />
      );

    case 'xray':
      return (
        <XrayMaterial
          isSelected={isSelected}
          isHovered={isHovered}
          hoverTintColor={hoverTintColor}
          hoverTintStrength={hoverTintStrength}
          selectedTintStrength={selectedTintStrength}
          useVertexColors={useVertexColors}
          meshColor={meshColor}
          materialRoughness={materialRoughness}
          clippingPlanes={clippingPlanes}
          opacity={xrayOpacity}
        />
      );

    case 'soft_clay':
    default:
      return (
        <SoftClayMaterial
          isSelected={isSelected}
          isHovered={isHovered}
          hoverTintColor={hoverTintColor}
          hoverTintStrength={hoverTintStrength}
          selectedTintStrength={selectedTintStrength}
          useVertexColors={useVertexColors}
          meshColor={meshColor}
          materialRoughness={materialRoughness}
          clippingPlanes={clippingPlanes}
        />
      );
  }
}
