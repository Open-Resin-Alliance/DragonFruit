import React from 'react';
import type { Vec3 } from '@/supports/types';
import type { GridAStarDebugPassSnapshot, SupportPathfindingDebugSnapshot } from '@/supports/PlacementLogic/Pathfinding/pathfindingDebugState';

function buildPositionArray(points: Vec3[]): Float32Array {
  const positions = new Float32Array(points.length * 3);
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    const base = i * 3;
    positions[base] = point.x;
    positions[base + 1] = point.y;
    positions[base + 2] = point.z;
  }
  return positions;
}

function DebugPoints({
  points,
  color,
  size,
  opacity,
}: {
  points: Vec3[];
  color: string;
  size: number;
  opacity: number;
}) {
  const positions = React.useMemo(() => buildPositionArray(points), [points]);
  if (points.length === 0) return null;

  return (
    <points renderOrder={1000} frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial
        color={color}
        size={size}
        sizeAttenuation={false}
        transparent
        opacity={opacity}
        depthWrite={false}
        depthTest={false}
        toneMapped={false}
      />
    </points>
  );
}

function DebugLine({
  points,
  color,
  opacity,
}: {
  points: Vec3[];
  color: string;
  opacity: number;
}) {
  const positions = React.useMemo(() => buildPositionArray(points), [points]);
  if (points.length < 2) return null;

  return (
    <line renderOrder={1001} frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <lineBasicMaterial
        color={color}
        transparent
        opacity={opacity}
        depthWrite={false}
        depthTest={false}
        toneMapped={false}
      />
    </line>
  );
}

function PassOverlay({
  pass,
  expandedColor,
  frontierColor,
  rawPathColor,
  simplifiedPathColor,
}: {
  pass: GridAStarDebugPassSnapshot;
  expandedColor: string;
  frontierColor: string;
  rawPathColor: string;
  simplifiedPathColor: string;
}) {
  return (
    <>
      <DebugPoints points={pass.expandedNodes} color={expandedColor} size={4.5} opacity={0.22} />
      <DebugPoints points={pass.frontierNodes} color={frontierColor} size={6.5} opacity={0.8} />
      <DebugLine points={pass.rawPath} color={rawPathColor} opacity={0.45} />
      <DebugLine points={pass.simplifiedPath} color={simplifiedPathColor} opacity={0.95} />
    </>
  );
}

export function SupportPathfindingDebugOverlay({
  snapshot,
}: {
  snapshot: SupportPathfindingDebugSnapshot | null;
}) {
  const socketPoint = React.useMemo(() => (snapshot ? [snapshot.socketPos] : []), [snapshot]);
  const rootTargetPoint = React.useMemo(() => (
    snapshot
      ? [{ x: snapshot.socketPos.x, y: snapshot.socketPos.y, z: snapshot.rootTopZ }]
      : []
  ), [snapshot]);

  if (!snapshot || snapshot.passes.length === 0) return null;

  const finePass = snapshot.passes.find((pass) => pass.label === 'fine') ?? null;
  const widePass = snapshot.passes.find((pass) => pass.label === 'wide') ?? null;

  return (
    <group name="support-pathfinding-debug-overlay">
      <DebugPoints points={socketPoint} color="#ff4fd8" size={11} opacity={1} />
      <DebugPoints points={rootTargetPoint} color="#5eead4" size={9} opacity={0.95} />

      {finePass && (
        <PassOverlay
          pass={finePass}
          expandedColor="#f59e0b"
          frontierColor="#fde68a"
          rawPathColor="#f97316"
          simplifiedPathColor="#22c55e"
        />
      )}

      {widePass && (
        <PassOverlay
          pass={widePass}
          expandedColor="#38bdf8"
          frontierColor="#bfdbfe"
          rawPathColor="#60a5fa"
          simplifiedPathColor="#a855f7"
        />
      )}
    </group>
  );
}
