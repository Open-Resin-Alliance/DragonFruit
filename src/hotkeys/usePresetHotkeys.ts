import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useActionActive } from './hotkeyStore';
import { setActivePreset, getPresetForPinnedSlot, subscribeToPresets } from '@/supports/Settings/presets';

export function usePresetHotkeys() {
    // Subscribe to preset changes so pinned slots are always current
    useSyncExternalStore(subscribeToPresets, () => null, () => null);

    const active1 = useActionActive('PRESETS', 'SLOT_1');
    const active2 = useActionActive('PRESETS', 'SLOT_2');
    const active3 = useActionActive('PRESETS', 'SLOT_3');
    const active4 = useActionActive('PRESETS', 'SLOT_4');
    const active5 = useActionActive('PRESETS', 'SLOT_5');
    const active6 = useActionActive('PRESETS', 'SLOT_6');

    const wasActive1 = useRef(false);
    const wasActive2 = useRef(false);
    const wasActive3 = useRef(false);
    const wasActive4 = useRef(false);
    const wasActive5 = useRef(false);
    const wasActive6 = useRef(false);

    useEffect(() => {
        const slots = [
            { active: active1, wasActive: wasActive1, slot: 1 },
            { active: active2, wasActive: wasActive2, slot: 2 },
            { active: active3, wasActive: wasActive3, slot: 3 },
            { active: active4, wasActive: wasActive4, slot: 4 },
            { active: active5, wasActive: wasActive5, slot: 5 },
            { active: active6, wasActive: wasActive6, slot: 6 },
        ];

        for (const { active, wasActive, slot } of slots) {
            if (active && !wasActive.current) {
                const preset = getPresetForPinnedSlot(slot);
                if (preset) {
                    setActivePreset(preset.id);
                }
            }
            wasActive.current = active;
        }
    }, [active1, active2, active3, active4, active5, active6]);
}
