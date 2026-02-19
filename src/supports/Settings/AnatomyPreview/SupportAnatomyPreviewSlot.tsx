"use client";

import React from 'react';
import { SupportAnatomyPreviewCanvas } from './SupportAnatomyPreviewCanvas';

export function SupportAnatomyPreviewSlot() {
    return (
        <div data-no-drag="true" className="w-full h-full relative bg-neutral-900/50 rounded-lg overflow-hidden border border-neutral-700/50">
            <SupportAnatomyPreviewCanvas />
        </div>
    );
}
