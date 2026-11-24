import assert from 'node:assert/strict';
import test from 'node:test';

import { HIGH_LEVERAGE_SPAN_MM, type PrintabilityReport } from '../autoSupport/printability';
import type { SupportFrameStressReport } from '../autoSupport/supportGraphStress';
import {
    summarizeSupportStress,
    supportStressReportToText,
} from '../autoSupport/supportStressReport';
import type { ToppleRiskReport } from '../autoSupport/toppleRisk';
import { ROCKING_THRESHOLD_MM } from '../autoSupport/toppleRisk';

function makeFrame(overrides: Partial<SupportFrameStressReport> = {}): SupportFrameStressReport {
    return {
        nodeCount: 24,
        rootCount: 4,
        tipCount: 8,
        memberCount: 20,
        braceCount: 6,
        layersEvaluated: 3,
        peakLayerZMm: 14.5,
        peakLayerPeelForceN: 4.2,
        maxTipUtilizationPct: 48,
        overloadedTips: 0,
        maxMemberUtilizationPct: 55,
        overloadedMembers: 0,
        maxTipDeflectionMm: 0.04,
        solverMode: 'frame3d',
        hotspots: [
            {
                entityId: 'trunk-1111aaaa',
                entityKind: 'trunk',
                kind: 'member',
                utilizationPct: 55,
                peakStressMpa: 6.6,
                layerZMm: 14.5,
                pos: { x: 1, y: 2, z: 14.5 },
            },
        ],
        layerProfile: [
            { zMm: 5.0, areaMm2: 40, peelForceN: 1.1, maxTipUtilPct: 12, maxMemberUtilPct: 18, critical: false },
            { zMm: 14.5, areaMm2: 180, peelForceN: 4.2, maxTipUtilPct: 48, maxMemberUtilPct: 55, critical: true },
        ],
        memberSegments: [],
        tipPoints: [],
        ...overrides,
    };
}

function makePrintability(overrides: Partial<PrintabilityReport> = {}): PrintabilityReport {
    return {
        verdict: 'ready',
        regions: [],
        uncoveredRegions: 0,
        deficientRegions: 0,
        criticalRegions: 0,
        totalFootprintAreaMm2: 120,
        uncoveredAreaMm2: 0,
        uncoveredFraction: 0,
        worst: null,
        loadBudget: {
            rows: [],
            totalDemandMm2: 120,
            totalCapacityMm2: 160,
            wouldAdd: 0,
            wouldCull: 0,
            islandsInDeficit: 0,
            islandsInSurplus: 1,
            islandsWithoutArea: 0,
            worst: null,
        },
        peelCurve: [
            { zMm: 14.5, areaMm2: 180, peelForceN: 4.2, maxTipUtilPct: 0, maxMemberUtilPct: 0, critical: false },
        ],
        peakPeelForceN: 4.2,
        peakPeelLayerZMm: 14.5,
        peakAreaJumpRatio: 1.8,
        maxFreeSpanMm: 2.4,
        frameMaxUtilizationPct: 55,
        ...overrides,
    };
}

function makeTopple(overrides: Partial<ToppleRiskReport> = {}): ToppleRiskReport {
    return {
        comDepthMm: 6.2,
        peelMomentNmm: 18.4,
        totalPeelForceN: 4.2,
        requiredAdhesionMpa: 0.012,
        complianceMm: 0.04,
        outcome: 'adhesionBound',
        ...overrides,
    };
}

test('summarizeSupportStress ranks critical, attention, ready, and unanalyzed consistently', () => {
    assert.deepEqual(summarizeSupportStress({}), {
        level: 'unanalyzed',
        primaryIssue: 'unanalyzed',
        peakUtilizationPct: 0,
        overloadedCount: 0,
    });

    const ready = summarizeSupportStress({
        frame: makeFrame(),
        printability: makePrintability(),
        topple: makeTopple(),
    });
    assert.equal(ready.level, 'ready');
    assert.equal(ready.primaryIssue, 'none');

    const overloaded = summarizeSupportStress({
        frame: makeFrame({ maxMemberUtilizationPct: 124, overloadedMembers: 2 }),
        printability: makePrintability({ uncoveredAreaMm2: 15, verdict: 'critical' }),
        topple: makeTopple({ outcome: 'pastEdge', comDepthMm: -1 }),
    });
    assert.equal(overloaded.level, 'critical');
    assert.equal(overloaded.primaryIssue, 'overloadedSupports');

    const pastEdge = summarizeSupportStress({
        frame: makeFrame(),
        printability: makePrintability({ uncoveredAreaMm2: 15, verdict: 'critical' }),
        topple: makeTopple({ outcome: 'pastEdge', comDepthMm: -1 }),
    });
    assert.equal(pastEdge.level, 'critical');
    assert.equal(pastEdge.primaryIssue, 'pastBearingEdge');

    const uncovered = summarizeSupportStress({
        frame: makeFrame(),
        printability: makePrintability({ uncoveredAreaMm2: 5.5, uncoveredRegions: 1, verdict: 'underSupported' }),
        topple: makeTopple(),
    });
    assert.equal(uncovered.level, 'critical');
    assert.equal(uncovered.primaryIssue, 'uncoveredOverhangs');

    const highLoad = summarizeSupportStress({
        frame: makeFrame({ maxTipUtilizationPct: 82 }),
        printability: makePrintability(),
        topple: makeTopple({ outcome: 'rocking', complianceMm: ROCKING_THRESHOLD_MM + 0.05 }),
    });
    assert.equal(highLoad.level, 'attention');
    assert.equal(highLoad.primaryIssue, 'highLoad');

    const rocking = summarizeSupportStress({
        frame: makeFrame(),
        printability: makePrintability({ maxFreeSpanMm: HIGH_LEVERAGE_SPAN_MM + 1 }),
        topple: makeTopple({ outcome: 'rocking', complianceMm: ROCKING_THRESHOLD_MM + 0.05 }),
    });
    assert.equal(rocking.level, 'attention');
    assert.equal(rocking.primaryIssue, 'rocking');

    const deficient = summarizeSupportStress({
        frame: makeFrame(),
        printability: makePrintability({ deficientRegions: 2, maxFreeSpanMm: HIGH_LEVERAGE_SPAN_MM + 1 }),
        topple: makeTopple(),
    });
    assert.equal(deficient.level, 'attention');
    assert.equal(deficient.primaryIssue, 'deficientRegions');

    const longSpan = summarizeSupportStress({
        frame: makeFrame(),
        printability: makePrintability({ maxFreeSpanMm: HIGH_LEVERAGE_SPAN_MM }),
        topple: makeTopple(),
    });
    assert.equal(longSpan.level, 'attention');
    assert.equal(longSpan.primaryIssue, 'longSpan');

    const floating = summarizeSupportStress({
        floatingUnsupported: true,
        modelMinZMm: 5.3,
    });
    assert.equal(floating.level, 'critical');
    assert.equal(floating.primaryIssue, 'floatingUnsupported');

    const unscannedNoFrame = summarizeSupportStress({
        printability: makePrintability(),
        topple: makeTopple(),
        hasScan: false,
    });
    assert.equal(unscannedNoFrame.level, 'unanalyzed');
    assert.equal(unscannedNoFrame.primaryIssue, 'unanalyzed');

    const unscannedWithFrame = summarizeSupportStress({
        frame: makeFrame(),
        printability: makePrintability(),
        topple: makeTopple(),
        hasScan: false,
    });
    assert.equal(unscannedWithFrame.level, 'unanalyzed');
    assert.equal(unscannedWithFrame.primaryIssue, 'notScanned');

    const scannedPassing = summarizeSupportStress({
        frame: makeFrame(),
        printability: makePrintability(),
        topple: makeTopple(),
        hasScan: true,
    });
    assert.equal(scannedPassing.level, 'ready');
    assert.equal(scannedPassing.primaryIssue, 'none');
});

test('supportStressReportToText renders full, printability-only, and empty reports deterministically', () => {
    const emptyText = supportStressReportToText({});
    assert.ok(emptyText.includes('PRINTABILITY REPORT'));
    assert.ok(emptyText.includes('NOT CHECKED'));

    const floatingText = supportStressReportToText({
        modelId: 'archer',
        floatingUnsupported: true,
        modelMinZMm: 5.3,
        hasScan: false,
    });
    assert.ok(floatingText.includes('ACTION NEEDED'));
    assert.ok(floatingText.includes('5.3mm above the build plate with no supports'));
    assert.ok(floatingText.includes('Coverage: not scanned'));
    assert.ok(!floatingText.includes('COVERAGE & PRINTABILITY'));

    const unscannedText = supportStressReportToText({
        modelId: 'benchy',
        printability: makePrintability(),
        topple: makeTopple(),
        hasScan: false,
    });
    assert.ok(unscannedText.includes('NOT CHECKED'));
    assert.ok(unscannedText.includes('Coverage: not scanned'));
    assert.ok(!unscannedText.includes('COVERAGE & PRINTABILITY'));

    const passingText = supportStressReportToText({
        modelId: 'benchy',
        frame: makeFrame(),
        printability: makePrintability(),
        topple: makeTopple(),
        hasScan: true,
    });
    assert.ok(passingText.includes('CHECKS PASSED'));

    const demandOnlyText = supportStressReportToText({
        modelId: 'benchy',
        printability: makePrintability({
            verdict: 'underSupported',
            uncoveredAreaMm2: 12.5,
            uncoveredRegions: 2,
            deficientRegions: 2,
            regions: [
                {
                    islandId: 'ok-reg',
                    source: 'overhang',
                    contact: { x: 0, y: 0, z: 4 },
                    baseZ: 4,
                    footprintAreaMm2: 30,
                    coverage: 1,
                    coverageRadiusMm: 2,
                    uncoveredAreaMm2: 0,
                    freeSpanMm: 1.2,
                    demandMm2: 30,
                    capacityMm2: 40,
                    deficitMm2: 0,
                    severity: 'ok',
                },
                {
                    islandId: 'warn-reg',
                    source: 'overhang',
                    contact: { x: 2, y: 0, z: 6 },
                    baseZ: 6,
                    footprintAreaMm2: 40,
                    coverage: 0.85,
                    coverageRadiusMm: 2,
                    uncoveredAreaMm2: 6,
                    freeSpanMm: 4.5,
                    demandMm2: 40,
                    capacityMm2: 20,
                    deficitMm2: 20,
                    severity: 'warn',
                },
                {
                    islandId: 'crit-reg',
                    source: 'voxel',
                    contact: { x: -3, y: 1, z: 8 },
                    baseZ: 8,
                    footprintAreaMm2: 50,
                    coverage: 0.4,
                    coverageRadiusMm: 2,
                    uncoveredAreaMm2: 30,
                    freeSpanMm: 6.5,
                    demandMm2: 50,
                    capacityMm2: 10,
                    deficitMm2: 40,
                    severity: 'critical',
                },
            ],
        }),
    });
    assert.ok(demandOnlyText.includes('COVERAGE & PRINTABILITY'));
    assert.ok(!demandOnlyText.includes('SUPPORT FRAME STRESS'));
    assert.ok(demandOnlyText.includes('PEEL PROFILE'));
    const critIdx = demandOnlyText.indexOf('crit-reg');
    const warnIdx = demandOnlyText.indexOf('warn-reg');
    assert.ok(critIdx !== -1 && warnIdx !== -1 && critIdx < warnIdx, 'critical problem region appears before warning region');
    assert.ok(!demandOnlyText.includes('ok-reg'), 'healthy regions omitted from problem regions list');

    const fullInput = {
        modelId: 'benchy',
        frame: makeFrame({
            overloadedMembers: 1,
            maxMemberUtilizationPct: 118,
            reinforcedCount: 3,
        }),
        printability: makePrintability(),
        topple: makeTopple(),
    };
    const fullA = supportStressReportToText(fullInput);
    const fullB = supportStressReportToText(fullInput);
    assert.equal(fullA, fullB, 'report formatting is deterministic');
    for (const section of ['SUMMARY', 'COVERAGE & PRINTABILITY', 'STABILITY & TOPPLE RISK', 'SUPPORT FRAME STRESS', 'PEEL PROFILE']) {
        assert.ok(fullA.includes(section), `includes ${section}`);
    }
    assert.ok(fullA.includes('3 reinforced'));
    assert.ok(fullA.includes('trunk trunk-11 (member)'));
});
