'use client';

import React from 'react';
import * as THREE from 'three';
import { Canvas } from '@react-three/fiber';
import { CrossSectionStencilCap, type CrossSectionStencilCapEntry } from '@/components/scene/CrossSectionStencilCap';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';

interface Props {
  models: LoadedModel[];
  clipZ: number | null;
  buildPlateWidthMm: number;
  buildPlateDepthMm: number;
  supportGroupRef?: React.RefObject<THREE.Group> | null;
  supportVersion?: number;
  mirrorX?: boolean;
  mirrorY?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * GPU-accelerated top-down orthographic view of the cross-section.
 * Renders only the stencil cap (true slice silhouette), not full below-layer geometry.
 */
export function PrintingLayerGpuPreview({
  models,
  clipZ,
  buildPlateWidthMm,
  buildPlateDepthMm,
  supportGroupRef,
  supportVersion = 0,
  mirrorX = false,
  mirrorY = false,
  className,
  style,
}: Props) {
  const capEntries = React.useMemo<CrossSectionStencilCapEntry[]>(() => {
    return models
      .filter((model) => model.visible)
      .map((model) => ({
        id: model.id,
        geometry: model.geometry.geometry,
        center: model.geometry.center,
        transform: model.transform,
      }));
  }, [models]);

  const cameraPosition = React.useMemo<[number, number, number]>(() => {
    return [0, 0, 1000];
  }, []);

  const planeWidthMm = Math.max(1, buildPlateWidthMm + 24);
  const planeHeightMm = Math.max(1, buildPlateDepthMm + 24);

  const orthoSize = React.useMemo(() => {
    const margin = 1.15;
    const width = buildPlateWidthMm * margin;
    const height = buildPlateDepthMm * margin;
    return { width, height };
  }, [buildPlateWidthMm, buildPlateDepthMm]);

  if (clipZ == null) {
    return (
      <div
        className={className}
        style={{ position: 'relative', overflow: 'hidden', background: '#000', ...style }}
      />
    );
  }

  return (
    <div
      className={className}
      style={{ position: 'relative', overflow: 'hidden', background: '#000', ...style }}
    >
      <Canvas
        orthographic
        camera={{
          position: cameraPosition,
          zoom: 1,
          left: -orthoSize.width / 2,
          right: orthoSize.width / 2,
          top: orthoSize.height / 2,
          bottom: -orthoSize.height / 2,
          near: 0.1,
          far: 2000,
        }}
        gl={{
          antialias: false,
          stencil: true,
          alpha: false,
          powerPreference: 'high-performance',
        }}
        onCreated={({ gl }) => {
          gl.localClippingEnabled = true;
        }}
        style={{
          width: '100%',
          height: '100%',
          transform: `scale(${mirrorX ? -1 : 1}, ${mirrorY ? -1 : 1})`,
        }}
      >
        <CrossSectionStencilCap
          entries={capEntries}
          sourceObject={supportGroupRef?.current ?? null}
          sourceObjectVersion={supportVersion}
          y={clipZ}
          color="#ffffff"
          planeWidthMm={planeWidthMm}
          planeHeightMm={planeHeightMm}
          visible={true}
        />
      </Canvas>
    </div>
  );
}
