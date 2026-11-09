import { useEffect, useRef, useSyncExternalStore } from 'react';
import { hotkeyStore, isActionActiveSync } from './hotkeyStore';
import { setActivePreset, getPresetForPinnedSlot, subscribeToPresets } from '@/supports/Settings/presets';

/** The preset hotkey slots, in the order the config binds them. */
const PRESET_SLOTS = [1, 2, 3, 4, 5, 6] as const;

export function usePresetHotkeys() {
    // Both stores are subscribed with a snapshot that never changes, so a keypress
    // does not re-render whatever this hook lives in. It lives in the settings
    // sidebar, which holds the anatomy preview canvas, and re-rendering that on
    // every preset key is a hitch on the way to the preview it redraws anyway. The
    // rising edge is read inside the callback instead, where noticing it is free.
    useSyncExternalStore(subscribeToPresets, () => null, () => null);

    const wasActiveRef = useRef<Record<number, boolean>>({});

    useEffect(() => {
        const applyRisingEdges = () => {
            const wasActive = wasActiveRef.current;
            for (const slot of PRESET_SLOTS) {
                const active = isActionActiveSync('PRESETS', `SLOT_${slot}`);
                if (active && !wasActive[slot]) {
                    const preset = getPresetForPinnedSlot(slot);
                    if (preset) {
                        setActivePreset(preset.id);
                    }
                }
                wasActive[slot] = active;
            }
        };

        // The key may already be down when this mounts, so read once before
        // listening.
        applyRisingEdges();
        return hotkeyStore.subscribe(applyRisingEdges);
    }, []);
}
