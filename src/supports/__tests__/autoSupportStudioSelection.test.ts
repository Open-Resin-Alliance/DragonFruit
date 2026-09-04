import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { footprintFromPoints } from '../../volumeAnalysis/Islands/voxelFootprint';
import { runAutoPlace } from '../autoSupport/autoPlace';
import { resetStore, getSnapshot, setSelectedId } from '../state';
import { resetKickstandStore } from '../SupportTypes/Kickstand/kickstandStore';
import { clearHistory } from '../../history/historyStore';
import { registerSupportHistoryHandlers } from '../history/useSupportHistoryHandlers';
import { setModelMesh } from '../autoSupport/meshStore';
import { resolveEditableSupportTarget, getSupportSettingsForTarget } from '../state';

test('selected auto trunk loads its own sized parameters, not the global band', () => {
    resetStore();
    resetKickstandStore();
    clearHistory();
    const dispose = registerSupportHistoryHandlers();

    const contactVoxels: { x: number; y: number }[] = [];
    for (let x = -10; x <= 10; x += 0.25) {
        for (let y = -10; y <= 10; y += 0.25) contactVoxels.push({ x, y });
    }
    const facet = {
        id: 'o0', source: 'overhang' as const,
        contact: new THREE.Vector3(0, 0, 6.5), baseZ: 6.5,
        areaMm2: 400, contactVoxels: footprintFromPoints(contactVoxels),
    };
    const result = runAutoPlace([facet], 'model-a', { debugSkipAutoBracing: true });
    assert.ok(result.placedTrunks > 0, 'trunks placed');

    // Select the first auto-placed trunk through the production chain.
    const snapshot = getSnapshot();
    const trunkId = Object.keys(snapshot.trunks)[0];
    setSelectedId(trunkId);

    const state = getSnapshot();
    const target = resolveEditableSupportTarget(state.selectedId!, state.selectedCategory!);
    assert.ok(target, 'auto trunk resolves to an editable target');
    assert.equal(target.kind, 'trunk');

    const loaded = getSupportSettingsForTarget(target);
    assert.ok(loaded, 'studio loads settings for the auto trunk');

    // The committed geometry used the auto-support tier band
    // (roots 2.0), NOT the global default (3.0). Before the fix the
    // stale settingsCodeHex made the studio load 3.0 here.
    const trunk = state.trunks[trunkId];
    const root = state.roots[trunk.rootId];
    assert.equal(loaded.roots.diameterMm, root.diameter,
        `studio loads the support's own root diameter (${loaded.roots.diameterMm} vs committed ${root.diameter})`);
    assert.equal(loaded.roots.diameterMm, 2.0, 'the tier band root diameter, not the global 3.0');

    setModelMesh('model-a', null);
    dispose();
});
