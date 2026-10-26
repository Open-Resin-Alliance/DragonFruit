"use client";

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';

import { createInstancedStandardMaterial } from './instancedStandardMaterial';

/**
 * The instanced-support program keys, one per primitive kind.
 *
 * A warmup mesh only has to compile the program for its key; geometry and
 * instance data do not affect the shader. Keep this list in step with the
 * `createInstancedStandardMaterial(...)` callers — a missing key costs one
 * first-draw compile, not correctness.
 */
const SUPPORT_INSTANCED_PROGRAM_KEYS = [
  'df-instanced-joint',
  'df-instanced-shaft',
  'df-instanced-contact-cone',
  'df-instanced-root',
  'df-instanced-joint-drag',
  'df-instanced-cone-drag',
] as const;

/**
 * Compiles the Support workspace's instanced programs while the app is idle.
 *
 * The first entry into Support builds six new `MeshStandardMaterial` programs;
 * on this driver that is a ~1.2–1.7 s stall charged to the mode switch, and the
 * second entry is smooth because the programs are cached. Warmup meshes are
 * added to the real scene (so the light/clipping defines match) with colour and
 * depth writes off, compiled, then removed and disposed. Work runs in an idle
 * callback, so it lands while the model is still settling rather than on the
 * first Support click.
 */
export function SupportShaderWarmup() {
  const { gl, scene, camera } = useThree();
  const doneRef = useRef(false);

  useEffect(() => {
    if (doneRef.current) return;

    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const usedIdleCallback = typeof idleWindow.requestIdleCallback === 'function';
    const handle = usedIdleCallback
      ? idleWindow.requestIdleCallback!(() => run(), { timeout: 1500 })
      : window.setTimeout(() => run(), 0);
    let cancelled = false;
    let group: THREE.Group | null = null;

    const run = () => {
      if (cancelled || doneRef.current) return;
      doneRef.current = true;

      const geometry = new THREE.BoxGeometry(0.001, 0.001, 0.001);
      const materials: THREE.MeshStandardMaterial[] = [];
      group = new THREE.Group();
      group.name = 'support-shader-warmup';
      group.position.set(0, 0, -1_000_000);

      for (const key of SUPPORT_INSTANCED_PROGRAM_KEYS) {
        const material = createInstancedStandardMaterial(key);
        // Compile without contributing pixels, and never let the warmup draw
        // affect the frame it is added to.
        material.colorWrite = false;
        material.depthWrite = false;
        material.depthTest = false;
        const mesh = new THREE.Mesh(geometry, material);
        mesh.frustumCulled = false;
        mesh.matrixAutoUpdate = false;
        group.add(mesh);
        materials.push(material);
      }

      scene.add(group);
      gl.compile(scene, camera);
      scene.remove(group);
      geometry.dispose();
      for (const material of materials) material.dispose();
      group = null;
    };

    return () => {
      cancelled = true;
      if (usedIdleCallback) idleWindow.cancelIdleCallback?.(handle);
      else window.clearTimeout(handle);
      if (group) {
        scene.remove(group);
        for (const child of group.children) {
          const mesh = child as THREE.Mesh;
          mesh.geometry?.dispose();
          (mesh.material as THREE.Material | undefined)?.dispose?.();
        }
      }
    };
  }, [camera, gl, scene]);

  return null;
}
