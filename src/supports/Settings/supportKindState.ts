export type SupportKind = 'trunk' | 'raft' | 'leaf' | 'branch' | 'stick' | 'twig';

type SupportKindState = {
    kind: SupportKind;
};

let currentState: SupportKindState = {
    kind: 'trunk',
};

type Listener = () => void;
const listeners = new Set<Listener>();

function notify() {
    listeners.forEach((listener) => {
        try {
            listener();
        } catch (err) {
            console.error('[SupportKindState] listener error', err);
        }
    });
}

export function getSupportKindState(): SupportKindState {
    return currentState;
}

export function getActiveSupportKind(): SupportKind {
    return currentState.kind;
}

export function subscribeToSupportKindState(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function setActiveSupportKind(kind: SupportKind): void {
    if (currentState.kind === kind) return;
    currentState = {
        ...currentState,
        kind,
    };
    notify();
}

export function getSupportKindSnapshot(): SupportKindState {
    return currentState;
}
