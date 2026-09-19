import assert from 'node:assert/strict';
import test from 'node:test';
import {
    activePlacementTypeId,
    BRACE_PLACEMENT_OWNER,
    BRANCH_FAMILY_PLACEMENT_OWNER,
    DEFAULT_PLACEMENT_TYPE_ID,
    isPlacementActiveForType,
    isPlacementPreviewForType,
    KICKSTAND_PLACEMENT_OWNER,
    LEAF_PLACEMENT_OWNER,
    PLACEMENT_MODE_TYPE_IDS,
    resolveActivePlacementTypeId,
    resolveSupportPlacementRouting,
} from '../interaction/shared/placement/hotkeys/supportPlacementRouting';
import { BRANCH_FAMILY_MEMBER_TYPES, getSupportTypeDescriptor, KICKSTAND_HOST_TYPES, MODEL_SURFACE_GESTURE_TYPES, PLACEMENT_MODE_OWNER_TYPES, placementModeOwnerDrift, SUPPORT_TYPES } from '../supportTypeRegistry';
import type { SupportPlacementActive, SupportPlacementPreviews } from '../rendering';
import type { PlacementOwnerTypeId } from '../interaction/shared/placement/hotkeys/supportPlacementRouting';
import { PLACEMENT_FAMILY_BY_BINDING } from '../interaction/shared/placement/hotkeys/supportPlacementHotkeyTypes';
import type { SupportPlacementHotkeyBindings, SupportPlacementModifierState, SupportPlacementRoutingState } from '../interaction/shared/placement/hotkeys/supportPlacementHotkeyTypes';

const defaultBindings: SupportPlacementHotkeyBindings = {
    branchFamily: { key: 'Alt', description: '' },
    leaf: { key: 'Alt', modifier: 'ctrl', description: '' },
    kickstand: { key: 'Control', description: '' }
};

const defaultModifierState: SupportPlacementModifierState = {
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false
};

const defaultRoutingState: SupportPlacementRoutingState = {
    branchHotkeyActive: false,
    braceHotkeyActive: false,
    leafHotkeyActive: false,
    kickstandHotkeyActive: false,
    braceAwaitingEnd: false,
    leafAwaitingBase: false,
    branchAwaitingBase: false
};

/**
 * The router answers two questions: which owner a gesture goes to, and whether
 * the default tool stands down. Its three support-side fields
 * (`supportHoverOwner` / `supportClickOwner` / `blocksDefaultSupportPlacement`)
 * are gone with the handlers that read them — see the note in the manager.
 */
test('resolveSupportPlacementRouting behaviour', () => {
    // 1. Idle state
    const resIdle = resolveSupportPlacementRouting({
        bindings: defaultBindings,
        modifierState: defaultModifierState,
        state: defaultRoutingState
    });
    assert.equal(resIdle.blocksDefaultModelPlacement, false);
    assert.equal(resIdle.owner, 'none');

    // 2. Leaf active via hotkey
    const resLeafHotkey = resolveSupportPlacementRouting({
        bindings: defaultBindings,
        modifierState: defaultModifierState,
        state: { ...defaultRoutingState, leafHotkeyActive: true }
    });
    assert.equal(resLeafHotkey.blocksDefaultModelPlacement, true);
    assert.equal(resLeafHotkey.owner, LEAF_PLACEMENT_OWNER);

    // 3. Kickstand active via Ctrl key modifier
    const resKickstand = resolveSupportPlacementRouting({
        bindings: defaultBindings,
        modifierState: { ...defaultModifierState, ctrlKey: true },
        state: defaultRoutingState
    });
    assert.equal(resKickstand.blocksDefaultModelPlacement, true);
    assert.equal(resKickstand.owner, KICKSTAND_PLACEMENT_OWNER);
});


test('the derived owner list covers exactly the flagged types', () => {
    assert.deepEqual(
        [...MODEL_SURFACE_GESTURE_TYPES].sort(),
        SUPPORT_TYPES.filter((d) => d.claimsModelSurfaceGestures).map((d) => d.id).sort(),
    );
});

/** The registry's placement-owner table is held to its descriptor flags at load. */
test('the registry placement-owner table agrees with the descriptor flags', () => {
    assert.deepEqual(placementModeOwnerDrift(), []);
});

/** Every placement mode has exactly one owner, and they are the registry's. */
test('the router owner constants are the registry placement modes', () => {
    const owners: readonly PlacementOwnerTypeId[] = [
        BRANCH_FAMILY_PLACEMENT_OWNER,
        LEAF_PLACEMENT_OWNER,
        BRACE_PLACEMENT_OWNER,
        KICKSTAND_PLACEMENT_OWNER,
    ];
    assert.deepEqual([...owners].sort(), [...PLACEMENT_MODE_OWNER_TYPES].sort());
});

/** The two type-named families cover every owner outside the shared branch family. */
test('the branch family members are the owners no own-named family covers', () => {
    const ownNamedFamilyNames = [PLACEMENT_FAMILY_BY_BINDING.leaf, PLACEMENT_FAMILY_BY_BINDING.kickstand];
    const branchFamilyMembers = PLACEMENT_MODE_OWNER_TYPES.filter(
        (typeId) => !ownNamedFamilyNames.some((familyName) => familyName === typeId),
    );
    assert.deepEqual([...branchFamilyMembers].sort(), [...BRANCH_FAMILY_MEMBER_TYPES].sort());
});

/** Every state and modifier combination, checked against the registry's sets. */
test('every owner the router answers with is a registry-declared one', () => {
    const booleans = [false, true];
    const states: SupportPlacementRoutingState[] = [];
    for (const branchHotkeyActive of booleans)
        for (const braceHotkeyActive of booleans)
            for (const leafHotkeyActive of booleans)
                for (const kickstandHotkeyActive of booleans)
                    for (const braceAwaitingEnd of booleans)
                        for (const leafAwaitingBase of booleans)
                            for (const branchAwaitingBase of booleans)
                                states.push({
                                    branchHotkeyActive,
                                    braceHotkeyActive,
                                    leafHotkeyActive,
                                    kickstandHotkeyActive,
                                    braceAwaitingEnd,
                                    leafAwaitingBase,
                                    branchAwaitingBase,
                                });

    const modifierStates: SupportPlacementModifierState[] = [];
    for (const ctrlKey of booleans)
        for (const altKey of booleans)
            for (const shiftKey of booleans)
                for (const metaKey of booleans)
                    modifierStates.push({ ctrlKey, altKey, shiftKey, metaKey });

    const gestureOwners: readonly string[] = MODEL_SURFACE_GESTURE_TYPES;
    let exercised = 0;
    for (const state of states) {
        for (const modifierState of modifierStates) {
            const input = { bindings: defaultBindings, modifierState, state };
            const routing = resolveSupportPlacementRouting(input);
            exercised++;
            if (routing.owner !== 'none') {
                assert.ok(
                    PLACEMENT_MODE_TYPE_IDS.includes(routing.owner),
                    `${routing.owner} owns a placement but declares no mode`,
                );
            }
            if (routing.modelHoverOwner !== 'none') {
                assert.ok(
                    gestureOwners.includes(routing.modelHoverOwner),
                    `${routing.modelHoverOwner} takes a model gesture but claims none`,
                );
            }
        }
    }
    assert.equal(exercised, states.length * modifierStates.length);
});

/**
 * The host set leaf sprouting walks is the kickstand-host set. Sprouting hangs a
 * knot off a host's SEGMENT, so every member must be a shaft.
 */
test('every host leaf sprouting may hang a knot on has segments', () => {
    assert.ok(KICKSTAND_HOST_TYPES.length > 0, 'a leaf sprout needs at least one host');
    for (const typeId of KICKSTAND_HOST_TYPES) {
        assert.equal(
            getSupportTypeDescriptor(typeId).hasSegments,
            true,
            `${typeId} is walked for a sprout knot but declares no segments to hang it on`,
        );
    }
});

/**
 * The branch family routes its gesture to the model face while its `owner` stays
 * `'none'`, so a reader that only looked at `owner` would call that idle. This
 * is the trap `resolveActivePlacementTypeId` exists for.
 */
test('the active placement is the gesture owner when the owner is none', () => {
    const branchFamilyInput = {
        bindings: defaultBindings,
        modifierState: { ...defaultModifierState, altKey: true },
        state: defaultRoutingState,
    };
    const routing = resolveSupportPlacementRouting(branchFamilyInput);
    assert.equal(routing.owner, 'none');
    assert.equal(routing.modelHoverOwner, BRANCH_FAMILY_PLACEMENT_OWNER);
    assert.equal(resolveActivePlacementTypeId(branchFamilyInput), BRANCH_FAMILY_PLACEMENT_OWNER);

    const idleInput = {
        bindings: defaultBindings,
        modifierState: defaultModifierState,
        state: defaultRoutingState,
    };
    assert.equal(resolveActivePlacementTypeId(idleInput), null);

    // An armed brace owns the interaction outright, without a model gesture.
    const braceInput = {
        bindings: defaultBindings,
        modifierState: defaultModifierState,
        state: { ...defaultRoutingState, braceAwaitingEnd: true },
    };
    assert.equal(resolveActivePlacementTypeId(braceInput), BRACE_PLACEMENT_OWNER);
});

/**
 * How the scene asks the type-keyed records about a type it holds at runtime
 * rather than spells. The ids below are values, so a rename in the registry
 * moves the question with the record and no key is written at the call site.
 */
test('the type-keyed placement records answer for a runtime type id', () => {
    const active: SupportPlacementActive = {
        [BRANCH_FAMILY_PLACEMENT_OWNER]: true,
        [LEAF_PLACEMENT_OWNER]: false,
    };
    assert.equal(isPlacementActiveForType(active, BRANCH_FAMILY_PLACEMENT_OWNER), true);
    assert.equal(isPlacementActiveForType(active, LEAF_PLACEMENT_OWNER), false);
    // A type with no placement mode at all, and a type merely absent from the
    // record, both read false rather than undefined.
    assert.equal(isPlacementActiveForType(active, BRACE_PLACEMENT_OWNER), false);
    assert.equal(isPlacementActiveForType(active, DEFAULT_PLACEMENT_TYPE_ID), false);

    // The first mode live, in registry order, is what "which mode is active"
    // answers when more than one is: branch is declared before leaf.
    assert.equal(activePlacementTypeId(active), BRANCH_FAMILY_PLACEMENT_OWNER);
    assert.equal(
        activePlacementTypeId({ [LEAF_PLACEMENT_OWNER]: true, [BRANCH_FAMILY_PLACEMENT_OWNER]: true }),
        BRANCH_FAMILY_PLACEMENT_OWNER,
    );
    assert.equal(activePlacementTypeId({ [LEAF_PLACEMENT_OWNER]: true }), LEAF_PLACEMENT_OWNER);
    assert.equal(activePlacementTypeId({}), null);

    const previews: SupportPlacementPreviews = {
        [BRANCH_FAMILY_PLACEMENT_OWNER]: null,
        [DEFAULT_PLACEMENT_TYPE_ID]: { id: 'trunk-1' },
    };
    // A null preview is not a preview; an absent one is not either.
    assert.equal(isPlacementPreviewForType(previews, BRANCH_FAMILY_PLACEMENT_OWNER), false);
    assert.equal(isPlacementPreviewForType(previews, LEAF_PLACEMENT_OWNER), false);
    assert.equal(isPlacementPreviewForType(previews, DEFAULT_PLACEMENT_TYPE_ID), true);
});
