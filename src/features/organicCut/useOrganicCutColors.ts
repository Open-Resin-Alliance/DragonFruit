import React from 'react';
import {
  colorToNumber,
  getSavedOrganicCutColors,
  subscribeToOrganicCutColors,
  type OrganicCutColors,
} from './organicCutColors';

/**
 * The saved Cut-tool colours, re-read whenever they change (including from
 * another window, via the `storage` event the preference module listens to).
 */
export function useOrganicCutColors(): OrganicCutColors {
  return React.useSyncExternalStore(
    subscribeToOrganicCutColors,
    getSavedOrganicCutColors,
    // The server render has no localStorage; hand back the same object the client
    // starts from so hydration doesn't trip over a colour that changed underneath.
    getSavedOrganicCutColors,
  );
}

/** Numeric form of {@link useOrganicCutColors}, for three.js materials. */
export function useOrganicCutColorNumbers(): Record<keyof OrganicCutColors, number> {
  const colors = useOrganicCutColors();
  return React.useMemo(() => {
    const out = {} as Record<keyof OrganicCutColors, number>;
    for (const key of Object.keys(colors) as (keyof OrganicCutColors)[]) {
      out[key] = colorToNumber(colors[key]);
    }
    return out;
  }, [colors]);
}
