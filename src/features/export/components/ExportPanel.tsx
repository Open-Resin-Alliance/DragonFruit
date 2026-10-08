import React, { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { Box, Download } from 'lucide-react';
import { useLingui } from '@lingui/react';
import { msg, plural } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { MessageDescriptor } from '@lingui/core';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { ExportManager, ExportOptions } from '../logic/ExportManager';
import { normalizeExportBaseName, resolvePlateOutputBaseName } from '../logic/exportFileNaming';
import { plateNumberPlaceholder } from '@/features/scene/plates/plateMessages';
import {
  Button,
  Card,
  CardHeader,
  Select,
  SettingRow,
  Spinner,
  Toggle,
} from '@/components/atoms';
import { PanelCollapseToggle } from '@/components/atoms/PanelCollapseToggle';
import { pickDirectoryWithNativeDialog } from '@/features/slicing/tauri/nativeSlicerBridge';
import { useFloatingPanelCollapse } from '@/components/layout/FloatingPanelStack';
import { Tooltip } from '@/components/ui/Tooltip';

interface ExportPanelProps {
  models: LoadedModel[];
  activeModel: LoadedModel | null;
  activeModelId: string | null;
  selectedModelIds?: string[];
  /**
   * The scene's plates with the models standing on each, in cascade order. The "Entire
   * Plate" scope is all of them or just the active one, and a per-plate export asks for
   * one file from each.
   */
  plateGroups?: ReadonlyArray<{ id: string; name: string; modelIds: readonly string[] }>;
  /** Which of those plates is being worked on. */
  activePlateId?: string;
  onActiveModelChange: (modelId: string | null) => void;
  supportsRef?: React.RefObject<THREE.Group | null>;
  captureSceneThumbnailPng?: () => Promise<Uint8Array | null>;
  onExportSuccess?: (savedPath: string) => void;
  onExportError?: (message: string) => void;
  onExportProgress?: (exporting: boolean) => void;
}

type ExportScope = 'entire_plate' | 'active_model';
type ExportPlateScope = 'current_plate' | 'all_plates';
type ExportLayout = 'bundle' | 'plates' | 'separate';

type Translate = (descriptor: MessageDescriptor, values?: Record<string, unknown>) => string;

// Interpolated messages live in module-level formatters: React Compiler renames
// locals before the Lingui macro computes the id, so interpolating inside a
// component leaves the placeholder raw in production builds.
function formatHiddenModelOptionLabel(translate: Translate, modelName: string): string {
  return translate(msg`${modelName} (hidden)`);
}

function formatScopedMeshCountTitle(translate: Translate, count: number): string {
  return translate(msg`${plural(count, {
    one: '# mesh will be exported.',
    other: '# meshes will be exported.',
  })}`);
}

const EXPORT_SCOPE_OPTIONS: ReadonlyArray<{ value: ExportScope; label: MessageDescriptor }> = [
  { value: 'entire_plate', label: msg`Entire Plate` },
  { value: 'active_model', label: msg`Active Model` },
];

/**
 * Which beds the "Entire Plate" scope covers. "Active Model" ignores it: one model is one
 * model wherever it stands.
 */
const EXPORT_PLATE_SCOPE_OPTIONS: ReadonlyArray<{ value: ExportPlateScope; label: MessageDescriptor }> = [
  { value: 'all_plates', label: msg`All Plates` },
  { value: 'current_plate', label: msg`Current Plate` },
];

/**
 * What one export run writes: one file for the lot, one per plate, or one per model.
 * `bundle` is a scene, so it only asks for VOXL; 3MF and STL offer the other two.
 */
const EXPORT_LAYOUT_OPTIONS: ReadonlyArray<{
  value: ExportLayout;
  label: MessageDescriptor;
  title: MessageDescriptor;
  formats: readonly ExportOptions['format'][];
}> = [
  {
    value: 'bundle',
    label: msg`Bundle`,
    title: msg`One file holding every plate together`,
    formats: ['voxl'],
  },
  {
    value: 'plates',
    label: msg`Plates`,
    title: msg`One file per plate`,
    formats: ['voxl', '3mf', 'stl'],
  },
  {
    value: 'separate',
    label: msg`Separate`,
    title: msg`One file per model`,
    formats: ['voxl', '3mf', 'stl'],
  },
];

const EXPORT_FORMAT_OPTIONS: ReadonlyArray<{
  value: ExportOptions['format'];
  label: MessageDescriptor;
  title: MessageDescriptor;
}> = [
  { value: 'voxl', label: msg`VOXL`, title: msg`VOXL Scene (.voxl)` },
  { value: '3mf', label: msg`3MF`, title: msg`3MF Mesh (.3mf)` },
  { value: 'stl', label: msg`STL`, title: msg`STL Mesh (.stl)` },
];

const STL_ENCODING_OPTIONS: ReadonlyArray<{
  value: 'binary' | 'ascii';
  label: MessageDescriptor;
  title: MessageDescriptor;
}> = [
  { value: 'binary', label: msg`Binary`, title: msg`Binary STL (recommended)` },
  { value: 'ascii', label: msg`ASCII`, title: msg`ASCII STL` },
];

const EXPORT_ACTION_LABELS: Record<ExportOptions['format'], MessageDescriptor> = {
  '3mf': msg`Export as 3MF`,
  stl: msg`Export as STL`,
  voxl: msg`Export Scene File`,
};

// Active state of the button-row pickers. The geometry is the Support Studio
// bracing card's Low/Mid/High density selector; the tint is the accent, except
// for the format row, which carries the secondary theme colour to match the
// lime action button below it.
const activeOptionStyle: React.CSSProperties = {
  borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 30%)',
  background: 'color-mix(in srgb, var(--accent), var(--surface-1) 85%)',
  color: 'var(--text-strong)',
};

const activeSecondaryOptionStyle: React.CSSProperties = {
  borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 30%)',
  background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 85%)',
  color: 'var(--text-strong)',
};

/** A row that is showing but has nothing to say: the plate choice under "Active Model". */
const disabledOptionStyle: React.CSSProperties = {
  borderColor: 'var(--border-subtle)',
  background: 'var(--surface-0)',
  color: 'var(--text-muted)',
  opacity: 0.6,
};

function joinNativePath(directory: string, fileName: string): string {
  const trimmedDirectory = directory.trim().replace(/[\\/]+$/, '');
  const separator = trimmedDirectory.includes('\\') ? '\\' : '/';
  return `${trimmedDirectory}${separator}${fileName}`;
}

export function ExportPanel({
  models,
  activeModel,
  activeModelId,
  selectedModelIds,
  plateGroups,
  activePlateId,
  onActiveModelChange,
  supportsRef,
  captureSceneThumbnailPng,
  onExportSuccess,
  onExportError,
  onExportProgress,
}: ExportPanelProps) {
  const { _ } = useLingui();
  const [isExpanded, setIsExpanded] = useFloatingPanelCollapse(true);
  const [exportScope, setExportScope] = useState<ExportScope>('entire_plate');
  const [plateScope, setPlateScope] = useState<ExportPlateScope>('all_plates');
  const [exportLayout, setExportLayout] = useState<ExportLayout>('bundle');
  const [isExporting, setIsExporting] = useState(false);
  const [isExportingIndividually, setIsExportingIndividually] = useState(false);

  const [options, setOptions] = useState<ExportOptions>({
    filename: '',
    format: 'voxl',
    binary: true,
    separateFiles: false,
    includeRaft: true,
    includeSupports: true,
    includeModel: true,
  });

  const modelOptions = useMemo(() => {
    return models.map((model) => ({
      id: model.id,
      name: model.name,
      visible: model.visible,
    }));
  }, [models]);

  /**
   * Which plate of the list the panel speaks for: the one being worked on, or the first it
   * knows, which is what an active plate with nothing on it leaves.
   */
  const activePlateIndex = useMemo(
    () => Math.max(0, (plateGroups ?? []).findIndex((plate) => plate.id === activePlateId)),
    [activePlateId, plateGroups],
  );

  /**
   * The models the "Entire Plate" scope covers: the plate being worked on, or every plate
   * in the scene. Hidden models are only reached when nothing visible is there to export,
   * which is what the scope has always done.
   */
  const entirePlateScopeModels = useMemo(() => {
    const currentPlateModelIds = (plateGroups ?? [])[activePlateIndex]?.modelIds;
    const plateModels = plateScope === 'current_plate' && currentPlateModelIds
      ? models.filter((model) => currentPlateModelIds.includes(model.id))
      : models;
    const visiblePlateModels = plateModels.filter((model) => model.visible);
    return visiblePlateModels.length > 0 ? visiblePlateModels : plateModels;
  }, [activePlateIndex, models, plateGroups, plateScope]);

  /** One bed is the whole export: there is no "per plate" to offer or to name. */
  const singlePlate = (plateGroups?.length ?? 0) <= 1;

  /**
   * The layouts this format offers, for this scene.
   *
   * A bundle is a scene, so 3MF and STL have no such thing and their nearest choice is one
   * file per plate — with a single plate that is one file for everything, which is what the
   * panel now calls it instead of "Plates".
   */
  const layoutOptions = useMemo(() => (
    EXPORT_LAYOUT_OPTIONS
      .filter((option) => option.formats.includes(options.format))
      .filter((option) => !(singlePlate && option.value === 'plates' && options.format === 'voxl'))
      .map((option) => (singlePlate && option.value === 'plates'
        ? { ...option, label: msg`Bundle`, title: msg`One file holding everything on the plate` }
        : option))
  ), [options.format, singlePlate]);

  // A scene is the only layout that can hold several plates at once, and one bed is the
  // whole export: with a single plate, "one file per plate" and "one file for the lot" write
  // the same file, so VOXL hides the duplicate and moves a selection that was on it.
  useEffect(() => {
    if (options.format !== 'voxl') {
      if (exportLayout === 'bundle') setExportLayout('plates');
      return;
    }
    if (singlePlate && exportLayout === 'plates') setExportLayout('bundle');
  }, [exportLayout, options.format, singlePlate]);

  /** The models the run covers, before the layout decides how to split them up. */
  const scopeModels = exportScope === 'active_model'
    ? (activeModel ? [activeModel] : [])
    : entirePlateScopeModels;

  const scopedMeshCount = scopeModels.length;

  /**
   * The plate being worked on, as a file name. A bundle and a per-plate run are both exports
   * of beds, so a bed is what they are named for — and an unnamed bed in a one-bed scene goes
   * by its model, which says more than its number does.
   */
  const activePlateFileBaseName = useMemo(() => resolvePlateOutputBaseName({
    plateName: (plateGroups ?? [])[activePlateIndex]?.name ?? '',
    plateNumberLabel: plateNumberPlaceholder(activePlateIndex + 1, _),
    singlePlate,
    plateModels: entirePlateScopeModels,
  }), [_, activePlateIndex, entirePlateScopeModels, plateGroups, singlePlate]);

  // The name the native save dialog opens with. The user renames the file there,
  // so this is only a starting suggestion and never displayed in the panel.
  const suggestedFileName = useMemo(
    () => (exportScope === 'active_model'
      ? normalizeExportBaseName(activeModel?.name)
      : activePlateFileBaseName),
    [activeModel, activePlateFileBaseName, exportScope],
  );

  useEffect(() => {
    if (options.format !== 'voxl') return;

    setOptions((prev) => {
      if (prev.includeModel && prev.includeSupports && !prev.includeRaft && !prev.separateFiles && prev.binary) {
        return prev;
      }

      return {
        ...prev,
        includeModel: true,
        includeSupports: true,
        includeRaft: false,
        separateFiles: false,
        binary: true,
      };
    });
  }, [options.format]);

  const buildModelGroup = (model: LoadedModel): THREE.Group => {
    const group = new THREE.Group();
    const t = model.transform;
    group.position.copy(t.position);
    group.rotation.copy(t.rotation);
    group.scale.copy(t.scale);

    const centerOffset = model.geometry.center;
    const mesh = new THREE.Mesh(model.geometry.geometry);
    mesh.position.set(-centerOffset.x, -centerOffset.y, -centerOffset.z);

    group.add(mesh);
    group.updateMatrixWorld(true);
    return group;
  };

  const resolveEffectiveOptions = React.useCallback((): ExportOptions => (
    options.format === 'voxl'
      ? {
          ...options,
          format: 'voxl',
          includeModel: true,
          includeSupports: true,
          includeRaft: false,
          separateFiles: false,
          binary: true,
        }
      : options
  ), [options]);

  const handleExport = async () => {
    const effectiveOptions = resolveEffectiveOptions();

    if (effectiveOptions.includeModel && scopeModels.length === 0) {
      return;
    }

    setIsExporting(true);
    onExportProgress?.(true);

    setTimeout(async () => {
      try {
        let exportThumbnailPng: Uint8Array | null = null;
        if (effectiveOptions.format === 'voxl' && captureSceneThumbnailPng) {
          try {
            exportThumbnailPng = await captureSceneThumbnailPng();
          } catch (thumbnailError) {
            console.warn('[ExportPanel] Scene thumbnail capture failed for VOXL export; continuing without thumbnail.', thumbnailError);
          }
        }

        const exportRoot = new THREE.Group();
        if (effectiveOptions.includeModel) {
          scopeModels.forEach((model) => {
            exportRoot.add(buildModelGroup(model));
          });
          exportRoot.updateMatrixWorld(true);
        }

        const scopedModelIds = scopeModels.map((model) => model.id);
        const scopedActiveModelId = exportScope === 'active_model'
          ? (activeModel?.id ?? null)
          : (scopedModelIds.includes(activeModelId ?? '') ? activeModelId : scopedModelIds[0] ?? null);

        const scopedSelectedModelIds = (selectedModelIds ?? [])
          .filter((id) => scopedModelIds.includes(id));

        const savedPath = await ExportManager.exportScene(
          effectiveOptions.includeModel ? exportRoot : null,
          supportsRef?.current || null,
          {
            ...effectiveOptions,
            filename: suggestedFileName || 'export',
          },
          {
            models: scopeModels,
            activeModelId: scopedActiveModelId,
            selectedModelIds: scopedSelectedModelIds.length > 0
              ? scopedSelectedModelIds
              : (scopedActiveModelId ? [scopedActiveModelId] : []),
            exportThumbnailPng,
            // A bundled scene carries its beds, so opening it back up finds the plates
            // where they were rather than everything piled on the first one.
            ...(plateGroups && plateGroups.length > 0
              ? {
                  plates: plateGroups.map((plate) => ({ id: plate.id, name: plate.name })),
                  ...(activePlateId ? { activePlateId } : {}),
                }
              : {}),
          },
        );
        if (savedPath) onExportSuccess?.(savedPath);
      } catch (err) {
        console.error('Export failed:', err);
        onExportError?.(_(msg`Export failed. Check console for details.`));
      } finally {
        setIsExporting(false);
        onExportProgress?.(false);
      }
    }, 100);
  };

  /**
   * Writes one file per group into a directory the user picks. Both "Plates" and
   * "Separate" are this: they differ only in how the models are grouped, and the plate
   * path names each file for the plate it holds.
   */
  const exportGroupsToDirectory = async (groups: Array<{ name: string; models: LoadedModel[] }>) => {
    const effectiveOptions = resolveEffectiveOptions();
    const exportableGroups = groups.filter((group) => group.models.length > 0);
    if (effectiveOptions.includeModel && exportableGroups.length === 0) return;

    setIsExportingIndividually(true);
    onExportProgress?.(true);

    try {
      const targetDirectory = (await pickDirectoryWithNativeDialog()).trim();
      if (!targetDirectory) return;

      const extension = effectiveOptions.format === '3mf'
        ? '3mf'
        : effectiveOptions.format === 'voxl'
          ? 'voxl'
          : 'stl';

      const nameCounts = new Map<string, number>();
      const savedPaths: string[] = [];

      for (const group of exportableGroups) {
        const normalizedBaseName = normalizeExportBaseName(group.name || 'model');
        const seenCount = nameCounts.get(normalizedBaseName) ?? 0;
        nameCounts.set(normalizedBaseName, seenCount + 1);
        const dedupedBaseName = seenCount > 0 ? `${normalizedBaseName}_${seenCount + 1}` : normalizedBaseName;

        const nativePath = joinNativePath(targetDirectory, `${dedupedBaseName}.${extension}`);

        const exportRoot = new THREE.Group();
        if (effectiveOptions.includeModel) {
          group.models.forEach((model) => exportRoot.add(buildModelGroup(model)));
          exportRoot.updateMatrixWorld(true);
        }

        const scopedModelIds = group.models.map((model) => model.id);
        const scopedActiveModelId = scopedModelIds.includes(activeModelId ?? '')
          ? activeModelId
          : (scopedModelIds[0] ?? null);

        const savedPath = await ExportManager.exportScene(
          effectiveOptions.includeModel ? exportRoot : null,
          supportsRef?.current || null,
          {
            ...effectiveOptions,
            filename: dedupedBaseName,
          },
          {
            models: group.models,
            activeModelId: scopedActiveModelId,
            selectedModelIds: scopedModelIds,
            exportThumbnailPng: null,
          },
          {
            nativePath,
          },
        );

        if (savedPath) {
          savedPaths.push(savedPath);
        }
      }

      if (savedPaths.length > 0) {
        onExportSuccess?.(targetDirectory);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? 'Unknown error');
      const normalized = message.toLowerCase();
      if (normalized.includes('cancelled by user') || normalized.includes('canceled by user')) {
        return;
      }
      console.error('Grouped export failed:', error);
      onExportError?.(_(msg`Export failed. Check console for details.`));
    } finally {
      setIsExportingIndividually(false);
      onExportProgress?.(false);
    }
  };

  /** One file per plate, each named for the plate and holding the models on it. */
  const handleExportPerPlate = async () => {
    const plates = plateGroups && plateGroups.length > 0
      ? plateGroups
      : [{ id: '', name: '', modelIds: scopeModels.map((model) => model.id) }];
    const groups = plates.map((plate, index) => {
      const plateModels = scopeModels.filter((model) => plate.modelIds.includes(model.id));
      return {
        name: resolvePlateOutputBaseName({
          plateName: plate.name ?? '',
          plateNumberLabel: plateNumberPlaceholder(index + 1, _),
          singlePlate,
          plateModels,
        }),
        models: plateModels,
      };
    });

    await exportGroupsToDirectory(groups);
  };

  /** One file per model, named for the model. */
  const handleExportSeparate = async () => {
    await exportGroupsToDirectory(
      scopeModels.map((model) => ({ name: model.name || 'model', models: [model] })),
    );
  };

  const isAnyExportInProgress = isExporting || isExportingIndividually;


  if (models.length === 0) {
    return (
      <Card className="w-72">
        <CardHeader
          left={(
            <>
              <PanelCollapseToggle
                expanded={isExpanded}
                onToggle={() => setIsExpanded((prev) => !prev)}
              />
              <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}><Trans>Export</Trans></h3>
            </>
          )}
        />
        {isExpanded && (
          <div className="px-2.5 pt-1 pb-2.5 text-xs" style={{ color: 'var(--text-muted)' }}>
            <Trans>No meshes loaded yet. Import a model first, then hop back to Export.</Trans>
          </div>
        )}
      </Card>
    );
  }

  return (
    <Card className="w-72">
      <CardHeader
        left={(
          <>
            <PanelCollapseToggle
              expanded={isExpanded}
              onToggle={() => setIsExpanded((prev) => !prev)}
            />
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}><Trans>Export</Trans></h3>
          </>
        )}
        right={(
          <Tooltip content={formatScopedMeshCountTitle(_, scopedMeshCount)} maxWidth={220}>
          <div
            className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5"
            style={{
              borderColor: 'color-mix(in srgb, var(--accent), transparent 62%)',
              background: 'color-mix(in srgb, var(--accent), var(--surface-1) 86%)',
            }}
          >
            <Box className="h-3 w-3" style={{ color: 'var(--accent)' }} />
            <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
              <Trans comment="Badge label next to the number of meshes this export writes. Rendered uppercase; keep it to one short word.">Meshes</Trans>
            </span>
            <span className="text-xs font-bold tabular-nums" style={{ color: 'var(--text-strong)' }}>
              {scopedMeshCount}
            </span>
          </div>
          </Tooltip>
        )}
      />

      {isExpanded && (
        <div className="px-2.5 pt-1 pb-2.5 space-y-2">
          <div className="rounded-md border p-2 space-y-1.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div role="group" aria-label={_(msg`Export scope`)} className="grid grid-cols-2 gap-1.5">
              {EXPORT_SCOPE_OPTIONS.map((option) => (
                <Button
                  key={option.value}
                  variant="secondary"
                  size="auto"
                  aria-pressed={exportScope === option.value}
                  className="!h-8 whitespace-nowrap px-1.5 text-[10px] sm:text-[11px]"
                  style={exportScope === option.value ? activeOptionStyle : { background: 'var(--surface-0)' }}
                  onClick={() => setExportScope(option.value)}
                >
                  {_(option.label)}
                </Button>
              ))}
            </div>

            {exportScope === 'active_model' && (
              <div className="space-y-0.5">
                <Select
                  value={activeModelId ?? ''}
                  onChange={(e) => onActiveModelChange(e.target.value || null)}
                  className="w-full"
                  aria-label={_(msg`Model to export`)}
                >
                  <option value="" disabled>{_(msg`Select a model`)}</option>
                  {modelOptions.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.visible ? model.name : formatHiddenModelOptionLabel(_, model.name)}
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </div>

          {/* Which beds "Entire Plate" means. Only asked when there is more than one bed
              to choose between, and it has nothing to say while "Active Model" is the
              scope: one model is one model wherever it stands. */}
          {(plateGroups?.length ?? 0) > 1 && (
            <div className="rounded-md border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
              <div
                role="group"
                aria-label={_(msg`Export plates`)}
                className="grid grid-cols-2 gap-1.5"
              >
                {EXPORT_PLATE_SCOPE_OPTIONS.map((option) => {
                  const isPlateScopeInert = exportScope === 'active_model';
                  return (
                    <Button
                      key={option.value}
                      variant="secondary"
                      size="auto"
                      aria-pressed={plateScope === option.value}
                      disabled={isPlateScopeInert}
                      className="!h-8 whitespace-nowrap px-1.5 text-[10px] sm:text-[11px]"
                      style={isPlateScopeInert
                        ? disabledOptionStyle
                        : (plateScope === option.value ? activeOptionStyle : { background: 'var(--surface-0)' })}
                      onClick={() => setPlateScope(option.value)}
                    >
                      {_(option.label)}
                    </Button>
                  );
                })}
              </div>
            </div>
          )}

          {exportScope === 'active_model' && !activeModel ? (
            <div className="rounded-md border px-2.5 py-2 text-xs" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)', background: 'var(--surface-1)' }}>
              <Trans>Pick a model to export.</Trans>
            </div>
          ) : (
            <>
              <div className="rounded-md border p-2 space-y-1.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div role="group" aria-label={_(msg`Export format`)} className="grid grid-cols-3 gap-1.5">
                  {EXPORT_FORMAT_OPTIONS.map((option) => (
                    <Tooltip key={option.value} content={_(option.title)} maxWidth={220} wrapperClassName="w-full">
                    <Button
                      variant="secondary"
                      size="auto"
                      aria-pressed={options.format === option.value}
                      className="!h-8 w-full whitespace-nowrap px-1.5 text-[10px] sm:text-[11px]"
                      style={options.format === option.value ? activeSecondaryOptionStyle : { background: 'var(--surface-0)' }}
                      onClick={() => setOptions(prev => ({ ...prev, format: option.value }))}
                    >
                      {_(option.label)}
                    </Button>
                    </Tooltip>
                  ))}
                </div>

                {options.format === 'stl' && (
                  <div role="group" aria-label={_(msg`STL encoding`)} className="grid grid-cols-2 gap-1.5">
                    {STL_ENCODING_OPTIONS.map((option) => (
                      <Tooltip key={option.value} content={_(option.title)} maxWidth={220} wrapperClassName="w-full">
                      <Button
                        variant="secondary"
                        size="auto"
                        aria-pressed={(options.binary ? 'binary' : 'ascii') === option.value}
                        className="!h-8 w-full whitespace-nowrap px-1.5 text-[10px] sm:text-[11px]"
                        style={(options.binary ? 'binary' : 'ascii') === option.value ? activeOptionStyle : { background: 'var(--surface-0)' }}
                        onClick={() => setOptions(prev => ({ ...prev, binary: option.value === 'binary' }))}
                      >
                        {_(option.label)}
                      </Button>
                      </Tooltip>
                    ))}
                  </div>
                )}
              </div>

              {/* How one run splits what it writes. A bundle is a single scene, so 3MF and
                  STL have no such thing — their nearest choice is one file per plate. */}
              <div className="rounded-md border p-2 space-y-1.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div
                  role="group"
                  aria-label={_(msg`Export layout`)}
                  className={`grid gap-1.5 ${layoutOptions.length >= 3 ? 'grid-cols-3' : 'grid-cols-2'}`}
                >
                  {layoutOptions
                    .map((option) => (
                      <Tooltip key={option.value} content={_(option.title)} maxWidth={220} wrapperClassName="w-full">
                      <Button
                        variant="secondary"
                        size="auto"
                        aria-pressed={exportLayout === option.value}
                        className="!h-8 w-full whitespace-nowrap px-1.5 text-[10px] sm:text-[11px]"
                        style={exportLayout === option.value ? activeSecondaryOptionStyle : { background: 'var(--surface-0)' }}
                        onClick={() => setExportLayout(option.value)}
                      >
                        {_(option.label)}
                      </Button>
                      </Tooltip>
                    ))}
                </div>
              </div>

              {options.format !== 'voxl' && (
                <div className="space-y-1.5">
                  <SettingRow as="label" bordered surface="raised" label={<Trans>Include Model Mesh</Trans>}>
                    <Toggle
                      checked={options.includeModel}
                      onChange={(v) => setOptions(prev => ({ ...prev, includeModel: v }))}
                      size="md"
                    />
                  </SettingRow>
                  <SettingRow as="label" bordered surface="raised" label={<Trans>Include Supports</Trans>}>
                    <Toggle
                      checked={options.includeSupports}
                      onChange={(v) => setOptions(prev => ({ ...prev, includeSupports: v }))}
                      size="md"
                    />
                  </SettingRow>
                  <SettingRow as="label" bordered surface="raised" label={<Trans>Include Raft</Trans>}>
                    <Toggle
                      checked={options.includeRaft}
                      onChange={(v) => setOptions(prev => ({ ...prev, includeRaft: v }))}
                      size="md"
                    />
                  </SettingRow>
                </div>
              )}

              <div className="space-y-1.5 border-t pt-2" style={{ borderColor: 'var(--border-subtle)' }}>
                <Button
                  onClick={() => {
                    void (exportLayout === 'bundle'
                      ? handleExport()
                      : exportLayout === 'plates'
                        ? handleExportPerPlate()
                        : handleExportSeparate());
                  }}
                  disabled={isAnyExportInProgress || (options.includeModel && scopeModels.length === 0)}
                  variant="accent"
                  className={`w-full gap-1.5 ${isAnyExportInProgress ? 'cursor-wait opacity-70' : ''}`}
                >
                  {isAnyExportInProgress ? (
                    <>
                      <Spinner size="md" />
                      <span><Trans>Exporting…</Trans></span>
                    </>
                  ) : (
                    <>
                      <Download className="h-4 w-4" />
                      <span>{_(EXPORT_ACTION_LABELS[options.format])}</span>
                    </>
                  )}
                </Button>
              </div>

            </>
          )}
        </div>
      )}
    </Card>
  );
}

export default ExportPanel;
