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
          useVertexColors={flatUseVertexColors}
          meshColor={meshColor}
          clippingPlanes={clippingPlanes}
        />
      );

    case 'matcap':
      return (
        <MatcapMaterial
          isSelected={isSelected}
          variant={matcapVariant}
          clippingPlanes={clippingPlanes}
        />
      );

    case 'toon':
      return <ToonMaterial isSelected={isSelected} toonSteps={toonSteps} clippingPlanes={clippingPlanes} />;

    case 'normal_debug':
      return <NormalDebugMaterial clippingPlanes={clippingPlanes} />;

    case 'wireframe':
      return <WireframeMaterial clippingPlanes={clippingPlanes} />;

    case 'xray':
      return (
        <XrayMaterial
          isSelected={isSelected}
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
          materialRoughness={materialRoughness}
          clippingPlanes={clippingPlanes}
        />
      );
  }
}
