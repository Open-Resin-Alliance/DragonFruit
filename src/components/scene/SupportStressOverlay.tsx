import React from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { LineMaterial, LineSegments2, LineSegmentsGeometry } from 'three-stdlib';
import { getFrameStressSnapshot, subscribeFrameStress } from '@/supports/autoSupport';
import { getSnapshot, subscribe as subscribeSupportState } from '@/supports/state';

const NORMAL_LINE_WIDTH_PX = 2.2;
const OVERLOADED_LINE_WIDTH_PX = 4.5;

function writeUtilizationColor(utilPct: number, out: THREE.Color): void {
  if (utilPct <= 50) {
    out.set('#2eb67d').lerp(new THREE.Color('#eab308'), Math.max(0, utilPct / 50));
  } else if (utilPct <= 85) {
    out.set('#eab308').lerp(new THREE.Color('#f59e0b'), (utilPct - 50) / 35);
  } else if (utilPct <= 100) {
    out.set('#f59e0b').lerp(new THREE.Color('#e45454'), (utilPct - 85) / 15);
  } else {
    out.set('#e45454');
  }
}

export function SupportStressOverlay({ activeModelId }: { activeModelId: string | null }) {
  const viewport = useThree((state) => state.size);
  const stressSnap = React.useSyncExternalStore(
    subscribeFrameStress,
    getFrameStressSnapshot,
    getFrameStressSnapshot,
  );

  const report = stressSnap.overlayEnabled && activeModelId
    ? stressSnap.byModelId[activeModelId]
    : undefined;

  // Model-to-model bridges are deliberately outside the plate-load frame
  // (`buildSupportGraph` omits twigs/sticks), so they have no solved
  // utilization. Draw them anyway, in a neutral colour: missing them reads as
  // "the overlay forgot these supports".
  const supportSnap = React.useSyncExternalStore(subscribeSupportState, getSnapshot, getSnapshot);
  const bridgeLineObj = React.useMemo(() => {
    if (!stressSnap.overlayEnabled || !activeModelId) return null;
    const positions: number[] = [];
    for (const stick of Object.values(supportSnap.sticks ?? {})) {
      if (stick.modelId !== activeModelId) continue;
      const a = stick.contactConeA?.pos;
      const b = stick.contactConeB?.pos;
      if (a && b) positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    for (const twig of Object.values(supportSnap.twigs ?? {})) {
      if (twig.modelId !== activeModelId) continue;
      const a = twig.contactDiskA?.pos;
      const b = twig.contactDiskB?.pos;
      if (a && b) positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    if (positions.length === 0) return null;

    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(positions);
    const material = new LineMaterial({
      color: 0x9aa4b8,
      linewidth: NORMAL_LINE_WIDTH_PX,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      depthTest: true,
    });
    const obj = new LineSegments2(geometry, material);
    obj.frustumCulled = false;
    obj.renderOrder = 998;
    return obj;
  }, [stressSnap.overlayEnabled, activeModelId, supportSnap]);

  const normalLineObj = React.useMemo(() => {
    if (!report || report.memberSegments.length === 0) return null;
    const positions: number[] = [];
    const colors: number[] = [];
    const color = new THREE.Color();

    for (const seg of report.memberSegments) {
      if (seg.utilizationPct > 100) continue;
      positions.push(seg.a.x, seg.a.y, seg.a.z, seg.b.x, seg.b.y, seg.b.z);
      writeUtilizationColor(seg.utilizationPct, color);
      colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
    }
    if (positions.length === 0) return null;

    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(positions);
    geometry.setColors(colors);

    const material = new LineMaterial({
      color: 0xffffff,
      vertexColors: true,
      linewidth: NORMAL_LINE_WIDTH_PX,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      depthTest: true,
    });
    const obj = new LineSegments2(geometry, material);
    obj.frustumCulled = false;
    obj.renderOrder = 999;
    return obj;
  }, [report]);

  const overloadedLineObj = React.useMemo(() => {
    if (!report || report.memberSegments.length === 0) return null;
    const positions: number[] = [];

    for (const seg of report.memberSegments) {
      if (seg.utilizationPct <= 100) continue;
      positions.push(seg.a.x, seg.a.y, seg.a.z, seg.b.x, seg.b.y, seg.b.z);
    }
    if (positions.length === 0) return null;

    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(positions);

    const material = new LineMaterial({
      color: 0xe45454,
      linewidth: OVERLOADED_LINE_WIDTH_PX,
      transparent: true,
      opacity: 0.98,
      depthWrite: false,
      depthTest: true,
    });
    const obj = new LineSegments2(geometry, material);
    obj.frustumCulled = false;
    obj.renderOrder = 1000;
    return obj;
  }, [report]);

  React.useLayoutEffect(() => {
    if (normalLineObj) {
      (normalLineObj.material as LineMaterial).resolution.set(viewport.width, viewport.height);
    }
    if (overloadedLineObj) {
      (overloadedLineObj.material as LineMaterial).resolution.set(viewport.width, viewport.height);
    }
  }, [normalLineObj, overloadedLineObj, viewport.width, viewport.height]);

  const pointsObj = React.useMemo(() => {
    if (!report || report.tipPoints.length === 0) return null;
    const count = report.tipPoints.length;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const color = new THREE.Color();

    for (let i = 0; i < count; i++) {
      const tip = report.tipPoints[i];
      const off = i * 3;
      positions[off] = tip.pos.x;
      positions[off + 1] = tip.pos.y;
      positions[off + 2] = tip.pos.z;
      writeUtilizationColor(tip.utilizationPct, color);
      colors[off] = color.r;
      colors[off + 1] = color.g;
      colors[off + 2] = color.b;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      vertexColors: true,
      size: 6,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.95,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
    });
    const pts = new THREE.Points(geometry, material);
    pts.renderOrder = 1001;
    pts.frustumCulled = false;
    return pts;
  }, [report]);

  React.useEffect(() => () => {
    if (normalLineObj) {
      normalLineObj.geometry.dispose();
      (normalLineObj.material as THREE.Material).dispose();
    }
  }, [normalLineObj]);

  React.useEffect(() => () => {
    if (overloadedLineObj) {
      overloadedLineObj.geometry.dispose();
      (overloadedLineObj.material as THREE.Material).dispose();
    }
  }, [overloadedLineObj]);

  React.useEffect(() => () => {
    if (pointsObj) {
      pointsObj.geometry.dispose();
      (pointsObj.material as THREE.Material).dispose();
    }
  }, [pointsObj]);

  React.useEffect(() => () => {
    if (bridgeLineObj) {
      bridgeLineObj.geometry.dispose();
      (bridgeLineObj.material as THREE.Material).dispose();
    }
  }, [bridgeLineObj]);

  if (!report && !bridgeLineObj) return null;

  return (
    <group name="support-stress-overlay">
      {bridgeLineObj && <primitive object={bridgeLineObj} />}
      {normalLineObj && <primitive object={normalLineObj} />}
      {overloadedLineObj && <primitive object={overloadedLineObj} />}
      {pointsObj && <primitive object={pointsObj} />}
    </group>
  );
}
