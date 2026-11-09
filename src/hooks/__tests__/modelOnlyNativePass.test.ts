import assert from 'node:assert/strict';
import test from 'node:test';

import { skipsNativePassForModelOnly } from '@/hooks/useStlGeometry';

test('a model-only import skips the native pass only when it is not auto-repairing', () => {
  assert.equal(skipsNativePassForModelOnly(true, false), true);
  assert.equal(skipsNativePassForModelOnly(true, true), false);
});

test('an import carrying a support section never skips the pass', () => {
  assert.equal(skipsNativePassForModelOnly(false, false), false);
  assert.equal(skipsNativePassForModelOnly(false, true), false);
});
