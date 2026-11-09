#!/usr/bin/env npx tsx
/**
 * Auto-support metric harness.
 *
 * Runs the placement pipeline over a corpus, prints one table, and can diff that
 * table against a baseline. The point is to make every change to auto-support
 * arguable with numbers instead of a screenshot: support count, member volume,
 * coverage, orphan culls, refusal tallies, router probes and phase timings, all
 * from the same run and all deterministic.
 *
 * What it measures is the *placement* half of the pipeline: islands go in as
 * data (authored with the synthetic corpus, or read beside the mesh for
 * `--corpus`), and everything from candidate generation to the committed forest
 * comes out of the real `runAutoPlaceRequest` path the worker uses.
 *
 * Usage:
 *   npm run bench:auto-supports
 *   npm run bench:auto-supports -- --json
 *   npm run bench:auto-supports -- --only overhang-slab --repeat 3
 *   npm run bench:auto-supports -- --settings '{"areaPerSupportMm2": 20}'
 *   npm run bench:auto-supports -- --corpus ~/models
 *   npm run bench:auto-supports -- --update-baseline
 *   npm run bench:auto-supports -- --check
 *
 * `--check` fails when a hard metric (counts, coverage, orphans, contacts above
 * their tip) differs from the baseline, or when a soft one (volume, coverage
 * gain) moves past its tolerance. Timings are reported but never fail the check:
 * they are wall-clock on whatever machine ran it.
 *
 * A corpus directory holds `<name>.stl` and, per model, `<name>.islands.json`:
 * an array of `DetectedIsland` values with `contact` as `{ x, y, z }`.
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

import { initializeBVH, accelerateGeometry } from '../src/utils/bvh';
import { createDefaultSettings } from '../src/supports/Settings/types';
import { setSettings } from '../src/supports/Settings/state';
import { clearHistory } from '../src/history/historyStore';
import { getSnapshot, resetKickstandsInState, resetStore } from '../src/supports/state';
import { registerSupportHistoryHandlers } from '../src/supports/history/useSupportHistoryHandlers';
import { setModelMesh } from '../src/supports/autoSupport/meshStore';
import {
    modelMeshKey,
    runAutoPlaceRequest,
    serializeIsland,
    serializeModelMesh,
    type AutoPlaceWorkerPayload,
} from '../src/supports/autoSupport/autoPlace.worker.shared';
import { getRouterStats, resetRouterStats } from '../src/supports/PlacementLogicV3/SmartPlacementV3';
import { disposeEventLoopChannel } from '../src/utils/yieldToEventLoop';
import { supportProxyGeometryOf, type ProxyGeometryContext } from '../src/supports/proxyGeometry/seam';
import { getFinalSocketPosition } from '../src/supports/SupportPrimitives/ContactCone';
import type { ContactDiskProfile } from '../src/supports/SupportPrimitives/ContactCone/types';
import { calculateDiskThickness } from '../src/supports/SupportPrimitives/ContactDisk/contactDiskUtils';
import { SUPPORT_STATE_TYPES, contactEndpointsFor } from '../src/supports/supportTypeRegistry';
import type { AutoSupportSettings } from '../src/supports/autoSupport/settings';
import type { AutoSupportPlan } from '../src/supports/autoSupport/types';
import type { SupportState, Vec3 } from '../src/supports/types';
import type { DetectedIsland } from '../src/volumeAnalysis/Islands/types';
import type { InstancedShaft } from '../src/supports/SupportPrimitives/Shaft/InstancedShaftGroup';
import type { InstancedRoot } from '../src/supports/SupportPrimitives/Roots/InstancedRootsGroup';
import type { InstancedJoint } from '../src/supports/SupportPrimitives/Joint/InstancedJointGroup';
import type { InstancedContactCone } from '../src/supports/SupportPrimitives/ContactCone/InstancedContactConeGroup';
import { SYNTHETIC_CORPUS, type CorpusEntry } from './bench-auto-support-corpus';
import { DEFAULT_DETECT_OPTIONS, detectIslands, type DetectOptions } from './bench-island-scan';

const BASELINE_PATH = 'scripts/bench/auto-support-baseline.json';

/** Where an entry's islands came from, recorded so a baseline is readable. */
type IslandSource = 'authored' | 'detected';

/** A contact cone this far above its own tip is a violation, not float noise. */
const ABOVE_CONTACT_TOLERANCE_MM = 0.01;
/** Volume is deterministic, so this only absorbs float summation order. */
const VOLUME_TOLERANCE_PCT = 0.5;

interface ModelMetrics {
    name: string;
    exercises: string;
    islands: number;
    islandSource: IslandSource;
    candidates: number;
    entities: number;
    /** What the run itself reported placing, one count per type id. */
    placedByType: Record<string, number>;
    /** The same types, counted from the committed state through each type's recipe. */
    entitiesByType: Record<string, number>;
    contacts: number;
    roots: number;
    joints: number;
    curvedSegments: number;
    memberLengthMm: number;
    memberVolumeMm3: number;
    /** Contacts whose own cone or socket joint rises over the tip it touches. */
    aboveContact: number;
    worstAboveContactMm: number;
    coveragePct: number;
    islandsCovered: number;
    islandsUncovered: number;
    orphans: number;
    orphansByReason: Record<string, number>;
    /** Candidates the grid refused and the fallback then placed without it. */
    gridFallbacks: number;
    /** Load budget, report only: supports a deficit model would add. */
    budgetAdd: number;
    /** ...and how many it would call redundant. */
    budgetCull: number;
    refusals: { fan: number; merge: number; consolidation: number; cavityFallbacks: number };
    rejections: Record<string, number>;
    deterministic: boolean;
    routerPlacements: number;
    routerCones: number;
    routerProbes: number;
    totalMs: number;
    phases: Record<string, number>;
}

type Interval = { low: number; high: number };

function parseArgs(argv: string[]): {
    only: string[] | null;
    corpusDir: string | null;
    json: boolean;
    check: boolean;
    updateBaseline: boolean;
    baselinePath: string;
    settings: Partial<AutoSupportSettings>;
    repeat: number;
    grid: boolean;
    verbose: boolean;
    detect: boolean;
    detectOptions: DetectOptions;
} {
    const options = {
        only: null as string[] | null,
        corpusDir: null as string | null,
        json: false,
        check: false,
        updateBaseline: false,
        baselinePath: BASELINE_PATH,
        settings: {} as Partial<AutoSupportSettings>,
        repeat: 1,
        grid: false,
        verbose: false,
        detect: false,
        detectOptions: { ...DEFAULT_DETECT_OPTIONS },
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const value = (): string => {
            const next = argv[++i];
            if (next === undefined) throw new Error(`${arg} needs a value`);
            return next;
        };
        if (arg === '--only') options.only = value().split(',');
        else if (arg === '--corpus') options.corpusDir = resolve(value());
        else if (arg === '--json') options.json = true;
        else if (arg === '--check') options.check = true;
        else if (arg === '--update-baseline') options.updateBaseline = true;
        else if (arg === '--baseline') options.baselinePath = value();
        else if (arg === '--settings') options.settings = JSON.parse(value()) as Partial<AutoSupportSettings>;
        else if (arg === '--repeat') options.repeat = Math.max(1, Number(value()));
        else if (arg === '--grid') options.grid = true;
        else if (arg === '--verbose') options.verbose = true;
        else if (arg === '--detect') options.detect = true;
        else if (arg === '--px-mm') options.detectOptions.pxMm = Number(value());
        else if (arg === '--layer-height') options.detectOptions.layerHeightMm = Number(value());
        else if (arg === '--help' || arg === '-h') {
            console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
            process.exit(0);
        } else {
            throw new Error(`unknown argument "${arg}" (try --help)`);
        }
    }
    return options;
}

/** Every `.stl` in a directory, as `--corpus` reads them. */
function corpusFromDirectory(dir: string): CorpusEntry[] {
    return readdirSync(dir)
        .filter((file) => file.toLowerCase().endsWith('.stl'))
        .map((file) => basename(file, file.slice(file.lastIndexOf('.'))))
        .sort()
        .map((name) => ({
            name,
            exercises: `model from ${dir}`,
            geometry: () => {
                const buffer = readFileSync(join(dir, `${name}.stl`));
                return new STLLoader().parse(
                    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
                );
            },
            islands: null,
        }));
}

interface InstancedPrimitives {
    shafts: InstancedShaft[];
    roots: InstancedRoot[];
    joints: InstancedJoint[];
    cones: InstancedContactCone[];
}

/**
 * Every primitive the committed state would render, through each type's own
 * registered recipe. Volume and the contact check are read from these rather
 * than from entity fields, so a new support type contributes to both without an
 * edit here.
 *
 * The walk goes through `SUPPORT_STATE_TYPES` and each type's declared
 * collection: the plan's draft state carries the named collections, and `typeId`
 * is the registry's own answer rather than a field the entity may not have.
 */
function collectPrimitives(state: SupportState): {
    primitives: InstancedPrimitives;
    entitiesByType: Record<string, number>;
    entities: number;
} {
    const primitives: InstancedPrimitives = { shafts: [], roots: [], joints: [], cones: [] };
    const entitiesByType: Record<string, number> = {};
    let entities = 0;

    const sink: ProxyGeometryContext = {
        state,
        includeDetailedPrimitives: true,
        pushShaft: (shaft) => primitives.shafts.push(shaft),
        pushSegmentShafts: (segment, start, end, supportId, modelId) => {
            // A curved segment goes in as its chord, so `memberLengthMm` and the
            // volume track the endpoints rather than the control points, and
            // `curvedSegments` reports how much of the forest that covers.
            primitives.shafts.push({ id: segment.id, start, end, diameter: segment.diameter, supportId, modelId });
        },
        pushRoot: (root) => primitives.roots.push(root),
        pushJoint: (joint) => primitives.joints.push(joint),
        pushCone: (cone) => primitives.cones.push(cone),
    };

    for (const descriptor of SUPPORT_STATE_TYPES) {
        const registered = supportProxyGeometryOf(descriptor.id);
        if (!registered) continue;
        for (const entity of Object.values(state[descriptor.location.key])) {
            entities++;
            entitiesByType[descriptor.id] = (entitiesByType[descriptor.id] ?? 0) + 1;
            registered.build(entity as never, sink);
        }
    }
    return { primitives, entitiesByType, entities };
}

/** A frustum: the shape every member primitive here reduces to. */
function frustumVolumeMm3(radiusBottomMm: number, radiusTopMm: number, heightMm: number): number {
    return (Math.PI * heightMm * (radiusBottomMm ** 2 + radiusBottomMm * radiusTopMm + radiusTopMm ** 2)) / 3;
}

/** The cone's socket, from the primitive's own axis and profile. */
function socketOf(cone: InstancedContactCone): THREE.Vector3 {
    const socket = getFinalSocketPosition({
        id: cone.id,
        pos: cone.pos,
        normal: cone.normal,
        surfaceNormal: cone.surfaceNormal,
        diskLengthOverride: cone.diskLengthOverride,
        profile: cone.profile,
    });
    return new THREE.Vector3(socket.x, socket.y, socket.z);
}

/**
 * The volume and length the committed forest would print, from the primitives.
 *
 * Joints and roots count at their nominal size, and overlaps at a junction are
 * not subtracted: consistent between runs, which is what a regression metric
 * needs, and wrong as an estimate of resin used.
 */
function measurePrimitives(primitives: InstancedPrimitives): {
    volumeMm3: number;
    lengthMm: number;
    curvedSegments: number;
} {
    let volumeMm3 = 0;
    let lengthMm = 0;
    let curvedSegments = 0;
    for (const shaft of primitives.shafts) {
        const length = Math.hypot(shaft.end.x - shaft.start.x, shaft.end.y - shaft.start.y, shaft.end.z - shaft.start.z);
        lengthMm += length;
        volumeMm3 += frustumVolumeMm3(shaft.diameter / 2, shaft.diameter / 2, length);
        if (shaft.controlPoint1) curvedSegments++;
    }
    for (const root of primitives.roots) {
        volumeMm3 += frustumVolumeMm3(root.bottomRadius, root.bottomRadius, root.effectiveDiskHeight);
        volumeMm3 += frustumVolumeMm3(root.bottomRadius, root.topRadius, root.coneHeight);
    }
    for (const joint of primitives.joints) volumeMm3 += (4 / 3) * Math.PI * (joint.diameter / 2) ** 3;
    for (const cone of primitives.cones) {
        const socket = socketOf(cone);
        const length = socket.distanceTo(new THREE.Vector3(cone.pos.x, cone.pos.y, cone.pos.z));
        volumeMm3 += frustumVolumeMm3(cone.profile.contactDiameterMm / 2, cone.profile.bodyDiameterMm / 2, length);
    }
    return { volumeMm3, lengthMm, curvedSegments };
}

/**
 * Contacts whose own cone rises over the tip they touch.
 *
 * The contact point is the top of a member: the cone leaves it downward, and a
 * cone swung flat would put its own socket end over the tip it hangs from (the
 * shape this whole check exists for). Only the `upper` contact of each type is
 * checked, because a member grafted onto a host may legitimately sit below a
 * host higher than its own contact, and a bridge's lower cone reaches *up* to
 * its partner by design.
 *
 * Read through the registry's declared contact fields, so a type that adds a
 * contact is checked without an edit here.
 */
function measureAboveContact(state: SupportState): { count: number; worstMm: number } {
    let count = 0;
    let worstMm = 0;
    for (const descriptor of SUPPORT_STATE_TYPES) {
        const upperFields = contactEndpointsFor(descriptor.id)
            .filter((endpoint) => endpoint.end === 'upper')
            .map((endpoint) => endpoint.field);
        if (upperFields.length === 0) continue;
        for (const entity of Object.values(state[descriptor.location.key])) {
            const fields = entity as unknown as Record<string, unknown>;
            for (const field of upperFields) {
                const contact = contactOf(fields[field]);
                if (!contact) continue;
                const above = contact.socket.z + (contact.bodyDiameterMm / 2) * contact.leanSin - contact.pos.z;
                if (above > ABOVE_CONTACT_TOLERANCE_MM) {
                    count++;
                    worstMm = Math.max(worstMm, above);
                }
            }
        }
    }
    return { count, worstMm };
}

interface DeclaredContact {
    pos: Vec3;
    /** Where the cone's own body ends, by the same math the builder uses. */
    socket: Vec3;
    bodyDiameterMm: number;
    /** Sine of the axis's lean from vertical, for the socket-end rise. */
    leanSin: number;
}

/** A value the registry declared as a contact: a tip, an axis and a tip profile. */
function contactOf(value: unknown): DeclaredContact | null {
    if (typeof value !== 'object' || value === null) return null;
    if (!('pos' in value) || !('normal' in value) || !('profile' in value)) return null;
    if (!isVec3(value.pos) || !isVec3(value.normal)) return null;
    const surfaceNormal = 'surfaceNormal' in value && isVec3(value.surfaceNormal) ? value.surfaceNormal : value.normal;
    const profile = 'profile' in value ? value.profile : null;
    if (typeof profile !== 'object' || profile === null) return null;

    const contactDiameterMm = 'contactDiameterMm' in profile ? profile.contactDiameterMm : undefined;
    const bodyDiameterMm = 'bodyDiameterMm' in profile ? profile.bodyDiameterMm : undefined;
    const lengthMm = 'lengthMm' in profile ? profile.lengthMm : undefined;
    if (!isFiniteNumber(contactDiameterMm) || !isFiniteNumber(bodyDiameterMm) || !isFiniteNumber(lengthMm)) return null;

    // The disk offset the cone start sits at, from the same function the builder
    // uses, so a contact measured here is the contact that renders.
    let diskThicknessMm = 0;
    if ('type' in profile && profile.type === 'disk') {
        const diskThickness = 'diskThicknessMm' in profile ? profile.diskThicknessMm : undefined;
        const maxStandoffMm = 'maxStandoffMm' in profile ? profile.maxStandoffMm : undefined;
        const standoffAngleThreshold = 'standoffAngleThreshold' in profile ? profile.standoffAngleThreshold : undefined;
        if (!isFiniteNumber(diskThickness) || !isFiniteNumber(maxStandoffMm) || !isFiniteNumber(standoffAngleThreshold)) return null;
        const diskProfile: ContactDiskProfile = {
            type: 'disk',
            diskThicknessMm: diskThickness,
            maxStandoffMm,
            standoffAngleThreshold,
            contactDiameterMm,
        };
        diskThicknessMm = calculateDiskThickness(surfaceNormal, value.normal, diskProfile);
    }

    const axisLength = Math.hypot(value.normal.x, value.normal.y, value.normal.z) || 1;
    return {
        pos: value.pos,
        socket: {
            x: value.pos.x + surfaceNormal.x * diskThicknessMm + value.normal.x * lengthMm,
            y: value.pos.y + surfaceNormal.y * diskThicknessMm + value.normal.y * lengthMm,
            z: value.pos.z + surfaceNormal.z * diskThicknessMm + value.normal.z * lengthMm,
        },
        bodyDiameterMm,
        leanSin: Math.hypot(value.normal.x, value.normal.y) / axisLength,
    };
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isVec3(value: unknown): value is Vec3 {
    if (typeof value !== 'object' || value === null) return false;
    if (!('x' in value) || !('y' in value) || !('z' in value)) return false;
    return typeof value.x === 'number' && typeof value.y === 'number' && typeof value.z === 'number';
}

/** Silences the pipeline's own logging so the table is the only output. */
function silencePipelineLogs(): () => void {
    const original = { log: console.log, info: console.info, warn: console.warn };
    console.log = () => {};
    console.info = () => {};
    console.warn = () => {};
    return () => Object.assign(console, original);
}

/**
 * Islands for one entry: the file or authored set when it has one, otherwise the
 * app's own detector. `--detect` forces detection even where a set exists, which
 * is how the two are compared on the same mesh.
 */
async function resolveIslands(
    entry: CorpusEntry,
    geometry: THREE.BufferGeometry,
    options: { detect: boolean; detectOptions: DetectOptions },
): Promise<{ islands: DetectedIsland[]; source: IslandSource }> {
    // An entry with no authored set (a model from `--corpus`) is detected, and so
    // is any entry under `--detect`: an authored *empty* set is a model with
    // nothing to support, which must stay a no-op rather than be detected.
    if (entry.islands && !options.detect) return { islands: entry.islands(), source: 'authored' };
    return { islands: await detectIslands(geometry, options.detectOptions), source: 'detected' };
}

/** Runs one corpus entry and reduces it to the numbers the table reports. */
async function runModel(
    entry: CorpusEntry,
    options: { settings: Partial<AutoSupportSettings>; repeat: number; grid: boolean; detect: boolean; detectOptions: DetectOptions },
): Promise<ModelMetrics> {
    const geometry = entry.geometry();
    geometry.computeVertexNormals();
    accelerateGeometry(geometry);
    const { islands, source } = await resolveIslands(entry, geometry, options);

    resetStore();
    resetKickstandsInState();
    clearHistory();
    const dispose = registerSupportHistoryHandlers();
    initializeBVH();
    const appSettings = createDefaultSettings();
    if (options.grid) appSettings.grid.enabled = true;
    setSettings(appSettings);
    const mesh = new THREE.Mesh(geometry);
    mesh.updateMatrixWorld(true);
    setModelMesh(entry.name, mesh);

    const payload: AutoPlaceWorkerPayload = {
        modelId: entry.name,
        islands: islands.map(serializeIsland),
        settingsOverride: options.settings,
        appSettings,
        baseState: getSnapshot(),
        mesh: serializeModelMesh(mesh),
        meshKey: modelMeshKey(mesh),
    };

    try {
        resetRouterStats();
        const startedAt = performance.now();
        const plan = runAutoPlaceRequest(payload);
        const totalMs = performance.now() - startedAt;
        if (!plan) throw new Error(`no plan for ${entry.name} (${islands.length} islands)`);
        const metrics = metricsFrom(plan, islands, source, entry, totalMs);
        if (options.repeat > 1) {
            const again = await runModel(entry, { ...options, repeat: 1 });
            metrics.deterministic = sameForestAs(metrics, again);
        }
        return metrics;
    } finally {
        setModelMesh(entry.name, null);
        dispose();
    }
}

function metricsFrom(
    plan: AutoSupportPlan,
    islands: DetectedIsland[],
    islandSource: IslandSource,
    entry: CorpusEntry,
    totalMs: number,
): ModelMetrics {
    const { primitives, entitiesByType, entities } = collectPrimitives(plan.support);
    const analysis = measurePrimitives(primitives);
    const aboveContact = measureAboveContact(plan.support);
    const report = plan.analytics.forestReport;
    const diagnostics = report?.diagnostics;
    const sumCounts = (counts: Partial<Record<string, number>> | undefined): number =>
        Object.values(counts ?? {}).reduce((sum: number, count) => sum + (count ?? 0), 0);
    const rejections: Record<string, number> = {};
    for (const [reason, count] of Object.entries(plan.analytics.rejectionReasons)) rejections[reason] = count ?? 0;

    return {
        name: entry.name,
        exercises: entry.exercises,
        islands: islands.length,
        islandSource,
        candidates: Object.values(diagnostics?.candidatesBySource ?? {}).reduce((sum, count) => sum + count, 0),
        entities,
        placedByType: { ...plan.result.placed },
        entitiesByType,
        contacts: primitives.cones.length,
        roots: primitives.roots.length,
        joints: primitives.joints.length,
        curvedSegments: analysis.curvedSegments,
        memberLengthMm: analysis.lengthMm,
        memberVolumeMm3: analysis.volumeMm3,
        aboveContact: aboveContact.count,
        worstAboveContactMm: aboveContact.worstMm,
        coveragePct: plan.analytics.areaCoverage * 100,
        islandsCovered: plan.analytics.islandsCovered,
        islandsUncovered: plan.analytics.islandsUncovered,
        gridFallbacks: diagnostics?.gridFallbacks ?? 0,
        budgetAdd: report?.loadBudget?.wouldAdd ?? 0,
        budgetCull: report?.loadBudget?.wouldCull ?? 0,
        orphans: report?.orphans?.length ?? 0,
        orphansByReason: (
            report?.orphans ?? []
        ).reduce<Record<string, number>>((counts, orphan) => {
            counts[orphan.reason] = (counts[orphan.reason] ?? 0) + 1;
            return counts;
        }, {}),
        refusals: {
            fan: sumCounts(diagnostics?.fanRefusals),
            merge: sumCounts(diagnostics?.mergeRefusals),
            consolidation: sumCounts(diagnostics?.consolidationRefusals),
            cavityFallbacks: diagnostics?.cavityFallbacks.length ?? 0,
        },
        rejections,
        deterministic: true,
        routerPlacements: getRouterStats().placements,
        routerCones: getRouterStats().conesTested,
        routerProbes: getRouterStats().jointProbes,
        totalMs,
        phases: Object.fromEntries(
            (plan.analytics.timings?.phases ?? []).map((phase) => [phase.label, Math.round(phase.durationMs)]),
        ),
    };
}

/** Whether two runs of the same entry produced the same forest. */
function sameForestAs(first: ModelMetrics, second: ModelMetrics): boolean {
    const keys: (keyof ModelMetrics)[] = [
        'islands', 'candidates', 'entities', 'contacts', 'roots', 'joints', 'curvedSegments',
        'memberVolumeMm3', 'coveragePct', 'islandsCovered', 'islandsUncovered', 'orphans', 'aboveContact',
        'routerPlacements', 'routerCones', 'routerProbes',
    ];
    return keys.every((key) => JSON.stringify(first[key]) === JSON.stringify(second[key]))
        && JSON.stringify(first.entitiesByType) === JSON.stringify(second.entitiesByType)
        && JSON.stringify(first.placedByType) === JSON.stringify(second.placedByType)
        && JSON.stringify(first.refusals) === JSON.stringify(second.refusals);
}

/** The metrics that must match the baseline exactly. */
const HARD_METRIC_KEYS: (keyof ModelMetrics)[] = [
    'islands', 'candidates', 'entities', 'contacts', 'roots', 'joints', 'curvedSegments',
    'aboveContact', 'islandsCovered', 'islandsUncovered', 'orphans', 'routerProbes',
];

/** The metrics allowed to drift within a tolerance. */
const INTERVALS: Partial<Record<keyof ModelMetrics, Interval>> = {
    memberVolumeMm3: { low: -VOLUME_TOLERANCE_PCT, high: VOLUME_TOLERANCE_PCT },
    memberLengthMm: { low: -VOLUME_TOLERANCE_PCT, high: VOLUME_TOLERANCE_PCT },
    coveragePct: { low: -0.01, high: Infinity },
};

function compareWithBaseline(metrics: ModelMetrics, baseline: ModelMetrics | undefined): { hard: string[]; soft: string[] } {
    if (!baseline) return { hard: ['no baseline entry'], soft: [] };
    const hard = HARD_METRIC_KEYS
        .filter((key) => JSON.stringify(metrics[key]) !== JSON.stringify(baseline[key]))
        .map((key) => `${key}: ${JSON.stringify(baseline[key])} -> ${JSON.stringify(metrics[key])}`);
    // Only ever false under `--repeat`, where a run that differs from itself is a
    // bug in placement rather than a metric that moved.
    if (!metrics.deterministic) hard.push('run is not reproducible (--repeat)');
    for (const key of ['entitiesByType', 'placedByType', 'refusals', 'orphansByReason'] as const) {
        if (JSON.stringify(metrics[key]) !== JSON.stringify(baseline[key])) {
            hard.push(`${key}: ${JSON.stringify(baseline[key])} -> ${JSON.stringify(metrics[key])}`);
        }
    }
    const soft = Object.entries(INTERVALS)
        .map(([key, interval]) => ({ key: key as keyof ModelMetrics, interval: interval! }))
        .filter(({ key, interval }) => {
            const before = baseline[key] as number;
            const after = metrics[key] as number;
            const change = before === 0 ? after : ((after - before) / Math.abs(before)) * 100;
            return change < interval.low || change > interval.high;
        })
        .map(({ key }) => `${key}: ${(baseline[key] as number).toFixed(2)} -> ${(metrics[key] as number).toFixed(2)}`);
    return { hard, soft };
}

function formatTable(rows: ModelMetrics[]): string {
    const header = ['model', 'islands', 'cand', 'entities', 'contacts', 'vol mm3', 'len mm', 'cover %', 'orphans', 'above', 'fallbk', 'budget', 'probes', 'ms'];
    const sum = (pick: (row: ModelMetrics) => number): number => rows.reduce((total, row) => total + pick(row), 0);
    const body = rows.map((row) => [
        row.name,
        String(row.islands),
        String(row.candidates),
        String(row.entities),
        String(row.contacts),
        row.memberVolumeMm3.toFixed(1),
        row.memberLengthMm.toFixed(0),
        row.coveragePct.toFixed(1),
        String(row.orphans),
        String(row.aboveContact),
        String(row.gridFallbacks),
        `+${row.budgetAdd}/-${row.budgetCull}`,
        String(row.routerProbes),
        row.totalMs.toFixed(0),
    ]);
    const totals = [
        'TOTAL', String(sum((row) => row.islands)), String(sum((row) => row.candidates)),
        String(sum((row) => row.entities)), String(sum((row) => row.contacts)),
        sum((row) => row.memberVolumeMm3).toFixed(1), sum((row) => row.memberLengthMm).toFixed(0), '',
        String(sum((row) => row.orphans)), String(sum((row) => row.aboveContact)),
        String(sum((row) => row.gridFallbacks)),
        `+${sum((row) => row.budgetAdd)}/-${sum((row) => row.budgetCull)}`,
        String(sum((row) => row.routerProbes)), sum((row) => row.totalMs).toFixed(0),
    ];
    const widths = header.map((_, column) => Math.max(
        header[column].length,
        ...body.map((row) => row[column].length),
        totals[column].length,
    ));
    const line = (cells: string[]): string => cells.map((cell, column) => cell.padEnd(widths[column])).join('  ');
    return [line(header), widths.map((width) => '-'.repeat(width)).join('  '), ...body.map(line), line(totals)].join('\n');
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    const entries = options.corpusDir ? corpusFromDirectory(options.corpusDir) : SYNTHETIC_CORPUS;
    const selected = options.only ? entries.filter((entry) => options.only!.includes(entry.name)) : entries;
    if (selected.length === 0) throw new Error(`no corpus entries selected (${entries.length} known)`);

    const mode = {
        corpus: options.corpusDir ?? 'synthetic',
        grid: options.grid,
        detect: options.detect,
        pxMm: options.detectOptions.pxMm,
        layerHeightMm: options.detectOptions.layerHeightMm,
        settings: options.settings,
    };
    const metrics: ModelMetrics[] = [];
    const restoreLogs = options.verbose ? null : silencePipelineLogs();
    for (const entry of selected) {
        process.stderr.write(`  running ${entry.name}\n`);
        metrics.push(await runModel(entry, {
            settings: options.settings,
            repeat: options.repeat,
            grid: options.grid,
            detect: options.detect,
            detectOptions: options.detectOptions,
        }));
    }
    restoreLogs?.();
    // Detection yields through a module-level MessageChannel, which holds the
    // event loop open: without this a `--detect` run prints its table and then
    // hangs until something kills it.
    disposeEventLoopChannel();

    const stored = existsSync(options.baselinePath)
        ? (JSON.parse(readFileSync(options.baselinePath, 'utf8')) as { models: ModelMetrics[]; mode?: typeof mode })
        : null;
    const baseline: ModelMetrics[] = stored?.models ?? [];
    const differences = metrics.map((row) => ({
        name: row.name,
        ...compareWithBaseline(row, baseline.find((entry) => entry.name === row.name)),
    }));

    if (options.json) {
        console.log(JSON.stringify({ models: metrics, differences }, null, 2));
    } else {
        const overrides = Object.entries(options.settings).map(([key, value]) => `${key}=${JSON.stringify(value)}`);
        const sources = [...new Set(metrics.map((row) => row.islandSource))].join(', ');
        console.log(`\n== Auto-support metrics (${metrics.length} models) ==`);
        console.log(`   grid: ${options.grid ? 'on' : 'off'} | islands: ${sources} | settings: ${overrides.length > 0 ? overrides.join(' ') : 'defaults'}`);
        if (metrics.some((row) => row.islandSource === 'detected')) {
            // A detected run carries the voxel family only: the overhang and
            // minima scanners are Tauri commands, so an island set the app would
            // have intersected with them arrives as voxel islands instead, and
            // coverage reads lower for it.
            console.log('   detected islands: voxel family only (scan_overhangs and scan_mesh_minima need a Tauri host)');
        }
        console.log(`   corpus: ${options.corpusDir ?? 'synthetic (scripts/bench-auto-support-corpus.ts)'}\n`);
        console.log(formatTable(metrics));
        const undetermined = metrics.filter((row) => !row.deterministic);
        if (undetermined.length > 0) console.log(`\nNOT DETERMINISTIC: ${undetermined.map((row) => row.name).join(', ')}`);
        for (const row of metrics.filter((candidate) => candidate.aboveContact > 0)) {
            console.log(`\nCONTACT ABOVE TIP: ${row.name}: ${row.aboveContact} contact(s), worst ${row.worstAboveContactMm.toFixed(3)}mm`);
        }
        for (const row of metrics.filter((candidate) => candidate.orphans > 0)) {
            console.log(`\nORPHANS: ${row.name}: ${row.orphans} (${JSON.stringify(row.orphansByReason)})`);
        }
        if (baseline.length > 0) {
            console.log('\n== against baseline ==');
            const changed = differences.filter((entry) => entry.hard.length > 0 || entry.soft.length > 0);
            if (changed.length === 0) console.log('  identical');
            for (const entry of changed) {
                console.log(`  ${entry.name}`);
                for (const line of entry.hard) console.log(`    hard: ${line}`);
                for (const line of entry.soft) console.log(`    soft: ${line}`);
            }
        }
    }

    if (options.updateBaseline) {
        writeFileSync(options.baselinePath, `${JSON.stringify({ mode, models: metrics }, null, 2)}\n`);
        console.log(`\nbaseline written to ${options.baselinePath}`);
    }

    if (options.check) {
        if (baseline.length === 0) {
            throw new Error(`--check needs a baseline at ${options.baselinePath}; run --update-baseline first`);
        }
        // A different corpus, mode or resolution is a different measurement, not
        // a regression: comparing them would fail on every flag.
        if (stored?.mode && JSON.stringify(stored.mode) !== JSON.stringify(mode)) {
            throw new Error(
                `the baseline was recorded with ${JSON.stringify(stored.mode)}\n`
                + `   this run is            ${JSON.stringify(mode)}\n`
                + '   rerun with the baseline\'s flags, or --update-baseline for this mode',
            );
        }
        if (differences.some((entry) => entry.hard.length > 0 || entry.soft.length > 0)) process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
