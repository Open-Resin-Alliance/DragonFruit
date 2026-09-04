/**
 * Selection System
 * 
 * Centralized selection management for models and other objects.
 */

// Context and Provider
export { SelectionProvider, useSelection, useSelectionState } from './SelectionContext';

// Components
export { SelectionManager } from './SelectionManager';
export { SelectionSpotlight } from './SelectionSpotlight';

// Types
export type { SelectableType, SelectionState, SelectionContextValue, SelectionHighlightMode } from './types';
