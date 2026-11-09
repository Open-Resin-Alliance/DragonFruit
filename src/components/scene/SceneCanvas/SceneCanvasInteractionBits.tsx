import React from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { usePicking } from '@/components/picking';
import { emitImmediateModelHover } from '@/supports/interaction/pointerOcclusion';

/**
 * three-mesh-bvh's accelerated raycast reads this flag; the type comes from its
 * own module augmentation, which this package does not apply to `Raycaster`.
 */
function enableFirstHitRaycasts(raycaster: THREE.Raycaster): void {
  (raycaster as THREE.Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true;
}

export function SceneRenderBindings({
  rendererRef,
  sceneRef,
  onWebGlContextLost,
  onWebGlContextRestored,
}: {
  rendererRef: React.MutableRefObject<THREE.WebGLRenderer | null>;
  sceneRef: React.MutableRefObject<THREE.Scene | null>;
  onWebGlContextLost?: (event: WebGLContextEvent) => void;
  onWebGlContextRestored?: (event: Event) => void;
}) {
  const { gl, scene, raycaster } = useThree();

  React.useEffect(() => {
    // R3F raycasts every model with a pointer handler on every pointer move, and
    // three-mesh-bvh otherwise collects *all* hits per mesh. Hover only needs the
    // nearest hit of each object, and `firstHitOnly` stops the BVH at the first
    // triangle instead of walking the rest of the geometry. Each object still
    // contributes its nearest hit, so the sorted intersection list and the
    // behind-the-model checks keep their ordering.
    enableFirstHitRaycasts(raycaster);
  }, [raycaster]);

  React.useEffect(() => {
    rendererRef.current = gl;
    sceneRef.current = scene;

    const canvas = gl.domElement;
    const handleContextLost = (event: Event) => {
      const webGlEvent = event as WebGLContextEvent;
      // Required to allow the browser to attempt context restoration.
      webGlEvent.preventDefault();
      onWebGlContextLost?.(webGlEvent);
    };

    const handleContextRestored = (event: Event) => {
      onWebGlContextRestored?.(event);
    };

    canvas.addEventListener('webglcontextlost', handleContextLost as EventListener, false);
    canvas.addEventListener('webglcontextrestored', handleContextRestored as EventListener, false);

    return () => {
      canvas.removeEventListener('webglcontextlost', handleContextLost as EventListener, false);
      canvas.removeEventListener('webglcontextrestored', handleContextRestored as EventListener, false);

      if (rendererRef.current === gl) {
        rendererRef.current = null;
      }
      if (sceneRef.current === scene) {
        sceneRef.current = null;
      }
    };
  }, [gl, onWebGlContextLost, onWebGlContextRestored, scene, rendererRef, sceneRef]);

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
