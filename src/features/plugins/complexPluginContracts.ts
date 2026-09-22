import type { ComponentType } from 'react';

export type RemoteMaterialFieldKind = 'number' | 'integer' | 'text' | 'boolean' | 'select';

export type RemoteMaterialFieldOption = {
    value: string;
    label: string;
};

/**
 * Generic field model for plugin-provided remote material settings.
 *
 * This is intentionally vendor-agnostic and maps cleanly to existing Athena
 * NanoDLP fields via compatibility shims.
 */
export type RemoteMaterialPrimaryField = {
    key: string;
    label: string;
    aliases: string[];
    defaultValue: number | string | boolean;
    kind?: RemoteMaterialFieldKind;
    description?: string;
    options?: RemoteMaterialFieldOption[];
};

export type RemoteMaterialBasicSection = {
    id: string;
    title: string;
    keys: string[];
};

export type RemoteMaterialAdvancedSection = {
    id: string;
    title: string;
    keywords: string[];
};

export type RemoteMaterialProcessValues = {
    layerHeightMm?: number;
    normalExposureSec?: number;
    bottomExposureSec?: number;
    bottomLayerCount?: number;
};

/**
 * Generic adapter contract for remote (device-side) material settings.
 *
 * NOTE: method names remain aligned with the current runtime usage so we can
 * migrate incrementally without behavior changes.
 */
export type RemoteMaterialSettingsAdapter = {
    primaryEditFields: RemoteMaterialPrimaryField[];
    basicSections: RemoteMaterialBasicSection[];
    advancedSections: RemoteMaterialAdvancedSection[];
    resolveEditDraftFromMeta: (meta: Record<string, unknown>) => Record<string, string>;
    resolveMaterialProcessValues: (meta: Record<string, unknown>) => RemoteMaterialProcessValues;
    denormalizeEditDraftForBackend: (draft: Record<string, string>) => Record<string, string>;
    resolveAdvancedSectionId: (fieldKey: string) => string;
    getFieldHelpText: (fieldKey: string) => string;
    isDynamicWaitEnabled: (draft: Record<string, string>) => boolean;
};

export type PluginNetworkUiAdapterContract = {
    mode: string;
    pluginId: string;
    displayName: string;
    operationNamespace: string;
    /**
     * Whether this backend exposes on-device remote material/profile listing and editing.
     * Defaults to true for existing backends when omitted.
     */
    supportsRemoteMaterialProfiles?: boolean;
    /**
     * When set, the Edit button is greyed out and this message is shown on hover.
     * Omit when editing is fully supported.
     */
    remoteMaterialEditingWipNotice?: string;
    operations: {
        connect: string;
        discover: string;
        materials: string;
        materialsEdit: string;
        /**
         * Optional operation that probes a printer endpoint and reports the
         * detected bit-depth (`bitdepth`), used to auto-select a model variant
         * (see `PrinterPreset.modelVariantDetectPath`). Omit when the backend
         * has no variant-detection probe.
         */
        printerData?: string;
    };
    defaultLocalHostnames: string[];
} & RemoteMaterialSettingsAdapter;

export type PluginMonitoringSnapshotContract = {
    connected: boolean;
    stateText: string;
    isPrinting: boolean;
    isPaused: boolean;
    cancelLatched: boolean;
    pauseLatched: boolean;
    finished: boolean;
    progressPct: number | null;
    currentLayer: number | null;
    totalLayers: number | null;
    plateId: number | null;
    jobName: string | null;
    etaSec: number | null;
    thumbnailPath?: string | null;
    taskId?: string | null;
    taskStatus?: number | null;
};

export type PluginMonitoringWebcamInfoContract = {
    available: boolean;
    streamUrl: string | null;
    snapshotUrl: string | null;
    message: string;
};

export type PluginMonitoringUiPolicy = {
    /** How long the monitor can keep showing stale online state after the last successful status poll. */
    busyResponseGraceMs?: number;
    /** How many inconclusive reachability polls are allowed before the UI treats a device as offline. */
    inconclusiveReachabilityMaxPolls?: number;
    /** Whether the UI should surface a manual stale-webcam-stream reset action. */
    supportsWebcamStreamSlotReset?: boolean;
    /** How many consecutive webcam failures should trigger a cooldown. */
    webcamMaxConsecutiveTimeouts?: number;
    /** Cooldown after repeated webcam timeouts. */
    webcamTimeoutCooldownMs?: number;
    /** Cooldown after an immediate webcam request failure. */
    webcamFailureCooldownMs?: number;
};

export type PluginMonitoringUiAdapterContract = {
    mode: string;
    pluginId: string | null;
    displayName: string;
    available: boolean;
    operations: {
        status: string;
        webcamInfo: string;
        webcamEnable?: string;
        webcamDisable?: string;
        timelapseEnable?: string;
        timelapseDisable?: string;
        platesList: string;
        start: string;
        deletePlate: string;
        pause: string;
        resume: string;
        cancel: string;
        emergencyStop: string;
    } | null;
    parseStatusPayload: (payload: unknown, contextKey?: string) => PluginMonitoringSnapshotContract;
    parseWebcamInfoPayload: (payload: unknown, host: string, port: number) => PluginMonitoringWebcamInfoContract;
    getMonitoringUiPolicy?: () => PluginMonitoringUiPolicy;
};

export type PluginNetworkOperationHandlerContract = (
    operationPath: string[],
    payload: unknown,
) => Promise<{ status: number; body: unknown }>;

/**
 * First-class scene overlay loader contributed by a plugin.
 *
 * The host obtains the loader from the central plugin registry and turns it
 * into a client-side lazy component without importing plugin-owned UI code
 * directly.
 */
export type PluginSceneOverlayLoaderContract = () => Promise<{
    default: ComponentType<{
        data: unknown;
        visible: boolean;
    }>;
}>;

export type PluginSlicingFormatDefinitionContract = {
    id: string;
    outputFormat: string;
    displayName: string;
    ownership: 'core' | 'plugin';
    pluginId?: string;
    formatVersions?: Array<{
        value: string;
        label: string;
        isDefault?: boolean;
    }>;
    settingsModes?: Array<{
        value: string;
        label: string;
        isDefault?: boolean;
    }>;
    rustModulePath: string;
    wasmExportName: string;
    notes?: string;
};

export type LocalMaterialFieldKind = 'number' | 'integer' | 'text' | 'boolean' | 'select' | 'spacer';

export type LocalMaterialFieldOption = {
    value: string;
    label: string;
};

export type LocalMaterialTabSchema = {
    id: string;
    title: string;
    order?: number;
    description?: string;
};

export type LocalMaterialSectionSchema = {
    id: string;
    title: string;
    tabId?: string;
    order?: number;
    description?: string;
};

export type LocalMaterialCardSchema = {
    id: string;
    title: string;
    tabId?: string;
    sectionId?: string;
    order?: number;
    description?: string;
};

export type LocalMaterialFieldPlacement = {
    /** Preferred tab target for this field (e.g. basic, advanced, custom). */
    tabId?: string;
    /** Optional section grouping under a tab. */
    sectionId?: string;
    /** Optional card grouping within a section/tab (e.g. metadata, print-settings). */
    cardId?: string;
    /** Render order within the destination group. */
    order?: number;
};

/**
 * Declarative local material field schema for file-format-specific settings.
 *
 * These fields are intended for local export profiles (not remote printer APIs)
 * and can be surfaced by UI based on selected output format/plugin.
 */
export type LocalMaterialFieldSchema = {
    key: string;
    label: string;
    kind: LocalMaterialFieldKind;
    defaultValue: number | string | boolean;
    /** Optional short tag rendered by the UI as an inline chip (e.g. Fast/Slow). */
    tag?: string;
    /** Optional accent color for the field chip / highlight. */
    color?: string;
    /** Optional key to render as a two-stage paired input row with this field. */
    splitWithKey?: string;
    /**
     * Render the field greyed out and non-interactive without taking it out of the
     * settings: its value merges into the job metadata like any other field, so a
     * preset that carries one is honoured while the input itself cannot change it.
     */
    disabled?: boolean;
    /**
     * Optional key that lays this field on one full-width row together with every
     * other field of the same card carrying it: three fields sharing a key read as a
     * 1:1:1 row, the shape the stock material form gives scale compensation.
     *
     * A grouped field takes one column of the row, so `splitWithKey` still collapses
     * a pair into the one column it renders — declare the pair inside the row, where
     * both halves are members. A field without a key keeps the card's own grid.
     */
    rowKey?: string;
    /**
     * This field's share of its `rowKey` row, as a flex weight; 1 when omitted, so a
     * group of equal fields needs no weights at all. Four fields weighted 3, 1, 1, 1
     * give the first half the row and the rest a sixth each. Ignored without a
     * `rowKey`, and read off the field that renders the column, so a `splitWithKey`
     * pair carries its declaring field's weight rather than both halves'.
     */
    rowWeight?: number;
    description?: string;
    min?: number;
    max?: number;
    step?: number;
    options?: LocalMaterialFieldOption[];
    placement?: LocalMaterialFieldPlacement;
    /** Optional metadata path override for serialization (dot notation). */
    metadataPath?: string;
};

export type PluginLocalMaterialSettingsAdapterContract = {
    outputFormat: string;
    displayName?: string;
    /** When true, plugin-defined material fields replace stock local material fields in the UI. */
    replacesDefaultMaterialSettings?: boolean;
    tabs?: LocalMaterialTabSchema[];
    sections?: LocalMaterialSectionSchema[];
    cards?: LocalMaterialCardSchema[];
    fields: LocalMaterialFieldSchema[];
};

/**
 * Optional mode-indexed local material settings contract.
 *
 * Example:
 * {
 *   '.ctb': {
 *     simple: { ...adapter },
 *     twostage: { ...adapter }
 *   }
 * }
 */
export type PluginLocalMaterialSettingsByModeContract =
    Record<string, Record<string, PluginLocalMaterialSettingsAdapterContract>>;

/**
 * Differential material settings source — a JSON that inherits from another mode
 * and applies additions/removals rather than being fully standalone.
 *
 * Examples:
 * ```jsonc
 * // twostage.diff.json — inherit from "simple", add two-stage fields
 * {
 *   "$inherit": "simple",
 *   "$update": {
 *     "tabs": [{ "id": "twostage", "title": "Two-Stage", "order": 20 }],
 *     "fields": [{ "key": "liftDistance2Mm", ... }]
 *   },
 *   "$remove": {
 *     "fields": ["liftDistanceMm", "liftSpeedMmMin"]
 *   }
 * }
 * ```
 */
export type DifferentialMaterialSettings = {
    /** Name of the settings mode to inherit from. */
    $inherit: string;

    /**
     * Items to REMOVE from the inherited result (by id/key).
     */
    $remove?: {
        fields?: string[];
        tabs?: string[];
        sections?: string[];
        cards?: string[];
    };

    /**
     * Items to UPSERT (update-or-insert) in the inherited result.
     * Arrays are matched by identity key (tabs/sections/cards by `id`, fields by `key`):
     * - If an item with the same key already exists, it is updated.
     * - If no item with that key exists, it is appended.
     */
    tabs?: LocalMaterialTabSchema[];
    sections?: LocalMaterialSectionSchema[];
    cards?: LocalMaterialCardSchema[];
    fields?: LocalMaterialFieldSchema[];
};

/**
 * Union of all possible material settings sources.
 * A plain adapter contract is treated as standalone (backward compatible).
 * A differential object uses `$inherit` to reference another mode.
 */
export type MaterialSettingsSource = Omit<PluginLocalMaterialSettingsAdapterContract, 'outputFormat'> | DifferentialMaterialSettings;


export type ComplexPluginManifestReference = {
    id: string;
    name: string;
    version: string;
    description?: string;
    author?: string;
    homepage?: string;
};

export type ComplexPluginCapabilities = {
    networkOperations?: boolean;
    uploadWithProgress?: boolean;
    slicerEncoder?: boolean;
    tauriRuntimePlugin?: boolean;
    fileType?: boolean;
};

/**
 * Reads one integer out of the container, at a fixed offset, with a stated width.
 * Little-endian, because both containers are.
 */
export type PluginBinaryField = {
    type: 'u16' | 'u32' | 'u64';
    at: number;
};

/**
 * Where a format keeps its stored preview, described rather than parsed.
 *
 * The shell providers - Windows Explorer's `IThumbnailProvider`, the macOS QuickLook
 * extension, the freedesktop thumbnailers - all have to answer "what does this file
 * look like?" without the app running, and none of them may execute plugin code (the
 * macOS appex cannot even spawn a process). So a plugin describes its container here
 * and the providers interpret the description: the grammar below covers a chunk table
 * whose entries point at a stored PNG, which is what both formats in the tree use and
 * what most print containers do.
 *
 * A format whose preview has to be *computed* rather than found - CTB's RGB565 blobs,
 * a mask rendered on the fly - cannot be expressed here and is not supported by the
 * capability yet.
 */
export type PluginThumbnailLocator = {
    /** The ASCII magic that identifies the container, e.g. `LUMN`. */
    magic: string;
    /** Optional version gate read from the header. */
    version?: PluginBinaryField & { equals?: number; atLeast?: number };
    /** Where the chunk table is and how its entries are laid out. */
    directory: {
        /** Either at a fixed offset, or at one the header states. */
        offset: { fixed: number } | PluginBinaryField;
        /** How many entries the table holds. */
        count: PluginBinaryField;
        /** Bytes per entry. */
        entrySize: number;
    };
    entry: {
        /** Four ASCII bytes naming the chunk. */
        type: { at: number };
        /** Absolute file offset of the payload. */
        offset: PluginBinaryField;
        /**
         * Payload length as stored: the first of these fields that reads non-zero.
         * Two are needed because LUMEN stores a compressed length that is zero for an
         * uncompressed payload, and the uncompressed length beside it.
         */
        size: PluginBinaryField[];
        /** Only an entry whose field here equals `value` is a preview (VOXL's chunk index). */
        index?: PluginBinaryField & { value: number };
        /**
         * Compression code. `stored` lists the codes that mean the payload is as it
         * was written, `zlib` the ones that mean it is a zlib stream; any other code
         * is refused with the code named rather than guessed at.
         */
        compression?: PluginBinaryField & { stored?: number[]; zlib: number[] };
        /** Flags carrying a preview role and a sealed bit, when the format has them. */
        flags?: PluginBinaryField & {
            /** Bit set means the payload is encrypted and cannot be read without a key. */
            sealedBit?: number;
            /** Bits holding the preview's role. */
            roleMask?: number;
            /**
             * Role values best-first. The provider takes the first preview whose role
             * appears here, in this order.
             */
            roleOrder?: number[];
        };
    };
    /** Chunk types that carry a preview, e.g. `['PREV']`. */
    previewChunks: string[];
    /** What the payload is, and how to get a PNG out of it. */
    payload:
        | { encoding: 'png' }
        | { encoding: 'json-base64'; /** Keys to walk inside the chunk's JSON. */ jsonPath: string[] };
    /** Magic at the end of the file, when the container signs off. */
    trailer?: { magic: string; size: number };
};

/**
 * A file type a plugin *writes*, and how the operating system shows it.
 *
 * This is the shape of `plugins/<id>/outputFileTypes.json` (and of the core
 * `src/config/core-output-file-types.json`): the declaration is data because the
 * shell providers are native — the registry generator compiles it into the provider
 * and into the platform registrations, so a plugin that writes a new container gets
 * thumbnails and file-manager recognition with no host code naming it.
 *
 * Separate from `fileTypes`, which is what a plugin can *import*: a print format is
 * usually written and not read back.
 */
export type PluginOutputFileTypeDefinition = {
    /** File extension including the leading dot, e.g. '.lumen'. Must be lowercase. */
    fileExtension: string;
    /** Media type, e.g. 'application/vnd.openresin.lumen'. */
    mimeType: string;
    /** macOS uniform type identifier, e.g. 'org.openresinalliance.lumen'. */
    uti: string;
    /** Human-readable label used by the file managers. */
    displayName: string;
    /** How a shell provider finds this format's preview. */
    thumbnail: PluginThumbnailLocator;
};

/**
 * A metadata payload the host bakes into a slice job when the merged settings ask
 * for it.
 *
 * Some formats need data the app owns rather than data a setting names - LUMEN's
 * scene embed wants the editor scene serialized into the file. The plugin declares
 * the setting that asks for a payload, where the payload lands, and what kind it is;
 * the host knows how to bake the kinds it implements, and skips a kind it does not,
 * so nothing in the slice path has to name a plugin.
 */
export type PluginJobMetadataPayloadDefinition = {
    /** Merged-settings path (a `metadataPath`) whose `true` asks for the payload. */
    settingPath: string;
    /** Metadata path the base64 payload is written to. */
    payloadPath: string;
    /** What to bake. The host implements `voxl-scene` today. */
    payload: 'voxl-scene';
};

/**
 * Declares a file extension that a plugin can import.
 *
 * Plugins that set `capabilities.fileType = true` must include at least one
 * entry in `ComplexPluginDefinition.fileTypes` and export a `handleFileTypeImport`
 * function from `fileTypeHandlers.ts` (see `plugins/CONTRIBUTING_COMPLEX_PLUGINS.md`).
 */
export type PluginFileTypeDefinition = {
    /** File extension including the leading dot, e.g. '.lys'. Must be lowercase. */
    fileExtension: string;
    /** Optional MIME type hint for drag-and-drop and file picker filtering. */
    mimeType?: string;
    /** Human-readable label used in UI (e.g. native file picker filter names). */
    displayName: string;
    /**
     * When true, the file is treated as a scene import (like .voxl) rather than
     * a mesh import. The host routes the file through the plugin's handler before
     * adding it to the scene.
     */
    isSceneFile?: boolean;
    /**
     * When set, the host shows a one-time dismissible warning dialog before
     * invoking the plugin handler. The `storageKey` is used as the localStorage
     * key to persist the user's "don't show again" choice.
     */
    importWarning?: {
        title: string;
        body: string;
        storageKey: string;
    };
};

/**
 * PR-1 foundation contract: single plugin definition shape that will become
 * the source of truth for complex plugin registration in later phases.
 */
export type ComplexPluginDefinition = {
    id: string;
    manifest: ComplexPluginManifestReference;
    capabilities?: ComplexPluginCapabilities;
    networkAdaptersByMode?: Record<string, PluginNetworkUiAdapterContract>;
    monitoringAdaptersByMode?: Record<string, PluginMonitoringUiAdapterContract>;
    networkOperationHandler?: PluginNetworkOperationHandlerContract;
    slicingFormatsByOutput?: Record<string, PluginSlicingFormatDefinitionContract>;
    localMaterialSettingsByOutput?: Record<string, PluginLocalMaterialSettingsAdapterContract>;
    localMaterialSettingsByOutputAndMode?: PluginLocalMaterialSettingsByModeContract;
    sceneOverlayLoader?: PluginSceneOverlayLoaderContract;
    /** File types this plugin can import. Required when `capabilities.fileType` is true. */
    fileTypes?: PluginFileTypeDefinition[];
    /** Scene data the host bakes into a job's metadata when these settings ask for it. */
    jobMetadataPayloads?: PluginJobMetadataPayloadDefinition[];
};
