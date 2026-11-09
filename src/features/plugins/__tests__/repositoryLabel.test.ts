import assert from 'node:assert/strict';
import test from 'node:test';

import { repositoryLabel } from '../repositoryLabel';

test('a GitHub repository reads as owner and name', () => {
  assert.equal(repositoryLabel('https://github.com/Open-Resin-Alliance/DragonFruit'), 'Open-Resin-Alliance/DragonFruit');
  assert.equal(repositoryLabel('https://github.com/Open-Resin-Alliance/DragonFruit/tree/dev'), 'Open-Resin-Alliance/DragonFruit');
  assert.equal(repositoryLabel('https://github.com/Open-Resin-Alliance/DragonFruit.git'), 'Open-Resin-Alliance/DragonFruit');
});

test('anything else keeps its host, minus the scheme', () => {
  assert.equal(repositoryLabel('https://example.com/plugins/alpha/'), 'example.com/plugins/alpha');
  assert.equal(repositoryLabel('https://example.com'), 'example.com');
});

test('a value that is not a URL is returned with only the scheme removed', () => {
  assert.equal(repositoryLabel('github.com/owner/repo'), 'github.com/owner/repo');
  assert.equal(repositoryLabel('https://'), '');
});
