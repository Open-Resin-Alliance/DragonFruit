#!/usr/bin/env npx tsx
/**
 * DragonFruit TS CLI — headless scene & support operations.
 *
 * Works at the VOXL file level (.voxl) — the same interchange format the GUI
 * uses. Reads/writes VoxlDocumentV1 JSON, so the CLI and GUI share the same
 * state format. No THREE.js or React dependencies.
 *
 * Usage:
 *   npx tsx scripts/dragonfruit-ts-cli.ts scene create -o scene.voxl
 *   npx tsx scripts/dragonfruit-ts-cli.ts scene add-model scene.voxl --mesh cube.stl --name Cube
 *   npx tsx scripts/dragonfruit-ts-cli.ts scene list-models scene.voxl --json
 *   npx tsx scripts/dragonfruit-ts-cli.ts support add-trunk scene.voxl --model-id m1 --position 10,20,0
 *   npx tsx scripts/dragonfruit-ts-cli.ts support list scene.voxl --json
 */

import { readFileSync, writeFileSync, statSync } from 'fs';
import { basename, resolve, dirname } from 'path';
import { execSync } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import {
  parseVoxlAuto,
  parseVoxlDocument,
  serializeVoxlDocument,
  buildVoxlDocumentV1,
} from '../src/features/scene/voxl/codec';
import type {
  VoxlDocumentV1,
  VoxlModelEntry,
  VoxlModelRuntimeLike,
} from '../src/features/scene/voxl/types';
import type {
  DragonfruitImportFormat,
  Roots,
  Trunk,
  Branch,
  Leaf,
  Brace,
  Knot,
  Vec3,
  SupportEntity,
} from '../src/supports/types';

// ---------------------------------------------------------------------------
// VOXL File I/O
// ---------------------------------------------------------------------------

function loadVoxl(path: string): VoxlDocumentV1 {
  const raw = readFileSync(path);
  const result = parseVoxlAuto(raw);
  return result.document;
}

function saveVoxl(path: string, doc: VoxlDocumentV1): void {
  const json = serializeVoxlDocument(doc, true, { compression: 'auto' });
  writeFileSync(path, json, 'utf-8');
}

function createEmptyDoc(): VoxlDocumentV1 {
  const emptySupports: DragonfruitImportFormat = {
    version: 1,
    meta: { source: 'dragonfruit-ts-cli', objectCenter: { x: 0, y: 0, z: 0 } },
    roots: [],
    trunks: [],
    branches: [],
    leaves: [],
    braces: [],
    knots: [],
  };

  return buildVoxlDocumentV1({
    models: [],
    activeModelId: null,
    selectedModelIds: [],
    supports: emptySupports,
    meta: { generator: 'dragonfruit-ts-cli' },
  });
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function parseVec3(s: string): Vec3 {
  const parts = s.split(',').map((p) => parseFloat(p.trim()));
  if (parts.length !== 3 || parts.some(isNaN)) {
    throw new Error(`Expected x,y,z got '${s}'`);
  }
  return { x: parts[0], y: parts[1], z: parts[2] };
}

function parseArgs(argv: string[]): { command: string; subcommand: string; positional: string[]; flags: Record<string, string | boolean> } {
  const command = argv[0] ?? '';
  const subcommand = argv[1] ?? '';
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i += 1;
      }
    } else {
      positional.push(arg);
      i += 1;
    }
  }

  return { command, subcommand, positional, flags };
}

function requireFlag(flags: Record<string, string | boolean>, key: string): string {
  const val = flags[key];
  if (val === undefined || val === true) {
    throw new Error(`Missing required flag: --${key}`);
  }
  return val as string;
}

function optionalFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const val = flags[key];
  if (val === true || val === undefined) return undefined;
  return val as string;
}

function jsonOutput(flags: Record<string, string | boolean>): boolean {
  return flags['json'] === true;
}

// ---------------------------------------------------------------------------
// Scene commands
// ---------------------------------------------------------------------------

function sceneCreate(args: ReturnType<typeof parseArgs>): void {
  const output = requireFlag(args.flags, 'o');
  const doc = createEmptyDoc();
  saveVoxl(output, doc);
  if (jsonOutput(args.flags)) {
    console.log(JSON.stringify({ created: output }, null, 2));
  } else {
    console.error(`scene create: ${output}`);
  }
}

function sceneAddModel(args: ReturnType<typeof parseArgs>): void {
  const voxlPath = args.positional[0];
  if (!voxlPath) throw new Error('Usage: scene add-model <scene.voxl> --mesh <path>');

  const doc = loadVoxl(voxlPath);
  const meshPath = requireFlag(args.flags, 'mesh');
  const name = optionalFlag(args.flags, 'name') ?? basename(meshPath, '.stl');
  const posStr = optionalFlag(args.flags, 'position');
  const rotStr = optionalFlag(args.flags, 'rotate');
  const scaleStr = optionalFlag(args.flags, 'scale');

  const position = posStr ? parseVec3(posStr) : { x: 0, y: 0, z: 0 };
  const rotation = rotStr ? parseVec3(rotStr) : { x: 0, y: 0, z: 0 };
  const scale = scaleStr ? parseVec3(scaleStr) : { x: 1, y: 1, z: 1 };

  let fileSizeBytes: number | undefined;
  try { fileSizeBytes = statSync(meshPath).size; } catch { /* ignore */ }

  const model: VoxlModelEntry = {
    id: uuidv4(),
    name,
    visible: true,
    color: '#a3a3a3',
    polygonCount: 0,
    fileSizeBytes,
    transform: { position, rotation, scale },
    mesh: { mode: 'external-file', fileName: basename(meshPath) },
  };

  doc.models.push(model);
  doc.scene.activeModelId = model.id;
  saveVoxl(voxlPath, doc);

  if (jsonOutput(args.flags)) {
    console.log(JSON.stringify(model, null, 2));
  } else {
    console.error(`add-model: '${name}' id=${model.id}`);
  }
}

function sceneRemoveModel(args: ReturnType<typeof parseArgs>): void {
  const voxlPath = args.positional[0];
  if (!voxlPath) throw new Error('Usage: scene remove-model <scene.voxl> --id <id>');

  const doc = loadVoxl(voxlPath);
  const id = requireFlag(args.flags, 'id');

  const before = doc.models.length;
  doc.models = doc.models.filter((m) => m.id !== id);

  // Clean supports referencing this model
  const s = doc.supports;
  s.roots = s.roots.filter((r) => r.modelId !== id);
  s.trunks = s.trunks.filter((t) => t.modelId !== id);
  s.branches = s.branches.filter((b) => b.modelId !== id);
  s.leaves = s.leaves.filter((l) => l.modelId !== id);
  s.braces = s.braces.filter((b) => b.modelId !== id);

  if (doc.scene.activeModelId === id) doc.scene.activeModelId = null;
  doc.scene.selectedModelIds = doc.scene.selectedModelIds.filter((sid) => sid !== id);

  saveVoxl(voxlPath, doc);

  if (jsonOutput(args.flags)) {
    console.log(JSON.stringify({ removed: id, models_before: before, models_after: doc.models.length }, null, 2));
  } else {
    console.error(`remove-model: ${id}`);
  }
}

function sceneListModels(args: ReturnType<typeof parseArgs>): void {
  const voxlPath = args.positional[0];
  if (!voxlPath) throw new Error('Usage: scene list-models <scene.voxl>');

  const doc = loadVoxl(voxlPath);

  if (jsonOutput(args.flags)) {
    console.log(JSON.stringify({
      count: doc.models.length,
      activeModelId: doc.scene.activeModelId,
      models: doc.models.map((m) => ({
        id: m.id,
        name: m.name,
        visible: m.visible,
        mesh: m.mesh.fileName ?? m.mesh.mode,
        transform: m.transform,
      })),
    }, null, 2));
  } else {
    console.error(`${doc.models.length} models:`);
    for (const m of doc.models) {
      const p = m.transform.position;
      console.error(`  ${m.id} '${m.name}' pos=(${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)})`);
    }
  }
}

function sceneTransformModel(args: ReturnType<typeof parseArgs>): void {
  const voxlPath = args.positional[0];
  if (!voxlPath) throw new Error('Usage: scene transform-model <scene.voxl> --id <id>');

  const doc = loadVoxl(voxlPath);
  const id = requireFlag(args.flags, 'id');
  const model = doc.models.find((m) => m.id === id);
  if (!model) throw new Error(`Model '${id}' not found`);

  const posStr = optionalFlag(args.flags, 'position');
  const rotStr = optionalFlag(args.flags, 'rotate');
  const scaleStr = optionalFlag(args.flags, 'scale');

  if (posStr) model.transform.position = parseVec3(posStr);
  if (rotStr) model.transform.rotation = parseVec3(rotStr);
  if (scaleStr) model.transform.scale = parseVec3(scaleStr);

  saveVoxl(voxlPath, doc);

  if (jsonOutput(args.flags)) {
    console.log(JSON.stringify({ id, transform: model.transform }, null, 2));
  } else {
    console.error(`transform-model: ${id}`);
  }
}

function sceneDuplicate(args: ReturnType<typeof parseArgs>): void {
  const voxlPath = args.positional[0];
  if (!voxlPath) throw new Error('Usage: scene duplicate <scene.voxl> --id <id>');

  const doc = loadVoxl(voxlPath);
  const id = requireFlag(args.flags, 'id');
  const count = parseInt(optionalFlag(args.flags, 'count') ?? '1', 10);
  const offsetStr = optionalFlag(args.flags, 'offset') ?? '20,0,0';
  const offset = parseVec3(offsetStr);

  const source = doc.models.find((m) => m.id === id);
  if (!source) throw new Error(`Model '${id}' not found`);

  const newIds: string[] = [];
  for (let i = 1; i <= count; i++) {
    const copy: VoxlModelEntry = JSON.parse(JSON.stringify(source));
    copy.id = uuidv4();
    copy.name = `${source.name} (${i})`;
    copy.transform.position.x += offset.x * i;
    copy.transform.position.y += offset.y * i;
    copy.transform.position.z += offset.z * i;
    doc.models.push(copy);
    newIds.push(copy.id);
  }

  saveVoxl(voxlPath, doc);

  if (jsonOutput(args.flags)) {
    console.log(JSON.stringify({ duplicated: newIds }, null, 2));
  } else {
    console.error(`duplicate: ${id} x${count} -> ${newIds.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// Support commands — manipulates DragonfruitImportFormat inside VOXL
// ---------------------------------------------------------------------------

function supportAddTrunk(args: ReturnType<typeof parseArgs>): void {
  const voxlPath = args.positional[0];
  if (!voxlPath) throw new Error('Usage: support add-trunk <scene.voxl> --model-id <id> --position x,y,z');

  const doc = loadVoxl(voxlPath);
  const modelId = requireFlag(args.flags, 'model-id');
  const posStr = requireFlag(args.flags, 'position');
  const pos = parseVec3(posStr);
  const diameter = parseFloat(optionalFlag(args.flags, 'diameter') ?? '2.0');

  const rootId = uuidv4();
  const trunkId = uuidv4();
  const segmentId = uuidv4();

  const root: Roots = {
    id: rootId,
    modelId,
    transform: { pos, rot: { x: 0, y: 0, z: 0, w: 1 } },
    diameter,
    diskHeight: 0.3,
    coneHeight: 1.0,
  };

  const trunk: Trunk = {
    id: trunkId,
    modelId,
    rootId,
    segments: [{
      id: segmentId,
      diameter,
      topJoint: undefined,
      bottomJoint: undefined,
    }],
  };

  doc.supports.roots.push(root);
  doc.supports.trunks.push(trunk);
  saveVoxl(voxlPath, doc);

  if (jsonOutput(args.flags)) {
    console.log(JSON.stringify({ trunk_id: trunkId, root_id: rootId, position: pos }, null, 2));
  } else {
    console.error(`add-trunk: ${trunkId} at (${pos.x},${pos.y},${pos.z})`);
  }
}

function supportAddBranch(args: ReturnType<typeof parseArgs>): void {
  const voxlPath = args.positional[0];
  if (!voxlPath) throw new Error('Usage: support add-branch <scene.voxl> --model-id <id> --parent-knot-id <id>');

  const doc = loadVoxl(voxlPath);
  const modelId = requireFlag(args.flags, 'model-id');
  const parentKnotId = requireFlag(args.flags, 'parent-knot-id');
  const diameter = parseFloat(optionalFlag(args.flags, 'diameter') ?? '1.0');

  const branchId = uuidv4();
  const segmentId = uuidv4();

  const branch: Branch = {
    id: branchId,
    modelId,
    parentKnotId,
    segments: [{
      id: segmentId,
      diameter,
      topJoint: undefined,
      bottomJoint: undefined,
    }],
  };

  doc.supports.branches.push(branch);
  saveVoxl(voxlPath, doc);

  if (jsonOutput(args.flags)) {
    console.log(JSON.stringify({ branch_id: branchId }, null, 2));
  } else {
    console.error(`add-branch: ${branchId} on knot ${parentKnotId}`);
  }
}

function supportAddLeaf(args: ReturnType<typeof parseArgs>): void {
  const voxlPath = args.positional[0];
  if (!voxlPath) throw new Error('Usage: support add-leaf <scene.voxl> --model-id <id> --parent-knot-id <id> --contact x,y,z --normal x,y,z');

  const doc = loadVoxl(voxlPath);
  const modelId = requireFlag(args.flags, 'model-id');
  const parentKnotId = requireFlag(args.flags, 'parent-knot-id');
  const contact = parseVec3(requireFlag(args.flags, 'contact'));
  const normal = parseVec3(optionalFlag(args.flags, 'normal') ?? '0,0,-1');
  const tipDiameter = parseFloat(optionalFlag(args.flags, 'tip-diameter') ?? '0.3');

  const leafId = uuidv4();
  const leaf: Leaf = {
    id: leafId,
    modelId,
    parentKnotId,
    contactCone: {
      pos: contact,
      normal,
      tipDiameterMm: tipDiameter,
      bodyDiameterMm: tipDiameter + 0.5,
      contactLengthMm: 0.3,
      bodyLengthMm: 1.0,
    } as any,
  };

  doc.supports.leaves.push(leaf);
  saveVoxl(voxlPath, doc);

  if (jsonOutput(args.flags)) {
    console.log(JSON.stringify({ leaf_id: leafId }, null, 2));
  } else {
    console.error(`add-leaf: ${leafId}`);
  }
}

function supportAddBrace(args: ReturnType<typeof parseArgs>): void {
  const voxlPath = args.positional[0];
  if (!voxlPath) throw new Error('Usage: support add-brace <scene.voxl> --model-id <id> --start-knot <id> --end-knot <id>');

  const doc = loadVoxl(voxlPath);
  const modelId = requireFlag(args.flags, 'model-id');
  const startKnotId = requireFlag(args.flags, 'start-knot');
  const endKnotId = requireFlag(args.flags, 'end-knot');
  const diameter = parseFloat(optionalFlag(args.flags, 'diameter') ?? '0.5');

  const braceId = uuidv4();
  const brace: Brace = {
    id: braceId,
    modelId,
    startKnotId,
    endKnotId,
    profile: { diameter },
  };

  doc.supports.braces.push(brace);
  saveVoxl(voxlPath, doc);

  if (jsonOutput(args.flags)) {
    console.log(JSON.stringify({ brace_id: braceId }, null, 2));
  } else {
    console.error(`add-brace: ${braceId} (${startKnotId} <-> ${endKnotId})`);
  }
}

function supportAddKnot(args: ReturnType<typeof parseArgs>): void {
  const voxlPath = args.positional[0];
  if (!voxlPath) throw new Error('Usage: support add-knot <scene.voxl> --parent-shaft-id <id> --position x,y,z');

  const doc = loadVoxl(voxlPath);
  const parentShaftId = requireFlag(args.flags, 'parent-shaft-id');
  const pos = parseVec3(requireFlag(args.flags, 'position'));
  const t = parseFloat(optionalFlag(args.flags, 't') ?? '0.5');

  const knotId = uuidv4();
  const knot: Knot = {
    id: knotId,
    parentShaftId,
    t,
    pos,
  };

  doc.supports.knots.push(knot);
  saveVoxl(voxlPath, doc);

  if (jsonOutput(args.flags)) {
    console.log(JSON.stringify({ knot_id: knotId }, null, 2));
  } else {
    console.error(`add-knot: ${knotId} on shaft ${parentShaftId} at t=${t}`);
  }
}

function supportRemove(args: ReturnType<typeof parseArgs>): void {
  const voxlPath = args.positional[0];
  if (!voxlPath) throw new Error('Usage: support remove <scene.voxl> --id <id>');

  const doc = loadVoxl(voxlPath);
  const id = requireFlag(args.flags, 'id');
  const s = doc.supports;

  // Cascading remove — mirrors state.ts removeTrunk/removeBranch logic
  const cascadeRemoveByShaftIds = (shaftIds: string[]) => {
    // Collect knots on these shafts
    const knotIds = s.knots.filter((k) => shaftIds.includes(k.parentShaftId)).map((k) => k.id);
    s.knots = s.knots.filter((k) => !shaftIds.includes(k.parentShaftId));
    // Collect branches hanging off those knots, then recurse
    const branchIds = s.branches.filter((b) => knotIds.includes(b.parentKnotId)).map((b) => b.id);
    s.branches = s.branches.filter((b) => !knotIds.includes(b.parentKnotId));
    s.leaves = s.leaves.filter((l) => !knotIds.includes(l.parentKnotId));
    s.braces = s.braces.filter((b) => !knotIds.includes(b.startKnotId) && !knotIds.includes(b.endKnotId));
    if (s.kickstands) s.kickstands = s.kickstands.filter((k: any) => !knotIds.includes(k.hostKnot?.id));
    // Recurse: branches are shafts too
    if (branchIds.length > 0) cascadeRemoveByShaftIds(branchIds);
  };

  const removedRoot = s.roots.find((r) => r.id === id);
  const removedTrunk = !removedRoot ? s.trunks.find((t) => t.id === id) : undefined;
  const removedBranch = !removedRoot && !removedTrunk ? s.branches.find((b) => b.id === id) : undefined;

  if (removedRoot) {
    const trunkIds = s.trunks.filter((t) => t.rootId === id).map((t) => t.id);
    s.roots = s.roots.filter((r) => r.id !== id);
    s.trunks = s.trunks.filter((t) => t.rootId !== id);
    cascadeRemoveByShaftIds(trunkIds);
  } else if (removedTrunk) {
    s.trunks = s.trunks.filter((t) => t.id !== id);
    // Also remove the root that owns this trunk
    s.roots = s.roots.filter((r) => r.id !== removedTrunk.rootId);
    cascadeRemoveByShaftIds([id]);
  } else if (removedBranch) {
    s.branches = s.branches.filter((b) => b.id !== id);
    cascadeRemoveByShaftIds([id]);
  } else {
    // Simple remove for leaf, brace, knot, kickstand
    s.leaves = s.leaves.filter((l) => l.id !== id);
    s.braces = s.braces.filter((b) => b.id !== id);
    s.knots = s.knots.filter((k) => k.id !== id);
    if (s.kickstands) s.kickstands = s.kickstands.filter((k: any) =>
      (k.kickstand?.id ?? k.id) !== id);
  }

  saveVoxl(voxlPath, doc);

  if (jsonOutput(args.flags)) {
    console.log(JSON.stringify({ removed: id }, null, 2));
  } else {
    console.error(`remove: ${id}`);
  }
}

function supportList(args: ReturnType<typeof parseArgs>): void {
  const voxlPath = args.positional[0];
  if (!voxlPath) throw new Error('Usage: support list <scene.voxl>');

  const doc = loadVoxl(voxlPath);
  const s = doc.supports;

  if (jsonOutput(args.flags)) {
    console.log(JSON.stringify({
      roots: s.roots.length,
      trunks: s.trunks.length,
      branches: s.branches.length,
      leaves: s.leaves.length,
      braces: s.braces.length,
      knots: s.knots.length,
      kickstands: s.kickstands?.length ?? 0,
      supports: s,
    }, null, 2));
  } else {
    const total = s.roots.length + s.trunks.length + s.branches.length +
      s.leaves.length + s.braces.length + s.knots.length + (s.kickstands?.length ?? 0);
    console.error(`${total} support elements:`);
    console.error(`  ${s.roots.length} roots, ${s.trunks.length} trunks, ${s.branches.length} branches`);
    console.error(`  ${s.leaves.length} leaves, ${s.braces.length} braces, ${s.knots.length} knots`);
    if (s.kickstands?.length) console.error(`  ${s.kickstands.length} kickstands`);
  }
}

// ---------------------------------------------------------------------------
// Scene load/save (raw VOXL dump)
// ---------------------------------------------------------------------------

function sceneLoad(args: ReturnType<typeof parseArgs>): void {
  const voxlPath = args.positional[0];
  if (!voxlPath) throw new Error('Usage: scene load <scene.voxl>');

  const doc = loadVoxl(voxlPath);

  if (jsonOutput(args.flags)) {
    console.log(JSON.stringify(doc, null, 2));
  } else {
    console.error(`scene: ${doc.models.length} models, generator=${doc.meta.generator}`);
    console.error(`  created: ${doc.meta.createdAt}`);
    const s = doc.supports;
    const total = s.roots.length + s.trunks.length + s.branches.length +
      s.leaves.length + s.braces.length + s.knots.length;
    console.error(`  supports: ${total} elements`);
  }
}

// ---------------------------------------------------------------------------
// Support update — patch fields on any support element by ID
// ---------------------------------------------------------------------------

function supportUpdate(args: ReturnType<typeof parseArgs>): void {
  const voxlPath = args.positional[0];
  if (!voxlPath) throw new Error('Usage: support update <scene.voxl> --id <id> [--diameter N] [--position x,y,z] [--tip-diameter N]');

  const doc = loadVoxl(voxlPath);
  const id = requireFlag(args.flags, 'id');
  const s = doc.supports;
  let found = false;

  const diameterStr = optionalFlag(args.flags, 'diameter');
  const positionStr = optionalFlag(args.flags, 'position');
  const tipDiameterStr = optionalFlag(args.flags, 'tip-diameter');
  const heightStr = optionalFlag(args.flags, 'height');

  // Search across all collections
  for (const root of s.roots) {
    if (root.id === id) {
      if (diameterStr) root.diameter = parseFloat(diameterStr);
      if (positionStr) root.transform.pos = parseVec3(positionStr);
      found = true; break;
    }
  }
  if (!found) for (const trunk of s.trunks) {
    if (trunk.id === id) {
      if (diameterStr && trunk.segments.length > 0) trunk.segments[0].diameter = parseFloat(diameterStr);
      found = true; break;
    }
  }
  if (!found) for (const branch of s.branches) {
    if (branch.id === id) {
      if (diameterStr && branch.segments.length > 0) branch.segments[0].diameter = parseFloat(diameterStr);
      found = true; break;
    }
  }
  if (!found) for (const leaf of s.leaves) {
    if (leaf.id === id) {
      if (tipDiameterStr && leaf.contactCone) (leaf.contactCone as any).tipDiameterMm = parseFloat(tipDiameterStr);
      found = true; break;
    }
  }
  if (!found) for (const brace of s.braces) {
    if (brace.id === id) {
      if (diameterStr) brace.profile.diameter = parseFloat(diameterStr);
      found = true; break;
    }
  }
  if (!found) for (const knot of s.knots) {
    if (knot.id === id) {
      if (positionStr) knot.pos = parseVec3(positionStr);
      found = true; break;
    }
  }
  if (!found) for (const k of s.kickstands ?? []) {
    if ((k as any).kickstand?.id === id || (k as any).id === id) {
      found = true; break;
    }
  }

  if (!found) throw new Error(`Support element '${id}' not found`);

  saveVoxl(voxlPath, doc);
  if (jsonOutput(args.flags)) {
    console.log(JSON.stringify({ updated: id }, null, 2));
  } else {
    console.error(`update: ${id}`);
  }
}

// ---------------------------------------------------------------------------
// Scene group / ungroup — stored in VOXL extensions
// ---------------------------------------------------------------------------

type VoxlGroup = { id: string; name: string; modelIds: string[] };

function getGroups(doc: VoxlDocumentV1): VoxlGroup[] {
  return ((doc.extensions as any)?.groups as VoxlGroup[]) ?? [];
}

function setGroups(doc: VoxlDocumentV1, groups: VoxlGroup[]): void {
  if (!doc.extensions) doc.extensions = {};
  (doc.extensions as any).groups = groups;
}

function sceneGroup(args: ReturnType<typeof parseArgs>): void {
  const voxlPath = args.positional[0];
  if (!voxlPath) throw new Error('Usage: scene group <scene.voxl> --ids id1,id2 [--name "Group"]');

  const doc = loadVoxl(voxlPath);
  const idsStr = requireFlag(args.flags, 'ids');
  const modelIds = idsStr.split(',').map((s) => s.trim());
  const name = optionalFlag(args.flags, 'name') ?? 'Group';
  const groupId = uuidv4();

  const groups = getGroups(doc);
  groups.push({ id: groupId, name, modelIds });
  setGroups(doc, groups);
  saveVoxl(voxlPath, doc);

  if (jsonOutput(args.flags)) {
    console.log(JSON.stringify({ group_id: groupId, name, modelIds }, null, 2));
  } else {
    console.error(`group: ${groupId} '${name}' with ${modelIds.length} models`);
  }
}

function sceneUngroup(args: ReturnType<typeof parseArgs>): void {
  const voxlPath = args.positional[0];
  if (!voxlPath) throw new Error('Usage: scene ungroup <scene.voxl> --group-id <id>');

  const doc = loadVoxl(voxlPath);
  const groupId = requireFlag(args.flags, 'group-id');
  const groups = getGroups(doc).filter((g) => g.id !== groupId);
  setGroups(doc, groups);
  saveVoxl(voxlPath, doc);

  if (jsonOutput(args.flags)) {
    console.log(JSON.stringify({ ungrouped: groupId }, null, 2));
  } else {
    console.error(`ungroup: ${groupId}`);
  }
}

function sceneListGroups(args: ReturnType<typeof parseArgs>): void {
  const voxlPath = args.positional[0];
  if (!voxlPath) throw new Error('Usage: scene list-groups <scene.voxl>');

  const doc = loadVoxl(voxlPath);
  const groups = getGroups(doc);

  if (jsonOutput(args.flags)) {
    console.log(JSON.stringify({ groups }, null, 2));
  } else {
    console.error(`${groups.length} groups:`);
    for (const g of groups) {
      console.error(`  ${g.id} '${g.name}' [${g.modelIds.join(', ')}]`);
    }
  }
}

// ---------------------------------------------------------------------------
// Scene center-xy — wraps useModelTransform.ts centerXY logic
// ---------------------------------------------------------------------------

function sceneCenterXY(args: ReturnType<typeof parseArgs>): void {
  const voxlPath = args.positional[0];
  if (!voxlPath) throw new Error('Usage: scene center-xy <scene.voxl> --id <model-id>');

  const doc = loadVoxl(voxlPath);
  const id = requireFlag(args.flags, 'id');
  const model = doc.models.find((m) => m.id === id);
  if (!model) throw new Error(`Model '${id}' not found`);

  const oldX = model.transform.position.x;
  const oldY = model.transform.position.y;
  model.transform.position.x = 0;
  model.transform.position.y = 0;

  saveVoxl(voxlPath, doc);

  if (jsonOutput(args.flags)) {
    console.log(JSON.stringify({
      id,
      position: model.transform.position,
      moved: { dx: -oldX, dy: -oldY },
    }, null, 2));
  } else {
    console.error(`center-xy: ${id} (${oldX.toFixed(1)},${oldY.toFixed(1)}) -> (0, 0)`);
  }
}

// ---------------------------------------------------------------------------
// Support straighten-segment — bezier→straight (wraps toggleSegmentCurve logic)
// ---------------------------------------------------------------------------

function supportStraightenSegment(args: ReturnType<typeof parseArgs>): void {
  const voxlPath = args.positional[0];
  if (!voxlPath) throw new Error('Usage: support straighten-segment <scene.voxl> --id <segment-id>');

  const doc = loadVoxl(voxlPath);
  const segId = requireFlag(args.flags, 'id');
  const s = doc.supports;
  let found = false;

  const straighten = (segments: any[]) => {
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].id === segId) {
        // Remove bezier fields, set to straight
        delete segments[i].type;
        delete segments[i].controlPoint1;
        delete segments[i].controlPoint2;
        delete segments[i].startTangent;
        delete segments[i].endTangent;
        delete segments[i].tension;
        delete segments[i].bias;
        delete segments[i].resolution;
        found = true;
        return;
      }
    }
  };

  for (const trunk of s.trunks) straighten(trunk.segments);
  if (!found) for (const branch of s.branches) straighten(branch.segments);
  if (!found) for (const twig of s.twigs ?? []) straighten((twig as any).segments ?? []);
  if (!found) for (const stick of s.sticks ?? []) straighten((stick as any).segments ?? []);

  if (!found) throw new Error(`Segment '${segId}' not found`);

  saveVoxl(voxlPath, doc);
  if (jsonOutput(args.flags)) {
    console.log(JSON.stringify({ straightened: segId }, null, 2));
  } else {
    console.error(`straighten-segment: ${segId}`);
  }
}

// ---------------------------------------------------------------------------
// Support add-twig — model-to-model contact via disks
// ---------------------------------------------------------------------------

function supportAddTwig(args: ReturnType<typeof parseArgs>): void {
  const voxlPath = args.positional[0];
  if (!voxlPath) throw new Error('Usage: support add-twig <scene.voxl> --model-id <id> --contact-a x,y,z --contact-b x,y,z');

  const doc = loadVoxl(voxlPath);
  const modelId = requireFlag(args.flags, 'model-id');
  const contactA = parseVec3(requireFlag(args.flags, 'contact-a'));
  const contactB = parseVec3(requireFlag(args.flags, 'contact-b'));
  const diameter = parseFloat(optionalFlag(args.flags, 'diameter') ?? '0.5');

  const twigId = uuidv4();
  const twig = {
    id: twigId,
    modelId,
    segments: [{ id: uuidv4(), diameter }],
    contactDiskA: {
      id: uuidv4(), pos: contactA,
      surfaceNormal: { x: 0, y: 0, z: -1 }, coneAxis: { x: 0, y: 0, z: 1 },
      profile: { type: 'default' }, contactDiameterMm: diameter,
    },
    contactDiskB: {
      id: uuidv4(), pos: contactB,
      surfaceNormal: { x: 0, y: 0, z: -1 }, coneAxis: { x: 0, y: 0, z: 1 },
      profile: { type: 'default' }, contactDiameterMm: diameter,
    },
  };

  if (!doc.supports.twigs) (doc.supports as any).twigs = [];
  (doc.supports as any).twigs.push(twig);
  saveVoxl(voxlPath, doc);

  if (jsonOutput(args.flags)) {
    console.log(JSON.stringify({ twig_id: twigId }, null, 2));
  } else {
    console.error(`add-twig: ${twigId}`);
  }
}

// ---------------------------------------------------------------------------
// Support add-stick — model-to-model contact via cones
// ---------------------------------------------------------------------------

function supportAddStick(args: ReturnType<typeof parseArgs>): void {
  const voxlPath = args.positional[0];
  if (!voxlPath) throw new Error('Usage: support add-stick <scene.voxl> --model-id <id> --contact-a x,y,z --contact-b x,y,z');

  const doc = loadVoxl(voxlPath);
  const modelId = requireFlag(args.flags, 'model-id');
  const contactA = parseVec3(requireFlag(args.flags, 'contact-a'));
  const contactB = parseVec3(requireFlag(args.flags, 'contact-b'));
  const diameter = parseFloat(optionalFlag(args.flags, 'diameter') ?? '0.5');
  const tipDiameter = parseFloat(optionalFlag(args.flags, 'tip-diameter') ?? '0.3');

  const stickId = uuidv4();
  const makeCone = (pos: Vec3) => ({
    pos, normal: { x: 0, y: 0, z: -1 },
    tipDiameterMm: tipDiameter, bodyDiameterMm: diameter,
    contactLengthMm: 0.3, bodyLengthMm: 1.0,
  });

  const stick = {
    id: stickId,
    modelId,
    segments: [{ id: uuidv4(), diameter }],
    contactConeA: makeCone(contactA),
    contactConeB: makeCone(contactB),
  };

  if (!doc.supports.sticks) (doc.supports as any).sticks = [];
  (doc.supports as any).sticks.push(stick);
  saveVoxl(voxlPath, doc);

  if (jsonOutput(args.flags)) {
    console.log(JSON.stringify({ stick_id: stickId }, null, 2));
  } else {
    console.error(`add-stick: ${stickId}`);
  }
}

// ---------------------------------------------------------------------------
// Support add-kickstand / remove-kickstand
// ---------------------------------------------------------------------------

function supportAddKickstand(args: ReturnType<typeof parseArgs>): void {
  const voxlPath = args.positional[0];
  if (!voxlPath) throw new Error('Usage: support add-kickstand <scene.voxl> --model-id <id> --base x,y,z --host-knot-id <id> --host-segment-id <id>');

  const doc = loadVoxl(voxlPath);
  const modelId = requireFlag(args.flags, 'model-id');
  const basePos = parseVec3(requireFlag(args.flags, 'base'));
  const hostKnotId = requireFlag(args.flags, 'host-knot-id');
  const hostSegmentId = requireFlag(args.flags, 'host-segment-id');
  const diameter = parseFloat(optionalFlag(args.flags, 'diameter') ?? '1.5');

  const rootId = uuidv4();
  const kickstandId = uuidv4();

  const root = {
    id: rootId, modelId,
    transform: { pos: basePos, rot: { x: 0, y: 0, z: 0, w: 1 } },
    diameter, diskHeight: 0.3, coneHeight: 1.0,
  };

  const hostKnot = {
    id: hostKnotId,
    parentShaftId: hostSegmentId,
    pos: basePos, // placeholder — real position computed by GUI
  };

  const kickstand = {
    root, hostKnot,
    kickstand: {
      id: kickstandId, modelId,
      rootId, hostKnotId, hostSegmentId,
      hostMinT: 0,
      segments: [{ id: uuidv4(), diameter }],
      profile: {
        bodyDiameterMm: diameter,
        terminalStartDiameterMm: diameter * 0.8,
        terminalEndDiameterMm: diameter * 0.5,
      },
    },
  };

  if (!doc.supports.kickstands) (doc.supports as any).kickstands = [];
  (doc.supports as any).kickstands.push(kickstand);
  saveVoxl(voxlPath, doc);

  if (jsonOutput(args.flags)) {
    console.log(JSON.stringify({ kickstand_id: kickstandId, root_id: rootId }, null, 2));
  } else {
    console.error(`add-kickstand: ${kickstandId}`);
  }
}

// ---------------------------------------------------------------------------
// Scene place-on-platform — needs STL bbox Z
// ---------------------------------------------------------------------------

function scenePlace(args: ReturnType<typeof parseArgs>): void {
  const voxlPath = args.positional[0];
  if (!voxlPath) throw new Error('Usage: scene place-on-platform <scene.voxl> --id <model-id> --mesh-dir <dir>');

  const doc = loadVoxl(voxlPath);
  const id = requireFlag(args.flags, 'id');
  const meshDir = optionalFlag(args.flags, 'mesh-dir') ?? dirname(resolve(voxlPath));
  const model = doc.models.find((m) => m.id === id);
  if (!model) throw new Error(`Model '${id}' not found`);

  const meshFileName = model.mesh.fileName ?? model.name + '.stl';
  const candidates = [resolve(meshDir, meshFileName), meshFileName, resolve(meshFileName)];
  let meshPath: string | null = null;
  for (const c of candidates) {
    try { statSync(c); meshPath = c; break; } catch { /* next */ }
  }
  if (!meshPath) throw new Error(`Mesh not found: ${candidates.join(', ')}`);

  const positions = loadBinaryStl(meshPath);
  let minZ = Infinity;
  for (let i = 2; i < positions.length; i += 3) {
    if (positions[i] < minZ) minZ = positions[i];
  }

  const oldZ = model.transform.position.z;
  model.transform.position.z = -minZ;
  saveVoxl(voxlPath, doc);

  if (jsonOutput(args.flags)) {
    console.log(JSON.stringify({ id, position: model.transform.position, mesh_min_z: minZ }, null, 2));
  } else {
    console.error(`place-on-platform: ${id} z=${oldZ.toFixed(2)} -> ${(-minZ).toFixed(2)} (mesh minZ=${minZ.toFixed(2)})`);
  }
}

// ---------------------------------------------------------------------------
// Scene export-stl — merge models + shell out to Rust mesh export-stl
// ---------------------------------------------------------------------------

function sceneExportStl(args: ReturnType<typeof parseArgs>): void {
  const voxlPath = args.positional[0];
  if (!voxlPath) throw new Error('Usage: scene export-stl <scene.voxl> --o <output.stl> --mesh-dir <dir>');

  const doc = loadVoxl(voxlPath);
  const output = requireFlag(args.flags, 'o');
  const meshDir = optionalFlag(args.flags, 'mesh-dir') ?? dirname(resolve(voxlPath));
  const visibleModels = doc.models.filter((m) => m.visible);
  if (visibleModels.length === 0) throw new Error('No visible models');

  // Merge all model positions with translations
  const allPositions: Float32Array[] = [];
  for (const model of visibleModels) {
    const meshFileName = model.mesh.fileName ?? model.name + '.stl';
    const candidates = [resolve(meshDir, meshFileName), meshFileName, resolve(meshFileName)];
    let meshPath: string | null = null;
    for (const c of candidates) {
      try { statSync(c); meshPath = c; break; } catch { /* next */ }
    }
    if (!meshPath) throw new Error(`Mesh not found for '${model.name}': ${candidates.join(', ')}`);

    const positions = loadBinaryStl(meshPath);
    applyVoxlTransform(positions, model.transform);
    allPositions.push(positions);
  }

  // Merge + write positions.bin
  const totalFloats = allPositions.reduce((sum, p) => sum + p.length, 0);
  const merged = new Float32Array(totalFloats);
  let off = 0;
  for (const p of allPositions) { merged.set(p, off); off += p.length; }

  const tmpDir = `/tmp/df-export-stl-${Date.now()}`;
  execSync(`mkdir -p ${tmpDir}`);
  const posPath = resolve(tmpDir, 'positions.bin');
  writePositionsBin(posPath, merged);

  // Shell out to Rust CLI
  const rustCli = resolve(dirname(new URL(import.meta.url).pathname), '../rust/dragonfruit-cli/target/release/dragonfruit-cli');
  execSync(`${rustCli} mesh export-stl -i ${tmpDir} -o ${resolve(output)}`, { stdio: 'inherit' });
  execSync(`rm -rf ${tmpDir}`);

  if (jsonOutput(args.flags)) {
    console.log(JSON.stringify({
      output: resolve(output),
      models: visibleModels.length,
      triangles: totalFloats / 9,
    }, null, 2));
  }
}

// ---------------------------------------------------------------------------
// Scene arrange — wraps highPrecisionArrange (same algo as GUI)
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { quaternionFromGlobalEuler } from '../src/utils/rotation';
import {
  computeHighPrecisionArrangeUpdates,
  type ArrangeModel,
  type ArrangeTransform,
  type HullCacheEntry,
  type HighPrecisionArrangeInput,
} from '../src/features/scene/arrange/highPrecisionArrange';
import type { ArrangeAnchorMode } from '../src/components/controls/ArrangePanel';

/**
 * Build a THREE.BufferGeometry from flat f32 STL positions.
 */
function geometryFromPositions(positions: Float32Array): THREE.BufferGeometry {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  return geom;
}

function sceneArrange(args: ReturnType<typeof parseArgs>): void {
  const voxlPath = args.positional[0];
  if (!voxlPath) throw new Error('Usage: scene arrange <scene.voxl> [--spacing 2] [--build-width-mm 218] [--build-depth-mm 122] [--mesh-dir <dir>]');

  const doc = loadVoxl(voxlPath);
  const meshDir = optionalFlag(args.flags, 'mesh-dir') ?? dirname(resolve(voxlPath));
  const spacing = parseFloat(optionalFlag(args.flags, 'spacing') ?? '2.0');
  const plateW = parseFloat(optionalFlag(args.flags, 'build-width-mm') ?? '218.0');
  const plateD = parseFloat(optionalFlag(args.flags, 'build-depth-mm') ?? '122.0');
  const anchorMode = (optionalFlag(args.flags, 'anchor') ?? 'center') as ArrangeAnchorMode;

  const visibleModels = doc.models.filter((m) => m.visible);
  if (visibleModels.length === 0) throw new Error('No visible models to arrange');

  // Build ArrangeModel[] for the existing arrange algo
  const arrangeModels: ArrangeModel[] = [];
  const geometryCache = new Map<string, { geom: THREE.BufferGeometry; center: THREE.Vector3 }>();

  for (const model of visibleModels) {
    const meshFileName = model.mesh.fileName ?? model.name + '.stl';
    const candidates = [resolve(meshDir, meshFileName), meshFileName, resolve(meshFileName)];
    let meshPath: string | null = null;
    for (const c of candidates) {
      try { statSync(c); meshPath = c; break; } catch { /* next */ }
    }
    if (!meshPath) throw new Error(`Mesh not found for '${model.name}': ${candidates.join(', ')}`);

    // Cache geometry per mesh file (duplicates share the same geometry)
    let cached = geometryCache.get(meshPath);
    if (!cached) {
      const positions = loadBinaryStl(meshPath);
      const geom = geometryFromPositions(positions);
      geom.computeBoundingBox();
      const bb = geom.boundingBox!;
      const center = new THREE.Vector3();
      bb.getCenter(center);
      cached = { geom, center };
      geometryCache.set(meshPath, cached);
    }

    const t = model.transform;
    const arrangeModel: ArrangeModel = {
      id: model.id,
      visible: model.visible,
      transform: {
        position: new THREE.Vector3(t.position.x, t.position.y, t.position.z),
        rotation: new THREE.Euler(t.rotation.x, t.rotation.y, t.rotation.z, 'XYZ'),
        scale: new THREE.Vector3(t.scale.x, t.scale.y, t.scale.z),
      },
      geometry: {
        center: cached.center,
        geometry: cached.geom,
      },
    };
    arrangeModels.push(arrangeModel);
  }

  console.error(`arrange: ${arrangeModels.length} models on ${plateW}x${plateD}mm plate (anchor=${anchorMode}, spacing=${spacing}mm)`);

  const hullCache = new Map<string, HullCacheEntry>();
  const input: HighPrecisionArrangeInput = {
    visibleModels: arrangeModels,
    sceneModels: arrangeModels,
    widthMm: plateW,
    depthMm: plateD,
    originMode: 'center',
    arrangeSpacingMm: spacing,
    arrangeAllowRotateOnZ: false,
    arrangeAnchorMode: anchorMode,
    getArrangeTransform: (model: ArrangeModel) => model.transform,
    hullCache,
  };

  const updates = computeHighPrecisionArrangeUpdates(input);

  // Apply updates back to the VOXL document
  for (const update of updates) {
    const model = doc.models.find((m) => m.id === update.id);
    if (!model) continue;
    model.transform.position.x = update.transform.position.x;
    model.transform.position.y = update.transform.position.y;
    model.transform.position.z = update.transform.position.z;
    model.transform.rotation.x = update.transform.rotation.x;
    model.transform.rotation.y = update.transform.rotation.y;
    model.transform.rotation.z = update.transform.rotation.z;
  }

  saveVoxl(voxlPath, doc);

  if (jsonOutput(args.flags)) {
    const result = updates.map((u) => ({
      id: u.id,
      name: doc.models.find((m) => m.id === u.id)?.name,
      position: { x: +u.transform.position.x.toFixed(2), y: +u.transform.position.y.toFixed(2), z: +u.transform.position.z.toFixed(2) },
    }));
    console.log(JSON.stringify({ arranged: result, plate: { width: plateW, depth: plateD } }, null, 2));
  } else {
    for (const update of updates) {
      const name = doc.models.find((m) => m.id === update.id)?.name ?? update.id;
      const p = update.transform.position;
      console.error(`  ${name}: (${p.x.toFixed(1)}, ${p.y.toFixed(1)})`);
    }
  }
}

// ---------------------------------------------------------------------------
// Scene slice — merge models from VOXL, shell out to Rust slicer
// ---------------------------------------------------------------------------

/**
 * Load a binary STL and return flat f32 positions [x,y,z,...].
 * Same logic as cli.rs load_binary_stl.
 */
function loadBinaryStl(path: string): Float32Array {
  const data = readFileSync(path);
  if (data.length < 84) throw new Error(`STL file too small: ${data.length} bytes`);

  const numTriangles = data.readUInt32LE(80);
  const expected = 84 + numTriangles * 50;
  if (data.length < expected) throw new Error(`STL truncated: expected ${expected}, got ${data.length}`);

  const positions = new Float32Array(numTriangles * 9);
  let offset = 84;
  let pi = 0;
  for (let t = 0; t < numTriangles; t++) {
    offset += 12; // skip normal
    for (let v = 0; v < 3; v++) {
      positions[pi++] = data.readFloatLE(offset);
      positions[pi++] = data.readFloatLE(offset + 4);
      positions[pi++] = data.readFloatLE(offset + 8);
      offset += 12;
    }
    offset += 2; // attribute byte count
  }
  return positions;
}

/**
 * Apply position offset to flat positions in-place.
 * For VOXL scene slicing, rotation/scale in the scene transform are Euler radians.
 * This handles translation; full matrix transform would need quaternion math.
 */
function applyTranslation(positions: Float32Array, tx: number, ty: number, tz: number): void {
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] += tx;
    positions[i + 1] += ty;
    positions[i + 2] += tz;
  }
}

/**
 * Apply full VOXL transform (position + rotation + scale) to flat positions.
 * Same transform pipeline as useIslandManager.ts::prepareTransformedGeom:
 * 1. Center geometry at origin (subtract bbox center)
 * 2. Apply rotation (Euler XYZ radians) + scale via Matrix4
 * 3. Apply position translation
 */
function applyVoxlTransform(
  positions: Float32Array,
  transform: { position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number }; scale: { x: number; y: number; z: number } },
): void {
  const { position: pos, rotation: rot, scale: scl } = transform;
  const hasRotation = rot.x !== 0 || rot.y !== 0 || rot.z !== 0;
  const hasScale = scl.x !== 1 || scl.y !== 1 || scl.z !== 1;

  if (!hasRotation && !hasScale) {
    // Translation only — fast path
    if (pos.x !== 0 || pos.y !== 0 || pos.z !== 0) {
      applyTranslation(positions, pos.x, pos.y, pos.z);
    }
    return;
  }

  // Compute bbox center for centering before rotation (matches GUI behavior)
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;

  // Build transform matrix: translate(pos) * rotate(rot) * scale(scl)
  // Same as GUI: Matrix4.compose(position, quaternionFromGlobalEuler(rotation), scale)
  const quaternion = quaternionFromGlobalEuler(rot);
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(pos.x, pos.y, pos.z),
    quaternion,
    new THREE.Vector3(scl.x, scl.y, scl.z),
  );

  const v = new THREE.Vector3();
  for (let i = 0; i < positions.length; i += 3) {
    // Center, then apply matrix
    v.set(positions[i] - cx, positions[i + 1] - cy, positions[i + 2] - cz);
    v.applyMatrix4(matrix);
    positions[i] = v.x;
    positions[i + 1] = v.y;
    positions[i + 2] = v.z;
  }
}

/**
 * Write flat f32 positions to a binary file (same as cli.rs write_positions_bin).
 */
function writePositionsBin(path: string, positions: Float32Array): void {
  writeFileSync(path, Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength));
}

function sceneSlice(args: ReturnType<typeof parseArgs>): void {
  const voxlPath = args.positional[0];
  if (!voxlPath) throw new Error('Usage: scene slice <scene.voxl> --o <output.nanodlp> [--mesh-dir <dir>]');

  const output = requireFlag(args.flags, 'o');
  const meshDir = optionalFlag(args.flags, 'mesh-dir') ?? dirname(resolve(voxlPath));
  const layerHeight = optionalFlag(args.flags, 'layer-height') ?? '0.05';
  const buildWidth = optionalFlag(args.flags, 'build-width-mm') ?? '218.0';
  const buildDepth = optionalFlag(args.flags, 'build-depth-mm') ?? '122.0';

  const doc = loadVoxl(voxlPath);
  const visibleModels = doc.models.filter((m) => m.visible);

  if (visibleModels.length === 0) throw new Error('No visible models in scene');

  console.error(`scene slice: ${visibleModels.length} visible models`);

  // Phase 1: Load each model's STL, apply translation, collect all positions
  const allPositions: Float32Array[] = [];
  let totalTriangles = 0;

  for (const model of visibleModels) {
    const meshFileName = model.mesh.fileName ?? model.name + '.stl';
    // Try mesh-dir, then absolute path, then cwd
    let meshPath: string | null = null;
    const candidates = [
      resolve(meshDir, meshFileName),
      meshFileName,
      resolve(meshFileName),
    ];
    for (const c of candidates) {
      try { statSync(c); meshPath = c; break; } catch { /* try next */ }
    }
    if (!meshPath) throw new Error(`Mesh file not found for model '${model.name}': tried ${candidates.join(', ')}`);

    console.error(`  loading ${model.name}: ${meshPath}`);
    const positions = loadBinaryStl(meshPath);

    // Apply full scene transform (position + rotation + scale)
    applyVoxlTransform(positions, model.transform);
    const t = model.transform;
    const hasRot = t.rotation.x !== 0 || t.rotation.y !== 0 || t.rotation.z !== 0;
    const hasScl = t.scale.x !== 1 || t.scale.y !== 1 || t.scale.z !== 1;
    const hasPos = t.position.x !== 0 || t.position.y !== 0 || t.position.z !== 0;
    if (hasPos || hasRot || hasScl) {
      console.error(`    transform: pos=(${t.position.x.toFixed(1)},${t.position.y.toFixed(1)},${t.position.z.toFixed(1)}) rot=(${t.rotation.x.toFixed(3)},${t.rotation.y.toFixed(3)},${t.rotation.z.toFixed(3)}) scale=(${t.scale.x},${t.scale.y},${t.scale.z})`);
    }

    allPositions.push(positions);
    totalTriangles += positions.length / 9;
  }

  // Phase 2: Merge into single positions buffer
  const totalFloats = allPositions.reduce((sum, p) => sum + p.length, 0);
  const merged = new Float32Array(totalFloats);
  let writeOffset = 0;
  for (const p of allPositions) {
    merged.set(p, writeOffset);
    writeOffset += p.length;
  }

  // Phase 3: Write merged positions.bin
  const tmpDir = `/tmp/df-scene-slice-${Date.now()}`;
  execSync(`mkdir -p ${tmpDir}`);
  const mergedPath = resolve(tmpDir, 'positions.bin');
  writePositionsBin(mergedPath, merged);
  console.error(`  merged: ${totalTriangles} triangles -> ${mergedPath}`);

  // Phase 4: Shell out to Rust slicer
  const rustCli = resolve(dirname(new URL(import.meta.url).pathname), '../rust/dragonfruit-cli/target/release/dragonfruit-cli');
  const sliceCmd = [
    rustCli,
    'slice', 'run',
    mergedPath,
    '-o', resolve(output),
    '--layer-height', layerHeight,
    '--build-width-mm', buildWidth,
    '--build-depth-mm', buildDepth,
    '--json',
  ].join(' ');

  console.error(`  slicing: ${sliceCmd}`);
  const result = execSync(sliceCmd, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });

  // Cleanup temp
  execSync(`rm -rf ${tmpDir}`);

  if (jsonOutput(args.flags)) {
    // Parse and augment the Rust output with scene info
    const sliceResult = JSON.parse(result);
    sliceResult.scene = {
      voxl: resolve(voxlPath),
      models: visibleModels.length,
      total_triangles: totalTriangles,
    };
    console.log(JSON.stringify(sliceResult, null, 2));
  } else {
    // Rust already printed JSON to stdout, just pass it through
    process.stdout.write(result);
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const USAGE = `dragonfruit-ts-cli — headless scene & support operations on .voxl files

Usage: npx tsx scripts/dragonfruit-ts-cli.ts <command> <subcommand> [args]

Commands:
  scene create          Create empty .voxl scene
  scene add-model       Add model to scene
  scene remove-model    Remove model (cascades supports)
  scene list-models     List models
  scene transform-model Set model transform
  scene duplicate       Duplicate a model
  scene arrange         Auto-arrange models on build plate (SAT nesting)
  scene slice           Merge scene models + slice via Rust engine
  scene group           Group models
  scene ungroup         Ungroup
  scene list-groups     List groups
  scene center-xy       Center model XY on plate
  scene place-on-platform  Place model on platform (min Z = 0)
  scene export-stl      Merge scene → binary STL via Rust
  scene load            Dump full scene

  support add-trunk     Add trunk + root support
  support add-branch    Add branch to knot
  support add-leaf      Add leaf to knot
  support add-brace     Add brace between knots
  support add-knot      Add knot on shaft
  support add-twig      Add twig (model-to-model disk contact)
  support add-stick     Add stick (model-to-model cone contact)
  support add-kickstand Add kickstand support
  support update        Update element fields (diameter, position, etc.)
  support remove        Remove element (full cascading)
  support straighten-segment  Convert bezier segment to straight
  support list          List all supports

Flags: --json for JSON stdout output

Each command operates on a .voxl file — the same format the DragonFruit GUI uses.`;

/**
 * Wrap a command function with timing. Captures stdout JSON output and injects _perf.
 */
function withTiming(fn: (args: ReturnType<typeof parseArgs>) => void, args: ReturnType<typeof parseArgs>): void {
  const t0 = performance.now();
  const commandLabel = `${args.command} ${args.subcommand}`;

  // Intercept console.log to capture JSON output and inject _perf
  const originalLog = console.log;
  let capturedJson: string | null = null;

  if (jsonOutput(args.flags)) {
    console.log = (...logArgs: unknown[]) => {
      capturedJson = String(logArgs[0]);
    };
  }

  fn(args);

  const elapsed_ms = +(performance.now() - t0).toFixed(2);

  if (jsonOutput(args.flags)) {
    console.log = originalLog;
    if (capturedJson) {
      try {
        const parsed = JSON.parse(capturedJson);
        parsed._perf = { command: commandLabel, elapsed_ms };
        console.log(JSON.stringify(parsed, null, 2));
      } catch {
        console.log(capturedJson);
      }
    }
  } else {
    console.error(`  [${commandLabel}] ${elapsed_ms}ms`);
  }
}

function main(): void {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 0 || rawArgs[0] === '--help' || rawArgs[0] === '-h') {
    console.log(USAGE);
    process.exit(0);
  }

  const args = parseArgs(rawArgs);

  const dispatch = (fn: (a: ReturnType<typeof parseArgs>) => void) => withTiming(fn, args);

  try {
    if (args.command === 'scene') {
      switch (args.subcommand) {
        case 'create': dispatch(sceneCreate); break;
        case 'add-model': dispatch(sceneAddModel); break;
        case 'remove-model': dispatch(sceneRemoveModel); break;
        case 'list-models': dispatch(sceneListModels); break;
        case 'transform-model': dispatch(sceneTransformModel); break;
        case 'duplicate': dispatch(sceneDuplicate); break;
        case 'arrange': dispatch(sceneArrange); break;
        case 'slice': dispatch(sceneSlice); break;
        case 'group': dispatch(sceneGroup); break;
        case 'ungroup': dispatch(sceneUngroup); break;
        case 'list-groups': dispatch(sceneListGroups); break;
        case 'center-xy': dispatch(sceneCenterXY); break;
        case 'place-on-platform': dispatch(scenePlace); break;
        case 'export-stl': dispatch(sceneExportStl); break;
        case 'load': dispatch(sceneLoad); break;
        default: throw new Error(`Unknown scene subcommand: ${args.subcommand}`);
      }
    } else if (args.command === 'support') {
      switch (args.subcommand) {
        case 'add-trunk': dispatch(supportAddTrunk); break;
        case 'add-branch': dispatch(supportAddBranch); break;
        case 'add-leaf': dispatch(supportAddLeaf); break;
        case 'add-brace': dispatch(supportAddBrace); break;
        case 'add-knot': dispatch(supportAddKnot); break;
        case 'add-twig': dispatch(supportAddTwig); break;
        case 'add-stick': dispatch(supportAddStick); break;
        case 'add-kickstand': dispatch(supportAddKickstand); break;
        case 'update': dispatch(supportUpdate); break;
        case 'remove': dispatch(supportRemove); break;
        case 'straighten-segment': dispatch(supportStraightenSegment); break;
        case 'list': dispatch(supportList); break;
        default: throw new Error(`Unknown support subcommand: ${args.subcommand}`);
      }
    } else {
      throw new Error(`Unknown command: ${args.command}\n\n${USAGE}`);
    }
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
