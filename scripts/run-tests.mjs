import { globSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Expand patterns in Node, not the shell: cmd.exe passes single quotes through
// literally, and node --test can then succeed without finding a single file.
const suites = {
    unit: {
        patterns: ['src/**/*.test.{ts,tsx}', 'plugins/**/*.test.{ts,tsx}'],
        preload: './scripts/test-unit/register.mjs',
    },
    dom: {
        patterns: ['src/**/*.dom-test.tsx'],
        preload: './scripts/test-dom/register.mjs',
    },
};

const [suiteName, ...runnerArgs] = process.argv.slice(2);
const suite = suites[suiteName];
if (!suite) {
    console.error('Usage: node scripts/run-tests.mjs <unit|dom> [Node test-runner options]');
    process.exit(1);
}

const files = [...globSync(suite.patterns)].sort();
if (files.length === 0) {
    console.error(`[tests] No ${suiteName} test files found in ${process.cwd()}.`);
    process.exit(1);
}

console.log(`[tests] Running ${files.length} ${suiteName} test files.`);
const result = spawnSync(process.execPath, [
    '--import', 'tsx', '--import', suite.preload, '--test', ...runnerArgs, ...files,
], { stdio: 'inherit' });
if (result.error) console.error(result.error);
process.exitCode = result.status ?? 1;
