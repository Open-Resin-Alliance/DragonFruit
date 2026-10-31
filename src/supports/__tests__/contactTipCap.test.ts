import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { initializeBVH, accelerateGeometry } from '../../utils/bvh';
import { footprintFromPoints } from '@/volumeAnalysis/Islands/voxelFootprint';
import { generateGridCandidates } from '../autoSupport/gridPlacement';
import { applyContactTipCap, localFreeWidthMm } from '../autoSupport/contactTipCap';
import { sizeParameters, smallIslandTipDiameterMm, activeSizingBand } from '../autoSupport/parameterSizing';
import { SDFCache } from '../PlacementLogic/Pathfinding/SDFCache';
import { createDefaultAutoSupportSettings, AUTO_SUPPORT_CONSTRAINTS, SIZING_BANDS } from '../autoSupport/settings';
import { setSettings, getSettings, updateAutoSupportSettings } from '../Settings/state';
import { createPreset, deletePreset } from '../Settings/presets';
import { createDefaultSettings } from '../Settings/types';
import type { SizingBand } from '../autoSupport/settings';
import type { CandidatePoint } from '../autoSupport/types';
import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';

// ---------------------------------------------------------------------------
// Fixtures
//
// A rib undersides at z = 18 and its contact footprint is a strip of voxels at
// that height, mirroring the bench corpus' `narrow-rib` entry. The rib's own
// WIDTH is the free width at a contact on it: a tip whose rendered disc is
// wider than the rib cannot sit on the rib — it spills over whatever is beside
// it, which on a scalloped roof is the neighbouring tooth.
// ---------------------------------------------------------------------------

/** A rib `widthMm` across, `lengthMm` long, 1.2 mm tall, underside at z = 18. */
function ribMesh(widthMm: number, lengthMm = 24): THREE.Mesh {
    initializeBVH();
    const geometry = new THREE.BoxGeometry(lengthMm, widthMm, 1.2).translate(0, 0, 18.6).toNonIndexed();
    geometry.computeVertexNormals();
    accelerateGeometry(geometry);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.updateMatrixWorld(true);
    return mesh;
}

/** Overhang island covering the rib's underside at `voxelMm` spacing. */
function ribIsland(lengthMm: number, widthMm: number, voxelMm = 0.1): DetectedIsland {
    const points: { x: number; y: number; z: number }[] = [];
    for (let x = -lengthMm / 2; x <= lengthMm / 2 + 1e-9; x += voxelMm) {
        for (let y = -widthMm / 2; y <= widthMm / 2 + 1e-9; y += voxelMm) {
            points.push({ x, y, z: 18 });
        }
    }
    return {
        id: 'o-rib',
        source: 'overhang',
        contact: new THREE.Vector3(-lengthMm / 2 + 2, 0, 18),
        baseZ: 18,
        areaMm2: lengthMm * widthMm,
        overhangAngleDeg: 0,
        surfaceNormal: { x: 0, y: 0, z: -1 },
        contactVoxels: footprintFromPoints(points),
    };
}

function makeCandidate(over: Partial<CandidatePoint> = {}): CandidatePoint {
    return {
        id: 'c',
        tipPos: { x: 0, y: 0, z: 18 },
        tipNormal: { x: 0, y: 0, z: -1 },
        modelId: 'm',
        source: 'overhang',
        islandAreaMm2: 10,
        zHeight: 18,
        priority: 0,
        ...over,
    };
}

function sdfFor(mesh: THREE.Mesh): SDFCache {
    const sdf = new SDFCache(mesh, { cellSize: 0.5 });
    sdf.refreshMatrix();
    return sdf;
}

/**
 * Pin the run's sizing tier for one case. The band is borrowed from a Support
 * Studio preset now, so a factory band is that preset's id.
 */
function withTier<T>(id: string, fn: () => T): T {
    const prev = getSettings().autoSupport;
    updateAutoSupportSettings({ sizingPreset: id });
    try {
        return fn();
    } finally {
        updateAutoSupportSettings({ ...prev });
    }
}

/**
 * Pin a band no factory preset ships: a Support Studio preset IS its tip, shaft
 * and roots, so the profile fields are written to the band's numbers, a preset is
 * created from them, and the block names its id. Everything is restored after.
 */
function withBand<T>(band: SizingBand, fn: () => T): T {
    const prevAutoSupport = getSettings().autoSupport;
    const prevSettings = getSettings();
    setSettings({
        ...prevSettings,
        tip: {
            ...prevSettings.tip,
            contactDiameterMm: band.tipContactDiameterMm,
            lengthMm: band.tipLengthMm,
            penetrationMm: band.tipPenetrationMm,
        },
        shaft: { ...prevSettings.shaft, diameterMm: band.shaftDiameterMm },
        roots: {
            ...prevSettings.roots,
            diameterMm: band.rootDiameterMm,
            diskHeightMm: band.rootDiskHeightMm,
            coneHeightMm: band.rootConeHeightMm,
        },
    });
    const created = createPreset('test band');
    updateAutoSupportSettings({ sizingPreset: created.id });
    try {
        return fn();
    } finally {
        deletePreset(created.id);
        setSettings(prevSettings);
        updateAutoSupportSettings({ ...prevAutoSupport });
    }
}

setSettings(createDefaultSettings());

// ---------------------------------------------------------------------------

test('localFreeWidthMm reads the feature width across a contact', () => {
    // On the 0.4 mm rib's own centreline the surface ends 0.2 mm away on both
    // sides: the largest disc that fits is 0.4 mm across.
    const narrowWidth = localFreeWidthMm(sdfFor(ribMesh(0.4)), 0, 0, 18, { x: 0, y: 0, z: -1 });
    assert.ok(Math.abs(narrowWidth - 0.4) < 0.05, `0.4 mm rib reads ~0.4, got ${narrowWidth}`);

    // The 8 mm rib is wider than the probe reach, so it reads full width and
    // the cap can never bind on it.
    const wideWidth = localFreeWidthMm(sdfFor(ribMesh(8)), 0, 0, 18, { x: 0, y: 0, z: -1 });
    assert.ok(wideWidth >= 0.9, `8 mm rib reads full width, got ${wideWidth}`);
});

test('a tip is capped to fit the narrow rib it lands on', () => {
    const mesh = ribMesh(0.26);
    const candidate = makeCandidate();
    applyContactTipCap(candidate, sdfFor(mesh));
    assert.equal(candidate.tipDiameterMm, 0.234, '0.9 x the 0.26 mm rib, above the 0.22 floor');

    // The cap is what the builders read: the contact that renders comes out of
    // sizeParameters, so assert the effective tip, not just the field.
    const size = sizeParameters(candidate);
    assert.equal(size.tipContactDiameterMm, 0.234);
    const uncapped = sizeParameters({ ...candidate, tipDiameterMm: undefined });
    assert.ok(uncapped.tipContactDiameterMm! > size.tipContactDiameterMm!,
        `the band contact was wider than the capped one (${uncapped.tipContactDiameterMm})`);
});

test('every lattice contact on a narrow rib comes out capped', () => {
    // Thinner than one lattice cell, so the ring carries the region — the same
    // shape the reported scalloped roof has.
    const settings = createDefaultAutoSupportSettings();
    const candidates = generateGridCandidates([ribIsland(24, 0.3)], settings, ribMesh(0.3), 'narrow-rib');
    assert.ok(candidates.length > 0, 'the narrow rib still gets contacts');

    const bandTip = activeSizingBand().tipContactDiameterMm;
    for (const candidate of candidates) {
        assert.ok(candidate.tipDiameterMm !== undefined, `${candidate.id} carries a capped tip`);
        assert.ok(candidate.tipDiameterMm! <= 0.27 + 1e-9, `${candidate.id}: must fit 0.9 x 0.3 mm`);
        assert.ok(candidate.tipDiameterMm! >= smallIslandTipDiameterMm(), `${candidate.id} floors at the detail band`);
        assert.ok(candidate.tipDiameterMm! < bandTip, `${candidate.id} is below the full band contact`);
    }
});

test('a contact with room above the band tip is untouched', () => {
    // 8 mm of rib: every contact sits further from the rib's edges than the
    // cap's reach, so nothing binds and the candidate keeps band sizing —
    // byte for byte, including the shaft floor the band tip sits under.
    const settings = createDefaultAutoSupportSettings();
    const candidates = generateGridCandidates([ribIsland(24, 8, 0.25)], settings, ribMesh(8), 'wide-rib');
    assert.ok(candidates.length > 0);

    for (const candidate of candidates) {
        assert.equal(candidate.tipDiameterMm, undefined,
            `${candidate.id} must keep band sizing — the cap never grows or re-floors a tip`);
        assert.equal(
            sizeParameters(candidate).tipContactDiameterMm,
            sizeParameters({ ...candidate, tipDiameterMm: undefined }).tipContactDiameterMm,
            'effective tip is the uncapped band sizing, byte for byte',
        );
    }
});

test('the cap never grows an already-small tip', () => {
    const candidate = makeCandidate({ tipDiameterMm: smallIslandTipDiameterMm() - 0.02 });
    applyContactTipCap(candidate, sdfFor(ribMesh(0.4)));
    assert.equal(candidate.tipDiameterMm, smallIslandTipDiameterMm() - 0.02,
        'a tip already below the floor is left alone');
});

test('a 0.3 mm tooth caps the anchor band to fit', () => {
    withTier('anchor', () => {
        const candidate = makeCandidate();
        applyContactTipCap(candidate, sdfFor(ribMesh(0.3)));
        assert.equal(candidate.tipDiameterMm, 0.27, '0.9 x 0.3 mm, above the 0.22 floor');
        assert.equal(sizeParameters(candidate).tipContactDiameterMm, 0.27,
            'the anchor band contact renders at the capped width');
    });
});

test('tipContactMarginScale sets the fraction of free width the contact keeps', () => {
    // An explicit 1.0 mm ceiling on a 0.6 mm-wide rib: the cap is the only
    // binder, so the rendered contact is exactly `freeWidth × marginScale`.
    const mesh = ribMesh(0.6);
    const prev = getSettings().autoSupport;
    try {
        updateAutoSupportSettings({ tipContactMarginScale: AUTO_SUPPORT_CONSTRAINTS.tipContactMarginScale.defaultValue });
        const defaulted = makeCandidate({ tipDiameterMm: 1.0 });
        applyContactTipCap(defaulted, sdfFor(mesh));
        assert.ok(Math.abs(defaulted.tipDiameterMm! - 0.54) < 0.03,
            `0.9 x 0.6 mm rib → ~0.54, got ${defaulted.tipDiameterMm}`);

        updateAutoSupportSettings({ tipContactMarginScale: 0.5 });
        const tighter = makeCandidate({ tipDiameterMm: 1.0 });
        applyContactTipCap(tighter, sdfFor(mesh));
        assert.ok(Math.abs(tighter.tipDiameterMm! - 0.3) < 0.03,
            `0.5 x 0.6 mm rib → ~0.30, got ${tighter.tipDiameterMm}`);
        assert.ok(tighter.tipDiameterMm! < defaulted.tipDiameterMm!,
            'a lower margin scale thins the capped contact');
    } finally {
        updateAutoSupportSettings({ ...prev });
    }
});

test('auto-support never produces a contact tip below 0.22 mm', () => {
    const tinyBand: SizingBand = { ...SIZING_BANDS.detail, tipContactDiameterMm: 0.1 };
    withBand(tinyBand, () => {
        assert.equal(activeSizingBand().tipContactDiameterMm, 0.22,
            'a preset tip below the floor is raised to it');
        assert.equal(smallIslandTipDiameterMm(), 0.22, 'and so is the small-island tip');

        const bandSized = sizeParameters(makeCandidate());
        assert.ok(bandSized.tipContactDiameterMm! >= 0.22,
            `band-sized contact floors at 0.22 (got ${bandSized.tipContactDiameterMm})`);

        const explicit = sizeParameters(makeCandidate({ tipDiameterMm: 0.1 }));
        assert.ok(explicit.tipContactDiameterMm! >= 0.22,
            `an explicit per-point tip cannot go below 0.22 (got ${explicit.tipContactDiameterMm})`);
    });
});
