import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { supportPainterStore, useSupportPainterState } from './supportPainterStore';
import { PAINT_ROI_ADD, PAINT_ROI_REMOVE } from './supportPainterHistoryTypes';
import { pushHistory, registerHistoryHandler } from '@/history/historyStore';
import { type ROIRegion } from './supportPainterTypes';

function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  return '__TAURI_INTERNALS__' in window;
}

let tauriInvokePromise: Promise<any> | null = null;
async function getTauriInvoke() {
  if (!isTauriRuntime()) return null;
  if (!tauriInvokePromise) {
    tauriInvokePromise = import('@tauri-apps/api/core')
      .then((mod) => mod.invoke)
      .catch(() => null);
  }
  return tauriInvokePromise;
}

function expandGeometryToTriangleSoup(geometry: THREE.BufferGeometry): Float32Array {
  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
  const positions = posAttr.array as Float32Array;
  const index = geometry.getIndex();

  if (!index) {
    if (positions instanceof Float32Array) {
      return positions;
    }
    return new Float32Array(positions as unknown as ArrayLike<number>);
  }

  const indexArr = index.array as Uint16Array | Uint32Array;
  const out = new Float32Array(indexArr.length * 3);
  for (let i = 0; i < indexArr.length; i++) {
    const vi = indexArr[i] * 3;
    const oi = i * 3;
    out[oi] = positions[vi];
    out[oi + 1] = positions[vi + 1];
    out[oi + 2] = positions[vi + 2];
  }
  return out;
}

/**
 * Headless coordination hook for Support Painter mode.
 * Manages window-level keyboard modifier state, pointer-up release states,
 * registers history undo/redo handlers, and communicates with the Rust backend via Tauri IPC.
 */
export function useSupportPainterManager(
  isActive: boolean,
  activeModelId: string | null = null,
  geometry: THREE.BufferGeometry | null = null
) {
  const { hoveredTriangleId, activeBrush } = useSupportPainterState();

  const initializedModelIdRef = useRef<string | null>(null);
  const lastModelIdRef = useRef<string | null>(null);
  const lastRequestTimeRef = useRef<number>(0);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  // 1. Register history undo/redo handlers for painting
  useEffect(() => {
    if (!isActive) return;

    const undoAdd = registerHistoryHandler(PAINT_ROI_ADD, (action, direction) => {
      const { region } = action.payload as { region: ROIRegion };
      if (direction === 'undo') {
        supportPainterStore.removeRegion(region.id);
      } else {
        // Redo: restore committed region
        const currentRegions = new Map(supportPainterStore.getSnapshot().regions);
        currentRegions.set(region.id, region);
        supportPainterStore.restoreRegions(currentRegions);
      }
    });

    const undoRemove = registerHistoryHandler(PAINT_ROI_REMOVE, (action, direction) => {
      const { region } = action.payload as { region: ROIRegion };
      if (direction === 'undo') {
        // Undo: restore removed region
        const currentRegions = new Map(supportPainterStore.getSnapshot().regions);
        currentRegions.set(region.id, region);
        supportPainterStore.restoreRegions(currentRegions);
      } else {
        // Redo: remove region again
        supportPainterStore.removeRegion(region.id);
      }
    });

    return () => {
      undoAdd();
      undoRemove();
    };
  }, [isActive]);

  // 2. Track modifier key state and pointer up at window level
  useEffect(() => {
    if (!isActive) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const keys: { alt?: boolean; shift?: boolean } = {};
      if (e.key === 'Alt') keys.alt = true;
      if (e.key === 'Shift') keys.shift = true;

      if (Object.keys(keys).length > 0) {
        supportPainterStore.setModifierKeys(keys);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      const keys: { alt?: boolean; shift?: boolean } = {};
      if (e.key === 'Alt') keys.alt = false;
      if (e.key === 'Shift') keys.shift = false;

      if (Object.keys(keys).length > 0) {
        supportPainterStore.setModifierKeys(keys);
      }
    };

    const handlePointerUp = () => {
      supportPainterStore.setInteractionPhase('Idle');
    };

    const handleBlur = () => {
      // Reset modifier keys on focus loss
      supportPainterStore.setModifierKeys({ alt: false, shift: false });
      supportPainterStore.setInteractionPhase('Idle');
    };

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp, true);
    window.addEventListener('pointerup', handlePointerUp, true);
    window.addEventListener('pointercancel', handlePointerUp, true);
    window.addEventListener('blur', handleBlur);

    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp, true);
      window.removeEventListener('pointerup', handlePointerUp, true);
      window.removeEventListener('pointercancel', handlePointerUp, true);
      window.removeEventListener('blur', handleBlur);
      supportPainterStore.setModifierKeys({ alt: false, shift: false });
      supportPainterStore.setInteractionPhase('Idle');
    };
  }, [isActive]);

  // 3. Keep track of the last active model ID for cleanup on deactivation or model change
  useEffect(() => {
    if (isActive && activeModelId) {
      lastModelIdRef.current = activeModelId;
    }
  }, [isActive, activeModelId]);

  // 4. Initialize model topology in the Rust backend
  useEffect(() => {
    if (!isActive || !activeModelId || !geometry) {
      initializedModelIdRef.current = null;
      return;
    }

    if (initializedModelIdRef.current === activeModelId) {
      return;
    }

    let active = true;

    const initModel = async () => {
      const invoke = await getTauriInvoke();
      if (!invoke || !active) return;

      try {
        console.log(`[SupportPainterManager] Initializing topology for model ${activeModelId}`);
        const positions = expandGeometryToTriangleSoup(geometry);
        
        await invoke('initialize_support_painter_model', {
          modelId: activeModelId,
          positions: positions,
        });

        if (active) {
          initializedModelIdRef.current = activeModelId;
          console.log(`[SupportPainterManager] Topology initialization completed for model ${activeModelId}`);
        }
      } catch (err) {
        console.error('[SupportPainterManager] Initialization failed', err);
      }
    };

    initModel();

    return () => {
      active = false;
    };
  }, [isActive, activeModelId, geometry]);

  // 5. Throttled Region Proposal Query (under 20-30ms)
  useEffect(() => {
    if (!isActive || !activeModelId || hoveredTriangleId === null) {
      return;
    }

    // Only run if the model has actually been initialized
    if (initializedModelIdRef.current !== activeModelId) {
      return;
    }

    let active = true;

    const run = async () => {
      const invoke = await getTauriInvoke();
      if (!invoke || !active) return;

      try {
        const proposedIds: number[] = await invoke('propose_brush_region', {
          modelId: activeModelId,
          seedTriangleId: hoveredTriangleId,
          brushType: activeBrush,
        });

        if (active) {
          supportPainterStore.setProposedTriangleIds(proposedIds);
        }
      } catch (err) {
        console.error('[SupportPainterManager] Region proposal failed', err);
      }
    };

    const now = Date.now();
    const timeSinceLast = now - lastRequestTimeRef.current;
    const throttleMs = 20; // 20ms low-latency throttle

    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    if (timeSinceLast >= throttleMs) {
      lastRequestTimeRef.current = now;
      run();
    } else {
      timeoutRef.current = setTimeout(() => {
        if (active) {
          lastRequestTimeRef.current = Date.now();
          run();
        }
      }, throttleMs - timeSinceLast);
    }

    return () => {
      active = false;
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [isActive, activeModelId, hoveredTriangleId, activeBrush]);

  // 6. Cleanup: Evict cache on model change, deactivation, or unmount
  useEffect(() => {
    return () => {
      // Eviction on unmount
      const lastId = lastModelIdRef.current;
      if (lastId) {
        getTauriInvoke().then((invoke) => {
          if (invoke) {
            console.log(`[SupportPainterManager] Unmount cleanup: evicting ${lastId}`);
            invoke('clear_support_painter_model', { modelId: lastId }).catch((err: any) => {
              console.error('[SupportPainterManager] Eviction on unmount failed', err);
            });
          }
        });
      }
    };
  }, []);

  useEffect(() => {
    if (!isActive) {
      // Eviction on deactivation
      const lastId = lastModelIdRef.current;
      if (lastId) {
        lastModelIdRef.current = null;
        initializedModelIdRef.current = null;
        getTauriInvoke().then((invoke) => {
          if (invoke) {
            console.log(`[SupportPainterManager] Deactivation cleanup: evicting ${lastId}`);
            invoke('clear_support_painter_model', { modelId: lastId }).catch((err: any) => {
              console.error('[SupportPainterManager] Eviction on deactivation failed', err);
            });
          }
        });
      }
    }
  }, [isActive]);

  useEffect(() => {
    if (!isActive) return;

    return () => {
      // Eviction on model change
      const lastId = lastModelIdRef.current;
      if (lastId && lastId !== activeModelId) {
        getTauriInvoke().then((invoke) => {
          if (invoke) {
            console.log(`[SupportPainterManager] Model change cleanup: evicting ${lastId}`);
            invoke('clear_support_painter_model', { modelId: lastId }).catch((err: any) => {
              console.error('[SupportPainterManager] Eviction on model change failed', err);
            });
          }
        });
      }
    };
  }, [isActive, activeModelId]);
}
