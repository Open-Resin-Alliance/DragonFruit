import React, { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { useHoveredIslandId } from '@/volumeAnalysis/Islands/hoverStore';
import { type IslandInstances } from '@/volumeAnalysis/Islands/islandInstances';

/**
 * Renders island contact footprints as instanced discs.
 *
 * This replaced the surface-dot decal (`IslandSurfaceDotsOverlay`), which
 * painted the model's own geometry by looping over a Z-sorted marker texture
 * per fragment — capped at 80 markers and four islands per fragment, and
 * costing O(markers in a 6 mm band) on every fragment of the model, twice.
 *
 * Here each contact voxel is one instance of a two-triangle quad rounded off
 * in the fragment shader. The whole island set is one draw call, nothing is
 * capped, and the per-fragment cost is constant regardless of how many islands
 * are on screen.
 *
 * A disc never draws smaller than `MIN_SCREEN_RADIUS_CSS_PX`: a contact voxel is
 * a fraction of a millimetre across, so zooming out walks it under a pixel and
 * a quad that covers no fragment centre draws nothing at all, dropping whole
 * islands out of the frame instead of shrinking them.
 *
 * The instance positions are world-space (the frame the detectors emit and
 * `StlMesh` places the model in), so this MUST be mounted at the scene root
 * with an identity transform. Mounting it inside the model group — as the
 * decal could afford to, because it redrew the model's own local geometry —
 * would apply the model transform twice.
 *
 * Clipping planes are world-space Z planes and work unchanged.
 */

interface IslandInstancesOverlayProps {
  instances: IslandInstances;
  selectedIslandId?: number | null;
  clipLower?: number | null;
  clipUpper?: number | null;
  opacity?: number;
}

const VERTEX_SHADER = `
  #include <clipping_planes_pars_vertex>

  attribute vec4 aCenterRadius; // x, y, z (world mm), disc radius (mm)
  attribute vec2 aMeta;         // markerId, type

  uniform float uSelectedIslandId;
  uniform vec2 uViewportPx;     // drawing buffer size, device pixels
  uniform float uMinScreenRadiusPx;

  varying vec2 vDisc;
  varying float vMarkerId;
  varying float vType;

  void main() {
    // Unit quad in [-1, 1] — the disc is carved out of it in the fragment stage.
    vDisc = position.xy;
    vMarkerId = aMeta.x;
    vType = aMeta.y;

    #ifdef OCCLUDED_PASS
    // This pass draws only the selected island, through the model. Parking the
    // rest outside clip space beats uploading the instances a second time.
    if (abs(aMeta.x - uSelectedIslandId) > 0.5) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    #endif

    vec3 center = aCenterRadius.xyz;
    float radius = aCenterRadius.w;

    vec4 centerClip = projectionMatrix * viewMatrix * modelMatrix * vec4(center, 1.0);

    // Keep a disc on screen once its world radius projects below a couple of
    // pixels. A contact voxel is a fraction of a millimetre across, so zooming
    // out walks it under a pixel, and a quad that covers no fragment centre
    // draws nothing at all: the island pops out entirely rather than shrinking.
    //
    // The probe offset is the camera's right axis rather than the disc's own
    // plane. It is always perpendicular to the view, so the measured
    // pixels-per-mm cannot collapse to zero and the grow factor stays bounded —
    // measured in the disc's plane, an edge-on plate would divide by ~0 and
    // inflate the quad across the screen.
    vec3 cameraRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec4 probeClip = projectionMatrix * viewMatrix * modelMatrix * vec4(center + cameraRight * radius, 1.0);
    vec2 centerNdc = centerClip.xy / centerClip.w;
    vec2 probeNdc = probeClip.xy / probeClip.w;
    float radiusPx = length(probeNdc - centerNdc) * 0.5 * uViewportPx.y;
    float grow = max(1.0, uMinScreenRadiusPx / max(radiusPx, 1e-6));

    vec4 worldPos = modelMatrix * vec4(center + vec3(position.xy * radius * grow, 0.0), 1.0);
    vec4 mvPosition = viewMatrix * worldPos;
    gl_Position = projectionMatrix * mvPosition;

    #include <clipping_planes_vertex>
  }
`;

const FRAGMENT_SHADER = `
  #include <clipping_planes_pars_fragment>

  uniform float uOpacity;
  uniform float uTime;
  uniform float uSelectedIslandId;
  uniform float uHoveredIslandId;

  varying vec2 vDisc;
  varying float vMarkerId;
  varying float vType;

  out vec4 fragColor;

  const vec3 COLOR_VOXEL = vec3(0.53, 0.81, 0.98);
  const vec3 COLOR_MINIMA = vec3(0.0, 1.0, 0.0);
  const vec3 COLOR_INTERSECTION = vec3(1.0, 0.0, 0.0);
  const vec3 COLOR_CONSOLIDATED = vec3(0.53, 0.81, 0.98);
  const vec3 COLOR_SELECTED_OCCLUDED = vec3(1.0, 0.4, 0.0);
  const vec3 COLOR_SELECTED_VISIBLE = vec3(1.0, 1.0, 0.0);
  const vec3 COLOR_HOVERED = vec3(0.0, 1.0, 1.0);

  void main() {
    #include <clipping_planes_fragment>

    float dist = length(vDisc);
    // Antialias against the disc's own screen-space footprint, so a disc that
    // lands under a pixel still reads as a dot instead of dropping out.
    float edge = max(fwidth(dist), 0.0001);
    float coverage = 1.0 - smoothstep(1.0 - edge, 1.0, dist);
    if (coverage <= 0.002) discard;

    bool isSelected = uSelectedIslandId >= 0.0 && abs(vMarkerId - uSelectedIslandId) < 0.5;
    bool isHovered = uHoveredIslandId >= 0.0 && abs(vMarkerId - uHoveredIslandId) < 0.5;

    vec3 color;
    if (isSelected) {
      #ifdef OCCLUDED_PASS
      color = COLOR_SELECTED_OCCLUDED;
      #else
      color = mix(COLOR_SELECTED_VISIBLE, vec3(1.0), (0.4 + 0.3 * sin(uTime * 8.0)) * 0.3);
      #endif
    } else if (isHovered) {
      color = mix(COLOR_HOVERED, vec3(1.0), (0.5 + 0.5 * sin(uTime * 12.0)) * 0.4);
    } else if (vType > 2.5) {
      color = COLOR_CONSOLIDATED;
    } else if (vType > 1.5) {
      color = COLOR_INTERSECTION;
    } else if (vType > 0.5) {
      color = COLOR_MINIMA;
    } else {
      color = COLOR_VOXEL;
    }

    fragColor = vec4(color, coverage * uOpacity);
  }
`;

/**
 * On-screen radius, in CSS pixels, that a contact voxel's disc never shrinks
 * below. A footprint disc is a fraction of a millimetre across (half the scan
 * pixel size), so at anything but a close view it projects under a pixel and the
 * quad covers no fragment centre: the island does not get smaller, it drops out
 * of the frame entirely as the camera pulls back.
 *
 * Two pixels keeps a dot legible and gives the fragment stage enough samples for
 * its own antialiasing to resolve, while staying small enough that islands keep
 * reading as their detected area where they are big enough to.
 */
const MIN_SCREEN_RADIUS_CSS_PX = 2;

/** World bounds of the whole instance set, so frustum culling can drop it. */
function instanceBounds(instances: IslandInstances): THREE.Sphere {
  const data = instances.centerRadius;
  if (instances.count === 0) return new THREE.Sphere();

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let maxRadius = 0;

  for (let i = 0; i < instances.count; i++) {
    const x = data[i * 4];
    const y = data[i * 4 + 1];
    const z = data[i * 4 + 2];
    const r = data[i * 4 + 3];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
    if (r > maxRadius) maxRadius = r;
  }

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;
  const dx = maxX - cx;
  const dy = maxY - cy;
  const dz = maxZ - cz;
  return new THREE.Sphere(new THREE.Vector3(cx, cy, cz), Math.sqrt(dx * dx + dy * dy + dz * dz) + maxRadius);
}

export function IslandInstancesOverlay({
  instances,
  selectedIslandId,
  clipLower,
  clipUpper,
  opacity = 0.9,
}: IslandInstancesOverlayProps) {
  const gl = useThree((state) => state.gl);
  const hoveredIslandId = useHoveredIslandId();

  const clippingPlanes = useMemo(() => {
    const planes: THREE.Plane[] = [];
    if (clipLower != null) {
      planes.push(new THREE.Plane(new THREE.Vector3(0, 0, 1), -clipLower));
    }
    if (clipUpper != null) {
      planes.push(new THREE.Plane(new THREE.Vector3(0, 0, -1), clipUpper));
    }
    return planes;
  }, [clipLower, clipUpper]);

  const geometry = useMemo(() => {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute('aCenterRadius', new THREE.InstancedBufferAttribute(instances.centerRadius, 4));
    g.setAttribute('aMeta', new THREE.InstancedBufferAttribute(instances.meta, 2));
    g.instanceCount = instances.count;
    // Without this the bounds come from the unit quad and the overlay is culled
    // as soon as the origin leaves the frustum.
    g.boundingSphere = instanceBounds(instances);
    return g;
  }, [instances]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  const uniforms = useMemo(
    () => ({
      uOpacity: { value: opacity },
      uTime: { value: 0 },
      uSelectedIslandId: { value: selectedIslandId ?? -1 },
      uHoveredIslandId: { value: hoveredIslandId ?? -1 },
      uViewportPx: { value: new THREE.Vector2(1, 1) },
      uMinScreenRadiusPx: { value: MIN_SCREEN_RADIUS_CSS_PX },
    }),
    // Mutated in place below; a stable identity keeps the materials compiled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useLayoutEffect(() => {
    uniforms.uOpacity.value = opacity;
    uniforms.uSelectedIslandId.value = selectedIslandId ?? -1;
    uniforms.uHoveredIslandId.value = hoveredIslandId ?? -1;
  }, [uniforms, opacity, selectedIslandId, hoveredIslandId]);

  // Device pixels, because that is what rasterization coverage is counted in.
  // The floor itself is expressed in CSS pixels so it renders the same size at
  // any device pixel ratio.
  const dpr = useThree((state) => state.viewport.dpr);
  const size = useThree((state) => state.size);
  useLayoutEffect(() => {
    const drawingBuffer = new THREE.Vector2();
    gl.getDrawingBufferSize(drawingBuffer);
    uniforms.uViewportPx.value.copy(drawingBuffer);
    uniforms.uMinScreenRadiusPx.value = MIN_SCREEN_RADIUS_CSS_PX * dpr;
  }, [gl, size, dpr, uniforms]);

  const timerRef = useRef(new THREE.Timer());
  useFrame(() => {
    timerRef.current.update();
    uniforms.uTime.value = timerRef.current.getElapsed();
  });

  const occludedMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        clipping: true,
        clippingPlanes,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -1.0,
        polygonOffsetUnits: -4.0,
        defines: { OCCLUDED_PASS: true },
        uniforms,
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
      }),
    [clippingPlanes, uniforms],
  );

  const visibleMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        transparent: true,
        depthTest: true,
        depthWrite: false,
        clipping: true,
        clippingPlanes,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -1.0,
        polygonOffsetUnits: -4.0,
        uniforms,
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
      }),
    [clippingPlanes, uniforms],
  );

  useEffect(
    () => () => {
      occludedMaterial.dispose();
      visibleMaterial.dispose();
    },
    [occludedMaterial, visibleMaterial],
  );

  if (instances.count === 0) return null;

  const isSelectedActive = selectedIslandId != null && selectedIslandId >= 0;

  return (
    <>
      {/* Occluded pass: the selected island, drawn through the model. */}
      {isSelectedActive && (
        <mesh geometry={geometry} material={occludedMaterial} renderOrder={999} raycast={() => null} />
      )}

      {/* Visible pass: every island, depth-tested against the model. */}
      <mesh geometry={geometry} material={visibleMaterial} renderOrder={1000} raycast={() => null} />
    </>
  );
}

export default IslandInstancesOverlay;
