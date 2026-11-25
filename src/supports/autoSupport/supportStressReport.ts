import {
    HIGH_LEVERAGE_SPAN_MM,
    type PrintabilityReport,
    type PrintabilityRegion,
} from './printability';
import type { SupportFrameStressReport } from './supportGraphStress';
import { planStressActions } from './stressActions';
import { ROCKING_THRESHOLD_MM, type ToppleRiskReport } from './toppleRisk';

export const FLOATING_Z_THRESHOLD_MM = 0.5;

export type SupportStressStatusLevel = 'ready' | 'attention' | 'critical' | 'unanalyzed';

export type SupportStressPrimaryIssue =
    | 'none'
    | 'unanalyzed'
    | 'notScanned'
    | 'floatingUnsupported'
    | 'overloadedSupports'
    | 'uncoveredOverhangs'
    | 'pastBearingEdge'
    | 'highLoad'
    | 'rocking'
    | 'longSpan'
    | 'deficientRegions';

export interface SupportStressSummary {
    level: SupportStressStatusLevel;
    primaryIssue: SupportStressPrimaryIssue;
    peakUtilizationPct: number;
    overloadedCount: number;
}

export interface SupportStressReportInput {
    modelId?: string;
    frame?: SupportFrameStressReport | null;
    printability?: PrintabilityReport | null;
    topple?: ToppleRiskReport | null;
    /** True when the model's lowest point sits above the build plate with no supports. */
    floatingUnsupported?: boolean;
    /** World min-Z of the posed model (mm), used when reporting floating parts. */
    modelMinZMm?: number;
    /** Whether an island/overhang scan has completed for the current model pose. */
    hasScan?: boolean;
}

/**
 * Distill structural frame stress, live printability coverage, and pose topple
 * risk into one ordered overall verdict for both UI banners and text reports.
 */
export function summarizeSupportStress(input: SupportStressReportInput): SupportStressSummary {
    const { frame, printability, topple, floatingUnsupported, hasScan } = input;
    const peakUtilizationPct = frame
        ? Math.max(frame.maxTipUtilizationPct, frame.maxMemberUtilizationPct)
        : 0;
    const overloadedCount = frame
        ? frame.overloadedMembers + frame.overloadedTips
        : 0;

    if (floatingUnsupported) {
        return {
            level: 'critical',
            primaryIssue: 'floatingUnsupported',
            peakUtilizationPct,
            overloadedCount,
        };
    }

    if (!frame && !printability && !topple) {
        return {
            level: 'unanalyzed',
            primaryIssue: 'unanalyzed',
            peakUtilizationPct: 0,
            overloadedCount: 0,
        };
    }

    const scanned = hasScan !== false;

    if (overloadedCount > 0 || peakUtilizationPct > 100) {
        return {
            level: 'critical',
            primaryIssue: 'overloadedSupports',
            peakUtilizationPct,
            overloadedCount,
        };
    }
    if (topple?.outcome === 'pastEdge') {
        return {
            level: 'critical',
            primaryIssue: 'pastBearingEdge',
            peakUtilizationPct,
            overloadedCount,
        };
    }
    if (scanned && printability && printability.verdict === 'critical') {
        return {
            level: 'critical',
            primaryIssue: 'uncoveredOverhangs',
            peakUtilizationPct,
            overloadedCount,
        };
    }

    if (peakUtilizationPct >= 75) {
        return {
            level: 'attention',
            primaryIssue: 'highLoad',
            peakUtilizationPct,
            overloadedCount,
        };
    }
    if (scanned && printability && printability.verdict === 'underSupported') {
        return {
            level: 'attention',
            primaryIssue: 'uncoveredOverhangs',
            peakUtilizationPct,
            overloadedCount,
        };
    }
    if (topple?.outcome === 'rocking') {
        return {
            level: 'attention',
            primaryIssue: 'rocking',
            peakUtilizationPct,
            overloadedCount,
        };
    }
    if (scanned && printability && printability.deficientRegions > 0) {
        return {
            level: 'attention',
            primaryIssue: 'deficientRegions',
            peakUtilizationPct,
            overloadedCount,
        };
    }
    if (scanned && printability && printability.maxFreeSpanMm >= HIGH_LEVERAGE_SPAN_MM) {
        return {
            level: 'attention',
            primaryIssue: 'longSpan',
            peakUtilizationPct,
            overloadedCount,
        };
    }

    if (!scanned && !frame) {
        return {
            level: 'unanalyzed',
            primaryIssue: 'unanalyzed',
            peakUtilizationPct: 0,
            overloadedCount: 0,
        };
    }
    if (!scanned && frame) {
        return {
            level: 'unanalyzed',
            primaryIssue: 'notScanned',
            peakUtilizationPct,
            overloadedCount: 0,
        };
    }

    return {
        level: 'ready',
        primaryIssue: 'none',
        peakUtilizationPct,
        overloadedCount: 0,
    };
}

function statusHeading(level: SupportStressStatusLevel): string {
    switch (level) {
        case 'ready':
            return 'CHECKS PASSED';
        case 'attention':
            return 'NEEDS ATTENTION';
        case 'critical':
            return 'ACTION NEEDED';
        case 'unanalyzed':
            return 'NOT CHECKED';
    }
}

function primaryIssueSentence(summary: SupportStressSummary, input: SupportStressReportInput): string {
    const { frame, printability, topple, modelMinZMm } = input;
    switch (summary.primaryIssue) {
        case 'none':
            return 'All checked overhangs, support loads, and stability metrics are within limits.';
        case 'unanalyzed':
            return 'Scan overhangs or generate supports to check printability.';
        case 'notScanned':
            return 'Support load and stability are within limits; scan overhangs to check coverage.';
        case 'floatingUnsupported':
            return typeof modelMinZMm === 'number'
                ? `Model floats ${modelMinZMm.toFixed(1)}mm above the build plate with no supports.`
                : 'Model floats above the build plate with no supports.';
        case 'overloadedSupports':
            return `${summary.overloadedCount} overloaded support element(s); peak load reaches ${summary.peakUtilizationPct.toFixed(0)}%.`;
        case 'uncoveredOverhangs':
            return printability
                ? `${printability.uncoveredAreaMm2.toFixed(2)}mm² of overhang surface is unsupported (${printability.uncoveredRegions} uncovered region(s)).`
                : 'Unsupported overhang regions remain.';
        case 'pastBearingEdge':
            return topple
                ? `Centre of mass sits ${Math.abs(topple.comDepthMm).toFixed(2)}mm past the bearing edge.`
                : 'Centre of mass sits past the bearing edge.';
        case 'highLoad':
            return `Peak support utilization is ${summary.peakUtilizationPct.toFixed(0)}% (>= 75% warning band).`;
        case 'rocking':
            return topple
                ? `Contact rocking (${topple.complianceMm.toFixed(3)}mm differential) exceeds the ${ROCKING_THRESHOLD_MM.toFixed(2)}mm layer-shift limit.`
                : 'Support frame deflection exceeds the rocking limit.';
        case 'deficientRegions':
            return printability
                ? `${printability.deficientRegions} region(s) fall short of target density/budget.`
                : 'Some overhang regions fall short of target density.';
        case 'longSpan':
            return printability
                ? `Max unsupported span is ${printability.maxFreeSpanMm.toFixed(1)}mm (>= ${HIGH_LEVERAGE_SPAN_MM.toFixed(1)}mm threshold).`
                : 'Long unsupported span detected.';
        default:
            return frame ? `Peak utilization ${summary.peakUtilizationPct.toFixed(0)}%.` : 'Analysis available.';
    }
}

function severityRank(severity: PrintabilityRegion['severity']): number {
    if (severity === 'critical') return 0;
    if (severity === 'warn') return 1;
    return 2;
}

function compareProblemRegions(a: PrintabilityRegion, b: PrintabilityRegion): number {
    return severityRank(a.severity) - severityRank(b.severity)
        || b.uncoveredAreaMm2 - a.uncoveredAreaMm2
        || b.deficitMm2 - a.deficitMm2
        || a.baseZ - b.baseZ
        || a.islandId.localeCompare(b.islandId);
}

/**
 * Plain-text diagnostic report matching `forestReportToText` formatting for
 * copy-to-clipboard sharing and detailed inspection from `SupportStressPanel`.
 */
export function supportStressReportToText(input: SupportStressReportInput): string {
    const { modelId, frame, printability, topple, floatingUnsupported, modelMinZMm, hasScan } = input;
    const summary = summarizeSupportStress(input);
    const scanned = hasScan !== false;
    const lines: string[] = [];

    lines.push('PRINTABILITY REPORT');
    lines.push('───────────────────');

    lines.push('SUMMARY');
    lines.push(`  Status: ${statusHeading(summary.level)}${modelId ? ` · model ${modelId}` : ''}`);
    lines.push(`  Finding: ${primaryIssueSentence(summary, input)}`);
    if (floatingUnsupported) {
        const heightStr = typeof modelMinZMm === 'number' ? `${modelMinZMm.toFixed(1)}mm ` : '';
        lines.push(`  Placement: floating ${heightStr}above build plate with no supports`);
    }
    if (!scanned) {
        lines.push('  Coverage: not scanned');
    } else if (printability) {
        const coveredPct = Math.max(0, 100 - printability.uncoveredFraction * 100);
        lines.push(
            `  Coverage: ${coveredPct.toFixed(1)}% covered · `
            + `${printability.uncoveredAreaMm2.toFixed(2)}/${printability.totalFootprintAreaMm2.toFixed(1)}mm² uncovered · `
            + `max span ${printability.maxFreeSpanMm.toFixed(1)}mm · `
            + `${printability.deficientRegions} short region(s)`,
        );
    }
    if (frame) {
        lines.push(
            `  Support load: tip max ${frame.maxTipUtilizationPct.toFixed(0)}% (${frame.overloadedTips} over) · `
            + `frame max ${frame.maxMemberUtilizationPct.toFixed(0)}% (${frame.overloadedMembers} over) · `
            + `max defl ${frame.maxTipDeflectionMm.toFixed(3)}mm`,
        );
    }
    if (topple) {
        lines.push(
            `  Stability: ${topple.outcome} · COM depth ${topple.comDepthMm.toFixed(2)}mm · `
            + `lift threshold ${topple.requiredAdhesionMpa.toFixed(3)}MPa · `
            + `rock ${topple.complianceMm.toFixed(3)}mm`,
        );
    }

    if (printability && (scanned || printability.regions.length > 0)) {
        lines.push('');
        lines.push('COVERAGE & PRINTABILITY');
        lines.push(
            `  Verdict: ${printability.verdict} · uncovered ${printability.uncoveredAreaMm2.toFixed(2)}/`
            + `${printability.totalFootprintAreaMm2.toFixed(1)}mm² (${(printability.uncoveredFraction * 100).toFixed(1)}%)`,
        );
        lines.push(
            `  Regions: ${printability.regions.length} total · `
            + `${printability.uncoveredRegions} uncovered · `
            + `${printability.deficientRegions} short · `
            + `${printability.criticalRegions} critical`,
        );
        lines.push(
            `  Span & shock: max free span ${printability.maxFreeSpanMm.toFixed(1)}mm `
            + `(warn >= ${HIGH_LEVERAGE_SPAN_MM.toFixed(1)}mm) · `
            + `peak area jump ×${printability.peakAreaJumpRatio.toFixed(2)}`,
        );
        lines.push(
            `  Load budget: demand ${printability.loadBudget.totalDemandMm2.toFixed(0)}mm² vs `
            + `capacity ${printability.loadBudget.totalCapacityMm2.toFixed(0)}mm²`,
        );

        const nonOk = printability.regions
            .filter((r) => r.severity !== 'ok')
            .sort(compareProblemRegions);
        if (nonOk.length > 0) {
            const shown = nonOk.slice(0, 12);
            lines.push(`  Problem regions (${shown.length}/${nonOk.length}):`);
            for (const r of shown) {
                lines.push(
                    `    [${r.severity.toUpperCase()}] ${r.islandId} (${r.source} @ Z${r.baseZ.toFixed(1)}mm): `
                    + `cov ${(r.coverage * 100).toFixed(0)}% · `
                    + `uncovered ${r.uncoveredAreaMm2.toFixed(2)}mm² · `
                    + `span ${r.freeSpanMm.toFixed(1)}mm · `
                    + `demand/cap ${r.demandMm2.toFixed(1)}/${r.capacityMm2.toFixed(1)}mm²`,
                );
            }
        }
    }

    if (topple) {
        lines.push('');
        lines.push('STABILITY & TOPPLE RISK');
        lines.push(`  Outcome: ${topple.outcome} · COM depth inside edge ${topple.comDepthMm.toFixed(2)}mm`);
        lines.push(
            `  Peel load (topple profile): ${topple.peakLayerForceN.toFixed(2)}N peak layer · `
            + `moment ${topple.peelMomentNmm.toFixed(1)}N·mm · `
            + `lift threshold ${topple.requiredAdhesionMpa.toFixed(3)}MPa`,
        );
        lines.push(
            `  Rocking offset: ${topple.complianceMm.toFixed(3)}mm `
            + `(limit ${ROCKING_THRESHOLD_MM.toFixed(2)}mm)`,
        );
    }

    if (frame) {
        lines.push('');
        lines.push('SUPPORT FRAME STRESS');
        lines.push(
            `  Solver: ${frame.solverMode} · ${frame.nodeCount} nodes · ${frame.rootCount} roots · `
            + `${frame.tipCount} tips · ${frame.memberCount} members (${frame.braceCount} braces) · `
            + `${frame.layersEvaluated} layer(s)`
            + ((frame.reinforcedCount ?? 0) > 0 ? ` · ${frame.reinforcedCount} reinforced` : ''),
        );
        lines.push(
            `  Critical-layer peel peak (incl. per-component stages): `
            + `${frame.peakLayerPeelForceN.toFixed(2)}N @ Z${frame.peakLayerZMm.toFixed(1)}mm`,
        );
        lines.push(
            `  Utilization: tip max ${frame.maxTipUtilizationPct.toFixed(0)}% (${frame.overloadedTips} over) · `
            + `member max ${frame.maxMemberUtilizationPct.toFixed(0)}% (${frame.overloadedMembers} over) · `
            + `max defl ${frame.maxTipDeflectionMm.toFixed(3)}mm`,
        );
        if (frame.hotspots.length > 0) {
            lines.push(`  Hotspots (${frame.hotspots.length}):`);
            for (const h of frame.hotspots) {
                const detailParts: string[] = [];
                if (h.peakStressMpa !== undefined) detailParts.push(`${h.peakStressMpa.toFixed(2)}MPa`);
                if (h.tipLoadN !== undefined) detailParts.push(`${h.tipLoadN.toFixed(2)}N`);
                if (h.deflectionMm !== undefined) detailParts.push(`defl ${h.deflectionMm.toFixed(3)}mm`);
                lines.push(
                    `    ${h.entityKind} ${h.entityId.slice(0, 8)} (${h.kind}) · ${h.utilizationPct.toFixed(0)}%`
                    + (detailParts.length > 0 ? ` · ${detailParts.join(' · ')}` : '')
                    + ` @ Z${h.layerZMm.toFixed(1)}mm (${h.pos.x.toFixed(1)}, ${h.pos.y.toFixed(1)}, ${h.pos.z.toFixed(1)})`,
                );
            }
        }
    }

    const actions = frame ? planStressActions(frame, { rockingLimitMm: ROCKING_THRESHOLD_MM }) : [];
    if (actions.length > 0) {
        lines.push('');
        lines.push('RECOMMENDED ACTIONS');
        for (const action of actions) {
            if (action.kind === 'brace-rocking') {
                lines.push(
                    `  Brace rocking pair ${action.aEntityId.slice(0, 8)} ↔ ${action.bEntityId.slice(0, 8)} `
                    + `at Z${action.layerZMm.toFixed(1)}mm · differential ${action.differentialMm.toFixed(3)}mm `
                    + `(limit ${ROCKING_THRESHOLD_MM.toFixed(2)}mm)`,
                );
            } else if (action.kind === 'brace-member') {
                lines.push(
                    `  Brace ${action.entityKind} ${action.entityId.slice(0, 8)} near Z${action.layerZMm.toFixed(1)}mm `
                    + `· ${action.utilizationPct.toFixed(0)}%`,
                );
            } else {
                lines.push(
                    `  Thicken ${action.entityKind} ${action.entityId.slice(0, 8)} · ${action.utilizationPct.toFixed(0)}%`,
                );
            }
        }
    }

    const layerRows = frame && frame.layerProfile.length > 0
        ? frame.layerProfile.filter((pt) => pt.critical)
        : (printability?.peelCurve ?? [])
            .slice()
            .sort((a, b) => b.peelForceN - a.peelForceN || a.zMm - b.zMm)
            .slice(0, 8);
    const orderedLayers = layerRows.slice().sort((a, b) => a.zMm - b.zMm);
    if (orderedLayers.length > 0) {
        lines.push('');
        lines.push('PEEL PROFILE (global layers)');
        for (const pt of orderedLayers) {
            const utilStr = frame
                ? ` · tip ${pt.maxTipUtilPct.toFixed(0)}% · member ${pt.maxMemberUtilPct.toFixed(0)}%`
                : '';
            lines.push(
                `  Z${pt.zMm.toFixed(1)}mm · area ${pt.areaMm2.toFixed(1)}mm² · `
                + `peel ${pt.peelForceN.toFixed(2)}N${utilStr}`,
            );
        }
    }

    return lines.join('\n');
}
