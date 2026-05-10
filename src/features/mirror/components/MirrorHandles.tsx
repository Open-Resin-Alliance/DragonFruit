import React from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { MirrorArrow } from './MirrorArrow';
import { computeHandlePlacements, type HandlePlacement } from '../logic/computeHandlePlacements';
import type { MirrorAxis } from '../types';
import { usePicking } from '@/components/picking';

interface MirrorHandlesProps {
  activeModelId: string;
  onMirror: (axis: MirrorAxis) => void;
}

export function MirrorHandles({ activeModelId, onMirror }: MirrorHandlesProps) {
  const { scene } = useThree();
  const { isDragging: isGlobalDragging } = usePicking();
  const [placements, setPlacements] = React.useState<HandlePlacement[]>([]);
  const [hoveredAxis, setHoveredAxis] = React.useState<MirrorAxis | null>(null);
  const [activeAxis, setActiveAxis] = React.useState<MirrorAxis | null>(null);

  const tmpBoxRef = React.useRef(new THREE.Box3());
  const lastSignatureRef = React.useRef<string>('');
  const hoverClearRafRef = React.useRef<number | null>(null);

  // Cleanup RAF on unmount
  React.useEffect(() => {
    return () => {
      if (hoverClearRafRef.current !== null) {
        window.cancelAnimationFrame(hoverClearRafRef.current);
        hoverClearRafRef.current = null;
      }
    };
  }, []);

  // Get center position for view culling
  const centerPos = React.useMemo(() => {
    if (placements.length === 0) return new THREE.Vector3();
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const p of placements) {
      minX = Math.min(minX, p.position.x);
      minY = Math.min(minY, p.position.y);
      minZ = Math.min(minZ, p.position.z);
      maxX = Math.max(maxX, p.position.x);
      maxY = Math.max(maxY, p.position.y);
      maxZ = Math.max(maxZ, p.position.z);
    }
    return new THREE.Vector3(
      (minX + maxX) / 2,
      (minY + maxY) / 2,
      (minZ + maxZ) / 2
    );
  }, [placements]);

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

  // Compute and update view cull state


  const handlePointerEnter = (axis: MirrorAxis) => {
    if (isGlobalDragging) return;
    if (hoverClearRafRef.current !== null) {
      window.cancelAnimationFrame(hoverClearRafRef.current);
      hoverClearRafRef.current = null;
    }
    if (!activeAxis) {
      setHoveredAxis(axis);
    }
  };

  const handlePointerLeave = () => {
    if (isGlobalDragging) return;
    if (activeAxis) return;

    if (hoverClearRafRef.current !== null) {
      window.cancelAnimationFrame(hoverClearRafRef.current);
    }

    hoverClearRafRef.current = window.requestAnimationFrame(() => {
      hoverClearRafRef.current = null;
      if (!activeAxis) {
        setHoveredAxis(null);
      }
    });
  };

  const handleDragStart = (axis: MirrorAxis): boolean => {
    setActiveAxis(axis);
    setHoveredAxis(null);
    return true;
  };

  const handleDragEnd = () => {
    setActiveAxis(null);
    if (hoverClearRafRef.current !== null) {
      window.cancelAnimationFrame(hoverClearRafRef.current);
      hoverClearRafRef.current = null;
    }
  };

  const handleMirrorClick = (axis: MirrorAxis) => {
    handleDragStart(axis);
    onMirror(axis);
    handleDragEnd();
  };

  const isDimmed = (axis: MirrorAxis) => activeAxis !== null && activeAxis !== axis;
  const isHidden = (axis: MirrorAxis) => false;
  const opacityScale = (axis: MirrorAxis) => isGlobalDragging ? 0.6 : 1;

  return (
    <group>
      {placements.map((p) => (
        <MirrorArrow
          key={`${p.axis}-${p.side}`}
          axis={p.axis}
          position={p.position}
          direction={p.direction}
          isHovered={hoveredAxis === p.axis}
          isActive={activeAxis === p.axis}
          isDimmed={isDimmed(p.axis)}
          isHidden={isHidden(p.axis)}
          suppressHover={isGlobalDragging}
          opacityScale={opacityScale(p.axis)}
          onPointerEnter={() => handlePointerEnter(p.axis)}
          onPointerLeave={handlePointerLeave}
          onClick={() => handleMirrorClick(p.axis)}
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
