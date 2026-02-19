import { describe, it } from 'node:test'; // using builtin test runner
import assert from 'node:assert';
import * as THREE from 'three';
import { LysConverter } from './LysConverter';
import { SupportSettings, createDefaultSettings } from '../../supports/Settings';
import { Roots, Trunk, Branch, Brace, Knot } from '../../supports/types';

// Mock Data
const MOCK_LYCHEE_DATA = {
    objects: {
        present: {
            byId: {
                'o15': {
                    id: 'o15',
                    center: { x: 0, y: 0, z: 10 },
                    position: { x: 0, y: 0, z: 0 },
                    scale: { x: 1, y: 1, z: 1 },
                    supportsBase: ['s1'] // Root support
                }
            }
        }
    },
    supports: {
        present: {
            byId: {
                // 1. ROOT SUPPORT
                's1': {
                    id: 's1',
                    base: { x: 0, y: 0, z: 0 }, // Floor
                    tip: { x: 0, y: 0, z: 20 },
                    settings: {
                        base: { joinDiameter: 1.2 },
                        tip: { diameter: 0.6, length: 3 }
                    },
                    parentId: []
                },
                // 2. BRANCH SUPPORT (Child of s1)
                's2': {
                    id: 's2',
                    base: { x: 0, y: 0, z: 10 }, // Mid-air (needs projection)
                    tip: { x: 10, y: 0, z: 20 },
                    settings: {
                        base: { joinDiameter: 0.8 },
                        tip: { diameter: 0.6, length: 2 }
                    },
                    parentId: ['s1'] // Linked to s1
                },
                // 3. BRACE (Connecting s1 and s2) -> This might need 2 roots to be realistic brace
                // Let's make a brace between s1 and a new root s3
                's3': {
                    id: 's3',
                    base: { x: 20, y: 0, z: 0 },
                    tip: { x: 20, y: 0, z: 20 },
                    parentId: []
                },
                's4_brace': {
                    id: 's4_brace',
                    base: { x: 0, y: 0, z: 5 }, // On s1
                    tip: { x: 20, y: 0, z: 5 }, // On s3
                    settings: {
                        base: { joinDiameter: 0.5 }
                    },
                    parentId: ['s1', 's3'] // Connected to both
                }
            }
        }
    }
};

describe('LysConverter', () => {
    it('should correctly convert Roots', () => {
        const result = LysConverter.convert(MOCK_LYCHEE_DATA, createDefaultSettings());

        const rootTrunk = result.trunks.find(t => t.id.includes('s1') || t.segments[0].bottomJoint === undefined);
        assert.ok(rootTrunk, 'Root trunk s1 should exist');
        assert.strictEqual(result.roots.length, 2, 'Should have 2 roots (s1, s3)');
    });

    it('should correctly convert Branches (Type 1 Child)', () => {
        // This expects the converter to handle parentId logic
        const result = LysConverter.convert(MOCK_LYCHEE_DATA, createDefaultSettings());

        // Check if s2 became a Branch
        // Note: ID generation in LysConverter uses uuidv4(), so we can't check ID directly unless we control it.
        // However, we can check result.branches length.

        // Expected: 1 Branch (s2)
        assert.strictEqual(result.branches.length, 1, 'Should have 1 branch');

        const branch = result.branches[0];
        assert.ok(branch.parentKnotId, 'Branch should have a parentKnotId');

        // Verify the Knot exists
        const knot = result.knots.find(k => k.id === branch.parentKnotId);
        assert.ok(knot, 'Parent knot should exist');

        // Verify Knot is on s1
        // We need to look up if s1's trunk has this knot. 
        // Data structure: Knots link to parentShaftId.
        // We assume s1 created a trunk.
        // Since IDs are UUIDs, this is hard to trace without the converter returning a map or using deterministic IDs.
        // But we know s1 is at x=0. Knot should be near x=0.
        assert.ok(Math.abs(knot.pos.x) < 1.0, 'Knot for s2 should be on s1 (approx x=0)');

        const hostedByKnownSegment = result.trunks.some(t => t.segments.some(seg => seg.id === knot.parentShaftId))
            || result.branches.some(b => b.segments.some(seg => seg.id === knot.parentShaftId));
        assert.ok(hostedByKnownSegment, 'Imported knot.parentShaftId should match a real segment ID for editability');
    });

    it('should treat explicit single-parent parentBaseId hints as parent-side host preferences without flipping child endpoints', () => {
        const BASE_SIDE_HINT_DATA = {
            objects: {
                present: {
                    byId: {
                        o1: {
                            id: 'o1',
                            formerCenter: { x: 0, y: 0, z: 0 },
                            position: { x: 0, y: 0, z: 0 },
                            rotation: { x: 0, y: 0, z: 0 },
                            scale: { x: 1, y: 1, z: 1 },
                        }
                    }
                }
            },
            supports: {
                present: {
                    byId: {
                        s_root: {
                            id: 's_root',
                            type: 1,
                            mini: false,
                            base: { x: 0, y: 0, z: 0 },
                            tip: { x: 0, y: 0, z: 20 },
                            parentId: [],
                            parentBaseId: null,
                            parentTipId: null,
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: {
                                base: { joinDiameter: 1.0 },
                                tip: { diameter: 0.8, length: 2.0 },
                            },
                        },
                        s_branch_flip: {
                            id: 's_branch_flip',
                            type: 1,
                            mini: false,
                            isBaseTip: true,
                            // isBaseTip should not flip branch endpoint roles for explicit single-parent hints.
                            // base remains the attach-side candidate; tip remains the model-contact side.
                            base: { x: 0.2, y: 0, z: 2 },
                            tip: { x: 6, y: 0, z: 14 },
                            parentId: [],
                            parentBaseId: 's_root',
                            parentTipId: null,
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: {
                                base: { joinDiameter: 0.7 },
                                tip: { diameter: 0.6, length: 2.0 },
                            },
                        }
                    }
                }
            }
        };

        const result = LysConverter.convert(BASE_SIDE_HINT_DATA as any, createDefaultSettings());
        assert.strictEqual(result.branches.length, 1, 'Expected one branch from single-parent support');

        const branch = result.branches[0];
        const knot = result.knots.find(k => k.id === branch.parentKnotId);
        assert.ok(knot, 'Expected branch parent knot to exist');
        assert.ok(branch.contactCone, 'Expected branch to include contact cone');

        assert.ok((knot!.t ?? -1) <= 0.05, 'parentBaseId hint should bias knot projection near host base side (t≈0)');
        assert.ok(Math.abs(branch.contactCone!.pos.x - 6) < 1e-6, 'Branch tip should remain sourced from Lychee tip endpoint');
        assert.ok(Math.abs(branch.contactCone!.pos.z - 14) < 1e-6, 'Branch tip Z should remain sourced from Lychee tip endpoint');

        const hostedByTrunk = result.trunks.some(t => t.segments.some(seg => seg.id === knot!.parentShaftId));
        assert.ok(hostedByTrunk, 'Hinted knot should remain attached to a real trunk segment');
    });

    it('should convert grounded single-parent supports with explicit parent hint into support braces', () => {
        const SUPPORT_BRACE_DATA = {
            objects: {
                present: {
                    byId: {
                        o1: {
                            id: 'o1',
                            formerCenter: { x: 0, y: 0, z: 0 },
                            position: { x: 0, y: 0, z: 0 },
                            rotation: { x: 0, y: 0, z: 0 },
                            scale: { x: 1, y: 1, z: 1 },
                        }
                    }
                }
            },
            supports: {
                present: {
                    byId: {
                        s_root: {
                            id: 's_root',
                            type: 1,
                            base: { x: 0, y: 0, z: 0 },
                            tip: { x: 0, y: 0, z: 20 },
                            parentId: [],
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: {
                                base: { joinDiameter: 1.0 },
                                tip: { diameter: 0.8, length: 2.0 },
                            },
                        },
                        s_support_brace: {
                            id: 's_support_brace',
                            type: 1,
                            mini: false,
                            base: { x: 6, y: 0, z: 0 },
                            tip: { x: 0, y: 0, z: 5 },
                            parentId: [],
                            parentBaseId: null,
                            parentTipId: 's_root',
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: {
                                base: { joinDiameter: 1.0 },
                                tip: { diameter: 0.7, length: 2.0 },
                            },
                        },
                    }
                }
            }
        };

        const result = LysConverter.convert(SUPPORT_BRACE_DATA as any, createDefaultSettings());

        assert.strictEqual(result.trunks.length, 1, 'Expected one root trunk host');
        assert.strictEqual(result.branches.length, 0, 'Support brace candidate should not import as branch');
        assert.strictEqual(result.leaves.length, 0, 'Support brace candidate should not import as leaf');
        assert.strictEqual(result.supportBraces?.length ?? 0, 1, 'Expected one imported support brace build');

        const build = result.supportBraces![0];
        assert.ok(build.supportBrace.segments.length >= 1, 'Support brace should include generated segments');
        assert.strictEqual(build.hostKnot.parentShaftId.length > 0, true, 'Support brace host knot should target a host segment id');
        assert.strictEqual(Math.abs(build.root.transform.pos.z) < 1e-6, true, 'Support brace root should remain grounded on plate');
    });

    it('should correctly convert Braces (Type 0)', () => {
        const result = LysConverter.convert(MOCK_LYCHEE_DATA, createDefaultSettings());

        // Expected: 1 Brace (s4_brace)
        assert.strictEqual(result.braces.length, 1, 'Should have 1 brace');

        const brace = result.braces[0];
        assert.ok(brace.startKnotId, 'Brace needs start knot');
        assert.ok(brace.endKnotId, 'Brace needs end knot');

        // Check knot positions
        const startKnot = result.knots.find(k => k.id === brace.startKnotId);
        const endKnot = result.knots.find(k => k.id === brace.endKnotId);

        assert.ok(startKnot, 'Start knot exists');
        assert.ok(endKnot, 'End knot exists');

        // s4_brace connects s1 (x=0) and s3 (x=20) at z=5
        // Start knot should be near x=0, z=5
        // End knot should be near x=20, z=5

        // Order is not guaranteed, but one should be near 0, one near 20.
        const x1 = startKnot.pos.x;
        const x2 = endKnot.pos.x;

        assert.ok((Math.abs(x1) < 1 && Math.abs(x2 - 20) < 1) || (Math.abs(x1 - 20) < 1 && Math.abs(x2) < 1),
            'Brace knots should match parent positions');
    });

    it('should keep authored brace endpoint positions when explicit parentBaseId/parentTipId are provided', () => {
        const BRACE_HINT_DATA = {
            objects: {
                present: {
                    byId: {
                        o1: {
                            id: 'o1',
                            formerCenter: { x: 0, y: 0, z: 0 },
                            position: { x: 0, y: 0, z: 0 },
                            rotation: { x: 0, y: 0, z: 0 },
                            scale: { x: 1, y: 1, z: 1 },
                        }
                    }
                }
            },
            supports: {
                present: {
                    byId: {
                        s_root_a: {
                            id: 's_root_a',
                            base: { x: 0, y: 0, z: 0 },
                            tip: { x: 0, y: 0, z: 20 },
                            parentId: [],
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: { tip: { length: 3 } }
                        },
                        s_root_b: {
                            id: 's_root_b',
                            base: { x: 10, y: 0, z: 0 },
                            tip: { x: 10, y: 0, z: 20 },
                            parentId: [],
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: { tip: { length: 3 } }
                        },
                        s_brace_hint: {
                            id: 's_brace_hint',
                            type: 0,
                            base: { x: 0, y: 0, z: 7 },
                            tip: { x: 10, y: 0, z: 11 },
                            parentId: [],
                            parentBaseId: 's_root_a',
                            parentTipId: 's_root_b',
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: { base: { joinDiameter: 0.5 } }
                        }
                    }
                }
            }
        };

        const result = LysConverter.convert(BRACE_HINT_DATA as any, createDefaultSettings());
        assert.strictEqual(result.braces.length, 1, 'Expected one brace from explicit parent hints');

        const brace = result.braces[0];
        const startKnot = result.knots.find(k => k.id === brace.startKnotId);
        const endKnot = result.knots.find(k => k.id === brace.endKnotId);

        assert.ok(startKnot, 'Brace start knot should exist');
        assert.ok(endKnot, 'Brace end knot should exist');

        assert.ok(Math.abs(startKnot!.pos.x - 0) < 1e-6 && Math.abs(startKnot!.pos.z - 7) < 1e-6,
            'Start knot should keep authored brace base endpoint position');
        assert.ok(Math.abs(endKnot!.pos.x - 10) < 1e-6 && Math.abs(endKnot!.pos.z - 11) < 1e-6,
            'End knot should keep authored brace tip endpoint position');
    });

    it('should correctly convert Leaves (Type 1 Child with negligible shaft)', () => {
        // Create a Mock Leaf: Short distance between base and tip
        // We need a deep copy of MOCK_LYCHEE_DATA to fix the const assignment issue
        const MOCK_LEAF_DATA = JSON.parse(JSON.stringify(MOCK_LYCHEE_DATA));

        // Add a leaf support
        // We know s1 is at 0,0,0 -> 0,0,20
        // Let's place a leaf on s1 at z=15.
        // Tip is VERY close to base.
        const leafBase = { x: 0, y: 0, z: 15 };
        const leafTip = { x: 0.1, y: 0, z: 15 }; // 0.1mm away

        MOCK_LEAF_DATA.supports.present.byId['s5_leaf'] = {
            id: 's5_leaf',
            base: leafBase,
            tip: leafTip,
            settings: {
                tip: { length: 2.0 } // Cone is 2mm long. Distance (0.1) < 2.0 -> Leaf
            },
            parentId: ['s1']
        };

        const result = LysConverter.convert(MOCK_LEAF_DATA, createDefaultSettings());

        // Expected: 1 Leaf
        assert.strictEqual(result.leaves.length, 1, 'Should have 1 leaf');

        const leaf = result.leaves[0];
        assert.ok(leaf.contactCone, 'Leaf must have contact cone');
        assert.ok(leaf.parentKnotId, 'Leaf must have parent knot');

        // Ensure no branch was created for this ID (we have s2 as a branch from original mock)
        // Original mock has 1 branch (s2). So we should still have 1 branch.
        assert.strictEqual(result.branches.length, 1, 'Should still have 1 branch (s2)');
    });

    it('should import single-parent Lychee mini-supports as leaves and preserve shaft-like mini diameter', () => {
        const MINI_LEAF_DATA = {
            objects: {
                present: {
                    byId: {
                        o1: {
                            id: 'o1',
                            formerCenter: { x: 0, y: 0, z: 0 },
                            position: { x: 0, y: 0, z: 0 },
                            rotation: { x: 0, y: 0, z: 0 },
                            scale: { x: 1, y: 1, z: 1 },
                        }
                    }
                }
            },
            supports: {
                present: {
                    byId: {
                        s_root: {
                            id: 's_root',
                            base: { x: 0, y: 0, z: 0 },
                            tip: { x: 0, y: 0, z: 20 },
                            parentId: [],
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: {
                                tip: { diameter: 0.6, length: 3 },
                                base: { joinDiameter: 1.0 }
                            }
                        },
                        s_mini_leaf: {
                            id: 's_mini_leaf',
                            mini: true,
                            base: { x: 0, y: 0, z: 8 },
                            tip: { x: 4, y: 0, z: 10 },
                            parentId: ['s_root'],
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: {
                                base: { joinDiameter: 0.9 },
                                tip: { diameter: 0.5, pointDiameter: 0.25, length: 2.0 }
                            }
                        }
                    }
                }
            }
        };

        const result = LysConverter.convert(MINI_LEAF_DATA as any, createDefaultSettings());

        assert.strictEqual(result.leaves.length, 1, 'Mini support should import as a leaf');
        assert.strictEqual(result.branches.length, 0, 'Mini support should not import as a branch');

        const leaf = result.leaves[0];
        const knot = result.knots.find(k => k.id === leaf.parentKnotId);
        assert.ok(knot, 'Leaf parent knot should exist');

        // Shaft-like mini should stretch cone to knot distance (not clamped to tip length).
        assert.ok((leaf.contactCone.profile.lengthMm ?? 0) > 3.5,
            'Mini leaf cone length should stretch to reach integrated knot');

        assert.strictEqual(leaf.contactCone.profile.bodyDiameterMm, 0.9,
            'Shaft-like mini leaf body diameter should follow base.joinDiameter');
    });

    it('should map mini leaf diameters by endpoint role (tip side vs attached side)', () => {
        const BASE_TIP_LEAF_DATA = {
            objects: {
                present: {
                    byId: {
                        o1: {
                            id: 'o1',
                            formerCenter: { x: 0, y: 0, z: 0 },
                            position: { x: 0, y: 0, z: 0 },
                            rotation: { x: 0, y: 0, z: 0 },
                            scale: { x: 1, y: 1, z: 1 },
                        }
                    }
                }
            },
            supports: {
                present: {
                    byId: {
                        s_root: {
                            id: 's_root',
                            base: { x: 0, y: 0, z: 0 },
                            tip: { x: 0, y: 0, z: 20 },
                            parentId: [],
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: {
                                tip: { diameter: 0.6, length: 3 },
                                base: { joinDiameter: 1.0 }
                            }
                        },
                        s_mini_leaf_basetip: {
                            id: 's_mini_leaf_basetip',
                            mini: true,
                            isBaseTip: true,
                            base: { x: 0, y: 0, z: 8 },
                            tip: { x: 3, y: 0, z: 10 },
                            parentId: ['s_root'],
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: {
                                base: { joinDiameter: 1.0 },
                                tip: { diameter: 0.6, pointDiameter: 0.25, length: 2.0 },
                                baseTip: { diameter: 1.0, pointDiameter: 1.0, length: 2.4, isStraight: true }
                            }
                        }
                    }
                }
            }
        };

        const result = LysConverter.convert(BASE_TIP_LEAF_DATA as any, createDefaultSettings());
        assert.strictEqual(result.leaves.length, 1, 'Expected mini baseTip support to import as a leaf');

        const leaf = result.leaves[0];
        assert.strictEqual(leaf.contactCone.profile.contactDiameterMm, 0.25,
            'Leaf contact diameter should follow the source tip endpoint diameter');
        assert.strictEqual(leaf.contactCone.profile.bodyDiameterMm, 1.0,
            'Leaf body diameter should follow the attached endpoint (anchor) diameter');
    });

    it('should group supports per owning object and apply XY placement per object', () => {
        const MULTI_OBJECT_DATA = {
            objects: {
                present: {
                    byId: {
                        o1: {
                            id: 'o1',
                            formerCenter: { x: 0, y: 0, z: 0 },
                            position: { x: 12, y: 3, z: 0 },
                            rotation: { x: 0, y: 0, z: 0 },
                            scale: { x: 1, y: 1, z: 1 },
                        },
                        o2: {
                            id: 'o2',
                            formerCenter: { x: 0, y: 0, z: 0 },
                            position: { x: -8, y: -2, z: 0 },
                            rotation: { x: 0, y: 0, z: 0 },
                            scale: { x: 1, y: 1, z: 1 },
                        }
                    }
                }
            },
            supports: {
                present: {
                    byId: {
                        s1: {
                            id: 's1',
                            base: { x: 0, y: 0, z: 0 },
                            tip: { x: 0, y: 0, z: 15 },
                            parentId: [],
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: { tip: { length: 3 } }
                        },
                        s2: {
                            id: 's2',
                            base: { x: 0, y: 0, z: 0 },
                            tip: { x: 0, y: 0, z: 15 },
                            parentId: [],
                            objectIdTip: 'o2',
                            objectIdBase: 'o2',
                            settings: { tip: { length: 3 } }
                        }
                    }
                }
            }
        };

        const result = LysConverter.convert(MULTI_OBJECT_DATA as any, createDefaultSettings());

        assert.strictEqual(result.roots.length, 2, 'Should produce one root per object owner');

        const rootO1 = result.roots.find(r => r.modelId === 'o1');
        const rootO2 = result.roots.find(r => r.modelId === 'o2');

        assert.ok(rootO1, 'Root for object o1 should exist');
        assert.ok(rootO2, 'Root for object o2 should exist');

        assert.strictEqual(rootO1!.transform.pos.x, 12, 'o1 root should receive o1 world X placement');
        assert.strictEqual(rootO1!.transform.pos.y, 3, 'o1 root should receive o1 world Y placement');
        assert.strictEqual(rootO2!.transform.pos.x, -8, 'o2 root should receive o2 world X placement');
        assert.strictEqual(rootO2!.transform.pos.y, -2, 'o2 root should receive o2 world Y placement');
    });

    it('should prefer objectIdTip when tip/base ownership are mixed', () => {
        const MIXED_OWNERSHIP_DATA = {
            objects: {
                present: {
                    byId: {
                        o1: {
                            id: 'o1',
                            formerCenter: { x: 0, y: 0, z: 0 },
                            position: { x: 0, y: 0, z: 0 },
                            rotation: { x: 0, y: 0, z: 0 },
                            scale: { x: 1, y: 1, z: 1 },
                        },
                        o2: {
                            id: 'o2',
                            formerCenter: { x: 0, y: 0, z: 0 },
                            position: { x: 20, y: 0, z: 0 },
                            rotation: { x: 0, y: 0, z: 0 },
                            scale: { x: 1, y: 1, z: 1 },
                        }
                    }
                }
            },
            supports: {
                present: {
                    byId: {
                        s_mixed: {
                            id: 's_mixed',
                            base: { x: 0, y: 0, z: 0 },
                            tip: { x: 0, y: 0, z: 12 },
                            parentId: [],
                            objectIdTip: 'o2',
                            objectIdBase: 'o1',
                            settings: { tip: { length: 3 } }
                        }
                    }
                }
            }
        };

        const result = LysConverter.convert(MIXED_OWNERSHIP_DATA as any, createDefaultSettings());
        assert.strictEqual(result.roots.length, 1, 'Should still produce one root');
        assert.strictEqual(result.roots[0].modelId, 'o2', 'Mixed ownership should resolve to objectIdTip');
        assert.strictEqual(result.roots[0].transform.pos.x, 20, 'Result should use o2 XY placement');
    });

    it('should apply staged transform order to support generation (formerCenter + Z/rotation/scale, then XY)', () => {
        const STAGED_TRANSFORM_DATA = {
            objects: {
                present: {
                    byId: {
                        o_stage: {
                            id: 'o_stage',
                            // Intentionally conflicting to verify formerCenter is preferred.
                            center: { x: 100, y: 100, z: 100 },
                            formerCenter: { x: 0, y: 0, z: 0 },
                            position: { x: 5, y: 7, z: 2 },
                            rotation: { x: 0, y: 0, z: 90 },
                            scale: { x: 2, y: 2, z: 1 },
                        }
                    }
                }
            },
            supports: {
                present: {
                    byId: {
                        s_stage: {
                            id: 's_stage',
                            base: { x: 1, y: 0, z: 0 },
                            tip: { x: 1, y: 0, z: 12 },
                            parentId: [],
                            objectIdTip: 'o_stage',
                            objectIdBase: 'o_stage',
                            settings: { tip: { length: 3 } }
                        }
                    }
                }
            }
        };

        const result = LysConverter.convert(STAGED_TRANSFORM_DATA as any, createDefaultSettings());
        assert.strictEqual(result.roots.length, 1, 'Expected one generated root');

        const root = result.roots[0];

        // Expected order:
        // base (1,0,0) -> scale (2,0,0) -> rotate Z+90 => (0,2,0)
        // apply pre-support Z (+2) then floor clamp => z=0
        // apply Stage B XY (+5,+7) => (5,9,0)
        assert.strictEqual(root.transform.pos.x, 5, 'X should reflect post-generation world XY placement');
        assert.strictEqual(root.transform.pos.y, 9, 'Y should reflect rotated/scaled local base then world XY placement');
        assert.strictEqual(root.transform.pos.z, 0, 'Root base should remain floor anchored at z=0');
    });

    it('should import floating dual-normal parentless supports as sticks with no root/knot entities', () => {
        const STICK_ONLY_DATA = {
            objects: {
                present: {
                    byId: {
                        o22: {
                            id: 'o22',
                            formerCenter: { x: 0, y: 0, z: 0 },
                            position: { x: 4, y: -3, z: 0 },
                            rotation: { x: 0, y: 0, z: 0 },
                            scale: { x: 1, y: 1, z: 1 },
                        }
                    }
                }
            },
            supports: {
                present: {
                    byId: {
                        s28074: {
                            id: 's28074',
                            type: 1,
                            mini: false,
                            isBaseTip: true,
                            parentId: [],
                            parentBaseId: null,
                            parentTipId: null,
                            objectIdTip: 'o22',
                            objectIdBase: 'o22',
                            base: { x: -0.7796396, y: 0.140519, z: 5.5941668 },
                            tip: { x: -2.1706474, y: 4.8230286, z: 6.9173617 },
                            baseNormal: { x: -0.5277328, y: 0.6205479, z: 0.5800158 },
                            tipNormal: { x: 0.3302881, y: -0.8984873, z: -0.2891890 },
                            settings: {
                                base: { joinDiameter: 1.0 },
                                baseTip: { pointDiameter: 0.42, diameter: 1.4, length: 2.5, isStraight: true },
                                tip: { pointDiameter: 0.28, diameter: 1.0, length: 2.5 },
                            }
                        }
                    }
                }
            }
        };

        const result = LysConverter.convert(STICK_ONLY_DATA as any, createDefaultSettings());

        assert.strictEqual(result.sticks?.length ?? 0, 1, 'Expected one imported stick');
        assert.strictEqual(result.twigs?.length ?? 0, 0, 'Stick fixture should not create twigs');
        assert.strictEqual(result.roots.length, 0, 'Stick fixture should not create roots');
        assert.strictEqual(result.trunks.length, 0, 'Stick fixture should not create trunks');
        assert.strictEqual(result.branches.length, 0, 'Stick fixture should not create branches');
        assert.strictEqual(result.leaves.length, 0, 'Stick fixture should not create leaves');
        assert.strictEqual(result.braces.length, 0, 'Stick fixture should not create braces');
        assert.strictEqual(result.knots.length, 0, 'Stick fixture should not create knots');

        const stick = result.sticks![0];
        assert.ok(stick.contactConeA, 'Stick should include contact cone A');
        assert.ok(stick.contactConeB, 'Stick should include contact cone B');
        assert.strictEqual(stick.segments.length, 1, 'Stick should create one shaft segment');

        // Endpoint A maps to Lychee base/baseTip settings.
        assert.strictEqual(stick.contactConeA.profile.contactDiameterMm, 0.42,
            'Stick contact cone A should use base endpoint pointDiameter');
        assert.strictEqual(stick.contactConeA.profile.bodyDiameterMm, 1.4,
            'Stick contact cone A should use base endpoint body diameter');

        // Endpoint B maps to Lychee tip settings.
        assert.strictEqual(stick.contactConeB.profile.contactDiameterMm, 0.28,
            'Stick contact cone B should use tip endpoint pointDiameter');
        assert.strictEqual(stick.contactConeB.profile.bodyDiameterMm, 1.0,
            'Stick contact cone B should use tip endpoint body diameter');

        // Stage B XY placement should shift both endpoints by object position.x/y.
        assert.ok(Math.abs(stick.contactConeA.pos.x - (STICK_ONLY_DATA.supports.present.byId.s28074.base.x + 4)) < 1e-6,
            'Stick contact cone A X should include object XY placement');
        assert.ok(Math.abs(stick.contactConeA.pos.y - (STICK_ONLY_DATA.supports.present.byId.s28074.base.y - 3)) < 1e-6,
            'Stick contact cone A Y should include object XY placement');
    });

    it('should import short floating dual-normal parentless supports as twigs with no root/knot entities', () => {
        const TWIG_ONLY_DATA = {
            objects: {
                present: {
                    byId: {
                        o22: {
                            id: 'o22',
                            formerCenter: { x: 0, y: 0, z: 0 },
                            position: { x: -2, y: 6, z: 0 },
                            rotation: { x: 0, y: 0, z: 0 },
                            scale: { x: 1, y: 1, z: 1 },
                        }
                    }
                }
            },
            supports: {
                present: {
                    byId: {
                        s_twig: {
                            id: 's_twig',
                            type: 1,
                            mini: true,
                            isBaseTip: true,
                            parentId: [],
                            parentBaseId: null,
                            parentTipId: null,
                            objectIdTip: 'o22',
                            objectIdBase: 'o22',
                            base: { x: 1.0, y: 2.0, z: 4.0 },
                            tip: { x: 3.2, y: 2.5, z: 4.6 },
                            baseNormal: { x: 0, y: 0, z: 1 },
                            tipNormal: { x: 0, y: 0, z: 1 },
                            settings: {
                                baseTip: { pointDiameter: 0.2, diameter: 0.6, length: 1.6, isStraight: true },
                                tip: { pointDiameter: 0.24, diameter: 0.7, length: 1.6 },
                            }
                        }
                    }
                }
            }
        };

        const result = LysConverter.convert(TWIG_ONLY_DATA as any, createDefaultSettings());

        assert.strictEqual(result.twigs?.length ?? 0, 1, 'Expected one imported twig');
        assert.strictEqual(result.sticks?.length ?? 0, 0, 'Twig fixture should not create sticks');
        assert.strictEqual(result.roots.length, 0, 'Twig fixture should not create roots');
        assert.strictEqual(result.trunks.length, 0, 'Twig fixture should not create trunks');
        assert.strictEqual(result.branches.length, 0, 'Twig fixture should not create branches');
        assert.strictEqual(result.leaves.length, 0, 'Twig fixture should not create leaves');
        assert.strictEqual(result.braces.length, 0, 'Twig fixture should not create braces');
        assert.strictEqual(result.knots.length, 0, 'Twig fixture should not create knots');

        const twig = result.twigs![0];
        assert.ok(twig.contactDiskA, 'Twig should include contact disk A');
        assert.ok(twig.contactDiskB, 'Twig should include contact disk B');
        assert.strictEqual(twig.segments.length, 1, 'Twig should create one shaft segment');

        assert.strictEqual(twig.contactDiskA.contactDiameterMm, 0.2,
            'Twig contact disk A should use base endpoint pointDiameter');
        assert.strictEqual(twig.contactDiskB.contactDiameterMm, 0.24,
            'Twig contact disk B should use tip endpoint pointDiameter');

        assert.ok(Math.abs(twig.contactDiskA.pos.x - (TWIG_ONLY_DATA.supports.present.byId.s_twig.base.x - 2)) < 1e-6,
            'Twig contact disk A X should include object XY placement');
        assert.ok(Math.abs(twig.contactDiskA.pos.y - (TWIG_ONLY_DATA.supports.present.byId.s_twig.base.y + 6)) < 1e-6,
            'Twig contact disk A Y should include object XY placement');
    });

    it('should transform Lychee tip normals by object rotation before solving socket axis', () => {
        const NORMAL_ROTATION_DATA = {
            objects: {
                present: {
                    byId: {
                        o_norm: {
                            id: 'o_norm',
                            formerCenter: { x: 0, y: 0, z: 0 },
                            position: { x: 0, y: 0, z: 0 },
                            rotation: { x: 90, y: 0, z: 0 },
                            scale: { x: 1, y: 1, z: 1 },
                        }
                    }
                }
            },
            supports: {
                present: {
                    byId: {
                        s_norm: {
                            id: 's_norm',
                            base: { x: 0, y: 0, z: 0 },
                            tip: { x: 0, y: 0, z: 10 },
                            tipNormal: { x: 0, y: 0, z: 1 },
                            parentId: [],
                            objectIdTip: 'o_norm',
                            objectIdBase: 'o_norm',
                            settings: { tip: { length: 3 } }
                        }
                    }
                }
            }
        };

        const result = LysConverter.convert(NORMAL_ROTATION_DATA as any, createDefaultSettings());
        assert.strictEqual(result.trunks.length, 1, 'Expected one generated trunk');

        const cone = result.trunks[0].contactCone;
        assert.ok(cone, 'Generated trunk should include a contact cone');

        // With a +90° X rotation, local +Z tip normal should align to world -Y.
        // The solver may flip sign to point toward the shaft start, so we expect +Y.
        assert.ok(cone.normal.y > 0.9, 'Cone axis should align to transformed tip normal direction (toward +Y)');
        assert.ok(Math.abs(cone.normal.z) < 0.2, 'Cone axis should no longer remain near raw +Z after rotation');
    });
});
