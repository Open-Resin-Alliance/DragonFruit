import React, { useState } from 'react';
import { Eye, EyeOff, Trash2, Box, Upload, FolderInput } from 'lucide-react';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { Card, CardHeader, IconButton } from '@/components/ui/primitives';

interface ModelManagerPanelProps {
  models: LoadedModel[];
  activeModelId: string | null;
  onSelect: (id: string) => void;
  onModelContextMenu?: (id: string, position: { x: number; y: number }) => void;
  onDelete: (id: string) => void;
  onVisibilityChange: (id: string, visible: boolean) => void;
  onLoadMeshChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onImportSceneChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  dimmed?: boolean;
}

export function ModelManagerPanel({
  models,
  activeModelId,
  onSelect,
  onModelContextMenu,
  onDelete,
  onVisibilityChange,
  onLoadMeshChange,
  onImportSceneChange,
  dimmed = false,
}: ModelManagerPanelProps) {
  const [expanded, setExpanded] = useState(true);

  return (
    <Card
      className={dimmed ? 'opacity-60 pointer-events-none transition-opacity duration-150' : 'transition-opacity duration-150'}
      style={dimmed ? { filter: 'grayscale(0.25)' } : undefined}
    >
      <CardHeader
        left={(
          <>
            <IconButton
              onClick={() => setExpanded(!expanded)}
              title={expanded ? 'Collapse card' : 'Expand card'}
              className="!p-0.5"
            >
              <svg
                className="w-3 h-3 transform transition-transform"
                style={{ color: expanded ? 'var(--accent)' : 'var(--text-muted)' }}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                {expanded ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                )}
              </svg>
            </IconButton>
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Models</h3>
          </>
        )}
        right={(
          <div
            className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5"
            style={{
              borderColor: 'color-mix(in srgb, var(--accent), transparent 62%)',
              background: 'color-mix(in srgb, var(--accent), var(--surface-1) 86%)',
            }}
            title={`${models.length} model${models.length === 1 ? '' : 's'} loaded`}
          >
            <Box className="h-3 w-3" style={{ color: 'var(--accent)' }} />
            <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
              Count
            </span>
            <span className="text-xs font-bold tabular-nums" style={{ color: 'var(--text-strong)' }}>
              {models.length}
            </span>
          </div>
        )}
        hideDivider={!expanded}
      />

      {expanded && (
        <div className="px-2.5 pt-1 pb-2.5 space-y-2">
          <div
            className="rounded-md border p-2"
            style={{ background: 'var(--surface-1)', borderColor: 'var(--border-subtle)' }}
          >
            <div className="mb-1.5 text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
              Quick Actions
            </div>

            <div className={`grid gap-2 ${onImportSceneChange ? 'grid-cols-2' : 'grid-cols-1'}`}>
              <label
                htmlFor="models-card-mesh-input"
                className="ui-button ui-button-primary inline-flex items-center justify-center gap-2 min-h-9"
              >
                <Upload className="w-4 h-4" />
                <span>Load Mesh</span>
              </label>
              <input
                id="models-card-mesh-input"
                type="file"
                accept=".stl"
                multiple
                onChange={onLoadMeshChange}
                className="hidden"
              />

              {onImportSceneChange && (
                <>
                  <label
                    htmlFor="models-card-scene-input"
                    className="ui-button ui-button-accent inline-flex items-center justify-center gap-2 min-h-9"
                  >
                    <FolderInput className="w-4 h-4" />
                    <span>Import Scene</span>
                  </label>
                  <input
                    id="models-card-scene-input"
                    type="file"
                    accept=".lys"
                    onChange={onImportSceneChange}
                    className="hidden"
                  />
                </>
              )}
            </div>

            <div className={`mt-1.5 grid gap-2 ${onImportSceneChange ? 'grid-cols-2' : 'grid-cols-1'}`}>
              <div className="text-[10px] text-center" style={{ color: 'var(--text-muted)' }}>
                STL now • 3MF soon
              </div>
              {onImportSceneChange && (
                <div className="text-[10px] text-center" style={{ color: 'var(--text-muted)' }}>
                  LYS now • VOXL soon
                </div>
              )}
            </div>
          </div>

          <div className="space-y-1 max-h-48 overflow-y-auto custom-scrollbar">
            {models.length === 0 ? (
              <div className="text-xs text-center py-2 italic" style={{ color: 'var(--text-muted)' }}>
                No models loaded
              </div>
            ) : (
              models.map((model) => {
                const isActive = model.id === activeModelId;
                return (
                  <div
                    key={model.id}
                    className={`p-2 rounded border transition-colors flex items-center gap-2 cursor-pointer ${
                      isActive
                        ? 'bg-blue-500/10 border-blue-500/50'
                        : 'border-transparent hover:bg-neutral-700/70'
                    }`}
                    style={!isActive ? { background: 'var(--surface-1)' } : undefined}
                    onClick={() => onSelect(model.id)}
                    onContextMenu={(e) => {
                      if (!onModelContextMenu) return;
                      e.preventDefault();
                      e.stopPropagation();
                      onModelContextMenu(model.id, { x: e.clientX, y: e.clientY });
                    }}
                  >
                    {/* Icon */}
                    <div className={`p-1 rounded ${isActive ? 'bg-blue-500/20 text-blue-300' : ''}`} style={!isActive ? { background: 'var(--surface-2)', color: 'var(--text-muted)' } : undefined}>
                      <Box className="w-3.5 h-3.5" />
                    </div>

                    {/* Details */}
                    <div className="flex-1 min-w-0">
                      <div className={`text-xs font-medium truncate ${isActive ? 'text-blue-100' : ''}`} style={!isActive ? { color: 'var(--text-strong)' } : undefined}>
                        {model.name}
                      </div>
                      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                        {model.polygonCount.toLocaleString()} polys
                      </div>
                    </div>

                    {/* Controls */}
                    <div className="flex items-center gap-1">
                      <IconButton
                        onClick={(e) => {
                          e.stopPropagation();
                          onVisibilityChange(model.id, !model.visible);
                        }}
                        className="!p-1.5"
                        title={model.visible ? 'Hide' : 'Show'}
                      >
                        {model.visible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                      </IconButton>
                      <IconButton
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(model.id);
                        }}
                        className="!p-1.5 text-red-300 hover:text-red-200"
                        title="Delete model"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </IconButton>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
