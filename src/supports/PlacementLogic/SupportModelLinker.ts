import type { SupportState } from '../types';
import { removeBranch, removeBrace, removeLeaf, removeStick, removeTrunk, removeTwig } from '../state';
import { getSupportBraceSnapshot, removeSupportBrace } from '../SupportTypes/SupportBrace/supportBraceStore';

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
    let removedCount = 0;

    // Remove Trunks
    // removeTrunk() handles the root cleanup internally if the trunk owns it.
    // It also handles notification.
    ids.trunks.forEach(trunkId => {
        const result = removeTrunk(trunkId);
        if (result) removedCount++;
    });

    // Remove any branches that were not already removed by trunk/branch cascades.
    ids.branches.forEach((branchId) => {
        const result = removeBranch(branchId);
        if (result) removedCount++;
    });

    // Remove any braces that remain after branch/trunk cascades.
    ids.braces.forEach((braceId) => {
        const result = removeBrace(braceId);
        if (result) removedCount++;
    });

    // Remove remaining leaf-only entities.
    ids.leaves.forEach((leafId) => {
        const result = removeLeaf(leafId);
        if (result) removedCount++;
    });

    // Remove mesh-to-mesh supports owned by the model.
    ids.twigs.forEach((twigId) => {
        const result = removeTwig(twigId);
        if (result) removedCount++;
    });

    ids.sticks.forEach((stickId) => {
        const result = removeStick(stickId);
        if (result) removedCount++;
    });

    // Remove any support braces owned by this model that remain in the local support-brace store.
    const supportBraceSnapshot = getSupportBraceSnapshot();
    for (const supportBrace of Object.values(supportBraceSnapshot.supportBraces)) {
        if (supportBrace.modelId !== modelId) continue;
        const removed = removeSupportBrace(supportBrace.id);
        if (removed) removedCount++;
    }

    return removedCount;
}
