/**
 * Auto-support worker: protocol and the worker's body.
 *
 * The plan is already pure with respect to the *stores* it writes (one commit
 * at the end, see `supportDraft.ts`), but it still reads three pieces of
 * module state: the settings store, the support snapshot and the model mesh.
 * A worker thread has its own copies of those, so every run seeds them from
 * the payload first. That seeding is what makes the worker's answer identical
 * to the main thread's rather than merely similar, and
 * `__tests__/autoPlaceWorker.test.ts` pins that equality.
 *
 * The body lives here rather than in the worker shell so it can be exercised
 * in-process; the shell is `autoPlace.worker.ts`.
 */

import * as THREE from 'three';
import { accelerateGeometry, initializeBVH } from '@/utils/bvh';
import type { DetectedIsland } from '@/volumeAnalysis/Islands/types';
import { setSnapshot } from '../state';
import { setSettings } from '../Settings/state';
import type { SupportSettings } from '../Settings/types';
import type { SupportState } from '../types';
import { registerMeshForAutoBrace } from '../autoBracing/meshGeometryStore';
import { computeAutoSupportPlan } from './autoPlace';
import { setModelMesh } from './meshStore';
import type { AutoSupportSettings } from './settings';
import type { AutoSupportPlan } from './types';

/**
 * A scene mesh on the wire. Arrays are **copied**, never transferred: the main
 * thread keeps rendering from the same buffers.
 */
export type SerializedModelMesh = {
    positions: Float32Array;
    /**
     * Vertex normals, when the geometry has them. They are not decoration:
     * three's raycast takes `face.normal` from this attribute when it is
     * present and computes it from the positions when it is not, and the two
     * disagree in the last few digits. The plan stores those normals on
     * contact cones, so dropping the attribute would make a worker run differ
     * from an in-process one in the 8th decimal.
     */
    normals?: Float32Array;
    index?: Uint32Array;
    position: [number, number, number];
    quaternion: [number, number, number, number];
    scale: [number, number, number];
};

/**
 * A detected island on the wire. `contact` is a `THREE.Vector3` in process and
 * a plain point after a structured clone, and the plan only ever reads x/y/z.
 */
export type SerializedIsland = Omit<DetectedIsland, 'contact'> & {
    contact: { x: number; y: number; z: number };
};

export type AutoPlaceWorkerPayload = {
    modelId: string;
    islands: SerializedIsland[];
    settingsOverride?: Partial<AutoSupportSettings>;
    /** The app's full settings, which the plan reads through `getSettings()`. */
    appSettings: SupportSettings;
    /** The pre-run snapshot: seeds the worker's store and is passed as `baseState`. */
    baseState: SupportState;
    mesh?: SerializedModelMesh;
    /** {@link modelMeshKey} of `mesh`, so an unchanged mesh is not rebuilt. */
    meshKey?: string;
};

export type AutoPlaceWorkerRequest = {
    type: 'run';
    requestId: number;
    payload: AutoPlaceWorkerPayload;
};

export type AutoPlaceWorkerResponse =
    | { type: 'started'; requestId: number }
    | { type: 'result'; requestId: number; plan: AutoSupportPlan | null }
    | { type: 'error'; requestId: number; error: string; stack?: string };

export function serializeIsland(island: DetectedIsland): SerializedIsland {
    return {
        ...island,
        contact: { x: island.contact.x, y: island.contact.y, z: island.contact.z },
    };
}

/** The identity a serialized mesh is valid for: geometry contents plus pose. */
export function modelMeshKey(mesh: THREE.Mesh): string {
    const geometry = mesh.geometry as THREE.BufferGeometry;
    const position = geometry.getAttribute('position');
    const index = geometry.getIndex();
    return [
        geometry.uuid,
        attributeVersion(position),
        attributeVersion(index),
        ...mesh.matrixWorld.elements,
    ].join(',');
}

/** An interleaved attribute carries no version of its own. */
function attributeVersion(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null | undefined): number {
    return attribute && 'version' in attribute ? attribute.version : -1;
}

export function serializeModelMesh(mesh: THREE.Mesh): SerializedModelMesh {
    const geometry = mesh.geometry as THREE.BufferGeometry;
    const positionAttr = geometry.getAttribute('position');
    const raw = positionAttr?.array;
    const positions = raw instanceof Float32Array
        ? raw.slice()
        : new Float32Array(raw ? Array.from(raw as ArrayLike<number>) : []);
    const normalAttr = geometry.getAttribute('normal');
    const rawNormal = normalAttr?.array;
    const normals = normalAttr
        ? (rawNormal instanceof Float32Array
            ? rawNormal.slice()
            : new Float32Array(Array.from(rawNormal as ArrayLike<number>)))
        : undefined;
    const indexAttr = geometry.getIndex();
    const rawIndex = indexAttr?.array;
    const index = indexAttr
        ? (rawIndex instanceof Uint32Array ? rawIndex.slice() : new Uint32Array(Array.from(rawIndex ?? [])))
        : undefined;

    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    mesh.matrixWorld.decompose(position, quaternion, scale);

    return {
        positions,
        normals,
        index,
        position: [position.x, position.y, position.z],
        quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
        scale: [scale.x, scale.y, scale.z],
    };
}

/**
 * Rebuild a mesh from the wire, BVH included. The pose is set through
 * position/quaternion/scale rather than the matrix so the plan's own
 * `updateMatrixWorld()` reproduces it.
 */
export function deserializeModelMesh(serialized: SerializedModelMesh): THREE.Mesh {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(serialized.positions, 3));
    if (serialized.normals) geometry.setAttribute('normal', new THREE.BufferAttribute(serialized.normals, 3));
    if (serialized.index) geometry.setIndex(new THREE.BufferAttribute(serialized.index, 1));
    accelerateGeometry(geometry);

    const mesh = new THREE.Mesh(geometry);
    mesh.position.set(...serialized.position);
    mesh.quaternion.set(...serialized.quaternion);
    mesh.scale.set(...serialized.scale);
    mesh.updateMatrixWorld(true);
    return mesh;
}

/**
 * The mesh this thread last rebuilt. Building a mesh costs a BVH over the
 * whole model (measured ~210 ms at 500k triangles), and a model's geometry
 * only changes when the user edits it, so an unchanged key reuses the mesh.
 */
let cachedMesh: { modelId: string; key: string; mesh: THREE.Mesh } | null = null;

/**
 * Point this thread's module state at the run's inputs. Returns the mesh the
 * plan should use, already registered for collision avoidance and for the
 * brace clearance check (which silently allows braces through the model when
 * no mesh is registered for the model id).
 */
export function seedAutoPlaceEnvironment(payload: AutoPlaceWorkerPayload): THREE.Mesh | undefined {
    initializeBVH();
    setSettings(payload.appSettings);
    setSnapshot(payload.baseState);

    if (!payload.mesh) return undefined;

    let mesh: THREE.Mesh;
    if (cachedMesh && cachedMesh.modelId === payload.modelId && cachedMesh.key === (payload.meshKey ?? '')) {
        mesh = cachedMesh.mesh;
    } else {
        mesh = deserializeModelMesh(payload.mesh);
        cachedMesh = { modelId: payload.modelId, key: payload.meshKey ?? '', mesh };
    }

    setModelMesh(payload.modelId, mesh);
    registerMeshForAutoBrace(payload.modelId, mesh.geometry as THREE.BufferGeometry, mesh.matrixWorld);
    return mesh;
}

/** The worker's whole job: seed this thread, then plan. */
export function runAutoPlaceRequest(payload: AutoPlaceWorkerPayload): AutoSupportPlan | null {
    const mesh = seedAutoPlaceEnvironment(payload);
    const islands: DetectedIsland[] = payload.islands.map((island) => ({
        ...island,
        contact: new THREE.Vector3(island.contact.x, island.contact.y, island.contact.z),
    }));
    return computeAutoSupportPlan(islands, payload.modelId, payload.settingsOverride, payload.baseState, mesh);
}
