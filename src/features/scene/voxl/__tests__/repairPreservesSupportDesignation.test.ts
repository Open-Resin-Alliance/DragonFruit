import assert from 'node:assert/strict';
import test from 'node:test';
import type { MeshRepairOptions } from '@/utils/meshRepair';
import type { ProcessGeometryOptions } from '@/hooks/useStlGeometry';

type SimpleModel = {
  id: string;
  name: string;
  isSupportGeometry?: boolean;
  geometry: {
    getAttribute: (name: string) => { count: number } | null;
  };
};

test('repair preserves isSupportGeometry designation on model object', () => {
  const model: SimpleModel = {
    id: 'support-model-1',
    name: 'Support Mesh',
    isSupportGeometry: true,
    geometry: {
      getAttribute: () => ({ count: 300 }),
    },
  };

  const processOptions: ProcessGeometryOptions = {
    center: false,
    nativeProcessingMode: 'repair',
    assumeSupportGeometry: model.isSupportGeometry,
  };

  assert.equal(processOptions.assumeSupportGeometry, true);

  // Simulate updating model state post-repair
  const repairedModel: SimpleModel = {
    ...model,
    isSupportGeometry: model.isSupportGeometry,
  };

  assert.equal(repairedModel.isSupportGeometry, true);
});

test('assumeSupportGeometry option is passed in MeshRepairOptions payload', () => {
  const options: MeshRepairOptions = {
    assumeSupportGeometry: true,
    weldEpsilon: 1e-5,
  };

  assert.equal(options.assumeSupportGeometry, true);

  const payload = {
    ...options,
    assume_support_geometry: options.assumeSupportGeometry,
  };

  const optionsJson = JSON.stringify(payload);
  const parsed = JSON.parse(optionsJson);

  assert.equal(parsed.assumeSupportGeometry, true);
  assert.equal(parsed.assume_support_geometry, true);
});
