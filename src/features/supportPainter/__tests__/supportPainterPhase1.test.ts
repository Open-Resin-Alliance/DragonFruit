import { describe, it } from 'node:test';
import assert from 'node:assert';
import { supportPainterStore } from '../supportPainterStore';
import { serializeROIsForVoxl, deserializeROIsFromVoxl } from '../voxlCodec';
import { type CustomBrushTemplate, type ROIRegion } from '../supportPainterTypes';
import { getSnapshot as getSupportSnapshot, setSnapshot as setSupportSnapshot } from '@/supports/state';

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
        id: 'minima-op-1',
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
        id: 'perimeter-op-1',
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
    const expectedBrush = {
      ...mockBrush,
      operations: [
        {
          id: 'minima-op-1',
          type: 'minima',
          enabled: true,
          supportPresetId: 'default-light',
          isIntervalDirectlyEdited: false,
          isEndIntervalDirectlyEdited: false,
          insetDistanceMm: 0.0,
          wrapFraction: 1.0,
          enableZHeightDensity: false,
          minimaStartInterval: 0.5,
          minimaEndInterval: 'auto',
          zFactor: 2.0,
          zFactorCurve: 'linear',
          suppression: {
            enabled: true,
            distanceMm: 1.5,
            suppressAgainst: ['minima'],
          },
          spacing: {
            baseSpacingMm: 1.5,
            sequence: undefined,
            solverMode: 'standard',
            useInflectionPoints: false,
            infillPattern: 'PoissonDisc',
            seedFromMinima: true,
            attemptLeafCreation: false,
          },
        },
        {
          id: 'perimeter-op-1',
          type: 'perimeter',
          enabled: true,
          supportPresetId: 'default-light',
          isIntervalDirectlyEdited: false,
          isEndIntervalDirectlyEdited: false,
          insetDistanceMm: 0.0,
          wrapFraction: 1.0,
          enableZHeightDensity: false,
          minimaStartInterval: 0.5,
          minimaEndInterval: 'auto',
          zFactor: 2.0,
          zFactorCurve: 'linear',
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
            infillPattern: 'PoissonDisc',
            seedFromMinima: true,
            attemptLeafCreation: false,
          },
        },
      ],
    };
    assert.deepStrictEqual(deserializedRegion?.customBrush, expectedBrush, 'Deserialized region must structurally match the custom brush template');
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

  it('should always recompute rleSpans dynamically during serialization and invalidate cached spans on mutations', () => {
    const testRegionId = 'test-rle-invalidation-region';
    const testModelId = 'test-model-abc';

    // 1. Create a region with a cached, stale rleSpan
    const testRegion: ROIRegion = {
      id: testRegionId,
      brushType: 'MacroFace',
      seedTriangleId: 10,
      triangleIds: new Set([10, 11, 12]), // True triangle IDs
      color: '#4A90E2',
      proposedOnly: false,
      createdAt: Date.now(),
      rleSpans: [{ start: 900, count: 5 }], // Stale cached spans
      loops: [],
    };

    const regionsMap = new Map<string, ROIRegion>();
    regionsMap.set(testRegionId, testRegion);
    const regionsByModel = new Map<string, Map<string, ROIRegion>>();
    regionsByModel.set(testModelId, regionsMap);

    // 2. Serialize and verify that stale cached rleSpans was ignored, and dynamic compressRLE was used instead
    const serialized = serializeROIsForVoxl(regionsByModel, testModelId);
    assert.strictEqual(serialized.regions[0].rleSpans?.length, 1);
    assert.strictEqual(serialized.regions[0].rleSpans?.[0].start, 10);
    assert.strictEqual(serialized.regions[0].rleSpans?.[0].count, 3, 'Dynamic serialization should always re-compress active triangleIds');

    // 3. Test store mutative invalidation
    // Initialize the store active model
    supportPainterStore.setActiveModelId(testModelId);
    
    // Set direct committed regions map in the store using restoreRegions
    supportPainterStore.restoreRegions(regionsMap);

    // Populate loops and rleSpans in the active store region to simulate generated supports
    const activeRegion = supportPainterStore.getSnapshot().regions.get(testRegionId)!;
    activeRegion.rleSpans = [{ start: 10, count: 3 }];
    activeRegion.loops = [{ type: 'outer', vertexIds: [1, 2, 3] }];

    // Run append stroke
    supportPainterStore.appendTrianglesToRegion(testRegionId, [13, 14]);

    // Verify cache was invalidated
    const mutatedRegion = supportPainterStore.getSnapshot().regions.get(testRegionId)!;
    assert.strictEqual(mutatedRegion.triangleIds.size, 5);
    assert.strictEqual(mutatedRegion.rleSpans, undefined, 'Mutating triangle IDs must invalidate cached rleSpans');
    assert.strictEqual(mutatedRegion.loops, undefined, 'Mutating triangle IDs must invalidate cached loops');

    // Re-populate and run subtract
    mutatedRegion.rleSpans = [{ start: 10, count: 5 }];
    mutatedRegion.loops = [{ type: 'hole', vertexIds: [4, 5, 6] }];
    supportPainterStore.subtractTrianglesFromRegions([14]);

    const subtractedRegion = supportPainterStore.getSnapshot().regions.get(testRegionId)!;
    assert.strictEqual(subtractedRegion.triangleIds.size, 4);
    assert.strictEqual(subtractedRegion.rleSpans, undefined, 'Subtracting triangle IDs must invalidate cached rleSpans');
    assert.strictEqual(subtractedRegion.loops, undefined, 'Subtracting triangle IDs must invalidate cached loops');

    // Clean up store
    supportPainterStore.clearAll();
    supportPainterStore.setActiveModelId(null);
  });

  it('should remap support roiIds correctly when merging regions through boolean union', () => {
    const roiIdA = 'roi-union-a';
    const roiIdB = 'roi-union-b';
    const testModelId = 'test-model-union';

    // 1. Create mock regions in the store
    const rA: ROIRegion = {
      id: roiIdA,
      brushType: 'MacroFace',
      seedTriangleId: 10,
      triangleIds: new Set([10, 11]),
      color: '#4A90E2',
      proposedOnly: false,
      createdAt: Date.now(),
    };
    const rB: ROIRegion = {
      id: roiIdB,
      brushType: 'MacroFace',
      seedTriangleId: 20,
      triangleIds: new Set([20, 21]),
      color: '#FF5B6F',
      proposedOnly: false,
      createdAt: Date.now(),
    };

    const regionsMap = new Map<string, ROIRegion>();
    regionsMap.set(roiIdA, rA);
    regionsMap.set(roiIdB, rB);

    supportPainterStore.setActiveModelId(testModelId);
    supportPainterStore.restoreRegions(regionsMap);

    // 2. Set up mock supports in the support state
    const originalSupportState = getSupportSnapshot();
    const mockSupportState = {
      ...originalSupportState,
      roots: {
        'root-1': { id: 'root-1', roiId: roiIdB, modelId: testModelId },
      },
      trunks: {
        'trunk-1': { id: 'trunk-1', roiId: roiIdB, modelId: testModelId, segments: [] },
      },
    };
    setSupportSnapshot(mockSupportState as any);

    // 3. Perform Union Boolean operation (merges B into A, and deletes B)
    supportPainterStore.booleanOperate('union', roiIdA, roiIdB);

    // 4. Verify ROIs in the store
    const snapshot = supportPainterStore.getSnapshot();
    assert.ok(snapshot.regions.has(roiIdA));
    assert.ok(!snapshot.regions.has(roiIdB), 'Merged region B should be deleted');
    assert.strictEqual(snapshot.regions.get(roiIdA)!.triangleIds.size, 4);

    // 5. Verify remapping of supports in the support state
    const postSupportState = getSupportSnapshot();
    assert.strictEqual(postSupportState.roots['root-1']?.roiId, roiIdA, 'Merged support roots must be reassociated with the target ROI');
    assert.strictEqual(postSupportState.trunks['trunk-1']?.roiId, roiIdA, 'Merged support trunks must be reassociated with the target ROI');

    // Clean up
    setSupportSnapshot(originalSupportState);
    supportPainterStore.clearAll();
    supportPainterStore.setActiveModelId(null);
  });
});
