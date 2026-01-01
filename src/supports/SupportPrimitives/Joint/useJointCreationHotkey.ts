import { useEffect } from 'react';
import { jointCreationStore } from './jointCreationState';
import { DEFAULT_KEYBINDINGS } from '@/hotkeys/hotkeyConfig';

export function useJointCreationHotkey(mode: string) {
    useEffect(() => {
        if (mode !== 'support') return;

        const handleKeyDown = (e: KeyboardEvent) => {
            // Ignore if typing in an input
            const target = e.target as HTMLElement;
            if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;

            if (e.key.toLowerCase() === DEFAULT_KEYBINDINGS.SUPPORTS.JOINT_CREATION.key && !e.repeat) {
                jointCreationStore.setIsActive(true);
            }
        };

        const handleKeyUp = (e: KeyboardEvent) => {
            if (e.key.toLowerCase() === DEFAULT_KEYBINDINGS.SUPPORTS.JOINT_CREATION.key) {
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
    }, [mode]);
}
