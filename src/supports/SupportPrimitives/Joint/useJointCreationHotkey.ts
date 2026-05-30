import { useEffect } from 'react';
import { jointCreationStore } from './jointCreationState';
import { useHotkeyConfig } from '@/hotkeys/HotkeyContext';

export function useJointCreationHotkey(mode: string) {
    const { getHotkey } = useHotkeyConfig();
    const binding = getHotkey('SUPPORTS', 'JOINT_CREATION');
    useEffect(() => {
        if (mode !== 'support' && mode !== 'supportPainter') return;

        const handleKeyDown = (e: KeyboardEvent) => {
            // Ignore if typing in an input
            const target = e.target as HTMLElement;
            if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;

            const matchesKey = e.key.toLowerCase() === binding.key.toLowerCase();
            const matchesModifier = mode === 'supportPainter' ? e.shiftKey : !e.shiftKey;

            if (matchesKey && matchesModifier && !e.repeat) {
                jointCreationStore.setIsActive(true);
            }
        };

        const handleKeyUp = (e: KeyboardEvent) => {
            if (e.key.toLowerCase() === binding.key.toLowerCase()) {
                jointCreationStore.setIsActive(false);
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('keyup', handleKeyUp);

        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('keyup', handleKeyUp);
            // Ensure we reset state on unmount or mode change
            jointCreationStore.setIsActive(false);
        };
    }, [mode, binding]);
}
