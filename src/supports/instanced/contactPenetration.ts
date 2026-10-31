import * as React from 'react';

import {
  getActiveMaterialProfile,
  getActivePrinterProfile,
  getProfileStoreSnapshot,
  getProfileStoreServerSnapshot,
  subscribeToProfileStore,
} from '@/features/profiles/profileStore';
import { calculateTipOffset } from '@/supports/rendering/calculateTipOffset';

/**
 * How deep a contact primitive's nib is sunk into the model, in millimetres.
 *
 * This follows the *active material and printer*, not the scene: it is
 * `calculateTipOffset` when the material's UI asks for a computed offset, and
 * the cone's own authored `penetrationMm` otherwise. That is why it is a writer
 * input rather than a field of the slot list — a slot list is rebuilt when the
 * scene changes, and this value changes when the operator edits the profile.
 *
 * The one consumer is `InstancedContactConeBatch`'s nib batch. The resolver is
 * the identity its write effects key on, so a profile edit re-writes the nibs
 * even though nothing in the scene moved.
 */

/** The authored fallback a slot carries, when the profile does not compute one. */
export type ContactPenetrationSlot = {
  penetrationMm?: number;
};

export type ContactPenetrationResolver = (slot: ContactPenetrationSlot) => number;

/**
 * The profile-store subscription, mirroring `InstancedContactConeGroup`'s
 * `resolvePenetration` exactly — same guards, same pixel-size fallbacks, same
 * `calculateTipOffset` call — so a batched cone's nib sits at the depth the
 * legacy group drew it at.
 */
export function useContactPenetrationResolver(): ContactPenetrationResolver {
  const storeState = React.useSyncExternalStore(
    subscribeToProfileStore,
    getProfileStoreSnapshot,
    getProfileStoreServerSnapshot,
  );
  const activeMaterial = React.useMemo(() => getActiveMaterialProfile(storeState), [storeState]);
  const activePrinter = React.useMemo(() => getActivePrinterProfile(storeState), [storeState]);

  return React.useCallback((slot: ContactPenetrationSlot) => {
    if (activeMaterial && activePrinter && activeMaterial.antiAliasingSettings?.tipOffsetDisplayInUi) {
      const pxX = activePrinter.pixelSize?.x
        ? activePrinter.pixelSize.x / 1000
        : (activePrinter.buildVolumeMm?.width ?? 143) / (activePrinter.display?.resolutionX ?? 2560);
      const pxY = activePrinter.pixelSize?.y
        ? activePrinter.pixelSize.y / 1000
        : (activePrinter.buildVolumeMm?.depth ?? 89) / (activePrinter.display?.resolutionY ?? 1620);
      return calculateTipOffset(
        activeMaterial.antiAliasingSettings,
        activeMaterial.layerHeightMm,
        pxX,
        pxY,
      );
    }
    return slot.penetrationMm ?? 0;
  }, [activeMaterial, activePrinter]);
}
