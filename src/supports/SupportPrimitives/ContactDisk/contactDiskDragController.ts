import * as THREE from 'three';
import { calculateSmoothedNormal } from '../../PlacementLogic/PlacementUtils';
import type { Vec3 } from '../../types';

export interface ContactDiskDragHit {
    point: Vec3;
    surfaceNormal: Vec3;
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
}

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
    const { camera, domElement, scene, onHit, onEnd, initialEvent, modelId } = options;
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let stopped = false;

    const processPointerEvent = (event: PointerEvent | MouseEvent | any) => {
        const pointerPosition = getPointerClientPosition(event);
        if (!pointerPosition) return;

        const rect = domElement.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;

        pointer.x = ((pointerPosition.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((pointerPosition.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);

        const modelMeshes = collectModelMeshes(scene, modelId);
        if (modelMeshes.length === 0) return;

        const hits = raycaster.intersectObjects(modelMeshes, true);
        const hit = hits[0];
        if (!hit) return;

        onHit({
            point: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
            surfaceNormal: calculateSmoothedNormal(hit),
        });
    };

    const handlePointerMove = (event: PointerEvent) => {
        if (stopped) return;
        processPointerEvent(event);
    };

    const stop = () => {
        if (stopped) return;
        stopped = true;
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
