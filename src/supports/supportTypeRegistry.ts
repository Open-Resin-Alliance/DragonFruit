import type { Branch, Knot, Roots, SupportCollectionByType, SupportCollectionName, SupportEntityAny, SupportEntityByCollection, SupportFieldsByType, SupportRemovedEntityByCollection, SupportState, Trunk } from './types';
import { SUPPORT_UPDATE_TRUNK, SUPPORT_UPDATE_BRANCH } from './history/actionTypes';
import type { SupportHistoryActionType } from './history/actionTypes';
import { ANCHOR_HEIGHT_THRESHOLD_MM } from './autoSupport/constants';
import { getSettings } from './Settings/state';

/**
 * The sidebar's tabs, by the PAGE each opens rather than by a type.
 *
 * The support-info tab carries the contact cone, cone angle and root settings
 * that apply to supports generally, so it is not any one type's page. Two of
 * the four are also tool panel ids, where page and tool are the same thing.
 */
export type SidebarTab = 'supportInfo' | 'raft' | 'grid' | 'bracing';

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
    /**
     * For `inlineRoot`: the field holding the base's radius.
     *
     * An inline root is plate geometry on the entity itself, so its width is a
     * field of that entity rather than the `diameter` of a shared `Roots` record.
     */
    radiusField?: string;
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
    /**
     * Plural display name, so panels listing collections need no label table.
     *
     * RENAMING A TYPE MUST UPDATE THIS. It is a second spelling of the type's
     * name, and cannot be derived from `id`: these plurals are irregular
     * (`leaf` -> `Leaves`, not `Leafs`). No rename check catches it.
     */
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
    /**
     * The sidebar tab this type is edited under. Declared for every type, even
     * one the sidebar has no panel for yet.
     */
    sidebarTab: SidebarTab;
    /**
     * Whether this type's diameter is re-solved from the members it carries. A
     * removal that changes them re-solves the host through
     * `computeAndApplySupportDiameterProfile`.
     */
    recomputesDiameterFromAttachments: boolean;
    /**
     * Whether adding one of these re-solves the diameter of the host it hangs
     * from. The host declares `recomputesDiameterFromAttachments` (it can be
     * re-solved); this says adding one changes what it carries.
     */
    repairsHostDiameterOnAdd: boolean;
    /**
     * Whether the bridge search may reach sideways to land this type.
     *
     * Twig alone: a twig is short, so it can prop a contact off a neighbouring
     * surface the near search misses. A stick has to stay near vertical and
     * keeps the near search, so the sideways reach never applies to it.
     */
    mayReachSideways: boolean;
    /**
     * Whether instances can host a fan link off their shaft. Read by
     * `collectFanShaftPoints`, which builds the fan host pool, and by
     * auto-placement, which records a grid-placed instance as a near-only host.
     */
    canBeGridHost: boolean;
    /**
     * Whether a kickstand's host knot may ride this type's segments.
     *
     * Trunk and branch: a kickstand braces a shaft standing in the print. Read
     * through `KICKSTAND_HOST_TYPES`, or `KICKSTAND_HOST_BY_TYPE` for the union.
     */
    hostsKickstand: boolean;
    /**
     * Whether the auto-support pass places this type and the ledger reports it.
     * A type added by hand or by its own tool declares false. Read through
     * `AUTO_PLACED_TYPE_IDS`, or `AUTO_PLACED_BY_TYPE` for the narrowed union.
     */
    isAutoPlaced: boolean;
    /**
     * Whether instances carry real shafts, for segment and joint walks. */
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
     * Whether auto-bracing may brace this type's shafts. Read through
     * `autoBraceableShaftTypes()`, which also requires a shaft and excludes
     * lateral stabilisers, those being generated by the pass itself.
     */
    isAutoBraceable: boolean;
    /**
     * Whether the auto-bracing hotkey is available while this type's tool is
     * active. Stick is the auto-placed span support auto-bracing adds braces
     * to, so its tool is where the hotkey runs.
     */
    hasAutoBracingHotkey?: boolean;
    /**
     * Whether a brace endpoint snaps to this type's contact cone (a primitive)
     * rather than a shaft segment. Leaf alone: it carries no shaft, so a brace
     * snaps to its cone. The brace snap code reads this flag instead of naming
     * the type, so a rename reaches only this descriptor.
     */
    hostsBraceSnapCone?: boolean;
    /**
     * The measurement range this type serves, when the type is chosen
     * automatically rather than picked by the user.
     *
     * A missing bound is unbounded on that side; `boundary` decides who owns
     * a value sitting exactly on a shared bound.
     * Enforced by `__tests__/placementRules.test.ts`.
     */
    placementRule?: SupportPlacementRule;
    /**
     * Names this type was known by before, for reading payloads written then.
     * `migrateSupportPayload` is the only reader.
     */
    renamedFrom?: {
        /** Type ids this type's entities were stamped with. */
        ids?: readonly string[];
        /** SupportState collection keys its entities were stored under. */
        collectionKeys?: readonly string[];
    };
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
     * Where this type sits when several live previews answer the same question,
     * per purpose; lower ranks first, and a type omitted is never consulted.
     * `whileActive` is an earlier rank used only while this type's placement
     * mode is active; `onlyWhileActive` drops it from the order otherwise.
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
    /**
     * Which shaft this type's contact-cone body follows. The resize pass
     * thickens shafts after cones are built, so `syncContactConeDiameters` sets
     * the body back to the shaft; the tip diameter never moves. Declaring a
     * source also makes this type's segments readable as a host for a cone
     * hosted through a knot.
     *
     * - `ownLastSegment` -- the shaft climbs into the cone;
     * - `ownFirstSegment` -- the shaft leaves the cone and hangs down;
     * - `hostKnotSegment` -- the cone sits on the model, and the host shaft is
     *   read through the knot this entity hangs from.
     *
     * Absent means neither role: the cone body is left as placed and the
     * segments are offered as no host.
     */
    coneBodyFollows?: 'ownFirstSegment' | 'ownLastSegment' | 'hostKnotSegment';
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
     * Whether a curve drag that produces no preview re-reads the entity from
     * the store before committing. True for a type whose segments another
     * interaction (the elastic chain on a knot drag) updates mid-drag.
     */
    curveDragReconcilesFromStore?: boolean;
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
     * Whether a knot drag on this type's shaft defers elastic-chain solving to
     * release. True for the default host, whose knots are the common case and
     * skip the per-frame solve for a smoother preview.
     */
    knotDragDefersElasticPreview?: boolean;
    /**
     * Whether a knot drag on this type's shaft computes its preview on the main
     * thread rather than delegating to a worker. True for the default host,
     * whose previews are the common case and skip the worker handoff.
     */
    knotDragComputesInline?: boolean;
    /**
     * Whether this type's shaft flexes when the knot it hangs from is dragged.
     * The elastic solver walks its segment joints, so a type with no segments
     * to bend declares nothing and is skipped.
     */
    flexesOnHostKnotDrag?: boolean;
    /**
     * Whether a knot drag on this type's shaft updates the attached leaf cones'
     * wide-end diameter from the taper at the knot's new position.
     */
    knotDragUpdatesLeafConeDiameter?: boolean;
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
     * Stump is the one: its renderer draws the cone directly, and only while
     * selected.
     */
    batchesContactCones: boolean;
    /**
     * Whether the shared batched passes draw this type's shaft: its straight
     * segments and the joints they carry. A type whose shaft is a curve, or
     * whose renderer draws its joints directly, opts out.
     */
    batchesShaft: boolean;
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
        /**
         * Shaft diameter when the entity carries no segments. A number is the
         * constant; a `{ path }` reads the diameter off the entity (a dotted
         * path, resolved like `shaftTaper.from`).
         */
        fallbackDiameterMm?: number | { path: string };
    };
    /**
     * Whether instances have per-entity editable settings.
     *
     * Such a type is selectable in the settings sidebar and caches a
     * `settingsCodeHex` outside the entity, keyed by type and id -- so it must
     * evict on remove or the next entity reusing that id inherits stale values.
     */
    hasEditableSettings: boolean;
    /**
     * Whether the settings sidebar offers a panel for this type. Not the same
     * question as `hasEditableSettings`: the two sets genuinely differ.
     */
    offersSidebarPanel: boolean;
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
        sidebarTab: 'supportInfo',
        hasEditableSettings: true,
        offersSidebarPanel: true,
        recomputesDiameterFromAttachments: true,
        repairsHostDiameterOnAdd: false,
        mayReachSideways: false,
        canBeGridHost: true,
        hostsKickstand: true,
        edges: [{ field: 'rootId', to: 'roots', ownership: 'owns' }],
        ownsRoot: true,
        segmentsCarryBothJoints: false,
        hasDedicatedSnapPass: true,
        hasContactDiskLengthOverride: true,
        transformPropagatesToShaft: true,
        ownsEditHistoryEntry: true,
        jointDragUsesLivePreview: true,
        batchesContactCones: true,
        batchesShaft: true,
        bezierContextIdPrefix: '',
        broadcastsAttachmentsWhileDragging: false,
        knotTakesJointDiameter: true,
        projectsUnparameterisedKnots: true,
        knotDragDefersElasticPreview: true,
        knotDragComputesInline: true,
        interiorVisibility: 'contacts',
        jointDragMovesContacts: false,
        jointDragCanCurveShaft: true,
        contactFields: ['contactCone'],
        shaftFallback: { stubLengthMm: 10, startFallsBackToSplitPoint: false, fallbackDiameterMm: 1.5 },
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
        // The shaft climbs INTO the cone, so the terminal segment is the one
        // under it.
        coneBodyFollows: 'ownLastSegment',
        lower: { kind: 'plateRoot' },
        upper: { kind: 'cone', field: 'contactCone' },
        isAutoPlaced: true,
        hasSegments: true,
        label: 'Trunks',
        singular: 'trunk',
        location: { store: 'support', key: 'trunks' },
        selectionCategory: 'trunk',
        historyUpdate: SUPPORT_UPDATE_TRUNK,
    },
    {
        id: 'branch',
        sidebarTab: 'supportInfo',
        hasEditableSettings: true,
        offersSidebarPanel: true,
        flexesOnHostKnotDrag: true,
        edges: [{ field: 'parentKnotId', to: 'knots', ownership: 'hostedBy', takeHost: 'always' }],
        ownsRoot: false,
        segmentsCarryBothJoints: false,
        hasDedicatedSnapPass: true,
        hasContactDiskLengthOverride: true,
        transformPropagatesToShaft: true,
        ownsEditHistoryEntry: false,
        jointDragUsesLivePreview: true,
        curveDragReconcilesFromStore: true,
        batchesContactCones: true,
        batchesShaft: true,
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
        // The shaft leaves the cone and hangs DOWN, so the first segment is
        // the one under it.
        coneBodyFollows: 'ownFirstSegment',
        lower: { kind: 'knot' },
        upper: { kind: 'cone', field: 'contactCone' },
        recomputesDiameterFromAttachments: false,
        repairsHostDiameterOnAdd: true,
        mayReachSideways: false,
        canBeGridHost: false,
        hostsKickstand: true,
        isAutoPlaced: true,
        hasSegments: true,
        label: 'Branches',
        singular: 'branch',
        location: { store: 'support', key: 'branches' },
        selectionCategory: 'branch',
        historyUpdate: SUPPORT_UPDATE_BRANCH,
    },
    {
        id: 'leaf',
        sidebarTab: 'supportInfo',
        hasEditableSettings: true,
        offersSidebarPanel: true,
        knotHostPrefix: 'leafCone:',
        hostsBraceSnapCone: true,
        edges: [{ field: 'parentKnotId', to: 'knots', ownership: 'hostedBy', takeHost: 'ifUnused' }],
        ownsRoot: false,
        segmentsCarryBothJoints: true,
        hasDedicatedSnapPass: false,
        hasContactDiskLengthOverride: false,
        transformPropagatesToShaft: true,
        ownsEditHistoryEntry: false,
        jointDragUsesLivePreview: true,
        batchesContactCones: true,
        batchesShaft: false,
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
        // The cone sits on the model while the leaf hangs off a knot on someone
        // else's shaft, so the host is read through that knot.
        coneBodyFollows: 'hostKnotSegment',
        lower: { kind: 'knot' },
        upper: { kind: 'cone', field: 'contactCone' },
        recomputesDiameterFromAttachments: false,
        repairsHostDiameterOnAdd: false,
        mayReachSideways: false,
        canBeGridHost: false,
        hostsKickstand: false,
        isAutoPlaced: true,
        hasSegments: false,
        label: 'Leaves',
        singular: 'leaf',
        location: { store: 'support', key: 'leaves' },
        selectionCategory: 'leaf',
    },
    {
        id: 'twig',
        sidebarTab: 'supportInfo',
        hasEditableSettings: false,
        offersSidebarPanel: true,
        edges: [],
        ownsRoot: false,
        segmentsCarryBothJoints: true,
        hasDedicatedSnapPass: false,
        hasContactDiskLengthOverride: false,
        transformPropagatesToShaft: true,
        ownsEditHistoryEntry: false,
        jointDragUsesLivePreview: true,
        batchesContactCones: false,
        batchesShaft: true,
        bezierContextIdPrefix: 'twig-',
        broadcastsAttachmentsWhileDragging: true,
        knotDragUpdatesLeafConeDiameter: true,
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
        recomputesDiameterFromAttachments: false,
        repairsHostDiameterOnAdd: false,
        mayReachSideways: true,
        canBeGridHost: false,
        hostsKickstand: false,
        isAutoPlaced: true,
        hasSegments: true,
        label: 'Twigs',
        singular: 'twig',
        location: { store: 'support', key: 'twigs' },
        selectionCategory: 'twig',
    },
    {
        id: 'stick',
        sidebarTab: 'bracing',
        hasEditableSettings: false,
        offersSidebarPanel: true,
        edges: [],
        ownsRoot: false,
        segmentsCarryBothJoints: true,
        hasDedicatedSnapPass: false,
        hasContactDiskLengthOverride: false,
        transformPropagatesToShaft: true,
        ownsEditHistoryEntry: false,
        jointDragUsesLivePreview: true,
        batchesContactCones: true,
        batchesShaft: true,
        bezierContextIdPrefix: 'stick-',
        hasAutoBracingHotkey: true,
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
        recomputesDiameterFromAttachments: false,
        repairsHostDiameterOnAdd: false,
        mayReachSideways: false,
        canBeGridHost: false,
        hostsKickstand: false,
        isAutoPlaced: true,
        hasSegments: true,
        label: 'Sticks',
        singular: 'stick',
        location: { store: 'support', key: 'sticks' },
        selectionCategory: 'stick',
    },
    {
        id: 'brace',
        sidebarTab: 'supportInfo',
        // Two named knot fields rather than a list: the history payload and its
        // undo handler read them by name, and start/end are not interchangeable.
        hasEditableSettings: false,
        offersSidebarPanel: false,
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
        batchesShaft: false,
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
        recomputesDiameterFromAttachments: false,
        repairsHostDiameterOnAdd: false,
        mayReachSideways: false,
        canBeGridHost: false,
        hostsKickstand: false,
        isAutoPlaced: false,
        hasSegments: false,
        label: 'Braces',
        singular: 'brace',
        location: { store: 'support', key: 'braces' },
        selectionCategory: 'brace',
    },
    {
        id: 'stump',
        // Written before the rename, so payloads saved then still load.
        renamedFrom: { ids: ['anchor'], collectionKeys: ['anchors'] },
        sidebarTab: 'supportInfo',
        hasEditableSettings: false,
        offersSidebarPanel: false,
        edges: [],
        ownsRoot: false,
        segmentsCarryBothJoints: true,
        hasDedicatedSnapPass: false,
        hasContactDiskLengthOverride: false,
        transformPropagatesToShaft: false,
        ownsEditHistoryEntry: false,
        jointDragUsesLivePreview: true,
        batchesContactCones: false,
        batchesShaft: false,
        bezierContextIdPrefix: 'stump-',
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
        lower: { kind: 'inlineRoot', field: 'rootPos', radiusField: 'rootBaseDiameter' },
        upper: { kind: 'cone', field: 'contactCone' },
        recomputesDiameterFromAttachments: false,
        repairsHostDiameterOnAdd: false,
        mayReachSideways: false,
        canBeGridHost: false,
        hostsKickstand: false,
        isAutoPlaced: true,
        hasSegments: true,
        label: 'Stumps',
        singular: 'stump',
        location: { store: 'support', key: 'stumps' },
        selectionCategory: 'stump',
    },
    {
        id: 'kickstand',
        sidebarTab: 'supportInfo',
        hasEditableSettings: true,
        offersSidebarPanel: false,
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
        batchesShaft: true,
        bezierContextIdPrefix: 'kickstand-',
        broadcastsAttachmentsWhileDragging: false,
        knotTakesJointDiameter: false,
        projectsUnparameterisedKnots: false,
        interiorVisibility: 'hidden',
        jointDragMovesContacts: false,
        jointDragCanCurveShaft: true,
        contactFields: [],
        shaftFallback: { stubLengthMm: 5, startFallsBackToSplitPoint: false, fallbackDiameterMm: { path: 'profile.bodyDiameterMm' } },
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
        recomputesDiameterFromAttachments: false,
        repairsHostDiameterOnAdd: false,
        mayReachSideways: false,
        canBeGridHost: false,
        hostsKickstand: false,
        isAutoPlaced: false,
        hasSegments: true,
        label: 'Kickstands',
        singular: 'kickstand',
        location: { store: 'support', key: 'kickstands' },
        selectionCategory: 'kickstand',
        serialisedAsBundle: true,
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

/** Whether a type has already claimed its updater slot from its own folder. */
export function hasSupportUpdater(typeId: SupportTypeId): boolean {
    return UPDATERS.has(typeId);
}

/**
 * Resolves an id to its type by looking in the store. A slot, because importing
 * `state.ts` back would be an initialisation cycle. Consulted only for an
 * entity that lost its `typeId`.
 */
let resolveSupportTypeOfId: ((id: string) => SupportTypeId | null) | null = null;

/** Called once by state.ts. */
export function registerSupportTypeResolver(resolve: (id: string) => SupportTypeId | null): void {
    resolveSupportTypeOfId = resolve;
}

/**
 * The type an entity is, so a reader can dispatch without the caller restating
 * it. Falls back to the store's membership scan for an entity that lost its
 * `typeId` -- a whole-store payload restored through `setSnapshot` bypasses the
 * writers that stamp it.
 */
export function resolveSupportTypeIdOf(entity: { typeId?: SupportTypeId; id: string }): SupportTypeId | null {
    return entity.typeId ?? resolveSupportTypeOfId?.(entity.id) ?? null;
}

/**
 * Apply an entity back to the store.
 *
 * Two forms: `updateSupportEntity(entity)` reads the type off the entity and
 * is preferred; `(typeId, entity)` is for a fresh build that carries none yet.
 * Returns false when nothing is registered for the id.
 */
export function updateSupportEntity<E extends { typeId?: SupportTypeId; id: string }>(entity: E): boolean;
export function updateSupportEntity(typeId: SupportTypeId, entity: unknown): boolean;
export function updateSupportEntity(
    typeIdOrEntity: SupportTypeId | { typeId?: SupportTypeId; id: string },
    maybeEntity?: unknown,
): boolean {
    // A string first argument is the explicit form. Anything else must be the
    // entity, and its own `typeId` decides -- falling back to the store's
    // membership scan for an entity that lost the field on the way in.
    let typeId: SupportTypeId | null;
    let entity: unknown;
    if (typeof typeIdOrEntity === 'string') {
        typeId = typeIdOrEntity;
        entity = maybeEntity;
    } else {
        entity = typeIdOrEntity;
        typeId = resolveSupportTypeIdOf(typeIdOrEntity);
    }
    if (!typeId) return false;

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
    stump: { self: 'stump', cascade: { knots: 'knots', leaves: 'leaves' } },
    kickstand: { self: 'kickstand', cascade: { roots: 'roots', knots: 'knots', braces: 'braces', leaves: 'leaves', branches: 'branches', kickstands: 'kickstands' } },
    // `satisfies` keeps the literal narrowing the result types read, while
    // making a renamed type a compile error here rather than at the call site.
} as const satisfies Record<SupportTypeId, { self: string; cascade: Record<string, string | readonly string[]> }>;

/**
 * The shape a value-level type id maps to. The map above is `as const` so the
 * result types derive from its literals, which a `SupportTypeId` value cannot
 * index; this reads it without giving that up.
 */
export function removalShapeFor(typeId: SupportTypeId): { self: string; cascade: Record<string, string | readonly string[]> } {
    return (SUPPORT_REMOVAL_SHAPES as Record<SupportTypeId, { self: string; cascade: Record<string, string | readonly string[]> }>)[typeId];
}

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
    stick: 'sticks', brace: 'braces', stump: 'stumps', kickstand: 'kickstands',
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
/**
 * Whether a bridge of `typeId` may land where the search ended up. The search
 * runs near radii first; a type declaring `mayReachSideways` searches wider,
 * and landing beyond the near cutoff is a lateral prop.
 *
 * A plain function so the rule is testable: its caller is a React hook.
 */
export function bridgeMayLandSideways(
    typeId: SupportTypeId,
    distMm: number,
    cutoffMm: number,
    reachedSideways: boolean,
): boolean {
    if (!reachedSideways) return true;
    if (distMm <= cutoffMm) return true;
    return getSupportTypeDescriptor(typeId).mayReachSideways;
}

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

/** Whether this type is a lateral stabiliser, generated beside a group. */
export function isLateralStabiliserType(typeId: SupportTypeId | string): boolean {
    return (lateralStabiliserTypes() as readonly string[]).includes(typeId);
}

/** The type whose brace snap target is its contact cone (leaf), if any. */
export function braceSnapConeType(): SupportTypeId | null {
    return SUPPORT_TYPES.find((d) => d.hostsBraceSnapCone)?.id ?? null;
}

/**
 * Types whose shafts auto-bracing may brace to each other: `isAutoBraceable`
 * plus `hasSegments`, less the lateral stabilisers, which the pass offers
 * beside a group rather than bracing as members of one.
 *
 * The stabiliser half needs the type registrations loaded; the pass runs long
 * after load, and a test pins it.
 */
export function autoBraceableShaftTypes(): readonly SupportTypeId[] {
    const stabilisers = new Set(lateralStabiliserTypes());
    return SUPPORT_TYPES
        .filter((d) => d.isAutoBraceable && d.hasSegments && !stabilisers.has(d.id))
        .map((d) => d.id);
}

/** Whether this type's shafts may be braced to each other. */
export function isAutoBraceableShaftType(typeId: SupportTypeId | string): boolean {
    return (autoBraceableShaftTypes() as readonly string[]).includes(typeId);
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
    /**
     * True when a person aimed both contacts by hand, rather than the auto
     * pass filling a gap. The cant caps a bridge type declares keep the auto
     * pass from crossing a gap with a near-horizontal whisker; an explicit aim
     * is the user's call, so a manual bridge is built whatever its cant. Auto
     * callers leave this unset and keep the caps.
     */
    manual?: boolean;
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

/**
 * The entity type a given type id holds.
 *
 * Derived through `SUPPORT_TYPE_COLLECTION` and the collection's own entity
 * type, so a ninth type joins by being declared. Naming Trunk, Branch and the
 * rest here is the POINT of this module: the registry is where a type is named,
 * and a shape that names none of them is a shape no consumer can type-check
 * against.
 */
export type SupportEntityFor<T extends SupportTypeId> =
    SupportEntityIn<(typeof SUPPORT_TYPE_COLLECTION)[T]>;

/**
 * The primitives a placement can carry in alongside its entity.
 *
 * Only roots and knots: an `edges` entry pointing at `'segment'` names part of
 * the entity itself rather than a collection member, and every other declared
 * edge is one of these two.
 */
export type PlacementPrimitives = Partial<Record<string, Roots | Knot>>;

/**
 * A support the engine has built and is about to place.
 *
 * A discriminated union on `typeId`, so narrowing on it gives the entity's REAL
 * type — `placed.typeId === 'trunk'` makes `placed.entity` a `Trunk`. That is
 * what lets every consumer commit a placement without a cast.
 *
 * Keep the per-type body: an untyped `{ id: string }` erases the typing and
 * forces `as never` at every consumer.
 */
export type PlacedSupport = {
    [T in SupportTypeId]: {
        typeId: T;
        entity: SupportEntityFor<T>;
        /** Primitives keyed by the `edges` field that declares each one, so a
         *  caller passes what it built under the same names the declaration
         *  uses and the two cannot drift. */
        supplied: PlacementPrimitives;
        /** The host it hangs from, when it hangs from one. */
        hostedBy?: { typeId: SupportTypeId; id: string };
    };
}[SupportTypeId];

/** What a type's build override is handed. */
export interface ContactOverrideRequest {
    tipPos: { x: number; y: number; z: number };
    tipNormal: { x: number; y: number; z: number };
    modelId: string;
    /**
     * Checked for clearance when given. Structural rather than `THREE.Mesh` --
     * the registry declares rules and does not depend on the renderer.
     */
    mesh?: { isMesh: boolean };
}

/**
 * What a type's override built.
 *
 * `refusal` is how a type declines a contact it cannot serve — it carries the
 * reason rather than the engine inferring one, because the invariant being
 * checked is the type's own (an anchor's cone must not dip below its root) and
 * the engine has no business reading that type's geometry to test it.
 */
export interface ContactOverrideResult {
    placed: PlacedSupport;
    /** Set when the type refuses this contact; passed through as the rejection. */
    refusal?: string;
    /** Preview and validation state for the ghost. Typed `unknown` because the
     *  renderer owns that shape and this module does not depend on it. */
    supportData?: unknown;
}

type ContactOverride = (request: ContactOverrideRequest) => ContactOverrideResult | null;

/**
 * Pair a type id with the entity built for it. Checked against the registry, so
 * `placementOf('trunk', leaf)` is a compile error. The unchecked path is a
 * differently named function ({@link placementOfResolved}) rather than an
 * overload, which TypeScript would fall through to.
 */
export function placementOf<T extends SupportTypeId>(
    typeId: T,
    entity: SupportEntityFor<T>,
    supplied?: PlacementPrimitives,
    hostedBy?: { typeId: SupportTypeId; id: string },
): PlacedSupport {
    return { typeId, entity, supplied: supplied ?? {}, hostedBy } as PlacedSupport;
}

/**
 * The same, for the engine's own paths, where the id comes from
 * `selectTypeForPlacement` at run time and the entity was built to match it.
 *
 * Named apart because it witnesses the pairing instead of checking it: the
 * caller resolved an id and then built that type's support, and nothing in the
 * type system connects those two facts. One named place to audit, rather than a
 * cast at each site.
 */
export function placementOfResolved(
    typeId: SupportTypeId,
    entity: SupportEntityAny,
    supplied?: PlacementPrimitives,
    hostedBy?: { typeId: SupportTypeId; id: string },
): PlacedSupport {
    return { typeId, entity, supplied: supplied ?? {}, hostedBy } as PlacedSupport;
}

const CONTACT_OVERRIDES = new Map<SupportTypeId, ContactOverride>();

/**
 * A type that OVERRIDES the default trunk build for the contact band it claims.
 *
 * Auto-placement stands a trunk on a contact by default. A type that claims a
 * `tipHeight` band and registers here builds its own support instead. Mirrors
 * the export and preview seams: the builder returns the same generic shape a
 * placement commits with, so it introduces no per-type branch and no per-type
 * decision arm.
 */
export function registerContactOverride(typeId: SupportTypeId, build: ContactOverride): void {
    CONTACT_OVERRIDES.set(typeId, build);
}

/** This type's own build for a contact, or undefined when it does not override. */
export function buildContactOverride(typeId: SupportTypeId): ContactOverride | undefined {
    return CONTACT_OVERRIDES.get(typeId);
}

/**
 * Types that claim a `tipHeight` band but registered no override. The default
 * tool is excluded, being what the fallback already builds; every other
 * claimant needs one, or the engine selects a type it cannot construct.
 */
export function typesMissingContactOverride(): readonly SupportTypeId[] {
    const defaultToolId = defaultPlacementToolTypeId();
    return SUPPORT_TYPES
        .filter((d) => d.placementRule?.metric === 'tipHeight' && d.id !== defaultToolId)
        .filter((d) => !CONTACT_OVERRIDES.has(d.id))
        .map((d) => d.id);
}

export const SUPPORT_TRANSFORM_EXTRAS = {
    brace: ['curve'],
    stump: ['rootPos', 'joint'],
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

/**
 * The order the sidebar offers a type's own panel in. Observable, and not
 * registry order: `panelForTab` opens the first panel declaring a tab. Which
 * types are offered is `offersSidebarPanel`, held to this list by
 * `sidebarPanelOrderDrift`.
 */
export const SIDEBAR_PANEL_TYPE_ORDER = ['trunk', 'leaf', 'branch', 'twig', 'stick'] as const satisfies readonly SupportTypeId[];

/** How `SIDEBAR_PANEL_TYPE_ORDER` and the `offersSidebarPanel` flag disagree. */
export function sidebarPanelOrderDrift(): readonly string[] {
    const derived = SUPPORT_TYPES.filter((descriptor) => descriptor.offersSidebarPanel).map((d) => d.id);
    const declared: readonly SupportTypeId[] = SIDEBAR_PANEL_TYPE_ORDER;
    const drift: string[] = [];
    for (const id of derived) {
        if (!declared.includes(id)) drift.push(`${id} offers a sidebar panel but is missing from SIDEBAR_PANEL_TYPE_ORDER`);
    }
    for (const id of declared) {
        if (!derived.includes(id)) drift.push(`${id} is in SIDEBAR_PANEL_TYPE_ORDER but does not offer a sidebar panel`);
    }
    if (declared.length !== derived.length) {
        const repeated = declared.filter((id, index) => declared.indexOf(id) !== index);
        drift.push(`SIDEBAR_PANEL_TYPE_ORDER lists ${[...new Set(repeated)].join(', ')} more than once`);
    }
    return drift;
}

const SIDEBAR_PANEL_ORDER_DRIFT = sidebarPanelOrderDrift();
if (SIDEBAR_PANEL_ORDER_DRIFT.length > 0) {
    throw new Error(`Sidebar panel order disagrees with the declared flags: ${SIDEBAR_PANEL_ORDER_DRIFT.join('; ')}`);
}

/** The types the sidebar offers a panel for, in the order it offers them. */
export const SIDEBAR_PANEL_TYPE_IDS: readonly SupportTypeId[] = SIDEBAR_PANEL_TYPE_ORDER;


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
    stump: { convertibleToTree: false },
    overhang: { convertibleToTree: true },
    island: { convertibleToTree: false },
    standalone: { convertibleToTree: true },
} as const;

export type SupportOriginId = keyof typeof SUPPORT_ORIGINS;

/**
 * The origin a support is stamped with when placed in the near-plate band. The
 * band is claimed by a type through its `placementRule`, and the origin is named
 * after that type.
 *
 * Origin keys are their own vocabulary and do not follow `SupportTypeId`, so
 * callers compare against this rather than spelling the name.
 */
export const NEAR_PLATE_ORIGIN: SupportOriginId = (() => {
    const matches = (Object.keys(SUPPORT_ORIGINS) as SupportOriginId[])
        .filter((origin) => SUPPORT_TYPES.some((descriptor) => descriptor.id === origin));
    const [origin, ...rest] = matches;
    if (!origin || rest.length > 0) {
        throw new Error(
            `expected exactly one origin named after a support type, found: ${matches.join(', ') || 'none'}.`,
        );
    }
    return origin;
})();

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

/**
 * Types whose shafts the fan host pool offers, in registry order.
 *
 * The pool, the merge search, the attachment-capacity check and the forest
 * report's host index all walk this one list, so extending `canBeGridHost` to
 * a second type reaches every one of them.
 */
export const GRID_HOST_TYPES: readonly SupportTypeDescriptor[] = SUPPORT_TYPES.filter(
    (descriptor) => descriptor.canBeGridHost,
);

/**
 * Mirrors each descriptor's `isAutoPlaced` with the literals kept, so the ledger
 * keeps the NARROW union of these names (`PlacedKind`) rather than widening to
 * `SupportTypeId`. A literal map gives both the narrow union and the check that
 * it matches the flag; held to it by `derivedTypeSubsets.test.ts`.
 */
export const AUTO_PLACED_BY_TYPE = {
    trunk: true,
    branch: true,
    leaf: true,
    twig: true,
    stick: true,
    brace: false,
    stump: true,
    kickstand: false,
} as const satisfies Record<SupportTypeId, boolean>;

/** A type the auto-placement pass can place. */
export type AutoPlacedTypeId = {
    [K in SupportTypeId]: (typeof AUTO_PLACED_BY_TYPE)[K] extends true ? K : never;
}[SupportTypeId];

/** Every type that pass can place, in registry order. */
export const AUTO_PLACED_TYPE_IDS: readonly AutoPlacedTypeId[] =
    (Object.keys(AUTO_PLACED_BY_TYPE) as SupportTypeId[])
        .filter((id): id is AutoPlacedTypeId => AUTO_PLACED_BY_TYPE[id]);

/** Whether a placed kind is one the ledger reports. */
export function isAutoPlacedType(kind: SupportTypeId | 'reject'): kind is AutoPlacedTypeId {
    return (AUTO_PLACED_TYPE_IDS as readonly string[]).includes(kind);
}

/** Collections whose entities can host a fan link, in registry order. */
export const GRID_HOST_COLLECTION_KEYS: readonly SupportCollectionKey[] = GRID_HOST_TYPES
    .map((descriptor) => descriptor.location.key as SupportCollectionKey);

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

/**
 * SupportState collection keys whose entities carry a modelId, in registry
 * order.
 *
 * Every support type does, and `roots` is the one primitive that does -- a
 * knot's model comes from its host shaft instead. Kept as its own list rather
 * than collapsed into `SUPPORT_STATE_COLLECTIONS`, which answers a different
 * question and only coincides today.
 */
export const MODEL_ID_COLLECTION_KEYS: readonly SupportCollectionKey[] = [
    'roots' as SupportCollectionKey,
    ...SUPPORT_STATE_TYPES.map((descriptor) => descriptor.location.key as SupportCollectionKey),
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
        const fields = hostKnotFieldsFor(descriptor.id);
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

/**
 * Every type that flexes when its host knot is dragged, with the edge fields
 * naming that knot. Derived, so adding a flexing type needs no change here.
 */
export const FLEXING_KNOT_HOST_TYPES: readonly {
    typeId: SupportTypeId;
    knotFields: readonly string[];
}[] = SUPPORT_TYPES
    .filter((descriptor) => descriptor.flexesOnHostKnotDrag)
    .map((descriptor) => ({
        typeId: descriptor.id,
        knotFields: [...hostKnotFieldsFor(descriptor.id)],
    }));

/** Precedence `findKnotHost` resolves in when several types name one knot. */
export const KNOT_HOST_PRECEDENCE: readonly SupportTypeId[] = [
    'leaf', 'branch', 'brace', 'kickstand',
];

/**
 * The order to walk the types that hang off a host shaft by a knot. Observable,
 * and not registry order: the cull and the forest report both list leaves
 * before branches. Membership is held to the edge declarations by
 * `shaftHostedMemberOrderDrift`.
 */
export const SHAFT_HOSTED_MEMBER_TYPE_ORDER = ['leaf', 'branch'] as const satisfies readonly SupportTypeId[];

/** A type the walk above visits. */
export type ShaftHostedMemberTypeId = Extract<SupportTypeId, (typeof SHAFT_HOSTED_MEMBER_TYPE_ORDER)[number]>;

/**
 * How `SHAFT_HOSTED_MEMBER_TYPE_ORDER` and the edge rule disagree, as messages.
 * Empty when they agree; this module throws at load when they do not.
 */
export function shaftHostedMemberOrderDrift(): readonly string[] {
    // The rule: a shaft-hosted member hangs by a knot and by nothing else --
    // exactly one `hostedBy` edge onto `knots`, none onto a segment. Leaf and
    // branch. A brace names two knots, so it is not one; a kickstand names a
    // knot AND a segment, so it is not one either -- it rides a specific span.
    const derived = SUPPORT_TYPES
        .filter((descriptor) => {
            const hostedBy = descriptor.edges.filter((edge) => edge.ownership === 'hostedBy');
            return hostedBy.filter((edge) => edge.to === 'knots').length === 1
                && hostedBy.filter((edge) => edge.to === 'segment').length === 0;
        })
        .map((descriptor) => descriptor.id);
    const declared: readonly SupportTypeId[] = SHAFT_HOSTED_MEMBER_TYPE_ORDER;
    const drift: string[] = [];
    for (const id of derived) {
        if (!declared.includes(id)) {
            drift.push(`${id} declares a shaft-hosted member but is missing from SHAFT_HOSTED_MEMBER_TYPE_ORDER`);
        }
    }
    for (const id of declared) {
        if (!derived.includes(id)) {
            drift.push(`${id} is in SHAFT_HOSTED_MEMBER_TYPE_ORDER but declares no shaft-hosted member`);
        }
    }
    if (declared.length !== derived.length) {
        const repeated = declared.filter((id, index) => declared.indexOf(id) !== index);
        drift.push(`SHAFT_HOSTED_MEMBER_TYPE_ORDER lists ${[...new Set(repeated)].join(', ')} more than once`);
    }
    return drift;
}

const SHAFT_HOSTED_MEMBER_ORDER_DRIFT = shaftHostedMemberOrderDrift();
if (SHAFT_HOSTED_MEMBER_ORDER_DRIFT.length > 0) {
    throw new Error(`Shaft-hosted member walk order disagrees with the declared edges: ${SHAFT_HOSTED_MEMBER_ORDER_DRIFT.join('; ')}`);
}

/** One shaft-hosted member type, as a walk over those members needs it. */
export interface ShaftHostedMemberType {
    /** The type id, which is also the `kind` a cull record for it carries. */
    typeId: ShaftHostedMemberTypeId;
    /** The entity field naming the knot this member hangs from. */
    knotField: string;
    /** The SupportState collection its entities live in. */
    collectionKey: SupportCollectionKey;
}

/**
 * Which types own a placement mode of their own, with the literals kept so the
 * owner union narrows rather than widening to every type.
 * `placementModeOwnerDrift` holds the table to the descriptor flags at load.
 */
export const PLACEMENT_MODE_OWNER_BY_TYPE = {
    trunk: false,
    branch: true,
    leaf: true,
    twig: false,
    stick: false,
    brace: true,
    stump: false,
    kickstand: true,
} as const satisfies Record<SupportTypeId, boolean>;

/** The types that own a placement mode. */
export type PlacementModeOwnerTypeId = {
    [K in SupportTypeId]: (typeof PLACEMENT_MODE_OWNER_BY_TYPE)[K] extends true ? K : never;
}[SupportTypeId];

export const PLACEMENT_MODE_OWNER_TYPES: readonly PlacementModeOwnerTypeId[] =
    (Object.keys(PLACEMENT_MODE_OWNER_BY_TYPE) as SupportTypeId[])
        .filter((id): id is PlacementModeOwnerTypeId => PLACEMENT_MODE_OWNER_BY_TYPE[id]);

/** How `PLACEMENT_MODE_OWNER_BY_TYPE` and the descriptor flags disagree. */
export function placementModeOwnerDrift(): readonly string[] {
    const derived = SUPPORT_TYPES
        .filter((descriptor) => descriptor.hasPlacementPreview && !descriptor.previewYieldsToOtherModes)
        .map((descriptor) => descriptor.id);
    const declared: readonly SupportTypeId[] = PLACEMENT_MODE_OWNER_TYPES;
    const drift: string[] = [];
    for (const id of derived) {
        if (!declared.includes(id)) drift.push(`${id} owns a placement mode but is missing from PLACEMENT_MODE_OWNER_BY_TYPE`);
    }
    for (const id of declared) {
        if (!derived.includes(id)) drift.push(`${id} is marked as owning a placement mode but declares none`);
    }
    return drift;
}

const PLACEMENT_MODE_OWNER_DRIFT = placementModeOwnerDrift();
if (PLACEMENT_MODE_OWNER_DRIFT.length > 0) {
    throw new Error(`Placement mode owners disagree with the declared flags: ${PLACEMENT_MODE_OWNER_DRIFT.join('; ')}`);
}

/**
 * The types sharing the ONE `branchFamily` placement binding.
 *
 * Branch and brace are placed by the same binding, so the family they belong to
 * is named `branchFamily` rather than after either type. Every other placement
 * owner is named after its own type, which is what
 * `OwnNamedPlacementFamilyTypeId` below says.
 */
export const BRANCH_FAMILY_MEMBER_TYPES = ['branch', 'brace'] as const satisfies readonly PlacementModeOwnerTypeId[];

/** A type whose placement is driven by the shared branch binding. */
export type BranchFamilyMemberTypeId = (typeof BRANCH_FAMILY_MEMBER_TYPES)[number];

/** The placement owners named after their own type rather than folded into a family. */
export type OwnNamedPlacementFamilyTypeId = Exclude<PlacementModeOwnerTypeId, BranchFamilyMemberTypeId>;

/**
 * The family a placement mode belongs to.
 *
 * `branchFamily` is a family NAME, not a type id -- it exists because branch and
 * brace are driven by one binding. The rest of the union is derived, so renaming
 * a type renames its family here.
 */
export type PlacementFamilyName = 'branchFamily' | OwnNamedPlacementFamilyTypeId;

/**
 * The shaft-hosted member types, in the order to walk them.
 *
 * The single naming point for those walks: a caller iterates this rather than
 * naming a collection or a member type, so a renamed type id reaches the
 * descriptor, this list and the walk together, and a stale walk does not compile.
 */
export const SHAFT_HOSTED_MEMBER_TYPES: readonly ShaftHostedMemberType[] =
    SHAFT_HOSTED_MEMBER_TYPE_ORDER.map((typeId) => {
        const descriptor = getSupportTypeDescriptor(typeId);
        const knotField = hostKnotFieldsFor(typeId)[0];
        if (!knotField) {
            throw new Error(`${typeId} is walked as a shaft-hosted member but declares no hostedBy edge onto knots`);
        }
        return { typeId, knotField, collectionKey: descriptor.location.key };
    });

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
    stump: false,
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
    stump: false,
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

/** The selection id for an entity whose span stands in for a segment. */
export function segmentSelectionId(typeId: SupportTypeId, entityId: string): string {
    const prefix = getSupportTypeDescriptor(typeId).segmentSelectionPrefix;
    if (!prefix) throw new Error(`${typeId} declares no segmentSelectionPrefix; its segments are real`);
    return `${prefix}${entityId}`;
}

/** Split a segment selection id into its type and entity id, or null for a real segment. */
export function parseSegmentSelectionId(
    segmentId: string,
): { typeId: SupportTypeId; entityId: string } | null {
    for (const descriptor of SUPPORT_TYPES) {
        const prefix = descriptor.segmentSelectionPrefix;
        if (!prefix || !segmentId.startsWith(prefix)) continue;
        return { typeId: descriptor.id, entityId: segmentId.slice(prefix.length) };
    }
    return null;
}

/**
 * The two kinds of pseudo-shaft a knot can ride, told apart by what they
 * declare rather than by name.
 *
 * A SPAN is selectable as a segment, so it declares a `segmentSelectionPrefix`
 * too (a brace's span between its knots). A CONE host is a knot host only (a
 * leaf's contact cone), so it declares no segment prefix -- which is exactly
 * the distinction `implicitSegmentCount` already relies on.
 */
function knotHostTypesWhere(wantsSegment: boolean): readonly SupportTypeId[] {
    return SUPPORT_TYPES
        .filter((d) => d.knotHostPrefix && !!d.segmentSelectionPrefix === wantsSegment)
        .map((d) => d.id);
}

/** Types whose knot host is a cone, not a selectable span. */
export const CONE_KNOT_HOST_TYPES: readonly SupportTypeId[] = knotHostTypesWhere(false);

/** Types whose knot host is a span that is also selectable as a segment. */
export const SPAN_KNOT_HOST_TYPES: readonly SupportTypeId[] = knotHostTypesWhere(true);

/** Whether this type hosts knots on a cone rather than a span. */
export function isConeKnotHost(typeId: SupportTypeId): boolean {
    return CONE_KNOT_HOST_TYPES.includes(typeId);
}

/**
 * The single type whose knot host is a selectable span.
 *
 * Callers that build such an id hold the entity but not its type; there is one
 * span host, and this asserts that rather than assuming it silently.
 */
export function spanKnotHostType(): SupportTypeId {
    const [typeId, ...rest] = SPAN_KNOT_HOST_TYPES;
    if (!typeId || rest.length > 0) {
        throw new Error(
            `expected exactly one span knot host, found: ${SPAN_KNOT_HOST_TYPES.join(', ') || 'none'}. `
            + 'A caller builds these ids without holding a type; give it the type instead.',
        );
    }
    return typeId;
}

/**
 * The single type whose knot host is a contact cone. Same contract as
 * `spanKnotHostType`: it asserts the "exactly one" rather than assuming it.
 */
export function coneKnotHostType(): SupportTypeId {
    const [typeId, ...rest] = CONE_KNOT_HOST_TYPES;
    if (!typeId || rest.length > 0) {
        throw new Error(
            `expected exactly one cone knot host, found: ${CONE_KNOT_HOST_TYPES.join(', ') || 'none'}. `
            + 'A caller builds these ids without holding a type; give it the type instead.',
        );
    }
    return typeId;
}

/**
 * The single type that is the default placement tool -- the one whose preview
 * yields to every other mode, and which auto-placement's fallback builds.
 *
 * Same contract as `coneKnotHostType`: it asserts the "exactly one" rather than
 * assuming it, so a second type claiming the flag fails loudly at the call
 * instead of silently widening what "not the default" excludes.
 */
export function defaultPlacementToolTypeId(): SupportTypeId {
    const matches = SUPPORT_TYPES.filter((descriptor) => descriptor.previewYieldsToOtherModes).map((d) => d.id);
    const [typeId, ...rest] = matches;
    if (!typeId || rest.length > 0) {
        throw new Error(
            `expected exactly one default placement tool, found: ${matches.join(', ') || 'none'}.`,
        );
    }
    return typeId;
}

/**
 * The type whose entities live in `key`: the inverse of each descriptor's
 * `location.key`, for a caller walking a `SupportState` collection by key.
 */
export function typeIdForCollection(key: SupportCollectionKey): SupportTypeId {
    const descriptor = SUPPORT_TYPES.find((candidate) => candidate.location.key === key);
    if (!descriptor) {
        throw new Error(`no support type stores its entities in the "${key}" collection`);
    }
    return descriptor.id;
}

/**
 * The single type serialised as a bundle with the root and host knot it owns.
 *
 * Same contract as `coneKnotHostType`: it asserts the "exactly one" rather than
 * assuming it, so a second bundled type is a loud failure instead of a silent
 * change to whose primitives a caller reads.
 */
export function bundledSupportTypeId(): SupportTypeId {
    const matches = SUPPORT_TYPES.filter((descriptor) => descriptor.serialisedAsBundle).map((d) => d.id);
    const [typeId, ...rest] = matches;
    if (!typeId || rest.length > 0) {
        throw new Error(
            `expected exactly one bundled support type, found: ${matches.join(', ') || 'none'}.`,
        );
    }
    return typeId;
}

/**
 * The types whose base is geometry on the entity rather than a shared `Roots`
 * record, and the fields that base position and radius live in.
 *
 * Read one type through `inlineRootPlacementFor`, or iterate for the whole set.
 */
export interface InlineRootPlacement {
    typeId: SupportTypeId;
    /** The collection the entities live in. */
    collectionKey: SupportCollectionKey;
    /** The field holding the base position. */
    posField: string;
    /** The field holding the base radius. */
    radiusField: string;
}

export const INLINE_ROOT_TYPES: readonly InlineRootPlacement[] = SUPPORT_TYPES
    .filter((descriptor) => descriptor.lower.kind === 'inlineRoot')
    .map((descriptor) => {
        const { field, radiusField } = descriptor.lower;
        if (!field || !radiusField) {
            throw new Error(
                `${descriptor.id} declares an inlineRoot without both a position and a radius field, `
                + 'so nothing can place its base on the raft',
            );
        }
        return {
            typeId: descriptor.id,
            collectionKey: descriptor.location.key,
            posField: field,
            radiusField,
        };
    });

/**
 * The fields through which a type hangs off a host knot: its `hostedBy` edges
 * onto `knots`. Empty for a type that hangs off no knot -- one standing on its
 * own root, or spanning two model contacts.
 */
export function hostKnotFieldsFor(typeId: SupportTypeId): readonly string[] {
    return getSupportTypeDescriptor(typeId).edges
        .filter((edge) => edge.to === 'knots' && edge.ownership === 'hostedBy')
        .map((edge) => edge.field);
}

/** Whether this type hosts knots on a selectable span. */
export function isSpanKnotHost(typeId: SupportTypeId): boolean {
    return SPAN_KNOT_HOST_TYPES.includes(typeId);
}

/**
 * Whether a `parentShaftId` names a pseudo-shaft rather than a real segment.
 * Asks every declared prefix, so a type gaining one is covered.
 */
export function isKnotHostId(parentShaftId: string): boolean {
    return parseKnotHostId(parentShaftId) !== null;
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

/**
 * Types that own their edit-history entry but declare no update action.
 *
 * The joint-drag path pushes that type's OWN typed action for the entry, so a
 * type declaring the flag without the action would record no undo entry at all,
 * and nothing would say so. `state.ts` asserts this list is empty at load, beside
 * the other flag-and-registration completeness checks.
 */
export function typesDeclaringOwnHistoryEntryWithoutUpdate(): readonly SupportTypeId[] {
    return SUPPORT_TYPES
        .filter((descriptor) => descriptor.ownsEditHistoryEntry && !descriptor.historyUpdate)
        .map((descriptor) => descriptor.id);
}

/**
 * Mirrors each descriptor's `hostsKickstand` with the literals kept, so the host
 * union narrows instead of widening to every type. `derivedTypeSubsets.test.ts`
 * holds the two in step.
 */
export const KICKSTAND_HOST_BY_TYPE = {
    trunk: true,
    branch: true,
    leaf: false,
    twig: false,
    stick: false,
    brace: false,
    stump: false,
    kickstand: false,
} as const satisfies Record<SupportTypeId, boolean>;

/** The types a kickstand's host knot may ride. */
export type KickstandHostTypeId = {
    [K in SupportTypeId]: (typeof KICKSTAND_HOST_BY_TYPE)[K] extends true ? K : never;
}[SupportTypeId];

export const KICKSTAND_HOST_TYPES: readonly KickstandHostTypeId[] =
    (Object.keys(KICKSTAND_HOST_BY_TYPE) as SupportTypeId[])
        .filter((id): id is KickstandHostTypeId => KICKSTAND_HOST_BY_TYPE[id]);

/** Whether an untrusted `kind` names a type a kickstand may host on. */
export function isKickstandHostType(kind: string): kind is KickstandHostTypeId {
    return (KICKSTAND_HOST_TYPES as readonly string[]).includes(kind);
}

/**
 * Whether one joint of this type can be removed on its own, keeping the support.
 *
 * Such a segment resolves an endpoint from a root, a host knot or its neighbour,
 * so a joint removal merges two segments. `derivedTypeSubsets.test.ts` holds it.
 */
export const JOINT_REMOVAL_BY_TYPE = {
    trunk: true,
    branch: true,
    leaf: false,
    twig: false,
    stick: false,
    brace: false,
    stump: false,
    kickstand: true,
} as const satisfies Record<SupportTypeId, boolean>;

/** The types whose joints `removeJointById` reports. */
export type JointRemovalTypeId = {
    [K in SupportTypeId]: (typeof JOINT_REMOVAL_BY_TYPE)[K] extends true ? K : never;
}[SupportTypeId];

/** The same set at runtime, for the scan that answers which entity holds a joint. */
export const JOINT_REMOVAL_TYPES: readonly JointRemovalTypeId[] =
    (Object.keys(JOINT_REMOVAL_BY_TYPE) as SupportTypeId[])
        .filter((id): id is JointRemovalTypeId => JOINT_REMOVAL_BY_TYPE[id]);
