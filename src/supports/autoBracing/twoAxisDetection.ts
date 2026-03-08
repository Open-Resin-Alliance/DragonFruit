export function normalizeAxisAngleRad(angleRad: number): number {
    let normalized = angleRad % Math.PI;
    if (normalized < 0) normalized += Math.PI;
    return normalized;
}

export function axisSeparationDeg(aRad: number, bRad: number): number {
    const diff = Math.abs(aRad - bRad);
    return (Math.min(diff, Math.PI - diff) * 180) / Math.PI;
}

export function hasQualifiedTwoAxisBracing(axes: number[], minAxisSeparationDeg: number): boolean {
    for (let i = 0; i < axes.length; i += 1) {
        for (let j = i + 1; j < axes.length; j += 1) {
            if (axisSeparationDeg(axes[i], axes[j]) >= minAxisSeparationDeg) {
                return true;
            }
        }
    }
    return false;
}

export function additionalAxesNeededForTwoAxisBracing(axes: number[], minAxisSeparationDeg: number): 0 | 1 | 2 {
    if (hasQualifiedTwoAxisBracing(axes, minAxisSeparationDeg)) return 0;
    return axes.length === 0 ? 2 : 1;
}
