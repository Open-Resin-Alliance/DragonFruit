export function buildNearestCandidateNodeKeys(preferredKey: string, maxRings: number): string[] {
    const [gxRaw, gyRaw] = preferredKey.split(',');
    const centerX = Number(gxRaw);
    const centerY = Number(gyRaw);
    const keys: string[] = [];

    for (let ring = 0; ring <= maxRings; ring++) {
        for (let dx = -ring; dx <= ring; dx++) {
            for (let dy = -ring; dy <= ring; dy++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
                keys.push(`${centerX + dx},${centerY + dy}`);
            }
        }
    }

    return keys;
}
