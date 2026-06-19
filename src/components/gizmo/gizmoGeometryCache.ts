"use client";

import * as THREE from 'three';
import { GIZMO_SIZES } from './constants';
import type { GizmoAxis } from './types';

const sphereGeometryCache = new Map<string, THREE.SphereGeometry>();
const coneGeometryCache = new Map<string, THREE.ConeGeometry>();
const boxGeometryCache = new Map<string, THREE.BoxGeometry>();
const circleGeometryCache = new Map<string, THREE.CircleGeometry>();
const ringGeometryCache = new Map<string, THREE.RingGeometry>();
const moveShaftGeometryCache = new Map<string, THREE.CylinderGeometry>();
const rotationArcGeometryCache = new Map<GizmoAxis, THREE.TubeGeometry>();
const rotationArcPointsCache = new Map<'front' | 'back', THREE.Vector3[]>();
let scaleCubeEdgeGeometry: THREE.EdgesGeometry | null = null;

function geometryKey(...values: Array<string | number>): string {
  return values.join(':');
}

export function getCachedSphereGeometry(radius: number, widthSegments: number, heightSegments: number): THREE.SphereGeometry {
  const key = geometryKey(radius, widthSegments, heightSegments);
  let geometry = sphereGeometryCache.get(key);
  if (!geometry) {
    geometry = new THREE.SphereGeometry(radius, widthSegments, heightSegments);
    sphereGeometryCache.set(key, geometry);
  }
  return geometry;
}

export function getCachedConeGeometry(radius: number, height: number, radialSegments: number): THREE.ConeGeometry {
  const key = geometryKey(radius, height, radialSegments);
  let geometry = coneGeometryCache.get(key);
  if (!geometry) {
    geometry = new THREE.ConeGeometry(radius, height, radialSegments);
    coneGeometryCache.set(key, geometry);
  }
  return geometry;
}

export function getCachedBoxGeometry(width: number, height: number, depth: number): THREE.BoxGeometry {
  const key = geometryKey(width, height, depth);
  let geometry = boxGeometryCache.get(key);
  if (!geometry) {
    geometry = new THREE.BoxGeometry(width, height, depth);
    boxGeometryCache.set(key, geometry);
  }
  return geometry;
}

export function getCachedCircleGeometry(radius: number, segments: number): THREE.CircleGeometry {
  const key = geometryKey(radius, segments);
  let geometry = circleGeometryCache.get(key);
  if (!geometry) {
    geometry = new THREE.CircleGeometry(radius, segments);
    circleGeometryCache.set(key, geometry);
  }
  return geometry;
}

export function getCachedRingGeometry(innerRadius: number, outerRadius: number, segments: number): THREE.RingGeometry {
  const key = geometryKey(innerRadius, outerRadius, segments);
  let geometry = ringGeometryCache.get(key);
  if (!geometry) {
    geometry = new THREE.RingGeometry(innerRadius, outerRadius, segments);
    ringGeometryCache.set(key, geometry);
  }
  return geometry;
}

export function getCachedMoveShaftGeometry(axis: GizmoAxis, shaftRadius: number, shaftLength: number): THREE.CylinderGeometry {
  const key = geometryKey(axis, shaftRadius, shaftLength);
  let geometry = moveShaftGeometryCache.get(key);
  if (!geometry) {
    geometry = new THREE.CylinderGeometry(shaftRadius, shaftRadius, shaftLength, 8, 1);
    const colors = new Float32Array(geometry.attributes.position.count * 3);

    const pureCenterColor = axis === 'x' ? '#ff0000' : axis === 'y' ? '#0ce300' : '#0000ff';
    const secondaryColor = axis === 'x' ? '#ff9900' : axis === 'y' ? '#ffcc00' : '#1596ff';

    const startColor = new THREE.Color(pureCenterColor);
    const endColor = new THREE.Color(secondaryColor);
    const tempColor = new THREE.Color();

    for (let i = 0; i < geometry.attributes.position.count; i += 1) {
      const y = geometry.attributes.position.getY(i);
      const normalizedPos = (y + shaftLength / 2) / shaftLength;
      const t = Math.max(0, (normalizedPos - 0.33) / 0.67);
      tempColor.lerpColors(startColor, endColor, t);
      colors[i * 3] = tempColor.r;
      colors[i * 3 + 1] = tempColor.g;
      colors[i * 3 + 2] = tempColor.b;
    }

    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    moveShaftGeometryCache.set(key, geometry);
  }
  return geometry;
}

export function getCachedRotationArcPoints(kind: 'front' | 'back'): THREE.Vector3[] {
  let points = rotationArcPointsCache.get(kind);
  if (!points) {
    points = [];
    const segments = 72;
    if (kind === 'front') {
      const arcAngle = Math.PI / 2;
      for (let i = 0; i <= segments; i += 1) {
        const angle = (i / segments) * arcAngle - arcAngle / 2;
        points.push(new THREE.Vector3(
          Math.cos(angle) * GIZMO_SIZES.ringMajorRadius,
          Math.sin(angle) * GIZMO_SIZES.ringMajorRadius,
          0,
        ));
      }
    } else {
      for (let i = 0; i <= segments; i += 1) {
        const angle = (i / segments) * Math.PI + Math.PI / 2;
        points.push(new THREE.Vector3(
          Math.cos(angle) * GIZMO_SIZES.ringMajorRadius,
          Math.sin(angle) * GIZMO_SIZES.ringMajorRadius,
          0,
        ));
      }
    }
    rotationArcPointsCache.set(kind, points);
  }
  return points;
}

export function getCachedRotationArcGeometry(axis: GizmoAxis): THREE.TubeGeometry {
  let geometry = rotationArcGeometryCache.get(axis);
  if (!geometry) {
    const segments = 72;
    const arcAngle = Math.PI / 2;

    const pureCenterColor = axis === 'x' ? '#ff0000' : axis === 'y' ? '#0ce300' : '#0000ff';
    const arcEndColor = axis === 'x' ? '#ff9900' : axis === 'y' ? '#ffcc00' : '#1596ff';

    const pureColor = new THREE.Color(pureCenterColor);
    const endColor = new THREE.Color(arcEndColor);
    const tempColor = new THREE.Color();

    const points: THREE.Vector3[] = [];
    for (let i = 0; i <= segments; i += 1) {
      const angle = (i / segments) * arcAngle - arcAngle / 2;
      points.push(new THREE.Vector3(
        Math.cos(angle) * GIZMO_SIZES.ringMajorRadius,
        Math.sin(angle) * GIZMO_SIZES.ringMajorRadius,
        0,
      ));
    }

    const curve = new THREE.CatmullRomCurve3(points);
    geometry = new THREE.TubeGeometry(curve, segments, 0.016, 16, false);

    const colors = new Float32Array(geometry.attributes.position.count * 3);
    for (let i = 0; i < geometry.attributes.position.count; i += 1) {
      const x = geometry.attributes.position.getX(i);
      const y = geometry.attributes.position.getY(i);
      const angle = Math.atan2(y, x);
      const normalizedAngle = (angle + arcAngle / 2) / arcAngle;
      const distFromCenter = Math.abs(normalizedAngle - 0.5) * 2;
      const t = Math.max(0, (distFromCenter - 0.4) / 0.6);
      tempColor.lerpColors(pureColor, endColor, t);
      colors[i * 3] = tempColor.r;
      colors[i * 3 + 1] = tempColor.g;
      colors[i * 3 + 2] = tempColor.b;
    }

    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    rotationArcGeometryCache.set(axis, geometry);
  }
  return geometry;
}

export function getCachedScaleCubeEdgeGeometry(): THREE.EdgesGeometry {
  if (!scaleCubeEdgeGeometry) {
    scaleCubeEdgeGeometry = new THREE.EdgesGeometry(getCachedBoxGeometry(1, 1, 1));
  }
  return scaleCubeEdgeGeometry;
}

export function warmTransformGizmoGeometryCache(): void {
  const shaftLength = Math.max(0.3, GIZMO_SIZES.arrowShaftLength);
  const shaftRadius = Math.max(0.008, 0.02);
  const headRadius = Math.max(0.03, GIZMO_SIZES.arrowHeadRadius);
  const headLength = Math.max(0.08, GIZMO_SIZES.arrowHeadLength);
  const pickTipRadius = Math.max(0.14, headRadius * 2.35);

  (['x', 'y', 'z'] as GizmoAxis[]).forEach((axis) => {
    getCachedMoveShaftGeometry(axis, shaftRadius, shaftLength);
    getCachedRotationArcGeometry(axis);
  });

  getCachedSphereGeometry(pickTipRadius, 12, 12);
  getCachedConeGeometry(headRadius, headLength, 8);
  getCachedSphereGeometry(GIZMO_SIZES.centerRadius * 1.08, 24, 24);
  getCachedCircleGeometry(GIZMO_SIZES.centerRadius * 1.05, 32);
  getCachedRingGeometry(GIZMO_SIZES.centerRadius * 1.0, GIZMO_SIZES.centerRadius * 1.05, 32);
  getCachedRingGeometry(GIZMO_SIZES.centerRadius * 1.1, GIZMO_SIZES.centerRadius * 1.32, 32);
  getCachedRotationArcPoints('front');
  getCachedRotationArcPoints('back');
  getCachedSphereGeometry(Math.max(0.18, GIZMO_SIZES.ringDiamondRadius * 0.9), 16, 16);
  getCachedConeGeometry(GIZMO_SIZES.ringDiamondRadius * 0.36, GIZMO_SIZES.ringDiamondRadius, 16);
  getCachedBoxGeometry(GIZMO_SIZES.scaleHexagonRadius * 2.3, GIZMO_SIZES.scaleHexagonRadius * 2.3, GIZMO_SIZES.scaleHexagonRadius * 2.3);
  getCachedBoxGeometry(1, 1, 1);
  getCachedScaleCubeEdgeGeometry();
}
