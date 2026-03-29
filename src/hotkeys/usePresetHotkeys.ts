import { useEffect } from 'react';
import { useHotkeyConfig } from './HotkeyContext';
import { matchesConfiguredHotkeyDown } from './hotkeyConfig';
import { setActivePreset } from '@/supports/Settings/presets';

export function usePresetHotkeys() {
    const { getHotkey } = useHotkeyConfig();

    // Retrieve current bindings
    const detailKey = getHotkey('PRESETS', 'APPLY_DETAIL');
    const structureKey = getHotkey('PRESETS', 'APPLY_STRUCTURE');
    const anchorKey = getHotkey('PRESETS', 'APPLY_ANCHOR');

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Ignore if typing in an input
            const target = e.target as HTMLElement;
            if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;

            if (e.repeat) return;

            // Check bindings and apply corresponding preset
            if (matchesConfiguredHotkeyDown(e, { key: detailKey.key, modifier: detailKey.modifier })) {
                e.preventDefault();
                setActivePreset('detail');
            } else if (matchesConfiguredHotkeyDown(e, { key: structureKey.key, modifier: structureKey.modifier })) {
                e.preventDefault();
                setActivePreset('structure');
            } else if (matchesConfiguredHotkeyDown(e, { key: anchorKey.key, modifier: anchorKey.modifier })) {
                e.preventDefault();
                setActivePreset('anchor');
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [detailKey, structureKey, anchorKey]);
}
