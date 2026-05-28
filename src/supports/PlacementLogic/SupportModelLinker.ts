import type { SupportState } from '../types';
import { setSnapshot } from '../state';
import { getKickstandSnapshot, setKickstandSnapshot } from '../SupportTypes/Kickstand/kickstandStore';

type SupportCollectionsState = Pick<
    SupportState,
    'roots' | 'trunks' | 'branches' | 'braces' | 'leaves' | 'twigs' | 'sticks'
> & {
    anchors?: SupportState['anchors'];
};

/**
 * SupportModelLinker
 * 
 * This module handles the relationship between Supports and 3D Models.
 * It ensures that:
 * 1. We can efficiently query supports belonging to a specific model.
 * 2. We can clean up all supports when a model is deleted.
 * 
 * It isolates this logic from the global state store to keep things modular.
 */

interface ModelSupportIds {
    roots: string[];
    trunks: string[];
    branches: string[];
    braces: string[];
    leaves: string[];
    twigs: string[];
    sticks: string[];
    anchors: string[];
}

/**
 * Finds all support entity IDs associated with a given model ID.
 */
export function getSupportsForModel(state: SupportCollectionsState, modelId: string): ModelSupportIds {
    const result: ModelSupportIds = {
        roots: [],
        trunks: [],
        branches: [],
        braces: [],
        leaves: [],
        twigs: [],
        sticks: [],
        anchors: [],
    };

    // Scan Roots
    for (const [id, root] of Object.entries(state.roots)) {
        if (root.modelId === modelId) {
            result.roots.push(id);
        }
    }

    // Scan Trunks
    for (const [id, trunk] of Object.entries(state.trunks)) {
        if (trunk.modelId === modelId) {
            result.trunks.push(id);
        }
    }

    // Scan Branches
    for (const [id, branch] of Object.entries(state.branches)) {
        if (branch.modelId === modelId) {
            result.branches.push(id);
        }
    }

    // Scan Braces
    for (const [id, brace] of Object.entries(state.braces)) {
        if (brace.modelId === modelId) {
            result.braces.push(id);
        }
    }

    // Scan Leaves
    for (const [id, leaf] of Object.entries(state.leaves)) {
        if (leaf.modelId === modelId) {
            result.leaves.push(id);
        }
    }

    // Scan Twigs
    for (const [id, twig] of Object.entries(state.twigs)) {
        if (twig.modelId === modelId) {
            result.twigs.push(id);
        }
    }

    // Scan Sticks
    for (const [id, stick] of Object.entries(state.sticks)) {
        if (stick.modelId === modelId) {
            result.sticks.push(id);
        }
    }

    // Scan Anchors
    if (state.anchors) {
        for (const [id, anchor] of Object.entries(state.anchors)) {
            if (anchor.modelId === modelId) {
                result.anchors.push(id);
            }
        }
    }

    return result;
}

/**
 * Orchestrates the deletion of all supports for a specific model.
 * 
 * NOTE: This calls mutations in the store directly. 
 * Ideally, this should generate a payload for a single atomic "REMOVE_MODEL_SUPPORTS" action,
 * but for now, we will iterate and call existing remove functions to reuse their cleanup logic (like clearing selection).
 * 
 * @returns Number of support entities removed.
 */
export function deleteSupportsForModel(state: SupportState, modelId: string): number {
    const ids = getSupportsForModel(state, modelId);

    const kickstandSnapshot = getKickstandSnapshot();
    const kickstandIdsToRemove = Object.values(kickstandSnapshot.kickstands)
        .filter((kickstand) => kickstand.modelId === modelId)
        .map((kickstand) => kickstand.id);

    const hasMainSupportEntities = ids.roots.length > 0
        || ids.trunks.length > 0
        || ids.branches.length > 0
        || ids.braces.length > 0
        || ids.leaves.length > 0
        || ids.twigs.length > 0
        || ids.sticks.length > 0;

    if (!hasMainSupportEntities && kickstandIdsToRemove.length === 0) {
        return 0;
    }

    const rootsToRemove = new Set(ids.roots);
    const trunksToRemove = new Set(ids.trunks);
    const branchesToRemove = new Set(ids.branches);
    const bracesToRemove = new Set(ids.braces);
    const leavesToRemove = new Set(ids.leaves);
    const twigsToRemove = new Set(ids.twigs);
    const sticksToRemove = new Set(ids.sticks);
    const anchorsToRemove = new Set(ids.anchors || []);

    const segmentsToRemove = new Set<string>();
    for (const trunkId of trunksToRemove) {
        const trunk = state.trunks[trunkId];
        if (!trunk) continue;
        for (const segment of trunk.segments) segmentsToRemove.add(segment.id);
    }
    for (const branchId of branchesToRemove) {
        const branch = state.branches[branchId];
        if (!branch) continue;
        for (const segment of branch.segments) segmentsToRemove.add(segment.id);
    }
    for (const twigId of twigsToRemove) {
        const twig = state.twigs[twigId];
        if (!twig) continue;
        for (const segment of twig.segments) segmentsToRemove.add(segment.id);
    }
    for (const stickId of sticksToRemove) {
        const stick = state.sticks[stickId];
        if (!stick) continue;
        for (const segment of stick.segments) segmentsToRemove.add(segment.id);
    }
    for (const braceId of bracesToRemove) {
        const brace = state.braces[braceId];
        if (!brace) continue;
        segmentsToRemove.add(`braceSegment:${brace.id}`);
    }

    const knotsToRemove = new Set<string>();
    for (const [knotId, knot] of Object.entries(state.knots)) {
        const parentShaftId = knot.parentShaftId;
        const removeByShaft = segmentsToRemove.has(parentShaftId);
        const removeByLeafCone = parentShaftId.startsWith('leafCone:')
            && leavesToRemove.has(parentShaftId.slice('leafCone:'.length));
        const removeByBraceSegment = parentShaftId.startsWith('braceSegment:')
            && bracesToRemove.has(parentShaftId.slice('braceSegment:'.length));
        if (removeByShaft || removeByLeafCone || removeByBraceSegment) {
            knotsToRemove.add(knotId);
        }
    }

    const filterRecord = <T>(record: Record<string, T>, shouldRemove: (id: string) => boolean): Record<string, T> => {
        const next: Record<string, T> = {};
        for (const [id, value] of Object.entries(record)) {
            if (shouldRemove(id)) continue;
            next[id] = value;
        }
        return next;
    };

    const nextState: SupportState = {
        ...state,
        roots: filterRecord(state.roots, (id) => rootsToRemove.has(id)),
        trunks: filterRecord(state.trunks, (id) => trunksToRemove.has(id)),
        branches: filterRecord(state.branches, (id) => branchesToRemove.has(id)),
        leaves: filterRecord(state.leaves, (id) => leavesToRemove.has(id)),
        twigs: filterRecord(state.twigs, (id) => twigsToRemove.has(id)),
        sticks: filterRecord(state.sticks, (id) => sticksToRemove.has(id)),
        braces: filterRecord(state.braces, (id) => bracesToRemove.has(id)),
        anchors: filterRecord(state.anchors, (id) => anchorsToRemove.has(id)),
        knots: filterRecord(state.knots, (id) => knotsToRemove.has(id)),
        selectedId: null,
        selectedCategory: null,
        hoveredId: null,
    };

    setSnapshot(nextState);

    if (kickstandIdsToRemove.length > 0) {
        const kickstandIdsSet = new Set(kickstandIdsToRemove);
        const kickstandRootIdsToRemove = new Set<string>();
        const kickstandKnotIdsToRemove = new Set<string>();

        for (const kickstandId of kickstandIdsToRemove) {
            const kickstand = kickstandSnapshot.kickstands[kickstandId];
            if (!kickstand) continue;
            kickstandRootIdsToRemove.add(kickstand.rootId);
            kickstandKnotIdsToRemove.add(kickstand.hostKnotId);
        }

        setKickstandSnapshot({
            kickstands: filterRecord(kickstandSnapshot.kickstands, (id) => kickstandIdsSet.has(id)),
            roots: filterRecord(kickstandSnapshot.roots, (id) => kickstandRootIdsToRemove.has(id)),
            knots: filterRecord(kickstandSnapshot.knots, (id) => kickstandKnotIdsToRemove.has(id)),
            selectedId: null,
        });
    }

    let removedCount = ids.trunks.length
        + ids.branches.length
        + ids.braces.length
        + ids.leaves.length
        + ids.twigs.length
        + ids.sticks.length
        + ids.anchors.length;

    removedCount += kickstandIdsToRemove.length;

    // Keep count semantics close to historical behavior, where root removals were
    // typically cascaded from shaft removals (not counted as explicit removals).

    return removedCount;
}

/**
 * Filter and remove all support entities belonging to a specific ROI region.
 * Cascades removal of attached segments, knots, and braces.
 */
export function deleteSupportsForRoi(state: SupportState, roiId: string): SupportState {
    const rootsToRemove = new Set<string>();
    const trunksToRemove = new Set<string>();
    const branchesToRemove = new Set<string>();
    const bracesToRemove = new Set<string>();
    const leavesToRemove = new Set<string>();
    const twigsToRemove = new Set<string>();
    const sticksToRemove = new Set<string>();
    const anchorsToRemove = new Set<string>();

    // 1. Gather all main support entities belonging to this ROI
    for (const [id, root] of Object.entries(state.roots)) {
        if (root.roiId === roiId) rootsToRemove.add(id);
    }
    for (const [id, trunk] of Object.entries(state.trunks)) {
        if (trunk.roiId === roiId) trunksToRemove.add(id);
    }
    for (const [id, branch] of Object.entries(state.branches)) {
        if (branch.roiId === roiId) branchesToRemove.add(id);
    }
    for (const [id, twig] of Object.entries(state.twigs)) {
        if (twig.roiId === roiId) twigsToRemove.add(id);
    }
    for (const [id, stick] of Object.entries(state.sticks)) {
        if (stick.roiId === roiId) sticksToRemove.add(id);
    }
    for (const [id, anchor] of Object.entries(state.anchors)) {
        if (anchor.roiId === roiId) anchorsToRemove.add(id);
    }

    // 2. Identify segments to remove
    const segmentsToRemove = new Set<string>();
    for (const trunkId of trunksToRemove) {
        const trunk = state.trunks[trunkId];
        if (!trunk) continue;
        for (const segment of trunk.segments) segmentsToRemove.add(segment.id);
    }
    for (const branchId of branchesToRemove) {
        const branch = state.branches[branchId];
        if (!branch) continue;
        for (const segment of branch.segments) segmentsToRemove.add(segment.id);
    }
    for (const twigId of twigsToRemove) {
        const twig = state.twigs[twigId];
        if (!twig) continue;
        for (const segment of twig.segments) segmentsToRemove.add(segment.id);
    }
    for (const stickId of sticksToRemove) {
        const stick = state.sticks[stickId];
        if (!stick) continue;
        for (const segment of stick.segments) segmentsToRemove.add(segment.id);
    }

    // 3. Identify attached knots to remove
    const knotsToRemove = new Set<string>();
    for (const [knotId, knot] of Object.entries(state.knots)) {
        const parentShaftId = knot.parentShaftId;
        const removeByShaft = segmentsToRemove.has(parentShaftId);
        const removeByLeafCone = parentShaftId.startsWith('leafCone:')
            && leavesToRemove.has(parentShaftId.slice('leafCone:'.length));
        const removeByBraceSegment = parentShaftId.startsWith('braceSegment:')
            && bracesToRemove.has(parentShaftId.slice('braceSegment:'.length));
        if (removeByShaft || removeByLeafCone || removeByBraceSegment) {
            knotsToRemove.add(knotId);
        }
    }

    // 4. Helper record filter
    const filterRecord = <T>(record: Record<string, T>, shouldRemove: (id: string) => boolean): Record<string, T> => {
        const next: Record<string, T> = {};
        for (const [id, value] of Object.entries(record)) {
            if (shouldRemove(id)) continue;
            next[id] = value;
        }
        return next;
    };

    // 5. Compile next state
    return {
        ...state,
        roots: filterRecord(state.roots, (id) => rootsToRemove.has(id)),
        trunks: filterRecord(state.trunks, (id) => trunksToRemove.has(id)),
        branches: filterRecord(state.branches, (id) => branchesToRemove.has(id)),
        leaves: filterRecord(state.leaves, (id) => leavesToRemove.has(id)),
        twigs: filterRecord(state.twigs, (id) => twigsToRemove.has(id)),
        sticks: filterRecord(state.sticks, (id) => sticksToRemove.has(id)),
        braces: filterRecord(state.braces, (id) => bracesToRemove.has(id)),
        anchors: filterRecord(state.anchors, (id) => anchorsToRemove.has(id)),
        knots: filterRecord(state.knots, (id) => knotsToRemove.has(id)),
        selectedId: null,
        selectedCategory: null,
        hoveredId: null,
    };
}

