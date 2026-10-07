import React, { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { Box, Download, Files } from 'lucide-react';
import { useLingui } from '@lingui/react';
import { msg, plural } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { MessageDescriptor } from '@lingui/core';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { ExportManager, ExportOptions } from '../logic/ExportManager';
import { normalizeExportBaseName, resolveEntirePlateExportBaseName } from '../logic/exportFileNaming';
import {
  Button,
  Card,
  CardHeader,
  Input,
  Select,
  SettingRow,
  Spinner,
  Toggle,
} from '@/components/atoms';
import { PanelCollapseToggle } from '@/components/atoms/PanelCollapseToggle';
import { pickDirectoryWithNativeDialog } from '@/features/slicing/tauri/nativeSlicerBridge';
import { useFloatingPanelCollapse } from '@/components/layout/FloatingPanelStack';

interface ExportPanelProps {
  models: LoadedModel[];
  activeModel: LoadedModel | null;
  activeModelId: string | null;
  selectedModelIds?: string[];
  onActiveModelChange: (modelId: string | null) => void;
  supportsRef?: React.RefObject<THREE.Group | null>;
  captureSceneThumbnailPng?: () => Promise<Uint8Array | null>;
  onExportSuccess?: (savedPath: string) => void;
  onExportError?: (message: string) => void;
  onExportProgress?: (exporting: boolean) => void;
}

type ExportScope = 'entire_plate' | 'active_model';

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
  const [filename, setFilename] = useState(() => normalizeExportBaseName(activeModel?.name));
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

  // How many meshes the current scope hands to the export, for the header badge.
  const visibleModelCount = models.filter((model) => model.visible).length;
  const scopedMeshCount = exportScope === 'active_model'
    ? (activeModel ? 1 : 0)
    : (visibleModelCount > 0 ? visibleModelCount : models.length);

  useEffect(() => {
    if (exportScope === 'active_model' && activeModel) {
      setFilename(normalizeExportBaseName(activeModel.name));
      return;
    }

    if (exportScope === 'entire_plate') {
      setFilename(resolveEntirePlateExportBaseName(models));
    }
  }, [activeModel, exportScope, models]);

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

    const visibleModels = models.filter((model) => model.visible);
    const scopeModels = exportScope === 'active_model'
      ? (activeModel ? [activeModel] : [])
      : (visibleModels.length > 0 ? visibleModels : models);

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
            filename: filename || 'export',
          },
          {
            models: scopeModels,
            activeModelId: scopedActiveModelId,
            selectedModelIds: scopedSelectedModelIds.length > 0
              ? scopedSelectedModelIds
              : (scopedActiveModelId ? [scopedActiveModelId] : []),
            exportThumbnailPng,
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

  const handleExportIndividually = async () => {
    const effectiveOptions = resolveEffectiveOptions();
    const visibleModels = models.filter((model) => model.visible);
    const plateModels = visibleModels.length > 0 ? visibleModels : models;

    if (effectiveOptions.includeModel && plateModels.length === 0) {
      return;
    }

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

      for (const model of plateModels) {
        const normalizedBaseName = normalizeExportBaseName(model.name || 'model');
        const seenCount = nameCounts.get(normalizedBaseName) ?? 0;
        nameCounts.set(normalizedBaseName, seenCount + 1);
        const dedupedBaseName = seenCount > 0 ? `${normalizedBaseName}_${seenCount + 1}` : normalizedBaseName;

        const nativePath = joinNativePath(targetDirectory, `${dedupedBaseName}.${extension}`);

        const savedPath = await ExportManager.exportScene(
          effectiveOptions.includeModel ? buildModelGroup(model) : null,
          supportsRef?.current || null,
          {
            ...effectiveOptions,
            filename: dedupedBaseName,
          },
          {
            models: [model],
            activeModelId: model.id,
            selectedModelIds: [model.id],
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
      console.error('Batch export failed:', error);
      onExportError?.(_(msg`Batch export failed. Check console for details.`));
    } finally {
      setIsExportingIndividually(false);
      onExportProgress?.(false);
    }
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
          <div
            className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5"
            style={{
              borderColor: 'color-mix(in srgb, var(--accent), transparent 62%)',
              background: 'color-mix(in srgb, var(--accent), var(--surface-1) 86%)',
            }}
            title={formatScopedMeshCountTitle(_, scopedMeshCount)}
          >
            <Box className="h-3 w-3" style={{ color: 'var(--accent)' }} />
            <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
              <Trans comment="Badge label next to the number of meshes this export writes. Rendered uppercase; keep it to one short word.">Meshes</Trans>
            </span>
            <span className="text-xs font-bold tabular-nums" style={{ color: 'var(--text-strong)' }}>
              {scopedMeshCount}
            </span>
          </div>
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
                <label className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  <Trans>Model</Trans>
                </label>
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

          {exportScope === 'active_model' && !activeModel ? (
            <div className="rounded-md border px-2.5 py-2 text-xs" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)', background: 'var(--surface-1)' }}>
              <Trans>Pick a model to export.</Trans>
            </div>
          ) : (
            <>
              <div className="rounded-md border p-2 space-y-1.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div className="space-y-0.5">
                  <Input
                    type="text"
                    value={filename}
                    onChange={(e) => setFilename(e.target.value)}
                    className="w-full !h-8"
                    placeholder="my_print"
                    aria-label={_(msg`Export file name`)}
                  />
                </div>

                <div role="group" aria-label={_(msg`Export format`)} className="grid grid-cols-3 gap-1.5">
                  {EXPORT_FORMAT_OPTIONS.map((option) => (
                    <Button
                      key={option.value}
                      variant="secondary"
                      size="auto"
                      aria-pressed={options.format === option.value}
                      className="!h-8 whitespace-nowrap px-1.5 text-[10px] sm:text-[11px]"
                      style={options.format === option.value ? activeSecondaryOptionStyle : { background: 'var(--surface-0)' }}
                      title={_(option.title)}
                      onClick={() => setOptions(prev => ({ ...prev, format: option.value }))}
                    >
                      {_(option.label)}
                    </Button>
                  ))}
                </div>

                {options.format === 'stl' && (
                  <div role="group" aria-label={_(msg`STL encoding`)} className="grid grid-cols-2 gap-1.5">
                    {STL_ENCODING_OPTIONS.map((option) => (
                      <Button
                        key={option.value}
                        variant="secondary"
                        size="auto"
                        aria-pressed={(options.binary ? 'binary' : 'ascii') === option.value}
                        className="!h-8 whitespace-nowrap px-1.5 text-[10px] sm:text-[11px]"
                        style={(options.binary ? 'binary' : 'ascii') === option.value ? activeOptionStyle : { background: 'var(--surface-0)' }}
                        title={_(option.title)}
                        onClick={() => setOptions(prev => ({ ...prev, binary: option.value === 'binary' }))}
                      >
                        {_(option.label)}
                      </Button>
                    ))}
                  </div>
                )}
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
                  onClick={handleExport}
                  disabled={isAnyExportInProgress || (options.includeModel && exportScope === 'active_model' && !activeModel)}
                  variant="accent"
                  className={`w-full gap-1.5 ${isExporting ? 'cursor-wait opacity-70' : ''}`}
                >
                  {isExporting ? (
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

                <Button
                  onClick={() => { void handleExportIndividually(); }}
                  disabled={isAnyExportInProgress || models.length <= 1}
                  variant="secondary"
                  className={`w-full gap-1.5 ${isExportingIndividually ? 'cursor-wait opacity-70' : ''}`}
                  title={models.length <= 1 ? _(msg`Add more models to use Batch Export`) : _(msg`Export each visible model and its supports into separate files in a folder`)}
                >
                  {isExportingIndividually ? (
                    <>
                      <Spinner size="md" />
                      <span><Trans>Exporting Individually…</Trans></span>
                    </>
                  ) : (
                    <>
                      <Files className="h-4 w-4" />
                      <span><Trans>Batch Export</Trans></span>
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
