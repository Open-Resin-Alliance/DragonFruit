/**
 * GPU Picking System - React Context
 * 
 * Provides the picking system to the component tree.
 * This is the single source of truth for "what's under the mouse".
 */

"use client";

import { createContext, useContext } from 'react';
import type { PickingContextValue, PickingResult } from './types';
import { DEFAULT_PICKING_CONFIG, PICK_ID } from './constants';

/**
 * Default "nothing" result.
 */
export const EMPTY_PICK_RESULT: PickingResult = {
  pickId: PICK_ID.NONE,
  category: 'none',
  objectId: null,
  screenPosition: { x: 0, y: 0 },
  timestamp: 0,
};

/**
 * Default context value (used when no provider is present).
 */
const defaultContextValue: PickingContextValue = {
  hit: EMPTY_PICK_RESULT,
  register: () => {
    console.warn('[Picking] No PickingProvider found. Registration ignored.');
    return 0;
  },
  unregister: () => {
    console.warn('[Picking] No PickingProvider found. Unregistration ignored.');
  },
  setConfig: () => {
    console.warn('[Picking] No PickingProvider found. Config change ignored.');
  },
  config: DEFAULT_PICKING_CONFIG,
  onDragStart: () => {},
  onDragEnd: () => {},
  pause: () => {},
  resume: () => {},
  isPaused: false,
};

/**
 * React Context for the picking system.
 */
export const PickingContext = createContext<PickingContextValue>(defaultContextValue);

/**
 * Hook to access the picking context.
 * Returns the current pick result and registration functions.
 */
export function usePicking(): PickingContextValue {
  return useContext(PickingContext);
}

/**
 * Hook to get just the current hit (for components that only need to read).
 */
export function usePickingHit(): PickingResult {
  const { hit } = useContext(PickingContext);
  return hit;
}
