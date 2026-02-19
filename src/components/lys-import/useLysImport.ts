import { useState, useCallback } from 'react';
import * as THREE from 'three';
import { LysParser } from './LysParser';
import { LysConverter } from './LysConverter';
import { createDefaultSettings } from '@/supports/Settings/types';
import { loadFromLychee } from '@/supports/state';
import { computeLowestZ } from '@/utils/geometry';

function normalizeLycheeRotation(rotation: { x?: number; y?: number; z?: number } | null | undefined) {
    const x = Number.isFinite(rotation?.x) ? (rotation?.x as number) : 0;
    return { x, y: 0, z: 0 };
}

function applySupportZOffset(importData: any, deltaZ: number) {
    if (!importData || !Number.isFinite(deltaZ) || Math.abs(deltaZ) < 1e-6) return;

    const shiftedJointIds = new Set<string>();
    const shiftJoint = (joint: any) => {
        if (!joint || !joint.pos) return;
        const key = typeof joint.id === 'string' ? joint.id : null;
        if (key && shiftedJointIds.has(key)) return;
        joint.pos.z += deltaZ;
        if (key) shiftedJointIds.add(key);
    };

    // Keep roots anchored to the platform; only move non-root support geometry.

    for (const trunk of importData.trunks || []) {
        const socketJointId = trunk?.contactCone?.socketJointId;
        for (const seg of trunk?.segments || []) {
            if (socketJointId) {
                if (seg?.bottomJoint?.id === socketJointId) shiftJoint(seg.bottomJoint);
                if (seg?.topJoint?.id === socketJointId) shiftJoint(seg.topJoint);
            } else {
                // Legacy fallback: if socket IDs are missing, preserve previous behavior.
                shiftJoint(seg?.bottomJoint);
                shiftJoint(seg?.topJoint);
            }
            if (seg?.type === 'bezier') {
                if (seg.controlPoint1) seg.controlPoint1.z += deltaZ;
                if (seg.controlPoint2) seg.controlPoint2.z += deltaZ;
            }
        }
        if (trunk?.contactCone?.pos) trunk.contactCone.pos.z += deltaZ;
    }

    for (const branch of importData.branches || []) {
        for (const seg of branch?.segments || []) {
            shiftJoint(seg?.bottomJoint);
            shiftJoint(seg?.topJoint);
            if (seg?.type === 'bezier') {
                if (seg.controlPoint1) seg.controlPoint1.z += deltaZ;
                if (seg.controlPoint2) seg.controlPoint2.z += deltaZ;
            }
        }
        if (branch?.contactCone?.pos) branch.contactCone.pos.z += deltaZ;
    }

    for (const leaf of importData.leaves || []) {
        if (leaf?.contactCone?.pos) leaf.contactCone.pos.z += deltaZ;
    }

    for (const twig of importData.twigs || []) {
        for (const seg of twig?.segments || []) {
            shiftJoint(seg?.bottomJoint);
            shiftJoint(seg?.topJoint);
            if (seg?.type === 'bezier') {
                if (seg.controlPoint1) seg.controlPoint1.z += deltaZ;
                if (seg.controlPoint2) seg.controlPoint2.z += deltaZ;
            }
        }
        if (twig?.contactDiskA?.pos) twig.contactDiskA.pos.z += deltaZ;
        if (twig?.contactDiskB?.pos) twig.contactDiskB.pos.z += deltaZ;
    }

    for (const stick of importData.sticks || []) {
        for (const seg of stick?.segments || []) {
            shiftJoint(seg?.bottomJoint);
            shiftJoint(seg?.topJoint);
            if (seg?.type === 'bezier') {
                if (seg.controlPoint1) seg.controlPoint1.z += deltaZ;
                if (seg.controlPoint2) seg.controlPoint2.z += deltaZ;
            }
        }
        if (stick?.contactConeA?.pos) stick.contactConeA.pos.z += deltaZ;
        if (stick?.contactConeB?.pos) stick.contactConeB.pos.z += deltaZ;
    }

    for (const knot of importData.knots || []) {
        if (knot?.pos) knot.pos.z += deltaZ;
    }
}

export function useLysImport() {
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // We don't store geometry in state here long-term, 
    // we return it to the caller (useSceneManager) to handle.

    const importFile = useCallback(async (file: File) => {
        setIsLoading(true);
        setError(null);

        try {
            console.log("[useLysImport] Starting LYS Import...");
            const data = await LysParser.parse(file);

            console.log("[useLysImport] Geometry parsed. Vertices:", data.geometry.getAttribute('position').count);

            console.log("[useLysImport] Converting Scene Data...");
            const settings = createDefaultSettings();
            let dragonfruitData = null;
            const importedModelId = crypto.randomUUID();
            let resolvedModelZ: number | null = null;
            let lycheeTransform = {
                position: new THREE.Vector3(0, 0, 0),
                rotation: new THREE.Euler(0, 0, 0),
                scale: new THREE.Vector3(1, 1, 1)
            };

            if (data.sceneData && data.sceneData.objects && data.sceneData.supports) {
                const sceneDataForConvert = JSON.parse(JSON.stringify(data.sceneData));
                const convertObjects = sceneDataForConvert?.objects?.present?.byId || {};
                for (const key of Object.keys(convertObjects)) {
                    convertObjects[key].rotation = normalizeLycheeRotation(convertObjects[key].rotation);
                }

                // Extract Transform from the same object LysConverter uses
                const objects = data.sceneData.objects.present.byId;
                console.log("[useLysImport] All Object IDs:", Object.keys(objects));

                let targetObj = objects['o15'];
                if (!targetObj) {
                    for (const key in objects) {
                        if (objects[key].supportsBase && objects[key].supportsBase.length > 0) {
                            targetObj = objects[key];
                            break;
                        }
                    }
                }

                // Final Fallback: Use the first object if nothing else matches
                if (!targetObj) {
                    const firstKey = Object.keys(objects)[0];
                    if (firstKey) {
                        targetObj = objects[firstKey];
                        console.log(`[useLysImport] Fallback to first object: ${firstKey}`);
                    }
                }

                // Build a ghost mesh with Lychee transforms for support tip raycasting.
                // This mirrors the legacy v102 conversion flow that produced accurate trunk tips.
                let raycastMesh: THREE.Mesh | undefined;
                let ghostMaterial: THREE.Material | undefined;
                if (targetObj) {
                    const center = targetObj.formerCenter || targetObj.center || { x: 0, y: 0, z: 0 };
                    const position = targetObj.position || { x: 0, y: 0, z: 0 };
                    const scale = targetObj.scale || { x: 1, y: 1, z: 1 };
                    const rot = normalizeLycheeRotation(targetObj.rotation);
                    const deg2rad = Math.PI / 180;

                    const ghostGroup = new THREE.Group();
                    // Match Stage A transform policy used by LysConverter:
                    // apply Z + rotation + scale before support generation; world XY is deferred.
                    ghostGroup.position.set(0, 0, position.z);
                    ghostGroup.scale.set(scale.x, scale.y, scale.z);
                    ghostGroup.rotation.set(
                        (rot.x || 0) * deg2rad,
                        (rot.y || 0) * deg2rad,
                        (rot.z || 0) * deg2rad
                    );

                    ghostMaterial = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
                    const mesh = new THREE.Mesh(data.geometry, ghostMaterial);
                    mesh.position.set(-center.x, -center.y, -center.z);

                    ghostGroup.add(mesh);
                    ghostGroup.updateMatrixWorld(true);
                    mesh.geometry.computeBoundingSphere();
                    raycastMesh = mesh;
                }

                dragonfruitData = LysConverter.convert(sceneDataForConvert, settings, raycastMesh);

                if (targetObj && dragonfruitData) {
                    const position = targetObj.position || { x: 0, y: 0, z: 0 };
                    const scale = targetObj.scale || { x: 1, y: 1, z: 1 };
                    const rot = normalizeLycheeRotation(targetObj.rotation);
                    const deg2rad = Math.PI / 180;

                    data.geometry.computeBoundingBox();
                    const bbox = data.geometry.boundingBox;
                    if (bbox) {
                        const geomCenter = bbox.getCenter(new THREE.Vector3());
                        const rotationScale = new THREE.Matrix4().compose(
                            new THREE.Vector3(0, 0, 0),
                            new THREE.Quaternion().setFromEuler(new THREE.Euler(
                                (rot.x || 0) * deg2rad,
                                (rot.y || 0) * deg2rad,
                                (rot.z || 0) * deg2rad,
                                'XYZ'
                            )),
                            new THREE.Vector3(scale.x || 1, scale.y || 1, scale.z || 1)
                        );
                        const centerOffset = new THREE.Matrix4().makeTranslation(-geomCenter.x, -geomCenter.y, -geomCenter.z);
                        const localTransform = rotationScale.clone().multiply(centerOffset);

                        const lycheeLiftZ = Number.isFinite(position.z) ? position.z : 0;
                        const transformedMinZ = computeLowestZ(data.geometry, localTransform);
                        const finalModelZ = lycheeLiftZ - transformedMinZ;
                        resolvedModelZ = finalModelZ;
                        const supportDeltaZ = finalModelZ - lycheeLiftZ;

                        if (Number.isFinite(supportDeltaZ) && Math.abs(supportDeltaZ) > 1e-6) {
                            applySupportZOffset(dragonfruitData, supportDeltaZ);
                            console.log(`[useLysImport] Applied support Z offset to match model lift: ${supportDeltaZ.toFixed(3)}mm`);
                        }
                    }

                    // Stage B world placement is now handled per-object inside LysConverter.convert().
                }

                if (dragonfruitData) {
                    LysConverter.reassignModelId(dragonfruitData, importedModelId);
                }

                if (ghostMaterial) {
                    ghostMaterial.dispose();
                }

                console.log("[useLysImport] Loading into State...", dragonfruitData);
                loadFromLychee(dragonfruitData);

                if (targetObj) {
                    console.log("[useLysImport] Target Object Found:", targetObj);

                    // Apply Center (Pivot Offset) - REMOVED for now as it might be interfering with simple position
                    // if (targetObj.center) {
                    //     const { x, y, z } = targetObj.center;
                    //     console.log(`[useLysImport] Applying Center Offset: ${x}, ${y}, ${z}`);
                    //     data.geometry.translate(x, y, z);
                    // }

                    if (targetObj.position) {
                        const finalModelZ = Number.isFinite(resolvedModelZ) ? (resolvedModelZ as number) : targetObj.position.z;
                        lycheeTransform.position.set(targetObj.position.x, targetObj.position.y, finalModelZ);
                        console.log(`[useLysImport] Extracted Position: ${targetObj.position.x}, ${targetObj.position.y}, ${targetObj.position.z}`);
                        if (Number.isFinite(resolvedModelZ)) {
                            console.log(`[useLysImport] Resolved model Z from transformed min-z + Lychee lift: ${finalModelZ}`);
                        }
                    }
                    if (targetObj.rotation) {
                        const normalizedRotation = normalizeLycheeRotation(targetObj.rotation);
                        const deg2rad = Math.PI / 180;
                        lycheeTransform.rotation.set(
                            normalizedRotation.x * deg2rad,
                            normalizedRotation.y * deg2rad,
                            normalizedRotation.z * deg2rad
                        );
                        console.log(`[useLysImport] Extracted Rotation (Deg): ${targetObj.rotation.x}, ${targetObj.rotation.y}, ${targetObj.rotation.z}`);
                        console.log(`[useLysImport] Applied Rotation (Deg): ${normalizedRotation.x}, ${normalizedRotation.y}, ${normalizedRotation.z}`);
                    }
                    if (targetObj.scale) {
                        lycheeTransform.scale.set(targetObj.scale.x, targetObj.scale.y, targetObj.scale.z);
                        console.log(`[useLysImport] Extracted Scale: ${targetObj.scale.x}, ${targetObj.scale.y}, ${targetObj.scale.z}`);
                    }
                }
            } else {
                console.warn("[useLysImport] No scene data found or invalid format");
            }

            setIsLoading(false);
            return { geometry: data.geometry, transform: lycheeTransform, modelId: importedModelId };
        } catch (err) {
            console.error("[useLysImport] Import Failed:", err);
            setError(err instanceof Error ? err.message : String(err));
            setIsLoading(false);
            return null;
        }
    }, []);

    const clearError = useCallback(() => {
        setError(null);
    }, []);

    return {
        importFile,
        isLoading,
        error,
        clearError
    };
}
