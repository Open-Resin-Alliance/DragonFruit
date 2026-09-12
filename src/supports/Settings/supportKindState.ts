/**
 * The sidebar tool selector. Its own vocabulary, not SupportTypeId: it carries
 * non-type tools (raft, grid, auto) and omits types with no sidebar tool.
 *
 * `drawsOwnPreview` -- the anatomy preview draws this kind itself.
 * `hasContactCone` / `hasShaft` / `hasPlateRoot` -- which settings fields show.
 * `tab` -- the tab this kind is edited under; leaf, branch and twig share trunk's.
 */
export const SUPPORT_KINDS = {
    trunk: { tab: 'trunk', drawsOwnPreview: false, hasContactCone: true, hasShaft: true, hasPlateRoot: true },
    raft: { tab: 'raft', drawsOwnPreview: true, hasContactCone: false, hasShaft: false, hasPlateRoot: false },
    leaf: { tab: 'trunk', drawsOwnPreview: false, hasContactCone: true, hasShaft: false, hasPlateRoot: false },
    branch: { tab: 'trunk', drawsOwnPreview: false, hasContactCone: true, hasShaft: true, hasPlateRoot: false },
    stick: { tab: 'stick', drawsOwnPreview: true, hasContactCone: false, hasShaft: false, hasPlateRoot: false },
    twig: { tab: 'trunk', drawsOwnPreview: false, hasContactCone: false, hasShaft: false, hasPlateRoot: false },
    grid: { tab: 'grid', drawsOwnPreview: true, hasContactCone: false, hasShaft: false, hasPlateRoot: false },
    auto: { tab: 'auto', drawsOwnPreview: false, hasContactCone: false, hasShaft: false, hasPlateRoot: false },
} as const;

export type SupportKind = keyof typeof SUPPORT_KINDS;

/** Whether a support type id also names a sidebar tool. Not every one does. */
export function isSupportKind(value: string): value is SupportKind {
    return value in SUPPORT_KINDS;
}

/** The tab a kind is edited under. Most are their own; some share the trunk tab. */
export function tabKindFor(kind: SupportKind): SupportKind {
    return SUPPORT_KINDS[kind].tab;
}

/** Whether the anatomy preview draws this kind itself. */
export function kindDrawsOwnPreview(kind: SupportKind): boolean {
    return SUPPORT_KINDS[kind].drawsOwnPreview;
}

/** Whether the sidebar offers this kind the given settings group. */
export function kindHas(
    kind: SupportKind | null | undefined,
    group: 'hasContactCone' | 'hasShaft' | 'hasPlateRoot',
): boolean {
    return !!kind && SUPPORT_KINDS[kind][group];
}

/**
 * The kind the sidebar returns to when an edit session ends.
 *
 * Named here rather than at each reset site.
 */
export const DEFAULT_SUPPORT_KIND: SupportKind = 'trunk';

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
