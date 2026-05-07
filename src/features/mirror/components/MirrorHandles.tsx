import React from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { MirrorArrow } from './MirrorArrow';
import { computeHandlePlacements, type HandlePlacement } from '../logic/computeHandlePlacements';
import type { MirrorAxis } from '../types';

interface MirrorHandlesProps {
  activeModelId: string;
  onMirror: (axis: MirrorAxis) => void;
}

export function MirrorHandles({ activeModelId, onMirror }: MirrorHandlesProps) {
  const { scene } = useThree();
  const [placements, setPlacements] = React.useState<HandlePlacement[]>([]);

  const tmpBoxRef = React.useRef(new THREE.Box3());
  const lastSignatureRef = React.useRef<string>('');

  useFrame(() => {
    const meshGroup = findActiveModelGroup(scene, activeModelId);
    if (!meshGroup) {
      if (placements.length > 0) setPlacements([]);
      return;
    }

    const worldBbox = computeWorldBbox(meshGroup, tmpBoxRef.current);
    if (!worldBbox || worldBbox.isEmpty()) {
      if (placements.length > 0) setPlacements([]);
      return;
    }

    const signature = `${worldBbox.min.x.toFixed(3)},${worldBbox.min.y.toFixed(3)},${worldBbox.min.z.toFixed(3)},${worldBbox.max.x.toFixed(3)},${worldBbox.max.y.toFixed(3)},${worldBbox.max.z.toFixed(3)}`;
    if (signature === lastSignatureRef.current) return;
    lastSignatureRef.current = signature;

    setPlacements(computeHandlePlacements(worldBbox));
  });

  return (
    <group>
      {placements.map((p) => (
        <MirrorArrow
          key={`${p.axis}-${p.side}`}
          axis={p.axis}
          position={p.position}
          direction={p.direction}
          onClick={onMirror}
        />
      ))}
    </group>
  );
}

function findActiveModelGroup(scene: THREE.Scene, modelId: string): THREE.Object3D | null {
  let result: THREE.Object3D | null = null;
  scene.traverse((obj) => {
    if (result) return;
    if (obj instanceof THREE.Mesh && obj.userData?.modelId === modelId) {
      result = obj.parent ?? obj;
    }
  });
  return result;
}

function computeWorldBbox(group: THREE.Object3D, target: THREE.Box3): THREE.Box3 | null {
  target.makeEmpty();
  let any = false;
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh && obj.geometry) {
      const geom = obj.geometry as THREE.BufferGeometry;
      if (!geom.boundingBox) geom.computeBoundingBox();
      if (geom.boundingBox) {
        const tmp = geom.boundingBox.clone().applyMatrix4(obj.matrixWorld);
        target.union(tmp);
        any = true;
      }
    }
  });
  return any ? target : null;
}
