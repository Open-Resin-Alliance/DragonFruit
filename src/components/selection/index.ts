/**
 * Selection System
 * 
 * Centralized selection management for models and other objects.
 */

// Context and Provider
export { SelectionProvider, useSelection, useSelectionState } from './SelectionContext';

// Components
export { SelectionOutline } from './SelectionOutline';
export { SelectionManager } from './SelectionManager';
export { SelectionOutlineRenderer } from './SelectionOutlineRenderer';

// Types
export type { SelectableType, SelectionState, SelectionContextValue } from './types';
