import type { SupportState } from '../../../types';
import type { KickstandState } from '../../../SupportTypes/Kickstand/types';

export function buildSupportIdBySegmentId(
    state: SupportState,
    kickstandState: KickstandState,
) {
    const map = new Map<string, string>();

    for (const trunk of Object.values(state.trunks)) {
        for (const segment of trunk.segments) map.set(segment.id, trunk.id);
    }

    for (const branch of Object.values(state.branches)) {
        for (const segment of branch.segments) map.set(segment.id, branch.id);
    }

    for (const twig of Object.values(state.twigs)) {
        for (const segment of twig.segments) map.set(segment.id, twig.id);
    }

    for (const stick of Object.values(state.sticks)) {
        for (const segment of stick.segments) map.set(segment.id, stick.id);
    }

    for (const brace of Object.values(state.braces)) {
        map.set(`braceSegment:${brace.id}`, brace.id);
    }

    for (const kickstand of Object.values(kickstandState.kickstands)) {
        for (const segment of kickstand.segments) map.set(segment.id, kickstand.id);
    }

    return map;
}

export function buildSupportIdByJointId(
    state: SupportState,
    kickstandState: KickstandState,
) {
    const map = new Map<string, string>();

    for (const trunk of Object.values(state.trunks)) {
        for (const segment of trunk.segments) {
            if (segment.topJoint?.id) map.set(segment.topJoint.id, trunk.id);
        }
    }

    for (const branch of Object.values(state.branches)) {
        for (const segment of branch.segments) {
            if (segment.topJoint?.id) map.set(segment.topJoint.id, branch.id);
        }
    }

    for (const twig of Object.values(state.twigs)) {
        for (const segment of twig.segments) {
            if (segment.bottomJoint?.id) map.set(segment.bottomJoint.id, twig.id);
            if (segment.topJoint?.id) map.set(segment.topJoint.id, twig.id);
        }
    }

    for (const stick of Object.values(state.sticks)) {
        for (const segment of stick.segments) {
            if (segment.bottomJoint?.id) map.set(segment.bottomJoint.id, stick.id);
            if (segment.topJoint?.id) map.set(segment.topJoint.id, stick.id);
        }
    }

    for (const kickstand of Object.values(kickstandState.kickstands)) {
        for (const segment of kickstand.segments) {
            if (segment.topJoint?.id) map.set(segment.topJoint.id, kickstand.id);
        }
    }

    return map;
}

export function buildSupportIdByKnotId(
    state: SupportState,
    kickstandState: KickstandState,
) {
    const map = new Map<string, string>();

    for (const branch of Object.values(state.branches)) {
        map.set(branch.parentKnotId, branch.id);
    }

    for (const leaf of Object.values(state.leaves)) {
        map.set(leaf.parentKnotId, leaf.id);
    }

    for (const brace of Object.values(state.braces)) {
        map.set(brace.startKnotId, brace.id);
        map.set(brace.endKnotId, brace.id);
    }

    for (const kickstand of Object.values(kickstandState.kickstands)) {
        map.set(kickstand.hostKnotId, kickstand.id);
    }

    return map;
}

export function buildSupportIdByContactDiskId(state: SupportState) {
    const map = new Map<string, string>();

    for (const trunk of Object.values(state.trunks)) {
        if (trunk.contactCone?.id) map.set(trunk.contactCone.id, trunk.id);
    }

    for (const branch of Object.values(state.branches)) {
        if (branch.contactCone?.id) map.set(branch.contactCone.id, branch.id);
    }

    for (const leaf of Object.values(state.leaves)) {
        if (leaf.contactCone?.id) map.set(leaf.contactCone.id, leaf.id);
    }

    for (const twig of Object.values(state.twigs)) {
        if (twig.contactDiskA?.id) map.set(twig.contactDiskA.id, twig.id);
        if (twig.contactDiskB?.id) map.set(twig.contactDiskB.id, twig.id);
    }

    for (const stick of Object.values(state.sticks)) {
        if (stick.contactConeA?.id) map.set(stick.contactConeA.id, stick.id);
        if (stick.contactConeB?.id) map.set(stick.contactConeB.id, stick.id);
    }

    return map;
}
