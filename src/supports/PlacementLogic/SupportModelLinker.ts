import type { SupportState } from '../types';
import { setSnapshot } from '../state';
import { getSupportBraceSnapshot, setSupportBraceSnapshot } from '../SupportTypes/SupportBrace/supportBraceStore';

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
}

/**
 * Finds all support entity IDs associated with a given model ID.
 */
export function getSupportsForModel(state: SupportState, modelId: string): ModelSupportIds {
    const result: ModelSupportIds = {
        roots: [],
        trunks: [],
        branches: [],
        braces: [],
        leaves: [],
        twigs: [],
        sticks: [],
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

    const supportBraceSnapshot = getSupportBraceSnapshot();
    const supportBraceIdsToRemove = Object.values(supportBraceSnapshot.supportBraces)
        .filter((supportBrace) => supportBrace.modelId === modelId)
        .map((supportBrace) => supportBrace.id);

    const hasMainSupportEntities = ids.roots.length > 0
        || ids.trunks.length > 0
        || ids.branches.length > 0
        || ids.braces.length > 0
        || ids.leaves.length > 0
        || ids.twigs.length > 0
        || ids.sticks.length > 0;

    if (!hasMainSupportEntities && supportBraceIdsToRemove.length === 0) {
        return 0;
    }

    const rootsToRemove = new Set(ids.roots);
    const trunksToRemove = new Set(ids.trunks);
    const branchesToRemove = new Set(ids.branches);
    const bracesToRemove = new Set(ids.braces);
    const leavesToRemove = new Set(ids.leaves);
    const twigsToRemove = new Set(ids.twigs);
    const sticksToRemove = new Set(ids.sticks);

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
        knots: filterRecord(state.knots, (id) => knotsToRemove.has(id)),
        selectedId: null,
        selectedCategory: null,
        hoveredId: null,
    };

    setSnapshot(nextState);

    if (supportBraceIdsToRemove.length > 0) {
        const supportBraceIdsSet = new Set(supportBraceIdsToRemove);
        const supportBraceRootIdsToRemove = new Set<string>();
        const supportBraceKnotIdsToRemove = new Set<string>();

        for (const supportBraceId of supportBraceIdsToRemove) {
            const supportBrace = supportBraceSnapshot.supportBraces[supportBraceId];
            if (!supportBrace) continue;
            supportBraceRootIdsToRemove.add(supportBrace.rootId);
            supportBraceKnotIdsToRemove.add(supportBrace.hostKnotId);
        }

        setSupportBraceSnapshot({
            supportBraces: filterRecord(supportBraceSnapshot.supportBraces, (id) => supportBraceIdsSet.has(id)),
            roots: filterRecord(supportBraceSnapshot.roots, (id) => supportBraceRootIdsToRemove.has(id)),
            knots: filterRecord(supportBraceSnapshot.knots, (id) => supportBraceKnotIdsToRemove.has(id)),
            selectedId: null,
        });
    }

    let removedCount = ids.trunks.length
        + ids.branches.length
        + ids.braces.length
        + ids.leaves.length
        + ids.twigs.length
        + ids.sticks.length;

    removedCount += supportBraceIdsToRemove.length;

    // Keep count semantics close to historical behavior, where root removals were
    // typically cascaded from shaft removals (not counted as explicit removals).

    return removedCount;
}
