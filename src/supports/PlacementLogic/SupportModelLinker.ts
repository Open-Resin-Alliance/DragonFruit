import type { SupportState } from '../types';
import { removeTrunk } from '../state';

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
}

/**
 * Finds all support entity IDs associated with a given model ID.
 */
export function getSupportsForModel(state: SupportState, modelId: string): ModelSupportIds {
    const result: ModelSupportIds = {
        roots: [],
        trunks: [],
        branches: [],
        braces: []
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

    return result;
}

/**
 * Orchestrates the deletion of all supports for a specific model.
 * 
 * NOTE: This calls mutations in the store directly. 
 * Ideally, this should generate a payload for a single atomic "REMOVE_MODEL_SUPPORTS" action,
 * but for now, we will iterate and call existing remove functions to reuse their cleanup logic (like clearing selection).
 * 
 * @returns Number of top-level supports (Trunks) removed.
 */
export function deleteSupportsForModel(state: SupportState, modelId: string): number {
    const ids = getSupportsForModel(state, modelId);
    let removedCount = 0;

    // Remove Trunks
    // removeTrunk() handles the root cleanup internally if the trunk owns it.
    // It also handles notification.
    ids.trunks.forEach(trunkId => {
        const result = removeTrunk(trunkId);
        if (result) removedCount++;
    });

    // TODO: Implement removeBranch() and removeBrace() when those features are active.
    // For now, we just log if we found others that we can't delete yet.
    if (ids.branches.length > 0 || ids.braces.length > 0) {
        console.warn(`[SupportModelLinker] Found ${ids.branches.length} branches and ${ids.braces.length} braces for model ${modelId}, but deletion is not yet implemented for these types.`);
    }

    return removedCount;
}
