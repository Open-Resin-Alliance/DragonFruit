import assert from 'node:assert/strict';
import test from 'node:test';
import { Profiler } from 'react';
import { createRoot } from 'react-dom/client';
import Home from '@/app/page';
import { withProviders } from '@/utils/__tests__/helpers/renderDom';

const reactGlobals = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The page only settles because the React Compiler keeps some effect
// dependencies stable. Mounted uncompiled, its commits keep climbing (15 at
// 300 ms, ~300 at 1 s) and React logs "Maximum update depth exceeded";
// compiled, it stops after a handful. So: no commits at all in the second half
// of the window.
//
// The window is two seconds, not one, because the scene schedules an idle chunk-store sweep as it
// mounts and an idle callback can land past 500 ms on a loaded runner: this test imports nothing and
// fails on 4 -> 5 there. An idle task that lands inside the window is the page settling. What the
// window is for is a loop, and a loop commits ~300 times a second, so the extra second costs the
// check nothing.
test('the page mounts on an empty scene and settles', async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
        errors.push(String(args[0]));
    };
    // Not `act`: it drains a render loop synchronously, so the timers below
    // would never fire and the test would run until the heap gave out. Left to
    // the scheduler, a loop shows up as a commit count.
    const actEnvironment = reactGlobals.IS_REACT_ACT_ENVIRONMENT;
    reactGlobals.IS_REACT_ACT_ENVIRONMENT = false;

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    let commits = 0;
    try {
        root.render(withProviders(
            <Profiler id="page" onRender={() => { commits += 1; }}>
                <Home />
            </Profiler>,
        ));
        await wait(1000);
        const commitsAtHalfTime = commits;
        await wait(1000);

        assert.equal(commits, commitsAtHalfTime, `still committing after half the window (${commitsAtHalfTime} → ${commits})`);
        assert.deepEqual(errors.filter((message) => message.startsWith('Maximum update depth exceeded')), []);
        // i18n-ignore-start: selectors against the English UI
        assert.ok(container.querySelector('button[aria-label="Open DragonFruit menu"]'), 'the top bar menu renders');
        assert.ok(container.querySelector('button[aria-label="Settings"]'), 'the settings button renders');
        // i18n-ignore-end
    } finally {
        root.unmount();
        container.remove();
        reactGlobals.IS_REACT_ACT_ENVIRONMENT = actEnvironment;
        console.error = originalError;
    }
});
