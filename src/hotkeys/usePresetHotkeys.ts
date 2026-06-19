import { useEffect, useSyncExternalStore } from 'react';
import { useHotkeyConfig } from './HotkeyContext';
import { matchesConfiguredHotkeyDown } from './hotkeyConfig';
import { setActivePreset, getPresetForPinnedSlot, subscribeToPresets } from '@/supports/Settings/presets';

export function usePresetHotkeys() {
    const { getHotkey } = useHotkeyConfig();

    // Subscribe to preset changes so pinned slots are always current
    useSyncExternalStore(subscribeToPresets, () => null, () => null);

    // Retrieve current bindings for 6 pinned slots
    const slot1Key = getHotkey('PRESETS', 'SLOT_1');
    const slot2Key = getHotkey('PRESETS', 'SLOT_2');
    const slot3Key = getHotkey('PRESETS', 'SLOT_3');
    const slot4Key = getHotkey('PRESETS', 'SLOT_4');
    const slot5Key = getHotkey('PRESETS', 'SLOT_5');
    const slot6Key = getHotkey('PRESETS', 'SLOT_6');

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Ignore if typing in an input
            const target = e.target as HTMLElement;
            if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;

            if (e.repeat) return;

            const slots = [
                { key: slot1Key, slot: 1 },
                { key: slot2Key, slot: 2 },
                { key: slot3Key, slot: 3 },
                { key: slot4Key, slot: 4 },
                { key: slot5Key, slot: 5 },
                { key: slot6Key, slot: 6 },
            ];

            for (const { key, slot } of slots) {
                if (matchesConfiguredHotkeyDown(e, { key: key.key, modifier: key.modifier })) {
                    e.preventDefault();
                    const preset = getPresetForPinnedSlot(slot);
                    if (preset) {
                        setActivePreset(preset.id);
                    }
                    break;
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [slot1Key, slot2Key, slot3Key, slot4Key, slot5Key, slot6Key]);
}
