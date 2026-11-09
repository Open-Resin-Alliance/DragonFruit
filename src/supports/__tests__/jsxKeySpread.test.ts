import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';

/**
 * `key` must not travel inside a spread object.
 *
 * React reads `key` before props are applied, so `<X {...props} />` with a
 * `key` in `props` warns at runtime and the element gets no key. Nothing
 * static catches it: it typechecks, and no React lint rules are configured.
 */

/** An object literal holding `key:` that is later spread into JSX. */
function spreadObjectsCarryingKey(source: string): string[] {
    const offenders: string[] = [];

    // `const <name> = { ... key: ... }` followed anywhere by `{...<name>}`.
    for (const match of source.matchAll(/const\s+(\w+)\s*=\s*\{([^}]*)\}/g)) {
        const [, name, body] = match;
        if (!/(^|[\s,{])key\s*:/.test(body)) continue;
        if (source.includes(`{...${name}}`)) offenders.push(name);
    }

    return offenders;
}

test('no support renderer spreads an object containing a key', () => {
    const files = globSync('src/supports/**/*.tsx');
    const bad: string[] = [];

    for (const file of files) {
        for (const name of spreadObjectsCarryingKey(readFileSync(file, 'utf8'))) {
            bad.push(`${file}: "${name}" carries a key and is spread into JSX`);
        }
    }

    assert.deepEqual(bad, []);
});

test('the check recognises the shape it is guarding against', () => {
    const offending = [
        'const shared = { key: `shaft-${id}`, id, start };',
        'return <ShaftRenderer {...shared} />;',
    ].join('\n');
    assert.deepEqual(spreadObjectsCarryingKey(offending), ['shared']);

    const fixed = [
        'const key = `shaft-${id}`;',
        'const shared = { id, start };',
        'return <ShaftRenderer key={key} {...shared} />;',
    ].join('\n');
    assert.deepEqual(spreadObjectsCarryingKey(fixed), []);
});
