/**
 * Selection System - Context and Provider
 * 
 * Provides selection state to the component tree.
 */

"use client";

import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';
import type { SelectionState, SelectionContextValue } from './types';

const EMPTY_STATE: SelectionState = {
  selectedModelId: null,
  hasSelection: false,
};

const SelectionContext = createContext<SelectionContextValue | null>(null);

interface SelectionProviderProps {
  /** Initial selected model ID */
  initialSelection?: string | null;
  /** Callback when selection changes */
  onSelectionChange?: (modelId: string | null) => void;
  children: React.ReactNode;
}

/**
 * SelectionProvider - Provides selection state to descendants.
 */
export function SelectionProvider({
  initialSelection = null,
  onSelectionChange,
  children,
}: SelectionProviderProps) {
  const [selectedModelId, setSelectedModelId] = useState<string | null>(initialSelection);
  
  const state: SelectionState = useMemo(() => ({
    selectedModelId,
    hasSelection: selectedModelId !== null,
  }), [selectedModelId]);

  const select = useCallback((modelId: string) => {
    setSelectedModelId(modelId);
    onSelectionChange?.(modelId);
  }, [onSelectionChange]);

  const deselect = useCallback(() => {
    setSelectedModelId(null);
    onSelectionChange?.(null);
  }, [onSelectionChange]);

  const toggle = useCallback((modelId: string) => {
    setSelectedModelId(prev => {
      const newValue = prev === modelId ? null : modelId;
      onSelectionChange?.(newValue);
      return newValue;
    });
  }, [onSelectionChange]);

  const isSelected = useCallback((modelId: string) => {
    return selectedModelId === modelId;
  }, [selectedModelId]);

  const value: SelectionContextValue = useMemo(() => ({
    state,
    select,
    deselect,
    toggle,
    isSelected,
  }), [state, select, deselect, toggle, isSelected]);

  return (
    <SelectionContext.Provider value={value}>
      {children}
    </SelectionContext.Provider>
  );
}

/**
 * useSelection - Hook to access selection state and actions.
 */
export function useSelection(): SelectionContextValue {
  const context = useContext(SelectionContext);
  if (!context) {
    throw new Error('useSelection must be used within a SelectionProvider');
  }
  return context;
}

/**
 * useSelectionState - Hook to access just the selection state (no actions).
 */
export function useSelectionState(): SelectionState {
  const { state } = useSelection();
  return state;
}
