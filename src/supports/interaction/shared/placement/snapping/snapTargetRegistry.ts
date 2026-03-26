import type { SnapTargetRegistration } from './snappingTypes';

const targets = new Map<string, SnapTargetRegistration>();

export function registerSnapTarget(target: SnapTargetRegistration) {
    targets.set(target.id, target);
}

export function unregisterSnapTarget(targetId: string) {
    targets.delete(targetId);
}

export function getRegisteredSnapTarget(targetId: string) {
    return targets.get(targetId) ?? null;
}

export function getAllRegisteredSnapTargets() {
    return Array.from(targets.values());
}

export function clearRegisteredSnapTargets() {
    targets.clear();
}
