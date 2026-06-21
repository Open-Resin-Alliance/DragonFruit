import { useEffect } from 'react';
import { jointCreationStore } from './jointCreationState';
import { useActionActive } from '@/hotkeys/hotkeyStore';

export function useJointCreationHotkey(mode: string) {
    const jointCreationActive = useActionActive('SUPPORTS', 'JOINT_CREATION');
    useEffect(() => {
        if (mode !== 'support') {
            jointCreationStore.setIsActive(false);
            return;
        }
        jointCreationStore.setIsActive(jointCreationActive);
        return () => {
            jointCreationStore.setIsActive(false);
        };
    }, [mode, jointCreationActive]);
}
