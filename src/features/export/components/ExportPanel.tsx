import React, { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { Download, FileType2, Layers3, PackageCheck, Settings2 } from 'lucide-react';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { ExportManager, ExportOptions } from '../logic/ExportManager';
import { Button, Card, CardHeader, IconButton, Input, Select } from '@/components/ui/primitives';

interface ExportPanelProps {
  models: LoadedModel[];
  activeModel: LoadedModel | null;
  activeModelId: string | null;
  onActiveModelChange: (modelId: string | null) => void;
  supportsRef?: React.RefObject<THREE.Group | null>;
}

type ToggleRowProps = {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
};

function ToggleRow({ label, hint, checked, onChange }: ToggleRowProps) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-md border px-2.5 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
      <div className="min-w-0">
        <div className="text-xs font-medium" style={{ color: 'var(--text-strong)' }}>{label}</div>
        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{hint}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className="w-10 h-6 rounded-full flex items-center px-0.5 transition-colors shrink-0"
        style={{ background: checked ? 'var(--accent)' : 'var(--surface-2)' }}
      >
        <span
          className={`w-5 h-5 rounded-full bg-white shadow transform transition-transform ${checked ? 'translate-x-4' : 'translate-x-0'}`}
        />
      </button>
    </label>
  );
}

export function ExportPanel({
  models,
  activeModel,
  activeModelId,
  onActiveModelChange,
  supportsRef,
}: ExportPanelProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [filename, setFilename] = useState(activeModel?.name?.replace('.stl', '') || 'MyPrint');
  const [isExporting, setIsExporting] = useState(false);

  const [options, setOptions] = useState<ExportOptions>({
    filename: '',
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
    if (!activeModel) return;
    const baseName = activeModel.name.replace(/\.(stl|obj|3mf)$/i, '');
    setFilename(baseName || 'MyPrint');
  }, [activeModel?.id]);

  const handleExport = async () => {
    if (!activeModel) return;

    setIsExporting(true);

    setTimeout(async () => {
      try {
        const group = new THREE.Group();
        const t = activeModel.transform;
        group.position.copy(t.position);
        group.rotation.copy(t.rotation);
        group.scale.copy(t.scale);

        const centerOffset = activeModel.geometry.center;
        const mesh = new THREE.Mesh(activeModel.geometry.geometry);
        mesh.position.set(-centerOffset.x, -centerOffset.y, -centerOffset.z);

        group.add(mesh);
        group.updateMatrixWorld(true);

        await ExportManager.exportScene(
          group as unknown as THREE.Mesh,
          supportsRef?.current || null,
          {
            ...options,
            filename: filename || 'export',
          }
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
              <h2 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Export STL</h2>
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
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Export STL</h2>
          </>
        )}
        hideDivider={!isExpanded}
      />

      {isExpanded && (
      <div className="px-3 pt-2 pb-3 space-y-2.5">
        <div className="rounded-md border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
            <Layers3 className="w-3.5 h-3.5" />
            <span>Model</span>
          </div>

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
        </div>

        {!activeModel ? (
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
                  <label className="text-xs" style={{ color: 'var(--text-muted)' }}>Format</label>
                  <Select
                    value={options.binary ? 'binary' : 'ascii'}
                    onChange={(e) => setOptions(prev => ({ ...prev, binary: e.target.value === 'binary' }))}
                    className="w-full !h-9 text-sm"
                  >
                    <option value="binary">Binary STL (recommended)</option>
                    <option value="ascii">ASCII STL</option>
                  </Select>
                </div>
              </div>
            </div>

            <div className="rounded-md border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
              <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                <Settings2 className="w-3.5 h-3.5" />
                <span>Include</span>
              </div>

              <div className="space-y-1.5">
                <ToggleRow
                  label="Model mesh"
                  hint="Export the selected model geometry"
                  checked={options.includeModel}
                  onChange={(checked) => setOptions(prev => ({ ...prev, includeModel: checked }))}
                />
                <ToggleRow
                  label="Supports"
                  hint="Include generated supports in the STL"
                  checked={options.includeSupports}
                  onChange={(checked) => setOptions(prev => ({ ...prev, includeSupports: checked }))}
                />
                <ToggleRow
                  label="Raft"
                  hint="Include raft geometry when enabled"
                  checked={options.includeRaft}
                  onChange={(checked) => setOptions(prev => ({ ...prev, includeRaft: checked }))}
                />
                <ToggleRow
                  label="Separate files"
                  hint="Reserved for split export workflow"
                  checked={options.separateFiles}
                  onChange={(checked) => setOptions(prev => ({ ...prev, separateFiles: checked }))}
                />
              </div>
            </div>

            <Button
              onClick={handleExport}
              disabled={isExporting || !activeModel}
              variant="accent"
              className={`w-full !h-9 text-sm inline-flex items-center justify-center gap-2 ${isExporting ? 'cursor-wait opacity-70' : ''}`}
            >
              {isExporting ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 rounded-full animate-spin" style={{ borderColor: 'color-mix(in srgb, var(--accent-contrast), transparent 65%)', borderTopColor: 'var(--accent-contrast)' }} />
                  <span>Exporting…</span>
                </>
              ) : (
                <>
                  <PackageCheck className="w-4 h-4" />
                  <span>Download STL</span>
                  <Download className="w-4 h-4" />
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
