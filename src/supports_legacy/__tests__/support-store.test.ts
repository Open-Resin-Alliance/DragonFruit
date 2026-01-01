/**
 * Support Store Tests
 * 
 * Tests for the normalized support store, including:
 * - Add/update/remove operations
 * - Undo/redo functionality
 * - Serialization/deserialization
 * - Validation helpers
 * 
 * Run with: node --loader ts-node/esm support-store.test.ts
 * Or add to package.json: "test": "node --test src/supports/__tests__/*.test.ts"
 */

import { strict as assert } from 'assert';
import { test, describe, beforeEach } from 'node:test';

// Import support store functions
import {
  addSupport,
  updateSupport,
  removeSupport,
  clearSupports,
  getSupportList,
  getSupportById,
  undoSupportAction,
  redoSupportAction,
  serializeSupports,
  deserializeSupports,
  generateSupportId,
} from '../state';

import { createSupportInstance, createDefaultSupportSettings } from '../types';
import { validateSupportInstance, validateSupportSettings } from '../validation';

describe('Support Store - Basic Operations', () => {
  beforeEach(() => {
    clearSupports();
  });

  test('should start with empty store', () => {
    const supports = getSupportList();
    assert.equal(supports.length, 0, 'Store should be empty initially');
  });

  test('should add a support instance', () => {
    const support = createSupportInstance({
      id: generateSupportId(),
      tip: { x: 0, y: 0, z: 10 },
      base: { x: 0, y: 0, z: 0 },
    });

    addSupport(support);
    const supports = getSupportList();
    
    assert.equal(supports.length, 1, 'Should have one support');
    assert.equal(supports[0].id, support.id, 'Support ID should match');
  });

  test('should retrieve support by ID', () => {
    const support = createSupportInstance({
      id: generateSupportId(),
      tip: { x: 5, y: 5, z: 10 },
      base: { x: 5, y: 5, z: 0 },
    });

    addSupport(support);
    const retrieved = getSupportById(support.id);
    
    assert.notEqual(retrieved, undefined, 'Should find support by ID');
    assert.equal(retrieved?.tip.x, 5, 'Tip position should match');
  });

  test('should remove a support instance', () => {
    const support = createSupportInstance({
      id: generateSupportId(),
      tip: { x: 0, y: 0, z: 10 },
      base: { x: 0, y: 0, z: 0 },
    });

    addSupport(support);
    assert.equal(getSupportList().length, 1, 'Should have one support');
    
    removeSupport(support.id);
    assert.equal(getSupportList().length, 0, 'Should have zero supports after removal');
  });

  test('should update a support instance', () => {
    const support = createSupportInstance({
      id: generateSupportId(),
      tip: { x: 0, y: 0, z: 10 },
      base: { x: 0, y: 0, z: 0 },
    });

    addSupport(support);
    
    const updated = { ...support, tip: { x: 10, y: 10, z: 10 } };
    updateSupport(updated);
    
    const retrieved = getSupportById(support.id);
    assert.equal(retrieved?.tip.x, 10, 'Tip X should be updated');
    assert.equal(retrieved?.tip.y, 10, 'Tip Y should be updated');
  });
});

describe('Support Store - Undo/Redo', () => {
  beforeEach(() => {
    clearSupports();
  });

  test('should undo add operation', () => {
    const support = createSupportInstance({
      id: generateSupportId(),
      tip: { x: 0, y: 0, z: 10 },
      base: { x: 0, y: 0, z: 0 },
    });

    addSupport(support);
    assert.equal(getSupportList().length, 1, 'Should have one support');
    
    undoSupportAction();
    assert.equal(getSupportList().length, 0, 'Should have zero supports after undo');
  });

  test('should redo add operation', () => {
    const support = createSupportInstance({
      id: generateSupportId(),
      tip: { x: 0, y: 0, z: 10 },
      base: { x: 0, y: 0, z: 0 },
    });

    addSupport(support);
    undoSupportAction();
    assert.equal(getSupportList().length, 0, 'Should have zero supports after undo');
    
    redoSupportAction();
    assert.equal(getSupportList().length, 1, 'Should have one support after redo');
  });

  test('should undo remove operation', () => {
    const support = createSupportInstance({
      id: generateSupportId(),
      tip: { x: 0, y: 0, z: 10 },
      base: { x: 0, y: 0, z: 0 },
    });

    addSupport(support);
    removeSupport(support.id);
    assert.equal(getSupportList().length, 0, 'Should have zero supports after removal');
    
    undoSupportAction();
    assert.equal(getSupportList().length, 1, 'Should have one support after undo');
  });

  test('should undo update operation', () => {
    const support = createSupportInstance({
      id: generateSupportId(),
      tip: { x: 0, y: 0, z: 10 },
      base: { x: 0, y: 0, z: 0 },
    });

    addSupport(support);
    const updated = { ...support, tip: { x: 20, y: 20, z: 10 } };
    updateSupport(updated);
    
    const afterUpdate = getSupportById(support.id);
    assert.equal(afterUpdate?.tip.x, 20, 'Should have updated value');
    
    undoSupportAction();
    const afterUndo = getSupportById(support.id);
    assert.equal(afterUndo?.tip.x, 0, 'Should restore original value');
  });
});

describe('Support Store - Serialization', () => {
  beforeEach(() => {
    clearSupports();
  });

  test('should serialize empty store', () => {
    const serialized = serializeSupports();
    
    assert.equal(serialized.version, 1, 'Should have version 1');
    assert.equal(serialized.supports.allIds.length, 0, 'Should have no supports');
  });

  test('should serialize and deserialize supports', () => {
    const support1 = createSupportInstance({
      id: generateSupportId(),
      tip: { x: 0, y: 0, z: 10 },
      base: { x: 0, y: 0, z: 0 },
    });
    const support2 = createSupportInstance({
      id: generateSupportId(),
      tip: { x: 5, y: 5, z: 10 },
      base: { x: 5, y: 5, z: 0 },
    });

    addSupport(support1);
    addSupport(support2);
    
    const serialized = serializeSupports();
    assert.equal(serialized.supports.allIds.length, 2, 'Should serialize two supports');
    
    clearSupports();
    assert.equal(getSupportList().length, 0, 'Store should be empty after clear');
    
    deserializeSupports(serialized);
    assert.equal(getSupportList().length, 2, 'Should restore two supports');
    
    const restored1 = getSupportById(support1.id);
    assert.notEqual(restored1, undefined, 'Should restore first support');
    assert.equal(restored1?.tip.x, 0, 'Should restore tip position');
  });

  test('should preserve settings during serialization', () => {
    const customSettings = createDefaultSupportSettings();
    customSettings.tip.contactDiameterMm = 0.5;
    customSettings.mid.diameterMm = 1.5;
    
    const support = createSupportInstance({
      id: generateSupportId(),
      tip: { x: 0, y: 0, z: 10 },
      base: { x: 0, y: 0, z: 0 },
      settings: customSettings,
    });

    addSupport(support);
    const serialized = serializeSupports();
    
    clearSupports();
    deserializeSupports(serialized);
    
    const restored = getSupportById(support.id);
    assert.equal(restored?.settings.tip.contactDiameterMm, 0.5, 'Should restore custom tip diameter');
    assert.equal(restored?.settings.mid.diameterMm, 1.5, 'Should restore custom mid diameter');
  });
});

describe('Support Validation', () => {
  test('should validate default support settings', () => {
    const settings = createDefaultSupportSettings();
    const issues = validateSupportSettings(settings);
    
    assert.equal(issues.length, 0, 'Default settings should be valid');
  });

  test('should detect invalid tip diameter', () => {
    const settings = createDefaultSupportSettings();
    settings.tip.contactDiameterMm = -1;
    
    const issues = validateSupportSettings(settings);
    assert.ok(issues.length > 0, 'Should detect negative diameter');
    assert.ok(issues.some(i => i.path.includes('contactDiameterMm')), 'Should report contactDiameterMm issue');
  });

  test('should validate support instance', () => {
    const support = createSupportInstance({
      id: generateSupportId(),
      tip: { x: 0, y: 0, z: 10 },
      base: { x: 0, y: 0, z: 0 },
    });
    
    const issues = validateSupportInstance(support);
    assert.equal(issues.length, 0, 'Default support instance should be valid');
  });

  test('should detect missing support ID', () => {
    const support = createSupportInstance({
      id: '',
      tip: { x: 0, y: 0, z: 10 },
      base: { x: 0, y: 0, z: 0 },
    });
    
    const issues = validateSupportInstance(support);
    assert.ok(issues.length > 0, 'Should detect empty ID');
    assert.ok(issues.some(i => i.path === 'id'), 'Should report ID issue');
  });
});

describe('Support Factory Functions', () => {
  test('should create support with defaults', () => {
    const support = createSupportInstance({
      id: 's1',
      tip: { x: 0, y: 0, z: 10 },
      base: { x: 0, y: 0, z: 0 },
    });
    
    assert.equal(support.id, 's1', 'Should have specified ID');
    assert.equal(support.isVisible, true, 'Should default to visible');
    assert.equal(support.collisionIsAccepted, false, 'Should default collision to false');
    assert.notEqual(support.settings, undefined, 'Should have default settings');
  });

  test('should create support with custom settings', () => {
    const customSettings = createDefaultSupportSettings();
    customSettings.tip.contactDiameterMm = 0.8;
    
    const support = createSupportInstance({
      id: 's2',
      tip: { x: 0, y: 0, z: 10 },
      base: { x: 0, y: 0, z: 0 },
      settings: customSettings,
    });
    
    assert.equal(support.settings.tip.contactDiameterMm, 0.8, 'Should use custom settings');
  });

  test('should generate unique IDs', () => {
    const id1 = generateSupportId();
    const id2 = generateSupportId();
    const id3 = generateSupportId();
    
    assert.notEqual(id1, id2, 'IDs should be unique');
    assert.notEqual(id2, id3, 'IDs should be unique');
    assert.ok(id1.startsWith('s'), 'IDs should start with "s"');
  });
});

console.log('✓ All support store tests passed');
