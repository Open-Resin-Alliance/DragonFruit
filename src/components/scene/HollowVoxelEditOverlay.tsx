import React from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';

type HollowVoxelEditOverlayProps = {
  voxelCenters: Float32Array;
  blockedVoxelCenters?: Float32Array;
  voxelRadiusMm: number;
  blockedVoxelIndexSet: Set<number>;
  meshOffset: THREE.Vector3;
  onToggleVoxel?: (voxelIndex: number) => void;
};

const YELLOW = '#ffd928';
const BLUE = '#3f8fff';
const YELLOW_COLOR = new THREE.Color(YELLOW);
const BLUE_COLOR = new THREE.Color(BLUE);

const VOXEL_POINTS_VERTEX_SHADER = `
attribute vec3 color;

uniform float uRadius;
uniform float uViewportHeight;
uniform float uPixelRatio;
uniform float uIsPerspective;

varying vec3 vColor;
varying vec3 vViewCenter;
varying float vViewRadius;

void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  float scaleX = length(modelMatrix[0].xyz);
  float scaleY = length(modelMatrix[1].xyz);
  float scaleZ = length(modelMatrix[2].xyz);
  float scaledRadius = uRadius * max(max(scaleX, scaleY), scaleZ);

  float pointSize = scaledRadius * uViewportHeight * uPixelRatio * projectionMatrix[1][1];
  if (uIsPerspective > 0.5) {
    pointSize /= max(1e-6, -mvPosition.z);
  }

  gl_PointSize = max(pointSize, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  vColor = color;
  vViewCenter = mvPosition.xyz;
  vViewRadius = scaledRadius;
}
`;

const VOXEL_POINTS_FRAGMENT_SHADER = `
uniform float uOpacity;
uniform mat4 uProjectionMatrix;

varying vec3 vColor;
varying vec3 vViewCenter;
varying float vViewRadius;

void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float radiusSq = dot(uv, uv);
  if (radiusSq > 1.0) {
    discard;
  }

  float sphereZ = sqrt(max(0.0, 1.0 - radiusSq));
  vec3 normal = normalize(vec3(uv.x, -uv.y, sphereZ));

  // Soft front lighting: light from upper-right with gentle contrast.
  vec3 lightDir = normalize(vec3(-0.35, 0.50, 0.79));
  float diffuse = 0.40 + max(dot(normal, lightDir), 0.0) * 0.60;
  // Gentle rim to separate overlapping spheres.
  float rim = pow(1.0 - max(normal.z, 0.0), 2.5) * 0.12;

  vec3 shaded = vColor * (diffuse + rim);

  gl_FragColor = vec4(shaded, uOpacity);
}
`;

function buildVoxelPositions(
  voxelCenters: Float32Array,
  offsetX: number,
  offsetY: number,
  offsetZ: number,
): Float32Array {
  const positions = new Float32Array(voxelCenters.length);
  for (let offset = 0; offset < voxelCenters.length; offset += 3) {
    positions[offset] = voxelCenters[offset] + offsetX;
    positions[offset + 1] = voxelCenters[offset + 1] + offsetY;
    positions[offset + 2] = voxelCenters[offset + 2] + offsetZ;
  }
  return positions;
}

function buildVoxelColors(count: number, blockedVoxelIndexSet: Set<number>): Float32Array {
  const colors = new Float32Array(count * 3);
  for (let index = 0; index < count; index += 1) {
    const base = index * 3;
    const color = blockedVoxelIndexSet.has(index) ? BLUE_COLOR : YELLOW_COLOR;
    colors[base] = color.r;
    colors[base + 1] = color.g;
    colors[base + 2] = color.b;
  }
  return colors;
}

export function HollowVoxelEditOverlay({
  voxelCenters,
  blockedVoxelCenters,
  voxelRadiusMm,
  blockedVoxelIndexSet,
  meshOffset,
  onToggleVoxel,
}: HollowVoxelEditOverlayProps) {
  const { camera, gl, size } = useThree();
  const pointsRef = React.useRef<THREE.Points>(null);
  const removedCount = Math.floor(voxelCenters.length / 3);
  const blockedCount = blockedVoxelCenters
    ? Math.floor(blockedVoxelCenters.length / 3)
    : 0;
  const totalCount = removedCount + blockedCount;

  // Merge removed + blocked positions into one buffer.
  const mergedPositions = React.useMemo(() => {
    const merged = new Float32Array(totalCount * 3);
    const base = buildVoxelPositions(voxelCenters, meshOffset.x, meshOffset.y, meshOffset.z);
    merged.set(base, 0);
    if (blockedVoxelCenters && blockedCount > 0) {
      const blockedPos = buildVoxelPositions(blockedVoxelCenters, meshOffset.x, meshOffset.y, meshOffset.z);
      merged.set(blockedPos, removedCount * 3);
    }
    return merged;
  }, [blockedCount, blockedVoxelCenters, meshOffset.x, meshOffset.y, meshOffset.z, removedCount, voxelCenters]);

  // blockedVoxelIndexSet includes instance indices for both removed and
  // blocked-only voxels (mapped by the parent via the editing set).
  const colors = React.useMemo(
    () => buildVoxelColors(totalCount, blockedVoxelIndexSet),
    [blockedVoxelIndexSet, totalCount],
  );

  const geometry = React.useMemo(() => {
    const next = new THREE.BufferGeometry();
    next.setAttribute('position', new THREE.BufferAttribute(mergedPositions, 3));
    next.setAttribute('color', new THREE.BufferAttribute(colors.slice(), 3));
    return next;
  }, [colors, mergedPositions]);

  const material = React.useMemo(() => (
    new THREE.ShaderMaterial({
      uniforms: {
        uRadius: { value: Math.max(voxelRadiusMm, 0.05) },
        uViewportHeight: { value: 1 },
        uPixelRatio: { value: gl.getPixelRatio() },
        uIsPerspective: { value: 1 },
        uOpacity: { value: 0.999 },
        uProjectionMatrix: { value: new THREE.Matrix4() },
      },
      vertexShader: VOXEL_POINTS_VERTEX_SHADER,
      fragmentShader: VOXEL_POINTS_FRAGMENT_SHADER,
      transparent: true,
      depthTest: true,
      depthWrite: true,
      toneMapped: false,
    })
  ), [gl, voxelRadiusMm]);

  React.useEffect(() => () => {
    geometry.dispose();
    material.dispose();
  }, [geometry, material]);

  React.useEffect(() => {
    const colorAttr = geometry.getAttribute('color');
    if (!(colorAttr instanceof THREE.BufferAttribute)) return;
    (colorAttr.array as Float32Array).set(colors);
    colorAttr.needsUpdate = true;
  }, [colors, geometry]);

  React.useEffect(() => {
    material.uniforms.uRadius.value = Math.max(voxelRadiusMm, 0.05);
    material.uniforms.uViewportHeight.value = size.height;
    material.uniforms.uPixelRatio.value = gl.getPixelRatio();
    material.uniforms.uIsPerspective.value = camera instanceof THREE.PerspectiveCamera ? 1 : 0;
    material.uniforms.uProjectionMatrix.value.copy(camera.projectionMatrix);
  }, [camera, gl, material, size.height, voxelRadiusMm]);

  const handlePointsRaycast = React.useCallback((raycaster: THREE.Raycaster, intersects: THREE.Intersection[]) => {
    const points = pointsRef.current;
    if (!points) return;

    const previousThreshold = raycaster.params.Points.threshold;
    raycaster.params.Points.threshold = Math.max(0.05, voxelRadiusMm * 1.15);
    try {
      THREE.Points.prototype.raycast.call(points, raycaster, intersects);
    } finally {
      raycaster.params.Points.threshold = previousThreshold;
    }
  }, [voxelRadiusMm]);

  return (
    <points
      ref={pointsRef}
      geometry={geometry}
      raycast={handlePointsRaycast}
      renderOrder={30001}
      frustumCulled={false}
      onClick={(event) => {
        if (typeof event.index !== 'number') return;
        event.stopPropagation();
        onToggleVoxel?.(event.index);
      }}
    >
      <primitive object={material} attach="material" />
    </points>
  );
}
