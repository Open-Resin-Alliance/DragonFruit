import React, { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import type { ModelTransform } from '@/hooks/useModelTransform';
import { quaternionFromGlobalEuler } from '@/utils/rotation';
import { ensureProtectedMask, getProtectedMask, triangleCount } from './logic/protectedMask';

interface ProtectedFacePaintToolProps {
  models: LoadedModel[];
  activeModelId: string | null;
  activeTransform?: ModelTransform;
  /** Erase instead of paint (e.g. when a modifier is held). */
  erase?: boolean;
  /** Brush radius in mm (world space). */
  brushRadiusMm?: number;
  /** Notified after the mask changes so the UI can refresh counts. */
  onMaskChange?: () => void;
}

const DEFAULT_BRUSH_MM = 3;
const PROTECT_COLOR = new THREE.Color('#ff5b5b');

/**
 * Brush tool for painting the per-triangle "protected" (keep support-free) mask.
 *
 * It renders an invisible pickable copy of the active model in the model's
 * world transform, captures pointer drags, and flips mask bits for the hit
 * triangle plus neighbours within the brush radius. Protected triangles are
 * shown as a translucent red overlay rebuilt whenever the mask changes.
 */
export function ProtectedFacePaintTool({
  models,
  activeModelId,
  activeTransform,
  erase = false,
  brushRadiusMm = DEFAULT_BRUSH_MM,
  onMaskChange,
}: ProtectedFacePaintToolProps) {
  const { gl, camera } = useThree();
  const activeModel = useMemo(() => models.find((m) => m.id === activeModelId), [models, activeModelId]);
  const transform = activeTransform || activeModel?.transform;
  const paintingRef = useRef(false);
  // Bumped after each imperative mask edit so the derived overlay recomputes.
  const [maskRev, setMaskRev] = React.useState(0);
  // Brush cursor: hover point + surface normal in the mesh's *local* frame
  // (i.e. inside the meshLocalOffset group), so the ring tracks the cursor.
  const [hover, setHover] = React.useState<{ point: THREE.Vector3; normal: THREE.Vector3 } | null>(null);

  const geometry = activeModel?.geometry.geometry;

  // Local-frame centroids of every triangle, cached for brush-radius spreading.
  const centroids = useMemo(() => {
    if (!geometry) return null;
    const pos = geometry.getAttribute('position');
    const index = geometry.getIndex();
    const count = triangleCount(geometry);
    const out = new Float32Array(count * 3);
    const vi = (t: number, k: number) => (index ? index.getX(t * 3 + k) : t * 3 + k);
    for (let t = 0; t < count; t++) {
      const a = vi(t, 0);
      const b = vi(t, 1);
      const c = vi(t, 2);
      out[t * 3] = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3;
      out[t * 3 + 1] = (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3;
      out[t * 3 + 2] = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
    }
    return out;
  }, [geometry]);

  // Mesh-local offset so the pickable mesh matches how the model is rendered
  // (models are drawn centered on their bbox center, then transformed).
  const meshLocalOffset = useMemo(() => {
    if (!geometry) return new THREE.Vector3();
    const bbox =
      geometry.boundingBox ??
      new THREE.Box3().setFromBufferAttribute(geometry.getAttribute('position') as THREE.BufferAttribute);
    const center = bbox.getCenter(new THREE.Vector3());
    return new THREE.Vector3(-center.x, -center.y, -center.z);
  }, [geometry]);

  // Derived overlay geometry of the currently-protected triangles. Recomputed
  // when the geometry or the mask revision changes (maskRev is bumped on paint).
  //
  // We intentionally do NOT manually dispose the previous geometry: tying
  // .dispose() to an effect cleanup (or doing it in render) is unsafe under React
  // StrictMode in dev, which double-invokes and would dispose the *live*
  // geometry while it is still rendered — making the red overlay flicker/vanish
  // after toggling paint, exactly the reported symptom. These overlay buffers are
  // tiny and short-lived; letting GC reclaim them is the correct trade-off.
  const overlayGeom = useMemo(() => {
    void maskRev;
    if (!geometry) return null;
    const mask = getProtectedMask(geometry);
    if (!mask) return null;
    const pos = geometry.getAttribute('position');
    const index = geometry.getIndex();
    const count = triangleCount(geometry);
    const verts: number[] = [];
    const vi = (t: number, k: number) => (index ? index.getX(t * 3 + k) : t * 3 + k);
    for (let t = 0; t < count; t++) {
      if (!mask[t]) continue;
      for (let k = 0; k < 3; k++) {
        const v = vi(t, k);
        verts.push(pos.getX(v), pos.getY(v), pos.getZ(v));
      }
    }
    if (verts.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    return g;
  }, [geometry, maskRev]);

  const paintAt = React.useCallback(
    (faceIndex: number | null | undefined) => {
      if (!geometry || faceIndex == null || !centroids) return;
      const mask = ensureProtectedMask(geometry);
      const value = erase ? 0 : 1;
      const r2 = brushRadiusMm * brushRadiusMm;
      const cx = centroids[faceIndex * 3];
      const cy = centroids[faceIndex * 3 + 1];
      const cz = centroids[faceIndex * 3 + 2];

      let changed = false;
      for (let t = 0; t < mask.length; t++) {
        const dx = centroids[t * 3] - cx;
        const dy = centroids[t * 3 + 1] - cy;
        const dz = centroids[t * 3 + 2] - cz;
        if (dx * dx + dy * dy + dz * dz <= r2) {
          if (mask[t] !== value) {
            mask[t] = value;
            changed = true;
          }
        }
      }
      if (changed) {
        setMaskRev((r) => r + 1);
        onMaskChange?.();
      }
    },
    [geometry, centroids, erase, brushRadiusMm, onMaskChange],
  );

  // Hidden pick mesh (exact model transform, scale 1.0). We don't rely on r3f's
  // pointer events for it — the model's own StlMesh stops event propagation,
  // which made our handlers fire unreliably and the cursor flicker in/out.
  // Instead we raycast against this mesh ourselves on every pointer move, so we
  // are completely independent of the scene's event competition.
  const pickMeshRef = useRef<THREE.Mesh | null>(null);

  useEffect(() => {
    const dom = gl.domElement;
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();

    const cast = (ev: PointerEvent) => {
      const mesh = pickMeshRef.current;
      if (!mesh) return null;
      const rect = dom.getBoundingClientRect();
      ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, camera);
      const hit = raycaster.intersectObject(mesh, false)[0];
      if (!hit) return null;
      const localPoint = mesh.worldToLocal(hit.point.clone());
      const normal = hit.face ? hit.face.normal.clone().normalize() : new THREE.Vector3(0, 0, 1);
      return { localPoint, normal, faceIndex: hit.faceIndex };
    };

    const onMove = (ev: PointerEvent) => {
      const r = cast(ev);
      if (!r) { setHover(null); return; }
      setHover({ point: r.localPoint, normal: r.normal });
      if (paintingRef.current) paintAt(r.faceIndex);
    };
    const onDown = (ev: PointerEvent) => {
      if (ev.button !== 0) return;
      const r = cast(ev);
      if (!r) return;
      // We have a model hit — claim the gesture and stop the scene from also
      // treating this as a model-select/transform click.
      ev.stopPropagation();
      paintingRef.current = true;
      setHover({ point: r.localPoint, normal: r.normal });
      paintAt(r.faceIndex);
    };
    const onUp = () => { paintingRef.current = false; };

    // Capture phase so we run before r3f's own canvas listeners.
    dom.addEventListener('pointermove', onMove);
    dom.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointerup', onUp);
    return () => {
      dom.removeEventListener('pointermove', onMove);
      dom.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointerup', onUp);
    };
  }, [gl, camera, paintAt]);

  if (!activeModel || !transform || !geometry) return null;

  const quaternion = quaternionFromGlobalEuler(transform.rotation);

  return (
    <group position={transform.position} quaternion={quaternion} scale={transform.scale}>
      <group position={meshLocalOffset}>
        {/* Hidden pick surface (raycast manually via the effect above). */}
        <mesh ref={pickMeshRef} geometry={geometry} visible={false} />

        {/* Protected-face highlight (non-pickable so it never steals brush rays) */}
        {overlayGeom && (
          <mesh geometry={overlayGeom} renderOrder={2} raycast={() => null}>
            <meshBasicMaterial
              color={PROTECT_COLOR}
              transparent
              opacity={0.5}
              side={THREE.DoubleSide}
              depthTest={false}
            />
          </mesh>
        )}

        {/* Brush cursor: a ring on the surface showing where/how big the brush is. */}
        {hover && (
          <BrushCursor
            point={hover.point}
            normal={hover.normal}
            radius={brushRadiusMm}
            erase={erase}
          />
        )}
      </group>
    </group>
  );
}

/** Surface ring + dot showing the brush footprint at the hover point. */
function BrushCursor({
  point,
  normal,
  radius,
  erase,
}: {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  radius: number;
  erase: boolean;
}) {
  const quaternion = useMemo(() => {
    const q = new THREE.Quaternion();
    q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal.clone().normalize());
    return q;
  }, [normal]);

  // Lift slightly off the surface (along the normal) to avoid z-fighting.
  const lift = Math.max(0.02, radius * 0.02);
  const position = useMemo(
    () => point.clone().addScaledVector(normal.clone().normalize(), lift),
    [point, normal, lift],
  );

  const ringInner = Math.max(0.01, radius * 0.92);
  const color = erase ? CURSOR_ERASE_COLOR : CURSOR_PAINT_COLOR;

  return (
    <group position={position} quaternion={quaternion} raycast={() => null}>
      <mesh renderOrder={99999}>
        <ringGeometry args={[ringInner, radius, 48]} />
        <meshBasicMaterial color={color} transparent opacity={0.9} depthTest={false} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <mesh renderOrder={99999}>
        <circleGeometry args={[radius, 48]} />
        <meshBasicMaterial color={color} transparent opacity={0.12} depthTest={false} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

const CURSOR_PAINT_COLOR = new THREE.Color('#ff5b5b');
const CURSOR_ERASE_COLOR = new THREE.Color('#9ca3af');
