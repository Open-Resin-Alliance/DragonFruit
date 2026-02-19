import { useSyncExternalStore } from 'react';
import type { SupportBraceBuildResult, SupportBraceState } from './types';

const listeners = new Set<() => void>();

const initialState: SupportBraceState = {
    supportBraces: {},
    roots: {},
    knots: {},
    selectedId: null,
};

let state: SupportBraceState = { ...initialState };

function notify() {
    listeners.forEach((listener) => listener());
}

export function subscribeToSupportBraceStore(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function getSupportBraceSnapshot(): SupportBraceState {
    return state;
}

export function resetSupportBraceStore() {
    state = { ...initialState };
    notify();
}

export function setSupportBraceSelectedId(id: string | null) {
    if (state.selectedId === id) return;
    state = {
        ...state,
        selectedId: id,
    };
    notify();
}

export function addSupportBrace(build: SupportBraceBuildResult) {
    state = {
        ...state,
        supportBraces: {
            ...state.supportBraces,
            [build.supportBrace.id]: build.supportBrace,
        },
        roots: {
            ...state.roots,
            [build.root.id]: build.root,
        },
        knots: {
            ...state.knots,
            [build.hostKnot.id]: build.hostKnot,
        },
    };
    notify();
}

export function updateSupportBrace(buildOrSupportBrace: SupportBraceBuildResult | SupportBraceState['supportBraces'][string]) {
    if ('supportBrace' in buildOrSupportBrace) {
        addSupportBrace(buildOrSupportBrace);
        return;
    }

    const supportBrace = buildOrSupportBrace;
    if (!state.supportBraces[supportBrace.id]) return;

    state = {
        ...state,
        supportBraces: {
            ...state.supportBraces,
            [supportBrace.id]: supportBrace,
        },
    };
    notify();
}

export function removeSupportBrace(id: string): SupportBraceBuildResult | null {
    const supportBrace = state.supportBraces[id];
    if (!supportBrace) return null;

    const root = state.roots[supportBrace.rootId];
    const hostKnot = state.knots[supportBrace.hostKnotId];
    if (!root || !hostKnot) return null;

    const remainingBraces = { ...state.supportBraces };
    delete remainingBraces[supportBrace.id];

    const remainingRoots = { ...state.roots };
    delete remainingRoots[root.id];

    const remainingKnots = { ...state.knots };
    delete remainingKnots[hostKnot.id];

    state = {
        ...state,
        supportBraces: remainingBraces,
        roots: remainingRoots,
        knots: remainingKnots,
        selectedId: state.selectedId === id ? null : state.selectedId,
    };
    notify();

    return {
        supportBrace,
        root,
        hostKnot,
    };
}

export function useSupportBraceStoreState() {
    return useSyncExternalStore(
        subscribeToSupportBraceStore,
        getSupportBraceSnapshot,
        getSupportBraceSnapshot,
    );
}
