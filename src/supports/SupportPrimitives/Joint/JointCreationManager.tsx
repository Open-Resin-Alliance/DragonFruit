import React from 'react';
import { useJointCreation } from './useJointCreation';
import { JointPlacementPreview } from './JointPlacementPreview';

export function JointCreationManager() {
    const { isActive, preview } = useJointCreation();

    if (!isActive || !preview) return null;

    return (
        <JointPlacementPreview 
            position={preview.pos} 
            diameter={preview.diameter} 
            normal={preview.normal}
        />
    );
}
