import { describe, it } from 'node:test';
import assert from 'node:assert';
import { supportPainterStore } from '../supportPainterStore';
import { type FailedPlacementCandidate } from '../supportPainterTypes';

describe('Support Painter Phase 4 - Diagnostics Navigation & Failure Collection', () => {
  it('should initialize with empty failed candidates', () => {
    supportPainterStore.clearFailedCandidates();
    const state = supportPainterStore.getSnapshot();
    assert.strictEqual(state.failedCandidates.length, 0);
    assert.strictEqual(state.activeFailureIndex, null);
  });

  it('should set failed candidates and default focus to the first failure', () => {
    supportPainterStore.clearFailedCandidates();
    const mockCandidates: FailedPlacementCandidate[] = [
      {
        id: 'fail-1',
        pos: { x: 10, y: 20, z: 30 },
        normal: { x: 0, y: 0, z: 1 },
        stage: 'minima',
        regionId: 'roi-1',
        reason: 'COLLISION_OR_UNPRINTABLE',
      },
      {
        id: 'fail-2',
        pos: { x: 40, y: 50, z: 60 },
        normal: { x: 0, y: 1, z: 0 },
        stage: 'perimeter',
        regionId: 'roi-1',
        reason: 'PLACEMENT_DECISION_FAILED',
      },
    ];

    supportPainterStore.setFailedCandidates(mockCandidates);
    const state = supportPainterStore.getSnapshot();

    assert.strictEqual(state.failedCandidates.length, 2);
    assert.strictEqual(state.activeFailureIndex, 0);
    assert.strictEqual(state.failedCandidates[0].id, 'fail-1');
  });

  it('should navigate forwards (goToNextFailure) and wrap around bounds correctly', () => {
    const mockCandidates: FailedPlacementCandidate[] = [
      {
        id: 'fail-1',
        pos: { x: 10, y: 20, z: 30 },
        normal: { x: 0, y: 0, z: 1 },
        stage: 'minima',
        regionId: 'roi-1',
        reason: 'COLLISION_OR_UNPRINTABLE',
      },
      {
        id: 'fail-2',
        pos: { x: 40, y: 50, z: 60 },
        normal: { x: 0, y: 1, z: 0 },
        stage: 'perimeter',
        regionId: 'roi-1',
        reason: 'PLACEMENT_DECISION_FAILED',
      },
      {
        id: 'fail-3',
        pos: { x: 70, y: 80, z: 90 },
        normal: { x: 1, y: 0, z: 0 },
        stage: 'infill',
        regionId: 'roi-2',
        reason: 'COLLISION_OR_UNPRINTABLE',
      },
    ];

    supportPainterStore.setFailedCandidates(mockCandidates);
    assert.strictEqual(supportPainterStore.getSnapshot().activeFailureIndex, 0);

    supportPainterStore.goToNextFailure();
    assert.strictEqual(supportPainterStore.getSnapshot().activeFailureIndex, 1);

    supportPainterStore.goToNextFailure();
    assert.strictEqual(supportPainterStore.getSnapshot().activeFailureIndex, 2);

    // Should wrap to 0
    supportPainterStore.goToNextFailure();
    assert.strictEqual(supportPainterStore.getSnapshot().activeFailureIndex, 0);
  });

  it('should navigate backwards (goToPrevFailure) and wrap around bounds correctly', () => {
    const mockCandidates: FailedPlacementCandidate[] = [
      {
        id: 'fail-1',
        pos: { x: 10, y: 20, z: 30 },
        normal: { x: 0, y: 0, z: 1 },
        stage: 'minima',
        regionId: 'roi-1',
        reason: 'COLLISION_OR_UNPRINTABLE',
      },
      {
        id: 'fail-2',
        pos: { x: 40, y: 50, z: 60 },
        normal: { x: 0, y: 1, z: 0 },
        stage: 'perimeter',
        regionId: 'roi-1',
        reason: 'PLACEMENT_DECISION_FAILED',
      },
    ];

    supportPainterStore.setFailedCandidates(mockCandidates);
    assert.strictEqual(supportPainterStore.getSnapshot().activeFailureIndex, 0);

    // Wrapping backwards from 0 should go to 1
    supportPainterStore.goToPrevFailure();
    assert.strictEqual(supportPainterStore.getSnapshot().activeFailureIndex, 1);

    supportPainterStore.goToPrevFailure();
    assert.strictEqual(supportPainterStore.getSnapshot().activeFailureIndex, 0);
  });

  it('should clear failed candidates and reset index to null', () => {
    const mockCandidates: FailedPlacementCandidate[] = [
      {
        id: 'fail-1',
        pos: { x: 10, y: 20, z: 30 },
        normal: { x: 0, y: 0, z: 1 },
        stage: 'minima',
        regionId: 'roi-1',
        reason: 'COLLISION_OR_UNPRINTABLE',
      },
    ];

    supportPainterStore.setFailedCandidates(mockCandidates);
    assert.strictEqual(supportPainterStore.getSnapshot().failedCandidates.length, 1);

    supportPainterStore.clearFailedCandidates();
    const state = supportPainterStore.getSnapshot();
    assert.strictEqual(state.failedCandidates.length, 0);
    assert.strictEqual(state.activeFailureIndex, null);
  });
});
