import assert from 'node:assert/strict';
import test from 'node:test';

import { planStressActions } from '../autoSupport/stressActions';
import type { SupportFrameStressReport } from '../autoSupport/supportGraphStress';

function makeReport(overrides: Partial<SupportFrameStressReport> = {}): SupportFrameStressReport {
    return {
        nodeCount: 0,
        rootCount: 0,
        tipCount: 0,
        memberCount: 0,
        braceCount: 0,
        layersEvaluated: 1,
        peakLayerZMm: 20,
        peakLayerPeelForceN: 5,
        maxTipUtilizationPct: 57,
        overloadedTips: 0,
        maxMemberUtilizationPct: 0,
        overloadedMembers: 0,
        maxTipDeflectionMm: 0,
        maxTipRockingMm: 0,
        solverMode: 'frame3d',
        hotspots: [],
        layerProfile: [],
        memberSegments: [],
        tipPoints: [],
        ...overrides,
    };
}

const ROCKING_PAIR: NonNullable<SupportFrameStressReport['rockingPair']> = {
    aEntityId: 'leaf-a',
    bEntityId: 'leaf-b',
    aPos: { x: 3.5, y: 1.5, z: 16 },
    bPos: { x: 9.2, y: 0.9, z: 16 },
    layerZMm: 20.2,
    differentialMm: 0.847,
};

test('the pasted frame report plans a rocking brace then the two overloaded leaves', () => {
    const report = makeReport({
        maxTipRockingMm: 0.847,
        rockingPair: ROCKING_PAIR,
        maxMemberUtilizationPct: 169,
        hotspots: [
            { entityId: 'f86b9d8f', entityKind: 'leaf', kind: 'member', utilizationPct: 169, layerZMm: 20.2, pos: { x: 3.5, y: 1.5, z: 16 } },
            { entityId: '27dfa9bf', entityKind: 'leaf', kind: 'member', utilizationPct: 126, layerZMm: 20.2, pos: { x: 3.7, y: 1.4, z: 18.2 } },
            { entityId: 'bb9b38ec', entityKind: 'leaf', kind: 'member', utilizationPct: 98, layerZMm: 5.6, pos: { x: 10.2, y: -6.7, z: 3.3 } },
            { entityId: 'auto-bra', entityKind: 'brace', kind: 'member', utilizationPct: 96, layerZMm: 20.2, pos: { x: 9.2, y: 0.9, z: 11.7 } },
            { entityId: '61e009c4', entityKind: 'leaf', kind: 'member', utilizationPct: 96, layerZMm: 20.2, pos: { x: 6.6, y: 0.9, z: 17.6 } },
            { entityId: 'tip-1', entityKind: 'leaf', kind: 'tip', utilizationPct: 57, tipLoadN: 0.2, layerZMm: 20.2, pos: { x: 3.5, y: 1.5, z: 16 } },
        ],
    });

    const actions = planStressActions(report);

    assert.equal(actions.length, 3, 'one rocking brace and the two overloaded leaves');
    assert.equal(actions[0]?.kind, 'brace-rocking');
    if (actions[0]?.kind === 'brace-rocking') {
        assert.equal(actions[0].aEntityId, 'leaf-a');
        assert.equal(actions[0].bEntityId, 'leaf-b');
        assert.ok(Math.abs(actions[0].severity - 0.847 / 0.15) < 1e-9);
    }
    assert.deepEqual(actions.slice(1).map((action) => (action as { entityId: string }).entityId), ['f86b9d8f', '27dfa9bf']);
    assert.ok(actions.slice(1).every((action) => action.kind === 'brace-member'));
});

test('a leaf gets a mid-span brace while a trunk thickens', () => {
    const report = makeReport({
        hotspots: [
            { entityId: 'leaf-1', entityKind: 'leaf', kind: 'member', utilizationPct: 169, layerZMm: 20, pos: { x: 1, y: 0, z: 10 } },
            { entityId: 'trunk-1', entityKind: 'trunk', kind: 'member', utilizationPct: 120, layerZMm: 20, pos: { x: 2, y: 0, z: 10 } },
        ],
    });

    const actions = planStressActions(report);

    assert.equal(actions.length, 2);
    assert.equal(actions[0]?.kind, 'brace-member');
    assert.equal(actions[1]?.kind, 'thicken-member');
    if (actions[1]?.kind === 'thicken-member') assert.equal(actions[1].entityId, 'trunk-1');
});

test('a target margin pulls near-limit members into the plan', () => {
    const report = makeReport({
        hotspots: [
            { entityId: 'leaf-98', entityKind: 'leaf', kind: 'member', utilizationPct: 98, layerZMm: 5.6, pos: { x: 1, y: 0, z: 3 } },
        ],
    });

    assert.equal(planStressActions(report).length, 0);
    const withMargin = planStressActions(report, { memberTargetPct: 90 });
    assert.equal(withMargin.length, 1);
    assert.equal(withMargin[0]?.kind, 'brace-member');
});

test('rocking under the limit or without a pair plans no rocking brace', () => {
    assert.equal(planStressActions(makeReport({ maxTipRockingMm: 0.12, rockingPair: ROCKING_PAIR })).length, 0);
    assert.equal(planStressActions(makeReport({ maxTipRockingMm: 0.9 })).length, 0);
});

test('actions are capped highest-severity first and deterministic', () => {
    const hotspots = Array.from({ length: 8 }, (_, index) => ({
        entityId: `leaf-${index}`,
        entityKind: 'leaf' as const,
        kind: 'member' as const,
        utilizationPct: 110 + index,
        layerZMm: 10,
        pos: { x: index, y: 0, z: 5 },
    }));
    const report = makeReport({ hotspots, maxTipRockingMm: 0.4, rockingPair: ROCKING_PAIR });

    const first = planStressActions(report, { maxActions: 3 });
    const second = planStressActions(report, { maxActions: 3 });
    assert.deepEqual(first, second, 'deterministic');
    assert.equal(first.length, 3);
    assert.equal(first[0]?.kind, 'brace-rocking');
    assert.deepEqual(first.slice(1).map((action) => (action as { entityId: string }).entityId), ['leaf-7', 'leaf-6']);
});

test('a heavily overloaded trunk is braced, not thickened again', () => {
    const report = makeReport({
        hotspots: [
            { entityId: 'trunk-630', entityKind: 'trunk', kind: 'member', utilizationPct: 630, layerZMm: 20, pos: { x: 1, y: 0, z: 10 } },
        ],
    });

    const actions = planStressActions(report);
    assert.equal(actions.length, 1);
    assert.equal(actions[0]?.kind, 'brace-member');

    const raised = planStressActions(report, { trunkBracePct: 700 });
    assert.equal(raised[0]?.kind, 'thicken-member');
});

test('thicken actions carry the member midpoint for a brace fallback', () => {
    const report = makeReport({
        hotspots: [
            { entityId: 'trunk-120', entityKind: 'trunk', kind: 'member', utilizationPct: 120, layerZMm: 12.5, pos: { x: 2, y: 1, z: 11 } },
        ],
    });

    const [action] = planStressActions(report);
    assert.equal(action?.kind, 'thicken-member');
    if (action?.kind === 'thicken-member') {
        assert.equal(action.layerZMm, 12.5);
        assert.deepEqual(action.pos, { x: 2, y: 1, z: 11 });
    }
});


test('rocking alone does not spend a brace, but an explicit request still plans it', () => {
    const report = makeReport({
        maxTipRockingMm: 0.533,
        rockingPair: { ...ROCKING_PAIR, differentialMm: 0.533 },
        maxTipUtilizationPct: 32,
        hotspots: [
            { entityId: 'tip-1', entityKind: 'leaf', kind: 'tip', utilizationPct: 32, layerZMm: 20.2, pos: { x: 3.5, y: 1.5, z: 16 } },
        ],
    });

    assert.equal(planStressActions(report).length, 0, 'elastic part rotation → no brace');
    const forced = planStressActions(report, { rockingRequiresOverload: false });
    assert.equal(forced[0]?.kind, 'brace-rocking');
});
