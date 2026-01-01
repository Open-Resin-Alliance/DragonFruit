type AnatomyPreviewDomRect = {
    left: number;
    top: number;
    width: number;
    height: number;
};

type AnatomyPreviewState = {
    domRect: AnatomyPreviewDomRect | null;
    activeSettingKey: string | null;
};

let currentState: AnatomyPreviewState = {
    domRect: null,
    activeSettingKey: null,
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
