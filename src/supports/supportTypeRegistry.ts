import type { SupportCollectionByType, SupportCollectionName, SupportEntityByCollection, SupportFieldsByType, SupportRemovedEntityByCollection, SupportState } from './types';
import { SUPPORT_UPDATE_TRUNK, SUPPORT_UPDATE_BRANCH } from './history/actionTypes';
import type { SupportHistoryActionType } from './history/actionTypes';
import { ANCHOR_HEIGHT_THRESHOLD_MM } from './autoSupport/constants';
import { getSettings } from './Settings/state';

/** Every declared support type, named once in `SupportFieldsByType`. */
export type SupportTypeId = keyof SupportFieldsByType;

export type SupportSelectionCategory = SupportTypeId | 'root' | 'joint' | 'knot' | 'segment' | 'contactDisk';

/** Entity collections on SupportState, named once in SupportEntityByCollection. */
export type SupportCollectionKey = SupportCollectionName;

/**
 * Where a type's instances live. Kept as a discriminated shape rather than a
 * bare key so a second store would be a compile error at every read.
 */
export type SupportCollectionLocation = { store: 'support'; key: SupportCollectionKey };

/**
 * What sits at one end of a support. A type is two endpoints plus whether a
 * shaft joins them; the vocabulary is closed over all eight.
 *
 * - `plateRoot`  -- a Roots row on the plate, via `rootId`.
 * - `inlineRoot` -- plate geometry on the entity, as an anchor carries.
 * - `knot`       -- hangs from a knot on another support's shaft.
 * - `cone` / `disk` -- a contact primitive against the model.
 * - `none`       -- nothing declared at this end.
 */
export type SupportEndpointKind =
    | 'plateRoot'
    | 'inlineRoot'
    | 'knot'
    | 'cone'
    | 'disk'
    | 'none';

/**
 * One end of a support: what kind it is, and the entity field carrying it.
 *
 * `field` is absent for `none`, and for an endpoint whose link is already a
 * declared edge (`plateRoot`, `knot`) -- the edge names the field.
 */
export interface SupportEndpoint {
    kind: SupportEndpointKind;
    field?: string;
}

/**
 * What a placement rule measures.
 *
 * - `contactSpan` -- distance between the two model contacts a support bridges.
 * - `tipHeight`   -- height of the model contact above the plate.
 */
export type SupportPlacementMetric = 'contactSpan' | 'tipHeight';

/**
 * A question answered by consulting live placement previews in turn, taking
 * the first that has an answer.
 *
 * - `contactGuideWidth`  -- how wide to draw the placement guide.
 * - `limitationFeedback` -- which preview's error or warning to show.
 */
export type SupportPreviewPurpose = 'contactGuideWidth' | 'limitationFeedback';

/**
 * Types whose placement preview is a bare segment rather than a whole
 * provisional support, mirroring `previewShape` at the type level so a preview
 * map can be typed without naming a type in the consumer.
 *
 * Kept in step with the descriptors by `__tests__/placementPreviewPriority.test.ts`.
 */
export type SegmentPreviewTypeId = 'brace';

/**
 * A settings path a threshold reads from, with the fallback used when the
 * setting is absent. The union keeps a typo a compile error.
 */
export type SupportPlacementThreshold =
    | number
    | { setting: SupportPlacementSettingPath; fallback: number };

/**
 * How densely auto-placement may lay a type down, and how it sizes the shafts.
 * `placementRule` picks WHICH type serves a candidate; this is the policy for
 * placing it. Read via {@link autoPlacementFor}.
 *
 * Declared but not yet read -- these were unreferenced constants when they
 * moved here. See docs/dev/support-registry-findings.md.
 */
export interface SupportAutoPlacement {
    /** Closest two of this type may sit (mm). */
    minSpacingMm?: number;
    /** Smallest region to densify: both XY extents must exceed this. */
    minXyMm?: number;
    /** Smallest region area to densify (mm²); slivers are not load-bearing. */
    minAreaMm2?: number;
    /** Multiplier over the sizing band; anchors carry the peel and run thick. */
    shaftMultiplier?: number;
}

/**
 * The range of a measurement this type serves. The two rules disagree about
 * which side owns a value sitting exactly on a shared bound, so `boundary`
 * declares it per rule.
 */
export interface SupportPlacementRule {
    metric: SupportPlacementMetric;
    minMm?: SupportPlacementThreshold;
    maxMm?: SupportPlacementThreshold;
    /** Which type claims a value exactly on a shared bound. Default `'lower'`. */
    boundary?: 'lower' | 'upper';
}

/**
 * One link between entities. `field` holds the id, `to` names the collection it
 * points into (or `'segment'`), and `ownership` is the cascade direction:
 * `owns` removes the target with this entity, `hostedBy` removes this with it.
 */
export interface SupportEdge {
    field: string;
    to: SupportCollectionKey | 'segment';
    ownership: 'owns' | 'hostedBy';
    /**
     * For a `hostedBy` edge, whether removing this entity removes the host:
     * `'never'`, `'ifUnused'` (only when nothing else references it), `'always'`.
     */
    takeHost?: 'never' | 'ifUnused' | 'always';
}

/**
 * What a support type IS — not how it renders, builds or places. Adding a
 * renderer or builder reference here turns a mechanical refactor into a rewrite.
 */
export interface SupportTypeDescriptor {
    id: SupportTypeId;
    /** Plural display name, so panels listing collections need no label table. */
    label: string;
    /**
     * Singular lower-case name, for history descriptions like
     * `Move ${singular} joint`. Declared rather than derived from `label`,
     * which does not depluralise ("Leaves" -> "Leave").
     */
    singular: string;
    location: SupportCollectionLocation;
    selectionCategory: SupportSelectionCategory;
    historyAdd: SupportHistoryActionType;
    historyRemove: SupportHistoryActionType;
    /**
     * Whether this type is serialised as a bundle rather than a bare entity.
     *
     * Kickstand alone is: the wire format writes it as
     * `{ kickstand, root, hostKnot }`, so a loader walking the arrays by
     * collection key has to unwrap it instead of reading entities directly.
     * A wire-format artefact, tracked in docs/dev/support-registry-findings.md
     * -- declared here so the loader can ask rather than test the key by name.
     */
    serialisedAsBundle?: boolean;
    /**
     * The action a before/after edit to this type records, when it has one of
     * its own. Trunk and branch do; every other type's edits go through the
     * shared support-edit snapshot instead.
     *
     * Distinct from `ownsEditHistoryEntry`, which only trunk sets: that says
     * the joint-drag path pushes its own entry, this says an update action
     * exists at all.
     */
    historyUpdate?: SupportHistoryActionType;
    /** Whether a modelId walk includes this type. All eight do; the flag exists so a future type can opt out. */
    carriesModelId: boolean;
    /** Whether instances carry real shafts, for segment and joint walks. */
    hasSegments: boolean;
    /**
     * Contact primitive fields, lower end first. Use for "every contact",
     * where order does not matter; when the end or kind matters use
     * `lower`/`upper` or `contactEndpointsFor`.
     */
    contactFields: readonly string[];
    /**
     * Prefix a selection id carries when one of this type's segments is
     * selected, if it uses one. Brace alone does today.
     */
    segmentSelectionPrefix?: string;
    /**
     * Prefix a knot's `parentShaftId` carries when it rides this type rather
     * than a real shaft segment: a leaf's contact cone, a brace's span.
     */
    knotHostPrefix?: string;
    /**
     * Whether instances record an auto-support `origin`, which the debug
     * origin-colouring overlay reads.
     */
    hasOrigin: boolean;
    /**
     * Whether the type has an interactive placement hook, and so a live
     * placement preview. Twig, stick and anchor have none -- they are chosen
     * automatically rather than placed.
     */
    hasPlacementPreview: boolean;
    /**
     * Whether the placement router hands this type pointer gestures on a model
     * face. Brace and kickstand attach to existing supports; trunk takes the
     * model surface by default rather than competing as an owner.
     */
    claimsModelSurfaceGestures: boolean;
    /**
     * What a live placement preview carries.
     *
     * `support` is a whole provisional support, with contacts and any error.
     * `segment` is a bare start-to-end pair -- brace places between two
     * existing supports, so there is no model contact to describe and nothing
     * to report. Consumers that measure contacts or read an error consult
     * `previewPriority` rather than excluding a type by name.
     */
    previewShape?: 'support' | 'segment';
    /**
     * Whether auto-bracing samples this type's shafts as a brace endpoint: a
     * shaft running plate-to-model, not one bridging two model contacts.
     */
    isAutoBraceable: boolean;
    /**
     * The measurement range this type serves, when the type is chosen
     * automatically rather than picked by the user.
     *
     * A missing bound is unbounded on that side; `boundary` decides who owns
     * a value sitting exactly on a shared bound.
     * Enforced by `__tests__/placementRules.test.ts`.
     */
    placementRule?: SupportPlacementRule;
    /** Auto-placement density and shaft sizing. See {@link SupportAutoPlacement}. */
    autoPlacement?: SupportAutoPlacement;
    /**
     * Whether this type's preview yields to any other placement mode.
     *
     * True for the default tool: a trunk preview follows the cursor whenever
     * nothing else is being placed, so it must stand down when another mode
     * takes over. The rest only preview while their own mode is active.
     */
    previewYieldsToOtherModes?: boolean;
    /**
     * Whether the preview shows only while this type's own placement mode is
     * active, rather than whenever a preview exists.
     */
    previewRequiresOwnMode?: boolean;
    /**
     * Whether this type's placement mode displaces the default tool's preview.
     *
     * False for brace: it places between two existing supports rather than
     * against the model, so a trunk preview may sit under it.
     */
    placementModeDisplacesDefault?: boolean;
    /**
     * Where this type sits when several live previews answer the same
     * question, per purpose. Lower ranks are consulted first.
     *
     * A type omitted from a purpose is never consulted for it: brace appears
     * in neither, because its preview is a bare segment with no contacts to
     * measure and no error to report.
     *
     * `whileActive` is a second, earlier rank used only while this type's own
     * placement mode is active; `onlyWhileActive` drops the type from the
     * order entirely unless its mode is active. The two purposes produce
     * different orders, and deliberately -- see
     * `__tests__/placementPreviewPriority.test.ts`.
     */
    previewPriority?: Partial<Record<SupportPreviewPurpose, {
        rank: number;
        whileActive?: number;
        onlyWhileActive?: boolean;
    }>>;
    /**
     * Where a tapering shaft reads its two end diameters, and on which
     * segment. A taper whose ends differ cannot be instanced, so the whole
     * support drops out of the batched pass.
     */
    shaftTaper?: {
        /** `'all'` tapers every segment; `'last'` only the terminal one. */
        segments: 'all' | 'last';
        /** Entity paths holding the start and end diameters. */
        from: readonly [string, string];
    };
    /** What sits at the bottom of this type. */
    lower: SupportEndpoint;
    /** What sits at the top of this type. */
    upper: SupportEndpoint;
    /**
     * Whether every segment carries both its own joints, so a host resolves from
     * the segment alone.
     *
     * False for types whose endpoints come from elsewhere -- a root, a parent
     * knot, or a neighbouring segment -- which need their own endpoint maps.
     */
    segmentsCarryBothJoints: boolean;
    /**
     * Whether the type is placed by its own dedicated snap pass.
     *
     * Such a type is skipped by the generic shafted-snap loop, which would
     * otherwise offer its segments a second time.
     */
    hasDedicatedSnapPass: boolean;
    /**
     * Whether a contact cone on this type carries `diskLengthOverride`, which a
     * joint drag strips on commit.
     */
    hasContactDiskLengthOverride: boolean;
    /**
     * Whether a model transform marks this type's segments as moved, so knots
     * sitting on them follow.
     *
     * False for a type that moves purely on its own `modelId` and carries no
     * hosted geometry -- an anchor is a plate-to-model stub, and a knot on its
     * shaft is not dragged along by the model moving.
     */
    transformPropagatesToShaft: boolean;
    /**
     * Whether an edit gizmo records its own before/after history entry.
     *
     * The generic path commits the preview and records one entry; a type that
     * writes its own would get two.
     */
    ownsEditHistoryEntry: boolean;
    /**
     * Whether a joint drag seeds and reads a live preview of the entity.
     *
     * A type that compares against the store instead gains nothing from the
     * preview ref, and seeding one leaves a stale entity behind the drag.
     */
    jointDragUsesLivePreview: boolean;
    /**
     * Prefix for this type's bezier handle context ids.
     *
     * Those ids are React keys. Trunk's predate the others and carry no prefix;
     * changing that remounts every trunk handle, so it is declared rather than
     * derived from some flag that happens to be trunk-only today.
     */
    bezierContextIdPrefix: string;
    /**
     * Whether reshaping this type's curve broadcasts its attached knots and
     * leaves live.
     *
     * Twig alone: knots ride its shaft and leaves hang off those, and without
     * the broadcast they jump to the new curve only on release.
     */
    broadcastsAttachmentsWhileDragging: boolean;
    /**
     * Whether a knot riding this shaft renders at the joint diameter.
     *
     * Trunk alone: at the bare shaft diameter the knot is hidden inside the
     * joint sphere.
     */
    knotTakesJointDiameter: boolean;
    /**
     * Whether a knot carrying no `t` is projected onto the segment.
     *
     * Auto merge and fan knots carry none. Projecting keeps a leaf on the shaft
     * through a joint drag; the others leave such a knot alone.
     */
    projectsUnparameterisedKnots: boolean;
    /**
     * How interior view decides whether an instance is inside the cavity.
     *
     * - `contacts`  -- test the type's own declared contacts.
     * - `inherited` -- it has none of its own; resolve through its host knots.
     * - `hidden`    -- never shown in interior view.
     */
    interiorVisibility: 'contacts' | 'inherited' | 'hidden';
    /**
     * Whether unselected contact cones are drawn by the shared batched pass.
     *
     * A type that draws its own cone instead would get two if it also batched.
     * Anchor is the one: its renderer draws the cone directly, and only while
     * selected.
     */
    batchesContactCones: boolean;
    /**
     * Whether the type's shaft joints are drawn by the shared batched pass.
     *
     * The joints a shaft carries hang off its segments. Anchor declares a
     * shaft but builds none, keeping its single joint on the entity instead,
     * so there is nothing per-segment for the batch to collect.
     */
    batchesShaftJoints: boolean;
    /**
     * Whether the shared plain-shaft batcher builds this type's shafts.
     *
     * Brace opts out: its shaft is a curve between two knots and it builds its
     * own set. Anchor declares a shaft but builds none.
     */
    batchesPlainShafts: boolean;
    /**
     * Whether dragging a joint re-solves the type's contact primitives.
     *
     * True where both ends are contacts against the model: moving an end
     * carries its disk or cone with it. A shaft running between hosts instead
     * moves the joint alone.
     */
    jointDragMovesContacts: boolean;
    /**
     * Whether a joint drag may turn this type's segments into curves.
     *
     * Segments already bezier keep updating regardless; this is whether the
     * drag can newly curve a straight one.
     */
    jointDragCanCurveShaft: boolean;
    /**
     * Whether instances own a Roots entry, via a `rootId` field.
     *
     * A root with no owner is garbage and gets culled, so a type missing here
     * has its roots deleted out from under it.
     */
    ownsRoot: boolean;
    /** How instances link to other entities. See {@link SupportEdge}. */
    edges: readonly SupportEdge[];
    /**
     * How a shaft behaves when its geometry cannot be resolved. Only reached
     * on malformed geometry, and the values differ per type.
     */
    shaftFallback: {
        /** No top joint and no contact: 10 for a trunk, 5 elsewhere. Inherited drift. */
        stubLengthMm: number;
        /**
         * Whether an unresolvable start falls back to the split point. True for
         * self-contained types; a hosted type stays straight instead.
         */
        startFallsBackToSplitPoint: boolean;
    };
    /**
     * Whether instances have per-entity editable settings.
     *
     * Such a type is selectable in the settings sidebar and caches a
     * `settingsCodeHex` outside the entity, keyed by type and id -- so it must
     * evict on remove or the next entity reusing that id inherits stale values.
     */
    hasEditableSettings: boolean;
}

/**
 * Each type's declaration, minus the fields derived below.
 *
 * `historyAdd` / `historyRemove` are filled from the id: they spell
 * `support:add-<id>` / `support:remove-<id>` for every type, so declaring them
 * by hand was a second place to keep in sync.
 */
const SUPPORT_TYPE_DECLARATIONS: readonly Omit<SupportTypeDescriptor, 'historyAdd' | 'historyRemove'>[] = [
    {
        id: 'trunk',
        hasEditableSettings: true,
        edges: [{ field: 'rootId', to: 'roots', ownership: 'owns' }],
        ownsRoot: true,
        segmentsCarryBothJoints: false,
        hasDedicatedSnapPass: true,
        hasContactDiskLengthOverride: true,
        transformPropagatesToShaft: true,
        ownsEditHistoryEntry: true,
        jointDragUsesLivePreview: true,
        batchesContactCones: true,
        batchesShaftJoints: true,
        batchesPlainShafts: true,
        bezierContextIdPrefix: '',
        broadcastsAttachmentsWhileDragging: false,
        knotTakesJointDiameter: true,
        projectsUnparameterisedKnots: true,
        interiorVisibility: 'contacts',
        jointDragMovesContacts: false,
        jointDragCanCurveShaft: true,
        contactFields: ['contactCone'],
        shaftFallback: { stubLengthMm: 10, startFallsBackToSplitPoint: false },
        hasOrigin: true,
        hasPlacementPreview: true,
        claimsModelSurfaceGestures: false,
        previewShape: 'support',
        previewYieldsToOtherModes: true,
        previewPriority: {
            contactGuideWidth: { rank: 0 },
            limitationFeedback: { rank: 2 },
        },
        placementRule: { metric: 'tipHeight', minMm: ANCHOR_HEIGHT_THRESHOLD_MM, boundary: 'upper' },
        isAutoBraceable: true,
        lower: { kind: 'plateRoot' },
        upper: { kind: 'cone', field: 'contactCone' },
        hasSegments: true,
        label: 'Trunks',
        singular: 'trunk',
        location: { store: 'support', key: 'trunks' },
        selectionCategory: 'trunk',
        historyUpdate: SUPPORT_UPDATE_TRUNK,
        carriesModelId: true,
    },
    {
        id: 'branch',
        hasEditableSettings: true,
        edges: [{ field: 'parentKnotId', to: 'knots', ownership: 'hostedBy', takeHost: 'always' }],
        ownsRoot: false,
        segmentsCarryBothJoints: false,
        hasDedicatedSnapPass: true,
        hasContactDiskLengthOverride: true,
        transformPropagatesToShaft: true,
        ownsEditHistoryEntry: false,
        jointDragUsesLivePreview: true,
        batchesContactCones: true,
        batchesShaftJoints: true,
        batchesPlainShafts: true,
        bezierContextIdPrefix: 'branch-',
        broadcastsAttachmentsWhileDragging: false,
        knotTakesJointDiameter: false,
        projectsUnparameterisedKnots: false,
        interiorVisibility: 'contacts',
        jointDragMovesContacts: false,
        jointDragCanCurveShaft: false,
        contactFields: ['contactCone'],
        shaftFallback: { stubLengthMm: 5, startFallsBackToSplitPoint: false },
        hasOrigin: true,
        hasPlacementPreview: true,
        claimsModelSurfaceGestures: true,
        previewShape: 'support',
        previewRequiresOwnMode: true,
        placementModeDisplacesDefault: true,
        previewPriority: {
            contactGuideWidth: { rank: 1, whileActive: -3 },
            limitationFeedback: { rank: 1, onlyWhileActive: true },
        },
        isAutoBraceable: true,
        lower: { kind: 'knot' },
        upper: { kind: 'cone', field: 'contactCone' },
        hasSegments: true,
        label: 'Branches',
        singular: 'branch',
        location: { store: 'support', key: 'branches' },
        selectionCategory: 'branch',
        historyUpdate: SUPPORT_UPDATE_BRANCH,
        carriesModelId: true,
    },
    {
        id: 'leaf',
        hasEditableSettings: true,
        knotHostPrefix: 'leafCone:',
        edges: [{ field: 'parentKnotId', to: 'knots', ownership: 'hostedBy', takeHost: 'ifUnused' }],
        ownsRoot: false,
        segmentsCarryBothJoints: true,
        hasDedicatedSnapPass: false,
        hasContactDiskLengthOverride: false,
        transformPropagatesToShaft: true,
        ownsEditHistoryEntry: false,
        jointDragUsesLivePreview: true,
        batchesContactCones: true,
        batchesShaftJoints: false,
        batchesPlainShafts: false,
        bezierContextIdPrefix: 'leaf-',
        broadcastsAttachmentsWhileDragging: false,
        knotTakesJointDiameter: false,
        projectsUnparameterisedKnots: false,
        interiorVisibility: 'contacts',
        jointDragMovesContacts: false,
        jointDragCanCurveShaft: false,
        contactFields: ['contactCone'],
        shaftFallback: { stubLengthMm: 5, startFallsBackToSplitPoint: false },
        hasOrigin: true,
        hasPlacementPreview: true,
        claimsModelSurfaceGestures: true,
        previewShape: 'support',
        placementModeDisplacesDefault: true,
        previewPriority: {
            contactGuideWidth: { rank: 2, whileActive: -2 },
            limitationFeedback: { rank: 0 },
        },
        isAutoBraceable: false,
        lower: { kind: 'knot' },
        upper: { kind: 'cone', field: 'contactCone' },
        hasSegments: false,
        label: 'Leaves',
        singular: 'leaf',
        location: { store: 'support', key: 'leaves' },
        selectionCategory: 'leaf',
        carriesModelId: true,
    },
    {
        id: 'twig',
        hasEditableSettings: false,
        edges: [],
        ownsRoot: false,
        segmentsCarryBothJoints: true,
        hasDedicatedSnapPass: false,
        hasContactDiskLengthOverride: false,
        transformPropagatesToShaft: true,
        ownsEditHistoryEntry: false,
        jointDragUsesLivePreview: true,
        batchesContactCones: false,
        batchesShaftJoints: true,
        batchesPlainShafts: true,
        bezierContextIdPrefix: 'twig-',
        broadcastsAttachmentsWhileDragging: true,
        knotTakesJointDiameter: false,
        projectsUnparameterisedKnots: false,
        interiorVisibility: 'contacts',
        jointDragMovesContacts: true,
        jointDragCanCurveShaft: false,
        contactFields: ['contactDiskA', 'contactDiskB'],
        shaftFallback: { stubLengthMm: 5, startFallsBackToSplitPoint: true },
        hasOrigin: false,
        shaftTaper: { segments: 'all', from: ['contactDiskA.contactDiameterMm', 'contactDiskB.contactDiameterMm'] },
        hasPlacementPreview: false,
        claimsModelSurfaceGestures: false,
        placementRule: { metric: 'contactSpan', maxMm: { setting: 'meshToMesh.stickVsTwigCutoffMm', fallback: 5 } },
        isAutoBraceable: false,
        lower: { kind: 'disk', field: 'contactDiskA' },
        upper: { kind: 'disk', field: 'contactDiskB' },
        hasSegments: true,
        label: 'Twigs',
        singular: 'twig',
        location: { store: 'support', key: 'twigs' },
        selectionCategory: 'twig',
        carriesModelId: true,
    },
    {
        id: 'stick',
        hasEditableSettings: false,
        edges: [],
        ownsRoot: false,
        segmentsCarryBothJoints: true,
        hasDedicatedSnapPass: false,
        hasContactDiskLengthOverride: false,
        transformPropagatesToShaft: true,
        ownsEditHistoryEntry: false,
        jointDragUsesLivePreview: true,
        batchesContactCones: true,
        batchesShaftJoints: true,
        batchesPlainShafts: true,
        bezierContextIdPrefix: 'stick-',
        broadcastsAttachmentsWhileDragging: false,
        knotTakesJointDiameter: false,
        projectsUnparameterisedKnots: false,
        interiorVisibility: 'contacts',
        jointDragMovesContacts: true,
        jointDragCanCurveShaft: false,
        contactFields: ['contactConeA', 'contactConeB'],
        shaftFallback: { stubLengthMm: 5, startFallsBackToSplitPoint: true },
        hasOrigin: false,
        hasPlacementPreview: false,
        claimsModelSurfaceGestures: false,
        placementRule: { metric: 'contactSpan', minMm: { setting: 'meshToMesh.stickVsTwigCutoffMm', fallback: 5 } },
        isAutoBraceable: false,
        lower: { kind: 'cone', field: 'contactConeA' },
        upper: { kind: 'cone', field: 'contactConeB' },
        hasSegments: true,
        label: 'Sticks',
        singular: 'stick',
        location: { store: 'support', key: 'sticks' },
        selectionCategory: 'stick',
        carriesModelId: true,
    },
    {
        id: 'brace',
        // Two named knot fields rather than a list: the history payload and its
        // undo handler read them by name, and start/end are not interchangeable.
        hasEditableSettings: false,
        edges: [
            { field: 'startKnotId', to: 'knots', ownership: 'hostedBy', takeHost: 'ifUnused' },
            { field: 'endKnotId', to: 'knots', ownership: 'hostedBy', takeHost: 'ifUnused' },
        ],
        ownsRoot: false,
        segmentsCarryBothJoints: true,
        hasDedicatedSnapPass: true,
        hasContactDiskLengthOverride: false,
        transformPropagatesToShaft: true,
        ownsEditHistoryEntry: false,
        jointDragUsesLivePreview: true,
        batchesContactCones: false,
        batchesShaftJoints: false,
        batchesPlainShafts: false,
        bezierContextIdPrefix: 'brace-',
        broadcastsAttachmentsWhileDragging: false,
        knotTakesJointDiameter: false,
        projectsUnparameterisedKnots: false,
        interiorVisibility: 'inherited',
        jointDragMovesContacts: false,
        jointDragCanCurveShaft: false,
        contactFields: [],
        shaftFallback: { stubLengthMm: 5, startFallsBackToSplitPoint: false },
        segmentSelectionPrefix: 'braceSegment:',
        knotHostPrefix: 'braceSegment:',
        hasOrigin: false,
        hasPlacementPreview: true,
        claimsModelSurfaceGestures: false,
        previewShape: 'segment',
        isAutoBraceable: false,
        lower: { kind: 'knot' },
        upper: { kind: 'knot' },
        hasSegments: false,
        label: 'Braces',
        singular: 'brace',
        location: { store: 'support', key: 'braces' },
        selectionCategory: 'brace',
        carriesModelId: true,
    },
    {
        id: 'anchor',
        hasEditableSettings: false,
        edges: [],
        ownsRoot: false,
        segmentsCarryBothJoints: true,
        hasDedicatedSnapPass: false,
        hasContactDiskLengthOverride: false,
        transformPropagatesToShaft: false,
        ownsEditHistoryEntry: false,
        jointDragUsesLivePreview: true,
        batchesContactCones: false,
        batchesShaftJoints: false,
        batchesPlainShafts: false,
        bezierContextIdPrefix: 'anchor-',
        broadcastsAttachmentsWhileDragging: false,
        knotTakesJointDiameter: false,
        projectsUnparameterisedKnots: false,
        interiorVisibility: 'contacts',
        jointDragMovesContacts: false,
        jointDragCanCurveShaft: false,
        contactFields: ['contactCone'],
        shaftFallback: { stubLengthMm: 5, startFallsBackToSplitPoint: true },
        hasOrigin: true,
        hasPlacementPreview: false,
        claimsModelSurfaceGestures: false,
        placementRule: { metric: 'tipHeight', maxMm: ANCHOR_HEIGHT_THRESHOLD_MM, boundary: 'upper' },
        autoPlacement: {
            minSpacingMm: 1.8,
            minXyMm: 4.0,
            minAreaMm2: 12.0,
            shaftMultiplier: 1.25,
        },
        isAutoBraceable: false,
        lower: { kind: 'inlineRoot', field: 'rootPos' },
        upper: { kind: 'cone', field: 'contactCone' },
        hasSegments: true,
        label: 'Anchors',
        singular: 'anchor',
        location: { store: 'support', key: 'anchors' },
        selectionCategory: 'anchor',
        carriesModelId: true,
    },
    {
        id: 'kickstand',
        hasEditableSettings: true,
        edges: [
            { field: 'rootId', to: 'roots', ownership: 'owns' },
            { field: 'hostKnotId', to: 'knots', ownership: 'hostedBy', takeHost: 'always' },
            { field: 'hostSegmentId', to: 'segment', ownership: 'hostedBy', takeHost: 'always' },
        ],
        ownsRoot: true,
        segmentsCarryBothJoints: false,
        hasDedicatedSnapPass: false,
        hasContactDiskLengthOverride: false,
        transformPropagatesToShaft: true,
        ownsEditHistoryEntry: false,
        jointDragUsesLivePreview: false,
        batchesContactCones: false,
        batchesShaftJoints: true,
        batchesPlainShafts: true,
        bezierContextIdPrefix: 'kickstand-',
        broadcastsAttachmentsWhileDragging: false,
        knotTakesJointDiameter: false,
        projectsUnparameterisedKnots: false,
        interiorVisibility: 'hidden',
        jointDragMovesContacts: false,
        jointDragCanCurveShaft: true,
        contactFields: [],
        shaftFallback: { stubLengthMm: 5, startFallsBackToSplitPoint: false },
        hasOrigin: false,
        shaftTaper: { segments: 'last', from: ['profile.terminalStartDiameterMm', 'profile.terminalEndDiameterMm'] },
        hasPlacementPreview: true,
        claimsModelSurfaceGestures: false,
        previewShape: 'support',
        placementModeDisplacesDefault: true,
        previewPriority: {
            contactGuideWidth: { rank: 3, whileActive: -1 },
        },
        isAutoBraceable: true,
        lower: { kind: 'plateRoot' },
        upper: { kind: 'knot' },
        hasSegments: true,
        label: 'Kickstands',
        singular: 'kickstand',
        location: { store: 'support', key: 'kickstands' },
        selectionCategory: 'kickstand',
        serialisedAsBundle: true,
        carriesModelId: true,
    },
];

export const SUPPORT_TYPES: readonly SupportTypeDescriptor[] = SUPPORT_TYPE_DECLARATIONS.map(
    (declaration) => ({
        ...declaration,
        historyAdd: `support:add-${declaration.id}` as SupportHistoryActionType,
        historyRemove: `support:remove-${declaration.id}` as SupportHistoryActionType,
    }),
);

/**
 * The store's update function for a type, filled in by state.ts at load.
 *
 * A slot rather than an import: state.ts calls into this module while building
 * its initial state, so importing it back would be an initialisation cycle.
 */
type SupportUpdater = (entity: never) => void;

const UPDATERS = new Map<SupportTypeId, SupportUpdater>();

/** Called once by state.ts; later calls for the same id replace the previous one. */
export function registerSupportUpdater<T>(typeId: SupportTypeId, update: (entity: T) => void): void {
    UPDATERS.set(typeId, update as SupportUpdater);
}

/**
 * Apply an entity back to the store by type id.
 *
 * Returns false when nothing is registered for the id, so a caller can tell
 * "no updater" from "updated".
 */
export function updateSupportEntity(typeId: SupportTypeId, entity: unknown): boolean {
    const update = UPDATERS.get(typeId);
    if (!update) return false;
    (update as (value: unknown) => void)(entity);
    return true;
}

/**
 * How a type sizes a knot sitting on its shaft, when it does so specially.
 *
 * Most types leave this unset and get the generic segment-diameter rule. Twigs
 * taper along their length, so a knot on one is sized from that taper instead.
 * A slot for the same reason as the updaters: the rule lives with the type, but
 * importing it here would be an initialisation cycle.
 */
type KnotDiameterRule = (entity: unknown, segmentId: string, t: number) => number | null;

const KNOT_DIAMETER_RULES = new Map<SupportTypeId, KnotDiameterRule>();

export function registerKnotDiameterRule<T>(
    typeId: SupportTypeId,
    rule: (entity: T, segmentId: string, t: number) => number | null,
): void {
    KNOT_DIAMETER_RULES.set(typeId, rule as KnotDiameterRule);
}

/** The type's own knot diameter at `t`, or null to use the generic rule. */
export function resolveKnotDiameter(
    typeId: SupportTypeId,
    entity: unknown,
    segmentId: string,
    t: number,
): number | null {
    return KNOT_DIAMETER_RULES.get(typeId)?.(entity, segmentId, t) ?? null;
}

/**
 * What each type's removal returns, so undo can rebuild what it deleted.
 * `self` is the field the entity arrives under; `cascade` maps a collection to
 * the field its removed members arrive under.
 *
 * Must stay `as const` and unannotated: {@link SupportRemovalResult} derives
 * the per-type return shapes from these literals.
 */
export const SUPPORT_REMOVAL_SHAPES = {
    trunk: { self: 'trunk', cascade: { roots: 'roots', branches: 'branches', braces: 'braces', kickstands: 'kickstands', leaves: 'leaves', knots: 'knots' } },
    branch: { self: 'branch', cascade: { branches: 'branches', braces: 'braces', kickstands: 'kickstands', leaves: 'leaves', knots: 'knots' } },
    leaf: { self: 'leaf', cascade: { knots: 'knot' } },
    twig: { self: 'twig', cascade: { knots: 'knots', leaves: 'leaves' } },
    stick: { self: 'stick', cascade: { knots: 'knots', leaves: 'leaves' } },
    brace: { self: 'brace', cascade: { knots: ['startKnot', 'endKnot'] } },
    anchor: { self: 'anchor', cascade: { knots: 'knots', leaves: 'leaves' } },
    kickstand: { self: 'kickstand', cascade: { roots: 'roots', knots: 'knots', braces: 'braces', leaves: 'leaves', branches: 'branches', kickstands: 'kickstands' } },
    // `satisfies` keeps the literal narrowing the result types read, while
    // making a renamed type a compile error here rather than at the call site.
} as const satisfies Record<SupportTypeId, { self: string; cascade: Record<string, string | readonly string[]> }>;

/**
 * Types whose removal history payload is not the cascade result verbatim.
 *
 * Leaf and brace narrow `null` to `undefined`; branch adds the trunk diameter
 * reprofile its removal triggers. Everything else pushes the shape it got.
 */
export const RESHAPED_REMOVAL_PAYLOADS: ReadonlySet<SupportTypeId> = new Set<SupportTypeId>([
    'leaf', 'brace', 'branch',
]);

/**
 * The entity type living in each collection, so a removal result can be typed
 * from the declared shape rather than restated at every call site.
 */
export type SupportEntityIn<K extends SupportCollectionKey> = SupportEntityByCollection[K];

/**
 * What a collection's entities look like when reported in a cascade.
 *
 * Read from SupportRemovedEntityByCollection, which names the one collection
 * that reports a nested shape. No type is named here.
 */
export type RemovedEntity<K extends SupportCollectionKey> = SupportRemovedEntityByCollection[K];

type CascadeField<K extends SupportCollectionKey, F> =
    F extends readonly string[]
        ? { [S in F[number]]: RemovedEntity<K> | null }
        : F extends `${string}s`
            ? { [S in F & string]: RemovedEntity<K>[] }
            : { [S in F & string]: RemovedEntity<K> | null };

type CascadeResult<C> = C extends Readonly<Record<string, unknown>>
    ? { [K in keyof C]: K extends SupportCollectionKey ? CascadeField<K, C[K]> : never }[keyof C]
    : never;

/**
 * What `removeSupportEntity` returns for a given type, derived from
 * {@link SUPPORT_REMOVAL_SHAPES}.
 *
 * Callers get precise field names and entity types without writing them out, so
 * renaming a field in the shape map is a compile error at every consumer rather
 * than a silent undo failure.
 */
export type SupportRemovalResult<T extends SupportTypeId> =
    { [S in (typeof SUPPORT_REMOVAL_SHAPES)[T]['self']]: RemovedEntity<(typeof SUPPORT_TYPE_COLLECTION)[T]> }
    & UnionToIntersection<CascadeResult<(typeof SUPPORT_REMOVAL_SHAPES)[T]['cascade']>>;

/**
 * A type's entity under the field name its removal shape declares.
 *
 * The add payload for a simple type is just this: `{ twig: Twig }` and so on.
 * Three of those were written out by hand, each repeating the `self` field the
 * shape map already names.
 */
export type SupportEntityPayload<T extends SupportTypeId> =
    { [S in (typeof SUPPORT_REMOVAL_SHAPES)[T]['self']]: RemovedEntity<(typeof SUPPORT_TYPE_COLLECTION)[T]> };

type UnionToIntersection<U> =
    (U extends unknown ? (arg: U) => void : never) extends (arg: infer I) => void ? I : never;

/** Type id -> the collection its entities live in, kept literal for the above. */
export const SUPPORT_TYPE_COLLECTION: SupportCollectionByType = {
    trunk: 'trunks', branch: 'branches', leaf: 'leaves', twig: 'twigs',
    stick: 'sticks', brace: 'braces', anchor: 'anchors', kickstand: 'kickstands',
};

/** Compile-time check that every support type declares a removal shape. */
type _RemovalShapesCoverEveryType =
    Exclude<SupportTypeId, keyof typeof SUPPORT_REMOVAL_SHAPES> extends never ? true : never;
const _removalShapesCoverEveryType: _RemovalShapesCoverEveryType = true;
void _removalShapesCoverEveryType;

/**
 * How a type derives settings from an entity when it carries no encoded hex.
 *
 * A slot rather than an import: the inference reads other collections, so it
 * lives in `state.ts` and registers itself at load.
 */
type SettingsInference = (entity: unknown, base?: unknown) => unknown;

const SETTINGS_INFERENCE = new Map<SupportTypeId, SettingsInference>();

export function registerSettingsInference<E, B, R>(
    typeId: SupportTypeId,
    infer: (entity: E, base?: B) => R,
): void {
    SETTINGS_INFERENCE.set(typeId, infer as SettingsInference);
}

/** Whether a type registered its own rule, rather than taking the generic one. */
export function hasSettingsInference(typeId: SupportTypeId): boolean {
    return SETTINGS_INFERENCE.has(typeId);
}

/** Settings inferred for `entity`, or null when the type declares no rule. */
export function inferSupportSettings<R>(typeId: SupportTypeId, entity: unknown, base?: unknown): R | null {
    const infer = SETTINGS_INFERENCE.get(typeId);
    return infer ? (infer(entity, base) as R) : null;
}

/**
 * How a collection puts one entity back, for undo.
 *
 * A slot rather than an import: the adders live in `state.ts`, and kickstands
 * take a nested build rather than a bare entity. Keyed by collection so the
 * `roots` and `knots` primitives participate alongside the types.
 */
type CollectionRestore = (entity: unknown) => void;

const COLLECTION_RESTORE = new Map<SupportCollectionKey, CollectionRestore>();

export function registerCollectionRestore(
    key: SupportCollectionKey,
    restore: CollectionRestore,
): void {
    COLLECTION_RESTORE.set(key, restore);
}

/** Puts one entity back into `key`. Throws if the collection declared no rule. */
export function restoreToCollection(key: SupportCollectionKey, entity: unknown): void {
    const restore = COLLECTION_RESTORE.get(key);
    if (!restore) throw new Error(`no restore registered for collection "${key}"`);
    restore(entity);
}

/** Whether every collection in the graph can be restored. For a startup check. */
export function collectionsMissingRestore(): SupportCollectionKey[] {
    return SUPPORT_COLLECTION_KEYS.filter((key) => !COLLECTION_RESTORE.has(key));
}

/**
 * Position-bearing fields a model transform must move, beyond the segments and
 * contact fields every shafted type shares.
 *
 * Declared because they are the only per-type difference in the transform's
 * apply phase: a brace carries a bezier curve, an anchor its own root position
 * and joint. Everything else is derived from `hasSegments` and `contactFields`.
 */
/**
 * The contact primitives this type carries, lower end first, each with its end
 * and kind -- so a caller never infers either from the field name.
 */
export function contactEndpointsFor(
    typeId: SupportTypeId,
): readonly { end: 'lower' | 'upper'; kind: 'cone' | 'disk'; field: string }[] {
    const descriptor = getSupportTypeDescriptor(typeId);
    const contacts: { end: 'lower' | 'upper'; kind: 'cone' | 'disk'; field: string }[] = [];
    for (const end of ['lower', 'upper'] as const) {
        const endpoint = descriptor[end];
        if ((endpoint.kind === 'cone' || endpoint.kind === 'disk') && endpoint.field) {
            contacts.push({ end, kind: endpoint.kind, field: endpoint.field });
        }
    }
    return contacts;
}

/** Whether any contact this type declares satisfies `test`. */
export function anyContactMatches(
    typeId: SupportTypeId,
    entity: unknown,
    test: (contact: unknown) => boolean,
): boolean {
    const record = entity as Record<string, unknown> | null | undefined;
    if (!record) return false;
    return contactEndpointsFor(typeId).some(({ field }) => test(record[field]));
}

/** A settings path a placement threshold may read from. */
export type SupportPlacementSettingPath = 'meshToMesh.stickVsTwigCutoffMm';

/** Reads a declared settings path off the live settings. */
function readPlacementSetting(path: SupportPlacementSettingPath): number | undefined {
    const settings = getSettings();
    switch (path) {
        case 'meshToMesh.stickVsTwigCutoffMm':
            return settings.meshToMesh?.stickVsTwigCutoffMm;
    }
}

/** Resolves a threshold, reading the named setting when there is one. */
function thresholdMm(
    threshold: SupportPlacementThreshold | undefined,
    readSetting: (path: SupportPlacementSettingPath) => number | undefined,
): number | undefined {
    if (threshold === undefined) return undefined;
    if (typeof threshold === 'number') return threshold;
    return readSetting(threshold.setting) ?? threshold.fallback;
}

/**
 * Which type serves a measurement, or null when none declares a range for it.
 *
 * Bounds are half-open, so adjacent types meet without overlapping and the
 * answer is unambiguous.
 */
export function selectTypeForPlacement(
    metric: SupportPlacementMetric,
    valueMm: number,
    readSetting: (path: SupportPlacementSettingPath) => number | undefined = readPlacementSetting,
): SupportTypeId | null {
    // A NaN measurement satisfies no comparison, so an unbounded side would
    // otherwise let it through.
    if (!Number.isFinite(valueMm)) return null;

    for (const descriptor of SUPPORT_TYPES) {
        const rule = descriptor.placementRule;
        if (!rule || rule.metric !== metric) continue;

        const min = thresholdMm(rule.minMm, readSetting);
        const max = thresholdMm(rule.maxMm, readSetting);
        const boundaryOwner = rule.boundary ?? 'lower';
        if (min !== undefined && (boundaryOwner === 'lower' ? valueMm <= min : valueMm < min)) continue;
        if (max !== undefined && (boundaryOwner === 'lower' ? valueMm > max : valueMm >= max)) continue;
        return descriptor.id;
    }
    return null;
}

/** Every type declaring a rule for this metric, in registry order. */
export function typesForPlacementMetric(metric: SupportPlacementMetric): readonly SupportTypeDescriptor[] {
    return SUPPORT_TYPES.filter((descriptor) => descriptor.placementRule?.metric === metric);
}

/**
 * One type's auto-placement policy, empty when it declares none -- so a caller
 * reads a field and falls back without testing the type by name.
 */
export function autoPlacementFor(typeId: SupportTypeId): SupportAutoPlacement {
    return getSupportTypeDescriptor(typeId).autoPlacement ?? {};
}

/** Every type declaring an auto-placement policy, in registry order. */
export function typesWithAutoPlacement(): readonly SupportTypeId[] {
    return SUPPORT_TYPES.filter((descriptor) => descriptor.autoPlacement).map((d) => d.id);
}

/**
 * The order to consult live placement previews in for one question, given
 * which placement modes are active.
 *
 * A type whose own mode is active can rank earlier -- the preview the user is
 * currently steering answers first. A type may appear twice for that reason,
 * which the originals did too; the caller takes the first with an answer, so a
 * repeat is harmless.
 */
export function previewTypesByPriority(
    purpose: SupportPreviewPurpose,
    activeModes: Partial<Record<SupportTypeId, boolean>>,
): readonly SupportTypeId[] {
    const entries: Array<{ id: SupportTypeId; at: number }> = [];

    for (const descriptor of SUPPORT_TYPES) {
        const priority = descriptor.previewPriority?.[purpose];
        if (!priority) continue;

        const active = !!activeModes[descriptor.id];
        if (priority.onlyWhileActive && !active) continue;

        if (active && priority.whileActive !== undefined) {
            entries.push({ id: descriptor.id, at: priority.whileActive });
        }
        entries.push({ id: descriptor.id, at: priority.rank });
    }

    return entries.sort((a, b) => a.at - b.at).map((entry) => entry.id);
}

/**
 * What a lateral stabiliser is asked for.
 *
 * Auto-bracing needs two bracing axes on a tall shaft. When no neighbouring
 * shaft is in reach there is nothing to brace against, so it asks the registry
 * for a support that stabilises on its own.
 */
export interface LateralStabiliserRequest {
    /** The whole store, for collision and occupancy checks. */
    snapshot: unknown;
    /** The stabilisers already present, plus the roots and knots they own. */
    existing: unknown;
    /** Auto-bracing settings; the generator reads its own thresholds from here. */
    settings: unknown;
    /** Bracing axes already satisfied, so the generator knows what is missing. */
    existingEdges: ReadonlyArray<{ a: string; b: string; angleRad: number }>;
    gridSettings: { enabled: boolean; spacingMm: number };
}

/** Builds stabilisers for shafts that bracing alone cannot satisfy. */
type LateralStabiliserGenerator = (request: LateralStabiliserRequest) => unknown[];

const LATERAL_STABILISERS = new Map<SupportTypeId, LateralStabiliserGenerator>();

/**
 * Registered from the type's own folder. A type that can stand a shaft up
 * without a partner registers here; auto-bracing asks rather than importing.
 */
export function registerLateralStabiliser(
    typeId: SupportTypeId,
    generate: LateralStabiliserGenerator,
): void {
    LATERAL_STABILISERS.set(typeId, generate);
}

/** Every registered stabiliser, in registry order. */
export function lateralStabiliserTypes(): readonly SupportTypeId[] {
    return SUPPORT_TYPES.filter((d) => LATERAL_STABILISERS.has(d.id)).map((d) => d.id);
}

/** Runs one type's generator, or returns nothing when it registers none. */
export function generateLateralStabilisers(
    typeId: SupportTypeId,
    request: LateralStabiliserRequest,
): unknown[] {
    return LATERAL_STABILISERS.get(typeId)?.(request) ?? [];
}

/** What a bridge builder is handed: two model contacts and how to size them. */
export interface ContactBridgeRequest {
    modelId: string;
    aPos: { x: number; y: number; z: number };
    aNormal: { x: number; y: number; z: number };
    bPos: { x: number; y: number; z: number };
    bNormal: { x: number; y: number; z: number };
    shaftDiameterMm?: number;
    tipContactDiameterMm?: number;
    /**
     * Checked for clearance when given, so a preview can show the failure.
     * Structural rather than `THREE.Mesh` -- the registry declares rules and
     * does not depend on the renderer.
     */
    mesh?: { isMesh: boolean };
}

/**
 * A built bridge and whatever limitation building it ran into.
 *
 * Both builders already returned this pair under their own entity field name;
 * `entity` is the same value under a name a caller can read without knowing
 * which type it asked for.
 */
export interface ContactBridgeResult {
    entity: { id: string };
    error?: string;
}

type ContactBridgeBuilder = (request: ContactBridgeRequest) => ContactBridgeResult | null;

const CONTACT_BRIDGE_BUILDERS = new Map<SupportTypeId, ContactBridgeBuilder>();

/**
 * Registered from the type's own folder. A type that can bridge two model
 * contacts registers how to build one, so a caller that asked
 * `selectTypeForPlacement` which type to use can build it without turning
 * that answer back into a name.
 */
export function registerContactBridgeBuilder(
    typeId: SupportTypeId,
    build: ContactBridgeBuilder,
): void {
    CONTACT_BRIDGE_BUILDERS.set(typeId, build);
}

/** Builds one type's bridge, or nothing when it registers no builder. */
export function buildContactBridge(
    typeId: SupportTypeId,
    request: ContactBridgeRequest,
): ContactBridgeResult | null {
    return CONTACT_BRIDGE_BUILDERS.get(typeId)?.(request) ?? null;
}

/** Every type that has registered a bridge builder, in registry order. */
export function contactBridgeTypes(): readonly SupportTypeId[] {
    return SUPPORT_TYPES.filter((d) => CONTACT_BRIDGE_BUILDERS.has(d.id)).map((d) => d.id);
}

export const SUPPORT_TRANSFORM_EXTRAS = {
    brace: ['curve'],
    anchor: ['rootPos', 'joint'],
} as const satisfies Partial<Record<SupportTypeId, readonly string[]>>;

/** Extra transform fields this type declares, or none. */
export function transformExtrasFor(typeId: SupportTypeId): readonly string[] {
    return (SUPPORT_TRANSFORM_EXTRAS as Record<string, readonly string[]>)[typeId] ?? [];
}

/**
 * Types whose entities have editable settings, and can be a sidebar target.
 *
 * Derived, so a new type with settings joins by declaring the flag.
 */
export const EDITABLE_SUPPORT_TYPES: readonly SupportTypeDescriptor[] =
    SUPPORT_TYPES.filter((descriptor) => descriptor.hasEditableSettings);

/** Whether `id` names a type with editable settings. */
export function isEditableSupportType(id: string): id is SupportTypeId {
    return EDITABLE_SUPPORT_TYPES.some((descriptor) => descriptor.id === id);
}

/**
 * Where an auto-placed support came from, and what that implies.
 *
 * `convertibleToTree` gates trunk-to-tree conversion: anchors sit near the
 * plate and island trunks carry their own geometry, so neither converts.
 */
export const SUPPORT_ORIGINS = {
    anchor: { convertibleToTree: false },
    overhang: { convertibleToTree: true },
    island: { convertibleToTree: false },
    standalone: { convertibleToTree: true },
} as const;

export type SupportOriginId = keyof typeof SUPPORT_ORIGINS;

/** Whether a trunk with this origin may be converted into a tree. */
export function isOriginConvertibleToTree(origin: string | undefined): boolean {
    if (!origin) return false;
    return SUPPORT_ORIGINS[origin as SupportOriginId]?.convertibleToTree ?? false;
}

/**
 * Ids of every Roots entry some entity still claims.
 *
 * A root outlives the entity that made it unless something culls it, so callers
 * need the live set. Derived from `ownsRoot` rather than named types: a new
 * root-owning type would otherwise have its roots collected as garbage.
 */
export function collectOwnedRootIds(
    collections: Partial<Record<SupportCollectionKey, Record<string, unknown>>>,
): Set<string> {
    const owned = new Set<string>();
    for (const descriptor of SUPPORT_TYPES) {
        if (!descriptor.ownsRoot) continue;
        const record = collections[descriptor.location.key];
        if (!record) continue;
        for (const entity of Object.values(record)) {
            const rootId = (entity as { rootId?: string }).rootId;
            if (rootId) owned.add(rootId);
        }
    }
    return owned;
}

const BY_ID = new Map<SupportTypeId, SupportTypeDescriptor>(
    SUPPORT_TYPES.map((descriptor) => [descriptor.id, descriptor]),
);

export function getSupportTypeDescriptor(id: SupportTypeId): SupportTypeDescriptor {
    const descriptor = BY_ID.get(id);
    if (!descriptor) throw new Error(`Unknown support type: ${id}`);
    return descriptor;
}

export function getSupportTypeBySelectionCategory(
    category: string | null | undefined,
): SupportTypeDescriptor | null {
    if (!category) return null;
    return SUPPORT_TYPES.find((descriptor) => descriptor.selectionCategory === category) ?? null;
}

/**
 * The placement surface an entity contacts, from whichever contact field is set.
 *
 * Braces and kickstands declare no contact fields and always return undefined.
 */
export function getPlacementSurface(
    descriptor: SupportTypeDescriptor,
    entity: unknown,
): 'interior' | 'exterior' | undefined {
    const record = entity as Record<string, { placementSurface?: 'interior' | 'exterior' } | undefined>;
    for (const field of descriptor.contactFields) {
        const surface = record[field]?.placementSurface;
        if (surface) return surface;
    }
    return undefined;
}

/** Collections whose entities have real shafts, for segment and joint walks. */
export const SHAFTED_COLLECTION_KEYS: readonly SupportCollectionKey[] = SUPPORT_TYPES
    .filter((descriptor) => descriptor.hasSegments)
    .map((descriptor) => descriptor.location.key as SupportCollectionKey);

/**
 * Types held in SupportState, in registry order.
 *
 * Every type, while there is one store. Kept as its own name because the
 * question is "what does the store hold", not "what types exist" -- the two
 * coincide today and would diverge again if a type ever lived elsewhere.
 */
export const SUPPORT_STATE_TYPES: readonly SupportTypeDescriptor[] = SUPPORT_TYPES.filter(
    (descriptor) => descriptor.location.store === 'support',
);

/** Types whose instances carry a modelId. */
export const MODEL_ID_TYPES: readonly SupportTypeDescriptor[] = SUPPORT_TYPES.filter(
    (descriptor) => descriptor.carriesModelId,
);

/**
 * Collections on SupportState that are not support types. Roots and knots are
 * primitives — they belong to a support rather than being one — but they are
 * still selectable and still need an empty collection at startup.
 *
 * ADDING A SUPPORT TYPE: this list is not the place. Add a descriptor to
 * SUPPORT_TYPES above instead.
 */
export const SUPPORT_PRIMITIVE_COLLECTIONS: readonly {
    key: SupportCollectionKey;
    selectionCategory: SupportSelectionCategory;
    /**
     * How the primitive links to the rest of the graph.
     *
     * A knot's `parentShaftId` is the busiest edge there is -- nearly every
     * cascade travels it -- so a walk that only reads SUPPORT_TYPES misses the
     * majority of what a removal should take.
     */
    edges: readonly SupportEdge[];
}[] = [
    { key: 'roots', selectionCategory: 'root', edges: [] },
    {
        key: 'knots',
        selectionCategory: 'knot',
        edges: [{ field: 'parentShaftId', to: 'segment', ownership: 'hostedBy' }],
    },
];

/** Every collection in the dependency graph, types and primitives both. */
export const SUPPORT_GRAPH_NODES: readonly {
    key: SupportCollectionKey;
    edges: readonly SupportEdge[];
    hasSegments: boolean;
}[] = [
    ...SUPPORT_TYPES.map((descriptor) => ({
        key: descriptor.location.key,
        edges: descriptor.edges,
        hasSegments: descriptor.hasSegments,
    })),
    ...SUPPORT_PRIMITIVE_COLLECTIONS.map((primitive) => ({
        key: primitive.key,
        edges: primitive.edges,
        hasSegments: false,
    })),
];

/** Collections selection resolves by direct id lookup: roots, then support types. */
export const SUPPORT_STATE_COLLECTIONS: readonly {
    key: SupportCollectionKey;
    selectionCategory: SupportSelectionCategory;
}[] = [
    { key: 'roots', selectionCategory: 'root' },
    ...SUPPORT_STATE_TYPES.map((descriptor) => ({
        key: descriptor.location.key as SupportCollectionKey,
        selectionCategory: descriptor.selectionCategory,
    })),
];

/** An empty collection per SupportState entity key, for initial and reset state. */
export function createEmptySupportCollections(): Pick<SupportState, SupportCollectionKey> {
    const collections = {} as Record<SupportCollectionKey, Record<string, never>>;
    for (const { key } of SUPPORT_PRIMITIVE_COLLECTIONS) collections[key] = {};
    for (const descriptor of SUPPORT_STATE_TYPES) {
        collections[descriptor.location.key as SupportCollectionKey] = {};
    }
    return collections as Pick<SupportState, SupportCollectionKey>;
}

/** Entity collection keys on SupportState: primitives first, then support types. */
export const SUPPORT_COLLECTION_KEYS: readonly SupportCollectionKey[] = [
    ...SUPPORT_PRIMITIVE_COLLECTIONS.map((c) => c.key),
    ...SUPPORT_STATE_TYPES.map((d) => d.location.key as SupportCollectionKey),
];

/**
 * Categories that count as "a support is selected": every type, plus `root`.
 *
 * Knots are excluded -- selecting one is selecting an attachment point, which
 * the multi-selection paths treat as not-a-support.
 */
export const SUPPORT_SELECTION_CATEGORIES: ReadonlySet<SupportSelectionCategory> = new Set([
    ...SUPPORT_TYPES.map((descriptor) => descriptor.selectionCategory),
    'root' as SupportSelectionCategory,
]);

/** Per-collection counts, for load diagnostics. */
export function countSupportCollections(
    snapshot: Pick<SupportState, SupportCollectionKey>,
): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const key of SUPPORT_COLLECTION_KEYS) counts[key] = Object.keys(snapshot[key]).length;
    return counts;
}

/** SupportState collection keys whose entities carry a modelId, in registry order. */
export const MODEL_ID_COLLECTION_KEYS: readonly SupportCollectionKey[] = [
    'roots' as SupportCollectionKey,
    ...SUPPORT_STATE_TYPES
        .filter((d) => d.carriesModelId)
        .map((d) => d.location.key as SupportCollectionKey),
];

/**
 * The support hanging off a knot, from the declared `hostedBy` edges onto
 * `knots`. `order` decides which wins when several types name the same knot.
 */
export function findKnotHost(
    state: Pick<SupportState, SupportCollectionKey>,
    knotId: string,
    order: readonly SupportTypeId[],
): { typeId: SupportTypeId; id: string } | null {
    for (const typeId of order) {
        const descriptor = getSupportTypeDescriptor(typeId);
        const fields = descriptor.edges
            .filter((edge) => edge.to === 'knots' && edge.ownership === 'hostedBy')
            .map((edge) => edge.field);
        if (fields.length === 0) continue;

        const record = state[descriptor.location.key] as unknown as
            Record<string, Record<string, unknown>>;
        for (const entity of Object.values(record ?? {})) {
            if (fields.some((field) => entity[field] === knotId)) {
                return { typeId, id: entity.id as string };
            }
        }
    }
    return null;
}

/** Precedence `findKnotHost` resolves in when several types name one knot. */
export const KNOT_HOST_PRECEDENCE: readonly SupportTypeId[] = [
    'leaf', 'branch', 'brace', 'kickstand',
];

/**
 * Whether each type's joint drags publish a live shaft preview.
 *
 * `as const satisfies` keeps the literals, so `JointDragPreviewTypeId` narrows
 * to exactly the types declared true.
 */
export const JOINT_DRAG_PREVIEW_BY_TYPE = {
    trunk: true,
    branch: true,
    leaf: false,
    twig: false,
    stick: false,
    brace: false,
    anchor: false,
    kickstand: true,
} as const satisfies Record<SupportTypeId, boolean>;

/** The types whose joint drags publish a preview. */
export type JointDragPreviewTypeId = {
    [K in SupportTypeId]: (typeof JOINT_DRAG_PREVIEW_BY_TYPE)[K] extends true ? K : never;
}[SupportTypeId];

export const JOINT_DRAG_PREVIEW_TYPES: readonly JointDragPreviewTypeId[] =
    (Object.keys(JOINT_DRAG_PREVIEW_BY_TYPE) as SupportTypeId[])
        .filter((id): id is JointDragPreviewTypeId => JOINT_DRAG_PREVIEW_BY_TYPE[id]);

/** Whether an untrusted `kind` off a preview event names such a type. */
export function isJointDragPreviewType(kind: string): kind is JointDragPreviewTypeId {
    return (JOINT_DRAG_PREVIEW_TYPES as readonly string[]).includes(kind);
}

/**
 * Mirrors each descriptor's `claimsModelSurfaceGestures` with the literals kept,
 * so the owner union narrows instead of widening to every type.
 * `supportPlacementRouting.test.ts` holds the two in step.
 */
export const MODEL_SURFACE_GESTURE_BY_TYPE = {
    trunk: false,
    branch: true,
    leaf: true,
    twig: false,
    stick: false,
    brace: false,
    anchor: false,
    kickstand: false,
} as const satisfies Record<SupportTypeId, boolean>;

/** The types the placement router hands model-face gestures to. */
export type ModelSurfaceGestureTypeId = {
    [K in SupportTypeId]: (typeof MODEL_SURFACE_GESTURE_BY_TYPE)[K] extends true ? K : never;
}[SupportTypeId];

/**
 * How many segments one instance contributes when it carries none of its own.
 *
 * A brace spans one implicit segment between its two knots, which is why it has
 * a `segmentSelectionPrefix` to select it by. A leaf's contact cone is a knot
 * host but not a segment, so `knotHostPrefix` cannot answer this.
 */
export function implicitSegmentCount(descriptor: SupportTypeDescriptor): number {
    if (descriptor.hasSegments) return 0;
    return descriptor.segmentSelectionPrefix ? 1 : 0;
}

/**
 * The name one of this type's groups carries in an exported mesh.
 *
 * `Trunk_<id>`, `Kickstand_<id>` and so on: the singular, capitalised. These
 * strings land in exported 3MF and OBJ files, so a type's name reaching the
 * registry reaches the export too -- which is the point, but it does mean
 * renaming a type renames its groups in every file written afterwards.
 */
export function exportGroupName(typeId: SupportTypeId, entityId: string): string {
    const { singular } = getSupportTypeDescriptor(typeId);
    return `${singular.charAt(0).toUpperCase()}${singular.slice(1)}_${entityId}`;
}

/**
 * Split a knot's `parentShaftId` into the type it rides and that entity's id,
 * or null when it names a real shaft segment.
 *
 * A knot rides either a real segment or a pseudo-shaft -- a leaf's contact
 * cone, a brace's span -- whose prefix each type declares. Callers ask rather
 * than spelling the prefix out, so renaming a type moves the string with it.
 */
export function parseKnotHostId(
    parentShaftId: string,
): { typeId: SupportTypeId; entityId: string } | null {
    for (const descriptor of SUPPORT_TYPES) {
        const prefix = descriptor.knotHostPrefix;
        if (!prefix || !parentShaftId.startsWith(prefix)) continue;
        return { typeId: descriptor.id, entityId: parentShaftId.slice(prefix.length) };
    }
    return null;
}

/** The `parentShaftId` a knot carries when it rides this type's pseudo-shaft. */
export function knotHostId(typeId: SupportTypeId, entityId: string): string {
    const prefix = getSupportTypeDescriptor(typeId).knotHostPrefix;
    if (!prefix) throw new Error(`${typeId} declares no knotHostPrefix; its knots ride real segments`);
    return `${prefix}${entityId}`;
}

/**
 * Split a prefixed segment selection id into the type that owns it and the
 * entity id, or null when the id is a real segment id. The prefix is declared
 * per type, so no caller spells one out.
 */
export function parsePrefixedSegmentId(
    segmentId: string,
): { typeId: SupportTypeId; entityId: string } | null {
    for (const descriptor of SUPPORT_TYPES) {
        const prefix = descriptor.segmentSelectionPrefix;
        if (!prefix || !segmentId.startsWith(prefix)) continue;
        return { typeId: descriptor.id, entityId: segmentId.slice(prefix.length) };
    }
    return null;
}

export const MODEL_SURFACE_GESTURE_TYPES: readonly ModelSurfaceGestureTypeId[] =
    (Object.keys(MODEL_SURFACE_GESTURE_BY_TYPE) as SupportTypeId[])
        .filter((id): id is ModelSurfaceGestureTypeId => MODEL_SURFACE_GESTURE_BY_TYPE[id]);
