export function snapToGridIndex(valueMm: number, spacingMm: number): number {
    if (spacingMm <= 0) return 0;
    const scaled = valueMm / spacingMm;
    if (scaled === 0) return 0;
    return Math.sign(scaled) * Math.round(Math.abs(scaled));
}

export function gridNodeKeyFromXY(xMm: number, yMm: number, spacingMm: number): string {
    const gx = snapToGridIndex(xMm, spacingMm);
    const gy = snapToGridIndex(yMm, spacingMm);
    return `${gx},${gy}`;
}

export function gridSnappedXYFromKey(key: string, spacingMm: number): { x: number; y: number } {
    const [gxRaw, gyRaw] = key.split(',');
    const gx = Number(gxRaw);
    const gy = Number(gyRaw);
    return {
        x: gx * spacingMm,
        y: gy * spacingMm,
    };
}
