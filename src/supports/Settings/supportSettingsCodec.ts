import { createDefaultSettings, type SupportSettings } from './types';

const CODEC_VERSION = 1;

type ConeAngleMode = NonNullable<SupportSettings['tip']['coneAngleMode']>;

const CONE_MODE_TO_BITS: Record<ConeAngleMode, number> = {
    normal: 0,
    locked: 1,
    adaptive: 2,
};

const BITS_TO_CONE_MODE: ConeAngleMode[] = ['normal', 'locked', 'adaptive', 'normal'];

function clampU16(value: number) {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(0xffff, Math.round(value)));
}

function encodeScaled(value: number, scale: number) {
    return clampU16(value * scale);
}

function decodeScaled(value: number, scale: number) {
    return value / scale;
}

function pushU16(bytes: number[], value: number) {
    bytes.push((value >> 8) & 0xff, value & 0xff);
}

function readU16(bytes: Uint8Array, offset: number) {
    if (offset + 1 >= bytes.length) return 0;
    return (bytes[offset] << 8) | bytes[offset + 1];
}

function toHex(bytes: number[]) {
    return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array | null {
    if (!hex || hex.length % 2 !== 0) return null;
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i += 1) {
        const chunk = hex.slice(i * 2, i * 2 + 2);
        const parsed = Number.parseInt(chunk, 16);
        if (!Number.isFinite(parsed)) return null;
        bytes[i] = parsed;
    }
    return bytes;
}

function mergeWithDefaults(base?: SupportSettings): SupportSettings {
    const defaults = createDefaultSettings();
    if (!base) return defaults;

    return {
        ...defaults,
        ...base,
        tip: { ...defaults.tip, ...base.tip },
        shaft: { ...defaults.shaft, ...base.shaft },
        roots: { ...defaults.roots, ...base.roots },
        baseFlare: { ...defaults.baseFlare, ...base.baseFlare },
        joint: { ...defaults.joint, ...base.joint },
        grid: { ...defaults.grid, ...base.grid },
        meshToMesh: { ...defaults.meshToMesh, ...base.meshToMesh },
        autoBracing: { ...defaults.autoBracing, ...base.autoBracing },
    };
}

export function encodeSupportSettingsHex(settings: SupportSettings): string {
    const normalized = mergeWithDefaults(settings);
    const coneModeBits = CONE_MODE_TO_BITS[normalized.tip.coneAngleMode ?? 'normal'];

    const flags =
        (coneModeBits & 0b11)
        | ((normalized.shaft.isStraight ? 1 : 0) << 2)
        | ((normalized.baseFlare.enabled ? 1 : 0) << 3);

    const values: number[] = [
        encodeScaled(normalized.tip.contactDiameterMm, 1000),
        encodeScaled(normalized.tip.bodyDiameterMm, 1000),
        encodeScaled(normalized.tip.lengthMm, 1000),
        encodeScaled(normalized.tip.penetrationMm, 1000),
        encodeScaled(normalized.tip.adaptiveConeAngleOffsetDeg ?? 0, 100),
        encodeScaled(normalized.tip.coneAngleDeg ?? 0, 100),
        encodeScaled(normalized.tip.breakpointMm ?? 0, 1000),
        encodeScaled(normalized.tip.diskThicknessMm ?? 0.1, 1000),
        encodeScaled(normalized.tip.maxStandoffMm ?? 1.5, 1000),
        encodeScaled(normalized.tip.standoffAngleThreshold ?? (Math.PI / 4), 10000),
        encodeScaled(normalized.shaft.diameterMm, 1000),
        encodeScaled(normalized.shaft.secondaryDiameterMm ?? normalized.shaft.diameterMm, 1000),
        encodeScaled(normalized.shaft.maxAngleDeg ?? 80, 100),
        encodeScaled(normalized.roots.diameterMm, 1000),
        encodeScaled(normalized.roots.diskHeightMm, 1000),
        encodeScaled(normalized.roots.coneHeightMm, 1000),
        encodeScaled(normalized.roots.neckDiameterMm, 1000),
        encodeScaled(normalized.roots.neckBlend, 10000),
        encodeScaled(normalized.baseFlare.diameterMm, 1000),
        encodeScaled(normalized.baseFlare.heightMm, 1000),
    ];

    const bytes: number[] = [CODEC_VERSION, flags];
    values.forEach((value) => pushU16(bytes, value));
    return toHex(bytes);
}

export function decodeSupportSettingsHex(hex: string, base?: SupportSettings): SupportSettings | null {
    const bytes = fromHex(hex);
    if (!bytes || bytes.length < 42) return null;
    if (bytes[0] !== CODEC_VERSION) return null;

    const mergedBase = mergeWithDefaults(base);
    const flags = bytes[1];

    const coneModeBits = flags & 0b11;
    const isStraight = ((flags >> 2) & 0b1) === 1;
    const flareEnabled = ((flags >> 3) & 0b1) === 1;

    let offset = 2;
    const read = () => {
        const value = readU16(bytes, offset);
        offset += 2;
        return value;
    };

    const decoded: SupportSettings = {
        ...mergedBase,
        tip: {
            ...mergedBase.tip,
            shape: 'cone',
            contactDiameterMm: decodeScaled(read(), 1000),
            bodyDiameterMm: decodeScaled(read(), 1000),
            lengthMm: decodeScaled(read(), 1000),
            penetrationMm: decodeScaled(read(), 1000),
            coneAngleMode: BITS_TO_CONE_MODE[coneModeBits] ?? 'normal',
            adaptiveConeAngleOffsetDeg: decodeScaled(read(), 100),
            coneAngleDeg: decodeScaled(read(), 100),
            breakpointMm: decodeScaled(read(), 1000),
            diskThicknessMm: decodeScaled(read(), 1000),
            maxStandoffMm: decodeScaled(read(), 1000),
            standoffAngleThreshold: decodeScaled(read(), 10000),
        },
        shaft: {
            ...mergedBase.shaft,
            diameterMm: decodeScaled(read(), 1000),
            secondaryDiameterMm: decodeScaled(read(), 1000),
            isStraight,
            maxAngleDeg: decodeScaled(read(), 100),
        },
        roots: {
            ...mergedBase.roots,
            diameterMm: decodeScaled(read(), 1000),
            diskHeightMm: decodeScaled(read(), 1000),
            coneHeightMm: decodeScaled(read(), 1000),
            neckDiameterMm: decodeScaled(read(), 1000),
            neckBlend: decodeScaled(read(), 10000),
        },
        baseFlare: {
            ...mergedBase.baseFlare,
            enabled: flareEnabled,
            diameterMm: decodeScaled(read(), 1000),
            heightMm: decodeScaled(read(), 1000),
        },
    };

    return decoded;
}

export function areSupportGeometrySettingsEqual(a: SupportSettings, b: SupportSettings): boolean {
    return (
        a.tip.contactDiameterMm === b.tip.contactDiameterMm
        && a.tip.bodyDiameterMm === b.tip.bodyDiameterMm
        && a.tip.lengthMm === b.tip.lengthMm
        && a.tip.penetrationMm === b.tip.penetrationMm
        && (a.tip.coneAngleMode ?? 'normal') === (b.tip.coneAngleMode ?? 'normal')
        && (a.tip.adaptiveConeAngleOffsetDeg ?? 0) === (b.tip.adaptiveConeAngleOffsetDeg ?? 0)
        && (a.tip.coneAngleDeg ?? 0) === (b.tip.coneAngleDeg ?? 0)
        && (a.tip.breakpointMm ?? 0) === (b.tip.breakpointMm ?? 0)
        && (a.tip.diskThicknessMm ?? 0.1) === (b.tip.diskThicknessMm ?? 0.1)
        && (a.tip.maxStandoffMm ?? 1.5) === (b.tip.maxStandoffMm ?? 1.5)
        && (a.tip.standoffAngleThreshold ?? (Math.PI / 4)) === (b.tip.standoffAngleThreshold ?? (Math.PI / 4))
        && a.shaft.diameterMm === b.shaft.diameterMm
        && (a.shaft.secondaryDiameterMm ?? a.shaft.diameterMm) === (b.shaft.secondaryDiameterMm ?? b.shaft.diameterMm)
        && a.shaft.isStraight === b.shaft.isStraight
        && (a.shaft.maxAngleDeg ?? 80) === (b.shaft.maxAngleDeg ?? 80)
        && a.roots.diameterMm === b.roots.diameterMm
        && a.roots.diskHeightMm === b.roots.diskHeightMm
        && a.roots.coneHeightMm === b.roots.coneHeightMm
        && a.roots.neckDiameterMm === b.roots.neckDiameterMm
        && a.roots.neckBlend === b.roots.neckBlend
        && a.baseFlare.enabled === b.baseFlare.enabled
        && a.baseFlare.diameterMm === b.baseFlare.diameterMm
        && a.baseFlare.heightMm === b.baseFlare.heightMm
    );
}
