import React, { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { Download, FileType2, Layers3, Settings2 } from 'lucide-react';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { ExportManager, ExportOptions } from '../logic/ExportManager';
import { Button, Card, CardHeader, IconButton, Input, Select } from '@/components/ui/primitives';

interface ExportPanelProps {
  models: LoadedModel[];
  activeModel: LoadedModel | null;
  activeModelId: string | null;
  selectedModelIds?: string[];
  onActiveModelChange: (modelId: string | null) => void;
  supportsRef?: React.RefObject<THREE.Group | null>;
}

type ExportScope = 'entire_plate' | 'active_model';

function normalizeExportBaseName(rawName: string | null | undefined): string {
  const trimmed = (rawName ?? '').trim();
  if (!trimmed) return 'MyPrint';

  // Strip common source suffixes if present (including chained suffixes).
  const withoutKnownExt = trimmed.replace(/(\.(stl|obj|3mf|lys|lychee|json|voxl))+$/i, '');
  const cleaned = withoutKnownExt.replace(/[.\s]+$/g, '').trim();
  return cleaned || 'MyPrint';
}

function resolveEntirePlateExportBaseName(models: LoadedModel[]): string {
  const firstVisible = models.find((model) => model.visible) ?? models[0] ?? null;
  const firstBase = normalizeExportBaseName(firstVisible?.name);
  return `${firstBase}_DF_Scene`;
}

export function ExportPanel({
  models,
  activeModel,
  activeModelId,
  selectedModelIds,
  onActiveModelChange,
  supportsRef,
}: ExportPanelProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [exportScope, setExportScope] = useState<ExportScope>('entire_plate');
  const [filename, setFilename] = useState(() => normalizeExportBaseName(activeModel?.name));
  const [isExporting, setIsExporting] = useState(false);

  const [options, setOptions] = useState<ExportOptions>({
    filename: '',
    format: '3mf',
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

  const handleExport = async () => {
    const effectiveOptions: ExportOptions = options.format === 'voxl'
      ? {
          ...options,
          format: 'voxl',
          includeModel: true,
          includeSupports: true,
          includeRaft: false,
          separateFiles: false,
          binary: true,
        }
      : options;

    const visibleModels = models.filter((model) => model.visible);
    const scopeModels = exportScope === 'active_model'
      ? (activeModel ? [activeModel] : [])
      : (visibleModels.length > 0 ? visibleModels : models);

    if (effectiveOptions.includeModel && scopeModels.length === 0) {
      return;
    }

    setIsExporting(true);

    setTimeout(async () => {
      try {
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

        await ExportManager.exportScene(
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
          },
        );
      } catch (err) {
        console.error('Export failed:', err);
        alert('Export failed. Check console for details.');
      } finally {
        setIsExporting(false);
      }
    }, 100);
  };


  if (models.length === 0) {
    return (
      <Card className="w-72">
        <CardHeader
          left={(
            <>
              <IconButton
                onClick={() => setIsExpanded((prev) => !prev)}
                className="!p-0.5"
                title={isExpanded ? 'Collapse card' : 'Expand card'}
              >
                <svg
                  className="w-3 h-3 transform transition-transform"
                  style={{ color: isExpanded ? 'var(--accent)' : 'var(--text-muted)' }}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  {isExpanded ? (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  ) : (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  )}
                </svg>
              </IconButton>
              <h2 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Export</h2>
            </>
          )}
          hideDivider={!isExpanded}
        />
        {isExpanded && (
          <div className="px-3 pb-3 text-xs" style={{ color: 'var(--text-muted)' }}>
            No meshes loaded yet. Import a model first, then hop back to Export.
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
            <IconButton
              onClick={() => setIsExpanded((prev) => !prev)}
              className="!p-0.5"
              title={isExpanded ? 'Collapse card' : 'Expand card'}
            >
              <svg
                className="w-3 h-3 transform transition-transform"
                style={{ color: isExpanded ? 'var(--accent)' : 'var(--text-muted)' }}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                {isExpanded ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                )}
              </svg>
            </IconButton>
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Export</h2>
          </>
        )}
        hideDivider={!isExpanded}
      />

      {isExpanded && (
      <div className="px-3 pt-2 pb-3 space-y-2.5">
        <div className="rounded-md border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
            <Layers3 className="w-3.5 h-3.5" />
            <span>{exportScope === 'active_model' ? 'Model' : 'Plate'}</span>
          </div>

          {exportScope === 'active_model' ? (
            <Select
              value={activeModelId ?? ''}
              onChange={(e) => onActiveModelChange(e.target.value || null)}
              className="w-full !h-9 text-sm"
            >
              <option value="" disabled>Select a model</option>
              {modelOptions.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.visible ? model.name : `${model.name} (hidden)`}
                </option>
              ))}
            </Select>
          ) : (
            <div className="rounded-md border px-2.5 py-2 text-xs" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)', background: 'var(--surface-0)' }}>
              Entire plate export uses all visible models.
            </div>
          )}
        </div>

        {exportScope === 'active_model' && !activeModel ? (
          <div className="rounded-md border p-2 text-xs" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)', background: 'var(--surface-1)' }}>
            Pick a model to export.
          </div>
        ) : (
          <>
            <div className="rounded-md border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
              <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                <FileType2 className="w-3.5 h-3.5" />
                <span>Output</span>
              </div>

              <div className="space-y-1.5">
                <div className="space-y-0.5">
                  <label className="text-xs" style={{ color: 'var(--text-muted)' }}>Filename</label>
                  <Input
                    type="text"
                    value={filename}
                    onChange={(e) => setFilename(e.target.value)}
                    className="w-full !h-9 text-sm"
                    placeholder="my_print"
                  />
                </div>

                <div className="space-y-0.5">
                  <label className="text-xs" style={{ color: 'var(--text-muted)' }}>Export scope</label>
                  <Select
                    value={exportScope}
                    onChange={(e) => setExportScope(e.target.value as ExportScope)}
                    className="w-full !h-9 text-sm"
                  >
                    <option value="entire_plate">Entire Plate (default)</option>
                    <option value="active_model">Active Model Only</option>
                  </Select>
                </div>

                <div className="space-y-0.5">
                  <label className="text-xs" style={{ color: 'var(--text-muted)' }}>Format</label>
                  <Select
                    value={options.format}
                    onChange={(e) => setOptions(prev => ({ ...prev, format: e.target.value as ExportOptions['format'] }))}
                    className="w-full !h-9 text-sm"
                  >
                    <option value="3mf">3MF Mesh (.3mf) — default</option>
                    <option value="stl">STL Mesh (.stl)</option>
                    <option value="voxl">VOXL Scene (.voxl)</option>
                  </Select>
                </div>

                {options.format === 'stl' && (
                  <div className="space-y-0.5">
                    <label className="text-xs" style={{ color: 'var(--text-muted)' }}>STL encoding</label>
                    <Select
                      value={options.binary ? 'binary' : 'ascii'}
                      onChange={(e) => setOptions(prev => ({ ...prev, binary: e.target.value === 'binary' }))}
                      className="w-full !h-9 text-sm"
                    >
                      <option value="binary">Binary STL (recommended)</option>
                      <option value="ascii">ASCII STL</option>
                    </Select>
                  </div>
                )}
                {options.format === '3mf' && (
                  <div className="rounded-md border px-2.5 py-2 text-xs" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)', background: 'var(--surface-0)' }}>
                    Mesh File (.3mf)
                  </div>
                )}
              </div>
            </div>

            {options.format !== 'voxl' ? (
              <div className="rounded-md border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                  <Settings2 className="w-3.5 h-3.5" />
                  <span>Include</span>
                </div>

                <div className="space-y-1.5">
                  <label className="flex items-center justify-between gap-3 rounded-md border px-2.5 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                    <div className="min-w-0">
                      <div className="text-xs font-medium" style={{ color: 'var(--text-strong)' }}>Model mesh</div>
                      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Export model geometry for the chosen scope</div>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={options.includeModel}
                      onClick={() => setOptions(prev => ({ ...prev, includeModel: !prev.includeModel }))}
                      className="w-10 h-6 rounded-full flex items-center px-0.5 transition-colors shrink-0"
                      style={{ background: options.includeModel ? 'var(--accent)' : 'var(--surface-2)' }}
                    >
                      <span className={`w-5 h-5 rounded-full bg-white shadow transform transition-transform ${options.includeModel ? 'translate-x-4' : 'translate-x-0'}`} />
                    </button>
                  </label>
                  <label className="flex items-center justify-between gap-3 rounded-md border px-2.5 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                    <div className="min-w-0">
                      <div className="text-xs font-medium" style={{ color: 'var(--text-strong)' }}>Supports</div>
                      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Include generated supports in the export</div>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={options.includeSupports}
                      onClick={() => setOptions(prev => ({ ...prev, includeSupports: !prev.includeSupports }))}
                      className="w-10 h-6 rounded-full flex items-center px-0.5 transition-colors shrink-0"
                      style={{ background: options.includeSupports ? 'var(--accent)' : 'var(--surface-2)' }}
                    >
                      <span className={`w-5 h-5 rounded-full bg-white shadow transform transition-transform ${options.includeSupports ? 'translate-x-4' : 'translate-x-0'}`} />
                    </button>
                  </label>
                  <label className="flex items-center justify-between gap-3 rounded-md border px-2.5 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                    <div className="min-w-0">
                      <div className="text-xs font-medium" style={{ color: 'var(--text-strong)' }}>Raft</div>
                      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Include raft geometry when enabled</div>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={options.includeRaft}
                      onClick={() => setOptions(prev => ({ ...prev, includeRaft: !prev.includeRaft }))}
                      className="w-10 h-6 rounded-full flex items-center px-0.5 transition-colors shrink-0"
                      style={{ background: options.includeRaft ? 'var(--accent)' : 'var(--surface-2)' }}
                    >
                      <span className={`w-5 h-5 rounded-full bg-white shadow transform transition-transform ${options.includeRaft ? 'translate-x-4' : 'translate-x-0'}`} />
                    </button>
                  </label>
                  <label className="flex items-center justify-between gap-3 rounded-md border px-2.5 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                    <div className="min-w-0">
                      <div className="text-xs font-medium" style={{ color: 'var(--text-strong)' }}>Separate files</div>
                      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Reserved for split export workflow</div>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={options.separateFiles}
                      onClick={() => setOptions(prev => ({ ...prev, separateFiles: !prev.separateFiles }))}
                      className="w-10 h-6 rounded-full flex items-center px-0.5 transition-colors shrink-0"
                      style={{ background: options.separateFiles ? 'var(--accent)' : 'var(--surface-2)' }}
                    >
                      <span className={`w-5 h-5 rounded-full bg-white shadow transform transition-transform ${options.separateFiles ? 'translate-x-4' : 'translate-x-0'}`} />
                    </button>
                  </label>
                </div>
              </div>
            ) : (
              <div className="rounded-md border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                  <Settings2 className="w-3.5 h-3.5" />
                  <span>VOXL includes</span>
                </div>
                <div className="rounded-md border px-2.5 py-2 text-xs" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)', background: 'var(--surface-0)' }}>
                  Scene export always includes mesh models and supports.
                </div>
              </div>
            )}

            <Button
              onClick={handleExport}
              disabled={isExporting || (options.includeModel && exportScope === 'active_model' && !activeModel)}
              variant="accent"
              className={`w-full !h-9 inline-flex items-center justify-center gap-1.5 ${isExporting ? 'cursor-wait opacity-70' : ''}`}
            >
              {isExporting ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 rounded-full animate-spin" style={{ borderColor: 'color-mix(in srgb, var(--accent-contrast), transparent 65%)', borderTopColor: 'var(--accent-contrast)' }} />
                  <span>Exporting…</span>
                </>
              ) : (
                <>
                  <Download className="h-4 w-4" />
                  <span>
                    {options.format === 'voxl'
                      ? 'Export Scene File'
                      : options.format === '3mf'
                        ? 'Export as 3MF'
                        : 'Export as STL'}
                  </span>
                </>
              )}
            </Button>

          </>
        )}
      </div>
      )}
    </Card>
  );
}

export default ExportPanel;
