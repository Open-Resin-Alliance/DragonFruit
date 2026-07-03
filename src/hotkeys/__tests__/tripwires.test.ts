import assert from 'node:assert/strict';
import test from 'node:test';
import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../HotkeyRegistryManager';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

test('Runtime monkey-patch allows registration from allowed paths', () => {
    let errorCalled = false;
    const originalConsoleError = console.error;
    console.error = () => {
        errorCalled = true;
    };

    try {
        const mockWindow = new EventTarget();
        const originalWindow = (global as any).window;
        (global as any).window = mockWindow;

        // Current test file (__tests__/tripwires.test.ts) is allowed
        mockWindow.addEventListener('keydown', () => {});

        assert.equal(errorCalled, false, 'Should not log error for allowed paths');

        (global as any).window = originalWindow;
    } finally {
        console.error = originalConsoleError;
    }
});

test('Runtime monkey-patch logs error for forbidden paths', () => {
    let loggedArgs: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: any[]) => {
        loggedArgs.push(args.join(' '));
    };

    const originalPrepareStackTrace = Error.prepareStackTrace;

    try {
        const mockWindow = new EventTarget();
        const originalWindow = (global as any).window;
        (global as any).window = mockWindow;

        // Mock Error.prepareStackTrace to return a stack trace originating from a forbidden path
        Error.prepareStackTrace = (err, structuredStack) => {
            return 'Error\n    at addEventListener (x:/Antigravity/DragonFruit-ORA/DragonFruit/src/hotkeys/HotkeyRegistryManager.tsx:15:10)\n    at forbiddenCall (x:/Antigravity/DragonFruit-ORA/DragonFruit/src/components/Forbidden.tsx:25:30)';
        };

        mockWindow.addEventListener('keydown', () => {});

        assert.equal(loggedArgs.length, 1, 'Should log one error');
        assert.ok(loggedArgs[0].includes('Forbidden keydown/keyup event listener registered on window'), 'Should mention window');
        assert.ok(loggedArgs[0].includes('/DragonFruit/docs/hotkeys/README.md'), 'Should link to README');

        (global as any).window = originalWindow;
    } finally {
        console.error = originalConsoleError;
        Error.prepareStackTrace = originalPrepareStackTrace;
    }
});

test('Static ESLint rule flags violations in forbidden paths and passes allowed paths', () => {
    const workspaceRoot = join(__dirname, '../../..');
    const forbiddenFile = join(workspaceRoot, 'src/hotkeys/temp_mock_forbidden.ts');
    const allowedFile = join(workspaceRoot, 'src/hotkeys/temp_mock_allowed.test.ts');

    // 1. Test forbidden file (CallExpression)
    writeFileSync(forbiddenFile, "window.addEventListener('keydown', () => {});\n");
    try {
        execSync(`npx eslint "${forbiddenFile}"`, { stdio: 'pipe' });
        assert.fail('ESLint should have failed for forbidden file CallExpression');
    } catch (err: any) {
        const output = err.stdout?.toString() || err.stderr?.toString() || '';
        assert.ok(
            output.includes('hotkey-restriction/no-direct-window-document-hotkeys'),
            `Should report forbidden hotkey rule error. Output: ${output}`
        );
    } finally {
        try { unlinkSync(forbiddenFile); } catch {}
    }

    // 2. Test forbidden file (AssignmentExpression)
    writeFileSync(forbiddenFile, "document.onkeyup = () => {};\n");
    try {
        execSync(`npx eslint "${forbiddenFile}"`, { stdio: 'pipe' });
        assert.fail('ESLint should have failed for forbidden file AssignmentExpression');
    } catch (err: any) {
        const output = err.stdout?.toString() || err.stderr?.toString() || '';
        assert.ok(
            output.includes('hotkey-restriction/no-direct-window-document-hotkeys'),
            `Should report forbidden hotkey rule error. Output: ${output}`
        );
    } finally {
        try { unlinkSync(forbiddenFile); } catch {}
    }

    // 3. Test allowed file (CallExpression in a .test.ts file)
    writeFileSync(allowedFile, "window.addEventListener('keydown', () => {});\n");
    try {
        execSync(`npx eslint "${allowedFile}"`, { stdio: 'pipe' });
        // Should pass, no error thrown
    } catch (err: any) {
        const output = err.stdout?.toString() || err.stderr?.toString() || '';
        assert.fail(`ESLint should have passed for allowed test file: ${output}`);
    } finally {
        try { unlinkSync(allowedFile); } catch {}
    }
});
