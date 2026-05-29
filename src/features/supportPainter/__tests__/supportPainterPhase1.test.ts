import { describe, it } from 'node:test';
import assert from 'node:assert';
import { supportPainterStore } from '../supportPainterStore';
import { serializeROIsForVoxl, deserializeROIsFromVoxl } from '../voxlCodec';
import { type CustomBrushTemplate, type ROIRegion } from '../supportPainterTypes';

describe('Support Painter Phase 1 - Custom Brush Store & Codec Tests', () => {
  const mockBrush: CustomBrushTemplate = {
    id: 'test-custom-brush-id',
    name: 'Detailed Minis Brush',
    color: '#FF5B6F',
    selection: {
      normalConeAngleMinDeg: 15,
      normalConeAngleMaxDeg: 45,
      overhangSlopeMinDeg: 0,
      overhangSlopeMaxDeg: 60,
      curvatureMin: 0.1,
      curvatureMax: 0.8,
      dihedralAngleToleranceDeg: 25,
    },
    operations: [
      {
        type: 'minima',
        enabled: true,
        suppression: {
          enabled: true,
          distanceMm: 1.5,
          suppressAgainst: ['minima'],
        },
        spacing: {
          baseSpacingMm: 1.5,
        },
      },
      {
        type: 'perimeter',
        enabled: true,
        suppression: {
          enabled: true,
          distanceMm: 2.0,
          suppressAgainst: ['minima'],
        },
        spacing: {
          baseSpacingMm: 2.0,
          sequence: [1.0, 2.0],
          solverMode: 'closest',
          useInflectionPoints: true,
        },
      },
    ],
  };

  it('should successfully add, retrieve, update, and delete a custom brush in the store', () => {
    // 1. Add Brush
    supportPainterStore.addCustomBrush(mockBrush);
    let snapshot = supportPainterStore.getSnapshot();
    assert.ok(snapshot.customBrushes.has(mockBrush.id), 'Store should contain the added custom brush');
    
    const added = snapshot.customBrushes.get(mockBrush.id);
    assert.strictEqual(added?.name, 'Detailed Minis Brush');
    assert.strictEqual(added?.color, '#FF5B6F');

    // 2. Set Active Brush
    supportPainterStore.setActiveCustomBrushId(mockBrush.id);
    snapshot = supportPainterStore.getSnapshot();
    assert.strictEqual(snapshot.activeCustomBrushId, mockBrush.id, 'Active custom brush ID should be updated');

    // 3. Update Brush
    supportPainterStore.updateCustomBrush(mockBrush.id, {
      name: 'Updated Minis Brush',
      selection: {
        normalConeAngleMinDeg: 20,
        normalConeAngleMaxDeg: 50,
        overhangSlopeMinDeg: 0,
        overhangSlopeMaxDeg: 60,
        curvatureMin: 0.1,
        curvatureMax: 0.8,
        dihedralAngleToleranceDeg: 25,
      },
    });
    snapshot = supportPainterStore.getSnapshot();
    const updated = snapshot.customBrushes.get(mockBrush.id);
    assert.strictEqual(updated?.name, 'Updated Minis Brush');
    assert.strictEqual(updated?.selection.normalConeAngleMinDeg, 20);
    assert.strictEqual(updated?.selection.normalConeAngleMaxDeg, 50);

    // 4. Delete Brush
    supportPainterStore.deleteCustomBrush(mockBrush.id);
    snapshot = supportPainterStore.getSnapshot();
    assert.ok(!snapshot.customBrushes.has(mockBrush.id), 'Store should no longer contain the custom brush');
    assert.strictEqual(snapshot.activeCustomBrushId, null, 'Active brush ID should be reset to null');
  });

  it('should serialize and deserialize customBrush data correctly through the VOXL codec', () => {
    const testRegionId = 'test-region-123';
    const testModelId = 'test-model-456';

    const testRegion: ROIRegion = {
      id: testRegionId,
      brushType: 'MacroFace',
      seedTriangleId: 1024,
      triangleIds: new Set([10, 11, 12]),
      color: '#4A90E2',
      proposedOnly: false,
      createdAt: Date.now(),
      customBrush: mockBrush,
    };

    const regionsMap = new Map<string, ROIRegion>();
    regionsMap.set(testRegionId, testRegion);

    const regionsByModel = new Map<string, Map<string, ROIRegion>>();
    regionsByModel.set(testModelId, regionsMap);

    // 1. Serialize
    const serialized = serializeROIsForVoxl(regionsByModel, testModelId);
    
    // Assert structural properties
    assert.strictEqual(serialized.kind, 'support-painter-rois');
    assert.strictEqual(serialized.regions.length, 1);
    assert.deepStrictEqual(serialized.regions[0].customBrush, mockBrush, 'Serialized payload must include the customBrush template');

    // 2. Deserialize
    const deserialized = deserializeROIsFromVoxl(serialized);
    assert.ok(deserialized.has(testModelId), 'Deserialized output must contain the model ID');
    
    const deserializedRegions = deserialized.get(testModelId);
    assert.ok(deserializedRegions?.has(testRegionId), 'Deserialized output must contain the region ID');
    
    const deserializedRegion = deserializedRegions?.get(testRegionId);
    assert.deepStrictEqual(deserializedRegion?.customBrush, mockBrush, 'Deserialized region must structurally match the custom brush template');
  });

  it('should safely handle imports of legacy VOXL files which lack customBrush namespaces without failing', () => {
    // Legacy VOXL simulation (lacks customBrush property)
    const legacyExtension = {
      kind: 'support-painter-rois' as const,
      version: 1,
      modelId: 'legacy-model-789',
      regions: [
        {
          id: 'legacy-region-999',
          brushType: 'Ridge' as const,
          seedTriangleId: 500,
          color: '#E2844A',
          createdAt: Date.now(),
          rleSpans: [{ start: 100, count: 5 }],
        }
      ]
    };

    // Attempt deserialization
    assert.doesNotThrow(() => {
      const deserialized = deserializeROIsFromVoxl(legacyExtension);
      const modelMap = deserialized.get('legacy-model-789');
      const region = modelMap?.get('legacy-region-999');
      assert.strictEqual(region?.brushType, 'Ridge');
      assert.strictEqual(region?.customBrush, undefined, 'Legacy ROI region should cleanly parse customBrush as undefined');
    }, 'Deserializing legacy VOXL extensions should be fully safe and backward-compatible');
  });
});
