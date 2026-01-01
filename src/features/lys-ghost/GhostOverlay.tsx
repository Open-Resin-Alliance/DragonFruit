import React, { useMemo } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import { LysConverter } from '../lys-conversion/LysConverter';
import { DragonfruitImportFormat, Segment } from '../../supports/types';

// ... (Keep Lychee Types if needed, or just use 'any' since Converter handles it)

import { createDefaultSettings } from '../../supports/Settings/types';

interface GhostOverlayProps {
  data: any; // Pass raw JSON
  visible: boolean;
}

export function GhostOverlay({ data, visible }: GhostOverlayProps) {
  // 1. Run Conversion Logic
  const convertedData: DragonfruitImportFormat | null = useMemo(() => {
    if (!data) return null;
    console.log('[Ghost] Running Converter...');
    return LysConverter.convert(data, createDefaultSettings());
  }, [data]);

  const ghostGeometry = useMemo(() => {
    if (!convertedData) return [];

    const items: React.ReactNode[] = [];

    convertedData.trunks.forEach(trunk => {
      // Render Segments
      trunk.segments.forEach(seg => {
        const startPos = seg.bottomJoint ? seg.bottomJoint.pos :
          (seg === trunk.segments[0] ?
            // If first segment (and no bottomJoint), connect to Root
            convertedData.roots.find(r => r.id === trunk.rootId)?.transform.pos
            : null);

        const endPos = seg.topJoint ? seg.topJoint.pos :
          // If last segment (and no topJoint), check contact cone?
          // The new converter sets topJoint for the socket, so we should be good.
          null;

        if (!startPos || !endPos) return;

        const s = new THREE.Vector3(startPos.x, startPos.y, startPos.z);
        const e = new THREE.Vector3(endPos.x, endPos.y, endPos.z);

        items.push(
          <line key={`line-${seg.id}`}>
            <bufferGeometry>
              <float32BufferAttribute
                attach="attributes-position"
                args={[
                  new Float32Array([
                    s.x, s.y, s.z,
                    e.x, e.y, e.z
                  ]),
                  3
                ]}
              />
            </bufferGeometry>
            <lineBasicMaterial color="yellow" opacity={0.5} transparent depthTest={false} />
          </line>
        );

        // Render Joint (Top)
        if (seg.topJoint) {
          items.push(
            <mesh key={`joint-${seg.topJoint.id}`} position={[e.x, e.y, e.z]}>
              <sphereGeometry args={[0.4, 8, 8]} />
              <meshBasicMaterial color="orange" depthTest={false} transparent opacity={0.8} />
            </mesh>
          );
        }
      });

      // Render Root
      const root = convertedData.roots.find(r => r.id === trunk.rootId);
      if (root) {
        items.push(
          <mesh key={`root-${root.id}`} position={[root.transform.pos.x, root.transform.pos.y, root.transform.pos.z]}>
            <sphereGeometry args={[0.6, 8, 8]} />
            <meshBasicMaterial color="red" depthTest={false} transparent opacity={0.8} />
          </mesh>
        );
      }

      // Render Contact Cone Tip
      if (trunk.contactCone) {
        const p = trunk.contactCone.pos;
        items.push(
          <mesh key={`cone-${trunk.contactCone.id}`} position={[p.x, p.y, p.z]}>
            <sphereGeometry args={[0.3, 8, 8]} />
            <meshBasicMaterial color="cyan" depthTest={false} transparent opacity={0.8} />
          </mesh>
        );
      }
    });

    return items;
  }, [convertedData]);

  if (!visible || !convertedData) return null;

  return (
    <group>
      {ghostGeometry}
    </group>
  );
}
