import type { SupportSettings } from '../types';

type AnatomyPreviewDomRect = {
    left: number;
    top: number;
    width: number;
    height: number;
};

type AnatomyPreviewState = {
    domRect: AnatomyPreviewDomRect | null;
    activeSettingKey: string | null;
    activeSettingValue: number | null;
    hoveredPresetSettings: SupportSettings | null;
    showTuner: boolean;
};

let currentState: AnatomyPreviewState = {
    domRect: null,
    activeSettingKey: null,
    activeSettingValue: null,
    hoveredPresetSettings: null,
    showTuner: false,
};

type Listener = () => void;
const listeners = new Set<Listener>();

function notify() {
    listeners.forEach((listener) => {
        try {
            listener();
        } catch (err) {
            console.error('[AnatomyPreviewState] listener error', err);
        }
    });
}

export function getAnatomyPreviewState(): AnatomyPreviewState {
    return currentState;
}

export function subscribeToAnatomyPreviewState(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function setAnatomyPreviewDomRect(domRect: AnatomyPreviewDomRect | null): void {
    currentState = {
        ...currentState,
        domRect,
    };
    notify();
}

export function setAnatomyPreviewActiveSettingKey(activeSettingKey: string | null): void {
    currentState = {
        ...currentState,
        activeSettingKey,
    };
    notify();
}

export function setAnatomyPreviewActiveSettingValue(activeSettingValue: number | null): void {
    currentState = {
        ...currentState,
        activeSettingValue,
    };
    notify();
}

export function setAnatomyPreviewHoveredPresetSettings(hoveredPresetSettings: SupportSettings | null): void {
    currentState = {
        ...currentState,
        hoveredPresetSettings,
    };
    notify();
}

export function setAnatomyPreviewShowTuner(showTuner: boolean): void {
    currentState = {
        ...currentState,
        showTuner,
    };
    notify();
}
