import React from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { usePicking } from '@/components/picking';
import { emitImmediateModelHover } from '@/supports/interaction/pointerOcclusion';

export function SceneRenderBindings({
  rendererRef,
  sceneRef,
}: {
  rendererRef: React.MutableRefObject<THREE.WebGLRenderer | null>;
  sceneRef: React.MutableRefObject<THREE.Scene | null>;
}) {
  const { gl, scene } = useThree();

  React.useEffect(() => {
    rendererRef.current = gl;
    sceneRef.current = scene;

    return () => {
      if (rendererRef.current === gl) {
        rendererRef.current = null;
      }
      if (sceneRef.current === scene) {
        sceneRef.current = null;
      }
    };
  }, [gl, scene, rendererRef, sceneRef]);

  return null;
}

export function PickingEmptySpaceHoverResetter({ enabled }: { enabled: boolean }) {
  const { hit } = usePicking();
  const wasEmptyRef = React.useRef<boolean>(false);
  const lastModelHoverIdRef = React.useRef<string | null>(null);
  const hoverClearTimeoutRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (!enabled) {
      wasEmptyRef.current = false;
      lastModelHoverIdRef.current = null;
      if (hoverClearTimeoutRef.current !== null) {
        window.clearTimeout(hoverClearTimeoutRef.current);
        hoverClearTimeoutRef.current = null;
      }
      return;
    }

    const hoveredModelIdFromPicking = (
      hit.category === 'model' && typeof hit.objectId === 'string' && hit.objectId.length > 0
    )
      ? hit.objectId
      : null;

    if (hoveredModelIdFromPicking) {
      if (hoverClearTimeoutRef.current !== null) {
        window.clearTimeout(hoverClearTimeoutRef.current);
        hoverClearTimeoutRef.current = null;
      }
    } else if (lastModelHoverIdRef.current !== null && hoverClearTimeoutRef.current === null) {
      hoverClearTimeoutRef.current = window.setTimeout(() => {
        hoverClearTimeoutRef.current = null;
        if (lastModelHoverIdRef.current === null) return;
        lastModelHoverIdRef.current = null;
        emitImmediateModelHover(null);
      }, 72);
    }

    if (lastModelHoverIdRef.current !== hoveredModelIdFromPicking) {
      lastModelHoverIdRef.current = hoveredModelIdFromPicking;
      emitImmediateModelHover(hoveredModelIdFromPicking);
    }

    const isEmpty = hit.category === 'none';
    if (!isEmpty) {
      wasEmptyRef.current = false;
      return;
    }

    if (wasEmptyRef.current) return;
    wasEmptyRef.current = true;

    emitImmediateModelHover(null);
    window.dispatchEvent(new CustomEvent('support-raft-model-pointer-hover', {
      detail: { modelId: null, category: 'support' },
    }));
    window.dispatchEvent(new CustomEvent('support-raft-model-pointer-hover', {
      detail: { modelId: null, category: 'raft' },
    }));
  }, [enabled, hit.category, hit.objectId]);

  React.useEffect(() => {
    return () => {
      if (hoverClearTimeoutRef.current !== null) {
        window.clearTimeout(hoverClearTimeoutRef.current);
        hoverClearTimeoutRef.current = null;
      }
    };
  }, []);

  return null;
}
