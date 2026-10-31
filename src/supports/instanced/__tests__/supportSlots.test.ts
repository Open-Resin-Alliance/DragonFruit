import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildSupportSlots } from '../supportSlots';
import type { ProxyModelGeometry } from '../../SupportProxyMeshLayer';
import type { SupportTipProfile } from '../../SupportPrimitives/ContactCone/types';

function diskProfile(bodyDiameterMm: number, contactDiameterMm: number): SupportTipProfile {
  return {
    type: 'disk',
    contactDiameterMm,
    bodyDiameterMm,
    lengthMm: 3,
    penetrationMm: 0.05,
    diskThicknessMm: 0.1,
    maxStandoffMm: 0.25,
    standoffAngleThreshold: Math.PI / 4,
  };
}

const at = (x: number, y: number, z: number) => ({ x, y, z });

/**
 * One model with every primitive shape the proxy collector can emit: a straight
 * shaft, a tapered one, a curved one, one whose ends differ by less than the
 * taper epsilon, a degenerate (zero-length) shaft with no support of its own, and
 * one of each other primitive.
 */
function model(): ProxyModelGeometry {
  return {
    modelId: 'model-1',
    shafts: [
      {
        id: 'shaft-straight',
        supportId: 'sup-a',
        modelId: 'model-1',
        start: at(0, 0, 0),
        end: at(0, 0, 5),
        diameter: 1.2,
      },
      {
        id: 'shaft-tapered',
        supportId: 'sup-a',
        modelId: 'model-1',
        start: at(0, 0, 5),
        end: at(0, 0, 9),
        diameter: 1.2,
        diameterEnd: 0.6,
      },
      {
        id: 'shaft-curved',
        supportId: 'sup-b',
        modelId: 'model-2',
        start: at(0, 0, 9),
        end: at(2, 0, 12),
        diameter: 0.8,
        controlPoint1: at(0.5, 0, 10),
        controlPoint2: at(1.5, 0, 11),
        resolution: 16,
      },
      {
        id: 'shaft-almost-cylindrical',
        supportId: 'sup-b',
        modelId: 'model-1',
        start: at(2, 0, 12),
        end: at(2, 0, 14),
        diameter: 1.2,
        diameterEnd: 1.2 + 1e-7,
      },
      {
        id: 'shaft-zero',
        start: at(3, 3, 3),
        end: at(3, 3, 3),
        diameter: 1.2,
      },
    ],
    joints: [
      { id: 'joint-a', supportId: 'sup-a', modelId: 'model-1', pos: at(0, 0, 5), diameter: 1.5 },
      { id: 'joint-b', supportId: 'sup-b', modelId: 'model-1', pos: at(2, 0, 12), diameter: 1.1 },
    ],
    roots: [
      {
        id: 'root-a',
        supportId: 'sup-a',
        modelId: 'model-1',
        basePos: at(0, 0, 0),
        bottomRadius: 4,
        topRadius: 1.5,
        effectiveDiskHeight: 0.6,
        coneHeight: 2.4,
      },
    ],
    cones: [
      {
        id: 'cone-disk',
        supportId: 'sup-a',
        modelId: 'model-1',
        pos: at(2, 0, 14),
        normal: at(0, 0, 1),
        surfaceNormal: at(0.1, 0, 0.99),
        profile: diskProfile(1.2, 0.4),
      },
      {
        id: 'cone-no-contact',
        supportId: 'sup-b',
        modelId: 'model-1',
        pos: at(2, 0, 14),
        normal: at(0, 0, 1),
        profile: diskProfile(1.2, 0),
      },
    ],
  };
}

describe('buildSupportSlots', () => {
  it('makes one slot per primitive, in input order', () => {
    const slots = buildSupportSlots(model());

    assert.deepStrictEqual(
      slots.shafts.map((s) => s.id),
      ['shaft-straight', 'shaft-tapered', 'shaft-curved', 'shaft-almost-cylindrical', 'shaft-zero'],
    );
    assert.deepStrictEqual(slots.joints.map((j) => j.id), ['joint-a', 'joint-b']);
    assert.deepStrictEqual(slots.roots.map((r) => r.id), ['root-a']);
    assert.deepStrictEqual(slots.cones.map((c) => c.id), ['cone-disk', 'cone-no-contact']);
  });

  it('classifies shaft kinds by control points first, then by the taper epsilon', () => {
    const kinds = buildSupportSlots(model()).shafts.map((s) => s.kind);
    assert.deepStrictEqual(kinds, ['straight', 'tapered', 'curved', 'straight', 'straight']);
  });

  it('carries both end diameters, filling the end with the start width when untapered', () => {
    const [straight, tapered, curved] = buildSupportSlots(model()).shafts;

    assert.strictEqual(straight.diameterStart, 1.2);
    assert.strictEqual(straight.diameterEnd, 1.2);
    assert.strictEqual(tapered.diameterStart, 1.2);
    assert.strictEqual(tapered.diameterEnd, 0.6);
    assert.strictEqual(curved.diameterStart, 0.8);
    assert.strictEqual(curved.diameterEnd, 0.8);
  });

  it('copies geometry by value and keeps the optional curve fields', () => {
    const source = model();
    const slots = buildSupportSlots(source);
    const curved = slots.shafts[2];

    assert.deepStrictEqual(curved.start, at(0, 0, 9));
    assert.deepStrictEqual(curved.controlPoint1, at(0.5, 0, 10));
    assert.deepStrictEqual(curved.controlPoint2, at(1.5, 0, 11));
    assert.strictEqual(curved.resolution, 16);
    assert.notStrictEqual(curved.start, source.shafts[2].start);
    assert.notStrictEqual(curved.controlPoint1, source.shafts[2].controlPoint1);
    assert.strictEqual('controlPoint1' in slots.shafts[0], false);
    assert.strictEqual('resolution' in slots.shafts[0], false);
  });

  it('takes the primitive model id, falling back to the geometry-wide one', () => {
    const slots = buildSupportSlots(model());

    assert.strictEqual(slots.shafts[0].modelId, 'model-1');
    assert.strictEqual(slots.shafts[2].modelId, 'model-2');
    // The zero-length shaft carries no model id of its own.
    assert.strictEqual(slots.shafts[4].modelId, 'model-1');
  });

  it('keeps a degenerate primitive and groups a support-less one under its own id', () => {
    const slots = buildSupportSlots(model());

    assert.strictEqual(slots.shafts.length, 5);
    assert.strictEqual(slots.shafts[4].supportId, 'shaft-zero');
    assert.deepStrictEqual(slots.bySupport.get('shaft-zero'), {
      shafts: [4],
      joints: [],
      roots: [],
      cones: [],
    });
  });

  it('groups every kind of each support by index into its own list', () => {
    const slots = buildSupportSlots(model());

    assert.deepStrictEqual(slots.bySupport.get('sup-a'), {
      shafts: [0, 1],
      joints: [0],
      roots: [0],
      cones: [0],
    });
    assert.deepStrictEqual(slots.bySupport.get('sup-b'), {
      shafts: [2, 3],
      joints: [1],
      roots: [],
      cones: [1],
    });
  });

  it('resolves every primitive id to its kind and list index', () => {
    const slots = buildSupportSlots(model());

    assert.deepStrictEqual(slots.byPrimitive.get('shaft-tapered'), { kind: 'shaft', index: 1 });
    assert.deepStrictEqual(slots.byPrimitive.get('joint-b'), { kind: 'joint', index: 1 });
    assert.deepStrictEqual(slots.byPrimitive.get('root-a'), { kind: 'root', index: 0 });
    assert.deepStrictEqual(slots.byPrimitive.get('cone-disk'), { kind: 'cone', index: 0 });
    assert.strictEqual(slots.byPrimitive.size, 10);
  });

  it('computes the cone shape ratio as body over contact, guarded at a zero contact', () => {
    const [disk, noContact] = buildSupportSlots(model()).cones;

    assert.ok(Math.abs(disk.shapeRatio - 3) < 1e-12, `shape ratio ${disk.shapeRatio}`);
    assert.strictEqual(noContact.shapeRatio, 1);
    assert.strictEqual(disk.profile.type, 'disk');
  });

  it('copies the joint, root and cone fields', () => {
    const slots = buildSupportSlots(model());

    assert.deepStrictEqual(slots.joints[0], {
      id: 'joint-a',
      supportId: 'sup-a',
      modelId: 'model-1',
      pos: at(0, 0, 5),
      diameter: 1.5,
    });
    assert.deepStrictEqual(slots.roots[0], {
      id: 'root-a',
      supportId: 'sup-a',
      modelId: 'model-1',
      basePos: at(0, 0, 0),
      bottomRadius: 4,
      topRadius: 1.5,
      effectiveDiskHeight: 0.6,
      coneHeight: 2.4,
    });
    assert.deepStrictEqual(slots.cones[0].pos, at(2, 0, 14));
    assert.deepStrictEqual(slots.cones[0].normal, at(0, 0, 1));
    assert.deepStrictEqual(slots.cones[0].surfaceNormal, at(0.1, 0, 0.99));
    assert.strictEqual('surfaceNormal' in slots.cones[1], false);
  });

  it('returns empty lists and maps for a model with no primitives', () => {
    const slots = buildSupportSlots({ shafts: [], joints: [], roots: [], cones: [] });

    assert.deepStrictEqual(slots.shafts, []);
    assert.strictEqual(slots.bySupport.size, 0);
    assert.strictEqual(slots.byPrimitive.size, 0);
  });
});
