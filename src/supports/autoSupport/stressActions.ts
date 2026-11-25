/**
 * Turns a solved support-frame report into ordered corrective actions.
 *
 * The report already says *what* failed (a rocking pair, an overloaded member,
 * an over-capacity tip). This module says what to do about it, using only data
 * the solver measured, so a closed auto-support loop has a deterministic order:
 *
 * 1. `brace-rocking` — tie the two extreme tips of the part's fitted rigid-body
 *    rotation along the drag axis at the worst layer. The fitted motion is
 *    elastic support/resin compliance (it recovers); the action is emitted only
 *    when a tip or member is also over, unless `rockingRequiresOverload: false`.
 * 2. `brace-member` — an overloaded leaf or branch is a slender cone/shaft at
 *    its thickness cap; a mid-span brace shortens its effective span. Promotion
 *    to a branch with a real shaft is the next step if no host is in reach.
 * 3. `thicken-member` — an overloaded trunk/stump/kickstand/brace already has a
 *    shaft that can grow under the existing clearance-capped reinforcement.
 *
 * Tips are deliberately not planned here: per-contact capacity is owned by
 * `computeForceBudget`, whose add point comes from the cell's furthest point,
 * not from the tip's own position. A tip-action here would duplicate that pass.
 */

import type { SupportTypeId } from '../supportTypeRegistry';
import type { Vec3 } from '../types';
import type { FrameStressHotspot, SupportFrameStressReport } from './supportGraphStress';

export type StressAction =
    | {
        kind: 'brace-rocking';
        severity: number;
        layerZMm: number;
        aEntityId: string;
        bEntityId: string;
        aPos: Vec3;
        bPos: Vec3;
        differentialMm: number;
    }
    | {
        kind: 'brace-member';
        severity: number;
        entityId: string;
        entityKind: SupportTypeId;
        layerZMm: number;
        pos: Vec3;
        utilizationPct: number;
    }
    | {
        kind: 'thicken-member';
        severity: number;
        entityId: string;
        entityKind: SupportTypeId;
        layerZMm: number;
        pos: Vec3;
        utilizationPct: number;
    };

export interface StressActionOptions {
    /** Rocking limit the stability check uses (mm). */
    rockingLimitMm?: number;
    /** Members over this utilization need an action. 100 = only overloaded. */
    memberTargetPct?: number;
    /** A trunk over this utilization is braced (shorter span) instead of being
     *  thickened again: past this point the diameter is usually at a cap or
     *  clearance limit, and a thicker shaft cannot fit. */
    trunkBracePct?: number;
    /** Brace a rocking pair even when no tip or member is over. Default `true`
     *  (suppressed): the fitted rotation is elastic support/resin compliance;
     *  a print flexes during peel and recovers. A brace is for a real overload
     *  (tip/member), not for that compliance. The report still states it. */
    rockingRequiresOverload?: boolean;
    /** Cap on returned actions, highest severity first. */
    maxActions?: number;
}

/** Same value the topple/stability check reports against. */
export const DEFAULT_ROCKING_LIMIT_MM = 0.15;
/** The report's own overload boundary; a margin can be passed by the caller. */
export const DEFAULT_MEMBER_TARGET_PCT = 100;
/** Above this a trunk needs a shorter span, not another diameter step. */
export const DEFAULT_TRUNK_BRACE_PCT = 200;

/** Entity kinds with a shaft that may thicken; leaves and branches are cones
 *  capped by `reinforceOverloadedFrameMembers`. */
function canThicken(kind: SupportTypeId): boolean {
    return kind === 'trunk' || kind === 'stump' || kind === 'kickstand' || kind === 'brace';
}

function actionForMember(hotspot: FrameStressHotspot, trunkBracePct: number): StressAction | null {
    if (hotspot.kind !== 'member' || !hotspot.entityId || !hotspot.entityKind) return null;
    const shaftBrace = hotspot.entityKind === 'trunk' && hotspot.utilizationPct > trunkBracePct;
    if (canThicken(hotspot.entityKind) && !shaftBrace) {
        return {
            kind: 'thicken-member',
            severity: hotspot.utilizationPct,
            entityId: hotspot.entityId,
            entityKind: hotspot.entityKind,
            layerZMm: hotspot.layerZMm,
            pos: hotspot.pos,
            utilizationPct: hotspot.utilizationPct,
        };
    }
    return {
        kind: 'brace-member',
        severity: hotspot.utilizationPct,
        entityId: hotspot.entityId,
        entityKind: hotspot.entityKind,
        layerZMm: hotspot.layerZMm,
        pos: hotspot.pos,
        utilizationPct: hotspot.utilizationPct,
    };
}

/**
 * Deterministic corrective plan from a solved report. Empty means the frame is
 * inside the requested limits.
 */
export function planStressActions(
    report: SupportFrameStressReport,
    options: StressActionOptions = {},
): StressAction[] {
    const rockingLimitMm = Math.max(1e-6, options.rockingLimitMm ?? DEFAULT_ROCKING_LIMIT_MM);
    const memberTargetPct = Math.max(1, options.memberTargetPct ?? DEFAULT_MEMBER_TARGET_PCT);
    const trunkBracePct = Math.max(memberTargetPct, options.trunkBracePct ?? DEFAULT_TRUNK_BRACE_PCT);
    const rockingRequiresOverload = options.rockingRequiresOverload ?? true;
    const maxActions = Math.max(1, options.maxActions ?? 12);
    const actions: StressAction[] = [];
    const hasOverload = report.overloadedTips > 0
        || report.overloadedMembers > 0
        || report.hotspots.some((h) => (h.kind === 'tip' ? h.utilizationPct > 100 : h.utilizationPct > memberTargetPct));

    if (report.rockingPair && report.maxTipRockingMm > rockingLimitMm
        && (!rockingRequiresOverload || hasOverload)) {
        actions.push({
            kind: 'brace-rocking',
            severity: report.maxTipRockingMm / rockingLimitMm,
            layerZMm: report.rockingPair.layerZMm,
            aEntityId: report.rockingPair.aEntityId,
            bEntityId: report.rockingPair.bEntityId,
            aPos: report.rockingPair.aPos,
            bPos: report.rockingPair.bPos,
            differentialMm: report.maxTipRockingMm,
        });
    }

    for (const hotspot of report.hotspots) {
        if (hotspot.utilizationPct <= memberTargetPct) continue;
        const action = actionForMember(hotspot, trunkBracePct);
        if (action) actions.push(action);
    }

    actions.sort((a, b) => (
        Number(b.kind === 'brace-rocking') - Number(a.kind === 'brace-rocking')
        || b.severity - a.severity
        || ('entityId' in a && 'entityId' in b ? a.entityId.localeCompare(b.entityId) : 0)
    ));
    return actions.slice(0, maxActions);
}
