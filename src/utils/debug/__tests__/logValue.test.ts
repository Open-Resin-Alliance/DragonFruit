import assert from 'node:assert/strict';
import test from 'node:test';
import { describeError, describeLogValue } from '../logValue';

test('an error leads with its name and message when the stack leaves them out (JavaScriptCore)', () => {
  const error = new TypeError('Load failed');
  error.stack = 'spill@tauri://localhost/chunk.js:1:2\nasyncFunctionResume@[native code]';
  assert.equal(
    describeError(error),
    'TypeError: Load failed\nspill@tauri://localhost/chunk.js:1:2\nasyncFunctionResume@[native code]',
  );
});

test('an error whose stack already starts with them (V8) is not repeated', () => {
  const error = new Error('boom');
  error.stack = 'Error: boom\n    at f (file.js:1:1)';
  assert.equal(describeError(error), 'Error: boom\n    at f (file.js:1:1)');
});

test('an object with a toJSON that dumps its data is summarised, not serialised', () => {
  let toJsonCalls = 0;
  class BufferGeometry {
    uuid = 'abc';
    attributes = { position: { array: new Float32Array(12_000_000), itemSize: 3 } };
    toJSON() {
      toJsonCalls += 1;
      return { everything: Array.from(this.attributes.position.array) };
    }
  }
  const text = describeLogValue(new BufferGeometry());
  assert.equal(toJsonCalls, 0);
  assert.ok(text.includes('"[type]":"BufferGeometry"'), text);
  assert.ok(text.includes('[Float32Array(12000000)]'), text);
  assert.ok(text.length < 300, `${text.length} chars`);
});

test('circular and deep values stay bounded', () => {
  const node: Record<string, unknown> = { name: 'root' };
  node.self = node;
  node.deep = { a: { b: { c: { d: { e: 1 } } } } };
  node.list = Array.from({ length: 50 }, (_, i) => i);
  const parsed = JSON.parse(describeLogValue(node));
  assert.equal(parsed.self, '[Circular]');
  assert.equal(parsed.deep.a.b.c, '[Object]');
  assert.equal(parsed.list.length, 21);
  assert.equal(parsed.list[20], '… 30 more');
});

test('strings pass through, and other primitives read as themselves', () => {
  assert.equal(describeLogValue('plain'), 'plain');
  assert.equal(describeLogValue(42), '42');
  assert.equal(describeLogValue(null), 'null');
  assert.equal(describeLogValue(undefined), 'undefined');
});
