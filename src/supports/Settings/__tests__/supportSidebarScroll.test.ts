import assert from 'node:assert/strict';
import test from 'node:test';

import { resetSupportSettingsScrollForTabChange } from '../supportSidebarScroll';

test('resets settings scroll when the user selects a different support tab', () => {
    const calls: ScrollToOptions[] = [];
    const viewport = {
        scrollTo(options?: ScrollToOptions) {
            calls.push(options ?? {});
        },
    };

    assert.equal(resetSupportSettingsScrollForTabChange(viewport, 'trunk', 'raft'), true);
    assert.deepEqual(calls, [{ top: 0 }]);
});

test('preserves settings scroll when the user selects the already-active tab', () => {
    let callCount = 0;
    const viewport = {
        scrollTo() {
            callCount += 1;
        },
    };

    assert.equal(resetSupportSettingsScrollForTabChange(viewport, 'grid', 'grid'), false);
    assert.equal(callCount, 0);
});

test('safely ignores a tab change before the settings viewport is mounted', () => {
    assert.equal(resetSupportSettingsScrollForTabChange(null, 'stick', 'trunk'), false);
});
