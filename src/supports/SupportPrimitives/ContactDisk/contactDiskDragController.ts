import * as THREE from 'three';
import { calculateSmoothedNormal } from '../../PlacementLogic/PlacementUtils';
import type { Vec3 } from '../../types';
import { getClipBounds } from '@/components/scene/SceneCanvas/clipBoundsStore';

export interface ContactDiskDragHit {
    point: Vec3;
    surfaceNormal: Vec3;
    mesh?: THREE.Mesh;
}

export interface ContactDiskDragSession {
    stop: () => void;
}

interface ContactDiskDragSessionOptions {
    camera: THREE.Camera;
    domElement: HTMLElement;
    scene: THREE.Object3D;
    onHit: (hit: ContactDiskDragHit) => void;
    onEnd?: () => void;
    initialEvent?: PointerEvent | MouseEvent | any;
    modelId?: string | null;
    placementSurface?: 'interior' | 'exterior';
}

const _interiorCavityRaycaster = new THREE.Raycaster();
const _interiorCavityRaycastMesh = new THREE.Mesh();

function extractPointerButton(event: any): number | undefined {
    return event?.button ?? event?.nativeEvent?.button;
}

function getPointerClientPosition(event: any): { clientX: number; clientY: number } | null {
    const candidate = event?.nativeEvent ?? event?.sourceEvent ?? event;
    const clientX = candidate?.clientX;
    const clientY = candidate?.clientY;
    if (typeof clientX !== 'number' || typeof clientY !== 'number') return null;
    return { clientX, clientY };
}

function isMeshCandidate(object: THREE.Object3D): object is THREE.Mesh {
    return object instanceof THREE.Mesh && !!object.geometry;
}

function collectModelMeshes(root: THREE.Object3D, targetModelId?: string | null): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    root.traverse((child) => {
        if (!isMeshCandidate(child)) return;
        const modelId = (child.userData as any)?.modelId;
        if (!modelId) return;
        if (targetModelId && modelId !== targetModelId) return;
        if ((child.parent?.userData as any)?.modelId) return;
        meshes.push(child);
    });
    return meshes;
}

export function startContactDiskDragSession(options: ContactDiskDragSessionOptions): ContactDiskDragSession {
    const { camera, domElement, scene, onHit, onEnd, initialEvent, modelId, placementSurface } = options;
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const modelMeshes = collectModelMeshes(scene, modelId);
    let stopped = false;
    let rafId: number | null = null;
    let pendingEvent: PointerEvent | MouseEvent | null = null;

    const findInteriorCavityHit = (
        ray: THREE.Ray,
        modelMesh: THREE.Object3D,
        cavityGeometry: THREE.BufferGeometry,
        targetModelId: string,
    ): THREE.Intersection | null => {
        const rc = _interiorCavityRaycaster;
        rc.ray.copy(ray);
        rc.near = 0;
        rc.far = 500;
        (rc as any).firstHitOnly = true;

        const mesh = _interiorCavityRaycastMesh;
        mesh.geometry = cavityGeometry;
        mesh.matrixWorld.copy(modelMesh.matrixWorld);
        mesh.matrixAutoUpdate = false;
        mesh.userData = {
            modelId: targetModelId,
            supportPlacementSurface: 'interior',
            cavityGeometry,
        };

        const hits: THREE.Intersection[] = [];
        mesh.raycast(rc, hits);

        rc.near = 0;
        rc.far = Infinity;
        (rc as any).firstHitOnly = false;

        if (hits.length === 0) return null;
        const hit = hits[0];
        hit.object = mesh;
        return hit;
    };

    const processPointerEvent = (event: PointerEvent | MouseEvent | any) => {
        const pointerPosition = getPointerClientPosition(event);
        if (!pointerPosition) return;

        const rect = domElement.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;

        pointer.x = ((pointerPosition.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((pointerPosition.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);

        if (modelMeshes.length === 0) return;

        const hits = raycaster.intersectObjects(modelMeshes, true);
        let hit = hits[0];
        if (!hit) return;

        if (placementSurface === 'interior') {
            const cavityGeometry = (hit.object.userData as any)?.cavityGeometry as THREE.BufferGeometry | undefined;
            const hitModelId = (hit.object.userData as any)?.modelId as string | undefined;
            if (cavityGeometry && hitModelId) {
                const interiorHit = findInteriorCavityHit(raycaster.ray, hit.object, cavityGeometry, hitModelId);
                if (interiorHit) {
                    hit = interiorHit;
                }
            }
        }

        // If the hit is in the clipped (invisible) zone, skip past it to
        // find the visible inner wall so contact disks attach correctly
        // when editing supports inside a cross-section view.
        const { clipLower, clipUpper } = getClipBounds();
        const clipped =
          (clipUpper != null && hit.point.z > clipUpper) ||
          (clipLower != null && hit.point.z < clipLower);
        if (clipped) {
          // Find first hit within visible bounds
          let fallback: THREE.Intersection | null = null;
          for (let i = 1; i < hits.length; i++) {
            const h = hits[i];
            if (clipUpper != null && h.point.z > clipUpper) continue;
            if (clipLower != null && h.point.z < clipLower) continue;
            fallback = h;
            break;
          }
          if (!fallback) return;
          hit = fallback;
        }

        onHit({
            point: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
            surfaceNormal: calculateSmoothedNormal(hit),
            mesh: hit.object instanceof THREE.Mesh ? hit.object : undefined,
        });
    };

    const handlePointerMove = (event: PointerEvent) => {
        if (stopped) return;
        pendingEvent = event;
        if (rafId === null) {
            rafId = requestAnimationFrame(() => {
                rafId = null;
                if (pendingEvent && !stopped) {
                    processPointerEvent(pendingEvent);
                    pendingEvent = null;
                }
            });
        }
    };

    const stop = () => {
        if (stopped) return;
        stopped = true;
        if (rafId !== null) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }
        window.removeEventListener('pointermove', handlePointerMove, true);
        if (onEnd) onEnd();
    };

    window.addEventListener('pointermove', handlePointerMove, true);
    if (getPointerClientPosition(initialEvent)) {
        processPointerEvent(initialEvent);
    }

    return { stop };
}

export function isPrimaryPointerPress(event: any) {
    const button = extractPointerButton(event);
    return button === undefined || button === 0;
}

export type { ContactDiskDragSessionOptions };
