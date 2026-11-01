'use client';

import React from 'react';
import * as THREE from 'three';
import { Canvas, useThree } from '@react-three/fiber';
import { CrossSectionStencilCap, type CrossSectionStencilCapEntry } from '@/components/scene/CrossSectionStencilCap';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { getProfileStoreSnapshot } from '@/features/profiles/profileStore';

interface Props {
  models: LoadedModel[];
  clipZ: number | null;
  buildPlateWidthMm: number;
  buildPlateDepthMm: number;
  viewportWidthMm?: number;
  viewportHeightMm?: number;
  supportGroupRef?: React.RefObject<THREE.Group | null> | null;
  supportVersion?: number;
  mirrorX?: boolean;
  mirrorY?: boolean;
  /** Draw each body in its material colour instead of one white silhouette. */
  multiMaterialMode?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

function DemandInvalidateOnChange({
  clipZ,
  supportVersion,
  entryCount,
  mirrorX,
  mirrorY,
  viewportWidthMm,
  viewportHeightMm,
}: {
  clipZ: number | null;
  supportVersion: number;
  entryCount: number;
  mirrorX: boolean;
  mirrorY: boolean;
  viewportWidthMm?: number;
  viewportHeightMm?: number;
}) {
  const { invalidate } = useThree();

  React.useEffect(() => {
    invalidate();
  }, [
    clipZ,
    supportVersion,
    entryCount,
    mirrorX,
    mirrorY,
    viewportWidthMm,
    viewportHeightMm,
    invalidate,
  ]);

  return null;
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
  viewportWidthMm,
  viewportHeightMm,
  supportGroupRef,
  supportVersion = 0,
  mirrorX = false,
  mirrorY = false,
  multiMaterialMode = false,
  className,
  style,
}: Props) {
  /**
   * One cap per colour: a single-colour cap shows the white silhouette, while a
   * multi-material scene is split into groups so each body's cross-section is drawn
   * in the resin it prints in. Bodies share the merged model's centre, which is the
   * offset the renderer subtracts for them too.
   */
  const capGroups = React.useMemo(() => {
    if (!multiMaterialMode) {
      return [{
        color: '#ffffff',
        entries: models
          .filter((model) => model.visible)
          .map((model) => ({
            id: model.id,
            geometry: model.geometry.geometry,
            center: model.geometry.center,
            transform: model.transform,
          })),
      }];
    }

    // The saved colour array can be missing (a scene kept under a single-material
    // printer before assignments became non-destructive); the body's material id
    // still names the resin, so resolve it from the profile store.
    const materialColorById = new Map(
      getProfileStoreSnapshot().materialProfiles.map((material) => [material.id, material.color]),
    );
    const groups = new Map<string, CrossSectionStencilCapEntry[]>();
    for (const model of models) {
      if (!model.visible) continue;
      const bodies = model.splitBodies && model.splitBodies.length > 0 ? model.splitBodies : null;
      if (bodies) {
        bodies.forEach((body, index) => {
          const materialId = model.bodyMaterialProfileIds?.[index];
          const color = model.bodyColors?.[index]
            || (materialId ? materialColorById.get(materialId) : undefined)
            || model.color
            || '#ffffff';
          const entry: CrossSectionStencilCapEntry = {
            id: `${model.id}:body:${index}`,
            geometry: body.geometry,
            center: model.geometry.center,
            transform: model.transform,
          };
          const list = groups.get(color);
          if (list) list.push(entry);
          else groups.set(color, [entry]);
        });
        continue;
      }
      const color = model.color || '#ffffff';
      const entry: CrossSectionStencilCapEntry = {
        id: model.id,
        geometry: model.geometry.geometry,
        center: model.geometry.center,
        transform: model.transform,
      };
      const list = groups.get(color);
      if (list) list.push(entry);
      else groups.set(color, [entry]);
    }
    return [...groups.entries()].map(([color, entries]) => ({ color, entries }));
  }, [multiMaterialMode, models]);

  const capEntryCount = React.useMemo(
    () => capGroups.reduce((total, group) => total + group.entries.length, 0),
    [capGroups],
  );

  const cameraPosition = React.useMemo<[number, number, number]>(() => {
    return [0, 0, 1000];
  }, []);

  const frustumSize = React.useMemo(() => {
    const baseWidth = Math.max(1, buildPlateWidthMm);
    const baseHeight = Math.max(1, buildPlateDepthMm);

    const viewportAspect =
      viewportWidthMm && viewportHeightMm && viewportWidthMm > 0 && viewportHeightMm > 0
        ? viewportWidthMm / viewportHeightMm
        : baseWidth / baseHeight;

    const safeViewportAspect = Number.isFinite(viewportAspect) && viewportAspect > 0
      ? viewportAspect
      : (baseWidth / baseHeight);

    const baseAspect = baseWidth / baseHeight;

    if (safeViewportAspect >= baseAspect) {
      const height = baseHeight;
      const width = height * safeViewportAspect;
      return { width, height };
    }

    const width = baseWidth;
    const height = width / safeViewportAspect;
    return { width, height };
  }, [buildPlateDepthMm, buildPlateWidthMm, viewportHeightMm, viewportWidthMm]);

  const frustumWidthMm = frustumSize.width;
  const frustumHeightMm = frustumSize.height;
  const planeWidthMm = frustumWidthMm;
  const planeHeightMm = frustumHeightMm;

  const orthoSize = React.useMemo(() => {
    return { width: frustumWidthMm, height: frustumHeightMm };
  }, [frustumHeightMm, frustumWidthMm]);

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
        // Always, not demand: the scrub preview has to repaint every frame the clip
        // plane moves, and a demand canvas adds a React invalidation hop per tick that
        // reads as stutter. The scene is one stencil cap per material.
        frameloop="always"
        dpr={[1, 1]}
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
        <DemandInvalidateOnChange
          clipZ={clipZ}
          supportVersion={supportVersion}
          entryCount={capEntryCount}
          mirrorX={mirrorX}
          mirrorY={mirrorY}
          viewportWidthMm={viewportWidthMm}
          viewportHeightMm={viewportHeightMm}
        />
        {capGroups.map((group, groupIndex) => (
          <CrossSectionStencilCap
            key={group.color}
            entries={group.entries}
            sourceObject={supportGroupRef?.current ?? null}
            sourceObjectVersion={supportVersion}
            y={clipZ}
            color={group.color}
            // Every group's stencil pass, cap and stencil clear must finish before
            // the next group starts: with one shared render order the groups' stencil
            // passes merge and the first cap paints all of their silhouettes.
            renderOrderOffset={groupIndex * 10}
            planeWidthMm={planeWidthMm}
            planeHeightMm={planeHeightMm}
            visible={true}
          />
        ))}
      </Canvas>
    </div>
  );
}
