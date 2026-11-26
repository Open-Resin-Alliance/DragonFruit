import assert from 'node:assert/strict';
import test from 'node:test';

import { formationOverhangColor, steepFlatOverlayColor } from '../IslandOverhangOverlay';

const FORMATION_ORANGE = '#ffa500';
const STEEP_FLAT_AMBER = '#ffd28a';

test('formation overhangs and steep-flat patches use uniform distinct colors', () => {
    assert.equal(`#${formationOverhangColor().getHexString()}`, FORMATION_ORANGE);
    assert.equal(`#${steepFlatOverlayColor().getHexString()}`, STEEP_FLAT_AMBER);
    assert.notEqual(
        formationOverhangColor().getHexString(),
        steepFlatOverlayColor().getHexString(),
        'formation overhang and steep-flat colors stay distinct',
    );
});
