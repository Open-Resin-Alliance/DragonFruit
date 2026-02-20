import React, { useEffect, useMemo, useState } from 'react';
import {
  Eye,
  EyeOff,
  Trash2,
  Box,
  AlertTriangle,
  Upload,
  FolderInput,
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  Pencil,
  FolderPlus,
  FolderMinus,
  PanelsTopLeft,
} from 'lucide-react';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { Card, CardHeader, IconButton } from '@/components/ui/primitives';

type SelectMode = 'single' | 'toggle' | 'add';

type GroupSelectMode = 'single' | 'add';

interface ModelManagerPanelProps {
  models: LoadedModel[];
  outsidePlateModelIds?: string[];
  activeModelId: string | null;
  selectedModelIds: string[];
  onSelect: (id: string, mode?: SelectMode) => void;
  onSelectRange?: (ids: string[], activeId: string, mode?: 'replace' | 'add') => void;
  onSelectGroup?: (groupId: string, mode?: GroupSelectMode) => void;
  onGroupModels?: (modelIds: string[]) => void;
  onUngroupModels?: (modelIds: string[]) => void;
  onUngroupGroup?: (groupId: string) => void;
  onRenameGroup?: (groupId: string, nextName: string) => void;
  onModelContextMenu?: (id: string, position: { x: number; y: number }) => void;
  onDelete: (id: string) => void;
  onVisibilityChange: (id: string, visible: boolean) => void;
  onLoadMeshChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onImportSceneChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  dimmed?: boolean;
}

type GroupedEntry = {
  id: string;
  name: string;
  models: LoadedModel[];
  isGrouped: boolean;
  isSystemGroup?: boolean;
};

type PanelContextMenuState = {
  x: number;
  y: number;
  modelId?: string;
  groupId?: string;
  groupName?: string;
  isSystemGroup?: boolean;
};

const OUTSIDE_PLATE_GROUP_ID = '__system_outside_plate__';

export function ModelManagerPanel({
  models,
  outsidePlateModelIds = [],
  activeModelId,
  selectedModelIds,
  onSelect,
  onSelectRange,
  onSelectGroup,
  onGroupModels,
  onUngroupModels,
  onUngroupGroup,
  onRenameGroup,
  onModelContextMenu,
  onDelete,
  onVisibilityChange,
  onLoadMeshChange,
  onImportSceneChange,
  dimmed = false,
}: ModelManagerPanelProps) {
  const [expanded, setExpanded] = useState(true);
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Record<string, boolean>>({});
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [renamingGroupName, setRenamingGroupName] = useState('');
  const [contextMenu, setContextMenu] = useState<PanelContextMenuState | null>(null);

  const selectedSet = useMemo(() => new Set(selectedModelIds), [selectedModelIds]);

  const grouped = useMemo<GroupedEntry[]>(() => {
    const outsidePlateSet = new Set(outsidePlateModelIds);
    const outsideModels = models.filter((model) => outsidePlateSet.has(model.id));
    const inPlateModels = models.filter((model) => !outsidePlateSet.has(model.id));

    const groupedMap = new Map<string, GroupedEntry>();

    inPlateModels.forEach((model) => {
      const key = model.groupId ?? `single-${model.id}`;
      const existing = groupedMap.get(key);
      if (existing) {
        existing.models.push(model);
        return;
      }

      groupedMap.set(key, {
        id: key,
        name: model.groupName ?? model.name,
        models: [model],
        isGrouped: !!model.groupId,
      });
    });

    return Array.from(groupedMap.values())
      .map((group) => ({
        ...group,
        models: [...group.models].sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => {
        if (a.isGrouped !== b.isGrouped) return a.isGrouped ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .reduce<GroupedEntry[]>((acc, group) => {
        acc.push(group);
        return acc;
      }, outsideModels.length > 0
        ? [{
            id: OUTSIDE_PLATE_GROUP_ID,
            name: 'Outside Plate',
            models: [...outsideModels].sort((a, b) => a.name.localeCompare(b.name)),
            isGrouped: true,
            isSystemGroup: true,
          }]
        : []);
  }, [models, outsidePlateModelIds]);

  const contextModel = useMemo(() => {
    if (!contextMenu?.modelId) return null;
    return models.find((m) => m.id === contextMenu.modelId) ?? null;
  }, [contextMenu?.modelId, models]);

  const contextGroup = useMemo(() => {
    if (!contextMenu?.groupId) return null;
    return grouped.find((g) => g.id === contextMenu.groupId) ?? null;
  }, [contextMenu?.groupId, grouped]);

  const selectedGroupedCount = useMemo(() => {
    if (selectedModelIds.length === 0) return 0;
    const selected = models.filter((m) => selectedSet.has(m.id));
    return selected.filter((m) => !!m.groupId).length;
  }, [models, selectedModelIds.length, selectedSet]);

  const closeContextMenu = () => setContextMenu(null);

  const orderedModelIds = useMemo(() => grouped.flatMap((group) => group.models.map((model) => model.id)), [grouped]);

  const toggleGroupCollapsed = (groupId: string) => {
    setCollapsedGroupIds((prev) => ({
      ...prev,
      [groupId]: !prev[groupId],
    }));
  };

  const beginRenameGroup = (groupId: string, currentName: string) => {
    setRenamingGroupId(groupId);
    setRenamingGroupName(currentName);
    closeContextMenu();
  };

  const cancelRenameGroup = () => {
    setRenamingGroupId(null);
    setRenamingGroupName('');
  };

  const commitRenameGroup = () => {
    if (!renamingGroupId || !onRenameGroup) {
      cancelRenameGroup();
      return;
    }

    const trimmed = renamingGroupName.trim();
    if (trimmed.length > 0) {
      onRenameGroup(renamingGroupId, trimmed);
    }
    cancelRenameGroup();
  };

  const selectFolder = (group: GroupedEntry, mode: GroupSelectMode) => {
    if (group.models.length === 0) return;

    if (onSelectGroup && group.isGrouped && !group.isSystemGroup) {
      onSelectGroup(group.id, mode);
      return;
    }

    group.models.forEach((model, index) => {
      if (mode === 'single') {
        onSelect(model.id, index === 0 ? 'single' : 'add');
        return;
      }
      onSelect(model.id, 'add');
    });
  };

  useEffect(() => {
    if (!contextMenu) return;

    const handlePointerDown = () => closeContextMenu();
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeContextMenu();
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleEscape);

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [contextMenu]);

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

          <div className="space-y-1 overflow-y-auto custom-scrollbar pr-0.5 max-h-[min(68vh,calc(100vh-var(--topbar-height)-220px))]">
            {models.length === 0 ? (
              <div className="text-xs text-center py-2 italic" style={{ color: 'var(--text-muted)' }}>
                No models loaded
              </div>
            ) : (
              grouped.map((group) => {
                const isCollapsed = group.isGrouped ? !!collapsedGroupIds[group.id] : false;
                const selectedCount = group.models.filter((model) => selectedSet.has(model.id)).length;
                const isGroupFullySelected = selectedCount > 0 && selectedCount === group.models.length;
                const isGroupPartiallySelected = selectedCount > 0 && !isGroupFullySelected;
                const showHeader = group.isGrouped;

                return (
                  <div
                    key={group.id}
                    className={showHeader ? 'space-y-1 rounded-md border p-1' : 'space-y-1'}
                    style={showHeader
                      ? {
                          borderColor: 'color-mix(in srgb, var(--border-subtle), var(--accent) 14%)',
                          background: 'color-mix(in srgb, var(--surface-1), var(--accent) 3%)',
                        }
                      : undefined}
                  >
                    {showHeader && (
                      <div
                        className={`px-1.5 py-1 rounded border flex items-center gap-1.5 cursor-pointer transition-colors ${
                          isGroupFullySelected
                            ? 'bg-blue-500/12 border-blue-500/45'
                            : isGroupPartiallySelected
                              ? 'bg-blue-500/8 border-blue-500/30'
                              : 'hover:bg-neutral-700/60'
                        }`}
                        style={isGroupFullySelected || isGroupPartiallySelected
                          ? undefined
                          : { borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}
                        onClick={(e) => {
                          const mode: GroupSelectMode = (e.ctrlKey || e.metaKey || e.shiftKey) ? 'add' : 'single';
                          selectFolder(group, mode);
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setContextMenu({
                            x: e.clientX,
                            y: e.clientY,
                            groupId: group.id,
                            groupName: group.name,
                            isSystemGroup: group.isSystemGroup,
                          });
                        }}
                      >
                        <button
                          type="button"
                          className="inline-flex items-center justify-center rounded p-0.5 hover:bg-black/20"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleGroupCollapsed(group.id);
                          }}
                          title={isCollapsed ? 'Expand folder' : 'Collapse folder'}
                        >
                          {isCollapsed
                            ? <ChevronRight className="w-3 h-3" style={{ color: 'var(--text-muted)' }} />
                            : <ChevronDown className="w-3 h-3" style={{ color: 'var(--text-muted)' }} />}
                        </button>

                        {group.isSystemGroup ? (
                          <AlertTriangle className="w-3.5 h-3.5" style={{ color: '#ff7c88' }} />
                        ) : isCollapsed
                          ? <Folder className="w-3.5 h-3.5" style={{ color: 'var(--accent)' }} />
                          : <FolderOpen className="w-3.5 h-3.5" style={{ color: 'var(--accent)' }} />}

                        {renamingGroupId === group.id ? (
                          <input
                            value={renamingGroupName}
                            onChange={(e) => setRenamingGroupName(e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                commitRenameGroup();
                              }
                              if (e.key === 'Escape') {
                                e.preventDefault();
                                cancelRenameGroup();
                              }
                            }}
                            onBlur={commitRenameGroup}
                            autoFocus
                            className="flex-1 min-w-0 rounded border px-1.5 py-0.5 text-[11px]"
                            style={{
                              borderColor: 'var(--border-subtle)',
                              background: 'var(--surface-0)',
                              color: 'var(--text-strong)',
                            }}
                            aria-label="Rename folder"
                          />
                        ) : (
                          <span className="text-[10px] font-semibold uppercase tracking-wide truncate" style={{ color: 'var(--text-muted)' }}>
                            {group.name}
                          </span>
                        )}

                        <span className="ml-auto text-[10px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
                          {group.models.length}
                        </span>
                      </div>
                    )}

                    {(!showHeader || !isCollapsed) && (
                      <div
                        className={showHeader ? 'ml-1.5 space-y-1 pl-1' : 'space-y-1'}
                      >
                        {group.models.map((model) => {
                      const isActive = model.id === activeModelId;
                      const isSelected = selectedSet.has(model.id);

                      return (
                        <div
                          key={model.id}
                          className={`p-2 rounded border transition-colors flex items-center gap-2 cursor-pointer ${
                            isSelected
                              ? 'bg-blue-500/10 border-blue-500/50'
                              : 'hover:bg-neutral-700/70'
                          }`}
                          style={!isSelected
                            ? {
                                background: 'var(--surface-1)',
                                borderColor: 'var(--border-subtle)',
                              }
                            : undefined}
                          onClick={(e) => {
                            if (e.shiftKey) {
                              const anchorId = activeModelId ?? selectedModelIds[selectedModelIds.length - 1] ?? model.id;
                              const anchorIndex = orderedModelIds.indexOf(anchorId);
                              const clickedIndex = orderedModelIds.indexOf(model.id);

                              if (anchorIndex >= 0 && clickedIndex >= 0) {
                                const start = Math.min(anchorIndex, clickedIndex);
                                const end = Math.max(anchorIndex, clickedIndex);
                                const rangeIds = orderedModelIds.slice(start, end + 1);
                                const additive = e.ctrlKey || e.metaKey;

                                if (onSelectRange) {
                                  onSelectRange(rangeIds, model.id, additive ? 'add' : 'replace');
                                } else {
                                  if (additive) {
                                    rangeIds.forEach((id) => onSelect(id, 'add'));
                                  } else {
                                    onSelect(model.id, 'single');
                                    rangeIds.filter((id) => id !== model.id).forEach((id) => onSelect(id, 'add'));
                                  }
                                }
                                return;
                              }
                            }

                            const isToggle = e.ctrlKey || e.metaKey;
                            onSelect(model.id, isToggle ? 'toggle' : 'single');
                          }}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setContextMenu({
                              x: e.clientX,
                              y: e.clientY,
                              modelId: model.id,
                              groupId: model.groupId,
                              groupName: model.groupName,
                            });
                          }}
                        >
                          <div className={`p-1 rounded ${isSelected ? 'bg-blue-500/20 text-blue-300' : ''}`} style={!isSelected ? { background: 'var(--surface-2)', color: 'var(--text-muted)' } : undefined}>
                            <Box className="w-3.5 h-3.5" />
                          </div>

                          <div className="flex-1 min-w-0">
                            <div className={`text-xs font-medium truncate ${isSelected ? 'text-blue-100' : ''}`} style={!isSelected ? { color: 'var(--text-strong)' } : undefined}>
                              {model.name}
                              {isActive && <span className="ml-1 text-[10px] uppercase" style={{ color: 'var(--accent)' }}>Active</span>}
                            </div>
                            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                              {model.polygonCount.toLocaleString()} polys
                            </div>
                          </div>

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
                    })}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {contextMenu && (
        <div
          className="fixed z-[130] w-52 rounded-lg border p-1.5 shadow-xl"
          style={{
            left: Math.max(8, Math.min(contextMenu.x, (typeof window !== 'undefined' ? window.innerWidth : 1920) - 216)),
            top: Math.max(8, Math.min(contextMenu.y, (typeof window !== 'undefined' ? window.innerHeight : 1080) - 220)),
            borderColor: 'var(--border-subtle)',
            background: 'color-mix(in srgb, var(--surface-0), #000 12%)',
          }}
          onPointerDown={(e) => e.stopPropagation()}
          role="menu"
          aria-label="Models context menu"
        >
          <div className="mb-1 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
            Models
          </div>

          <div className="space-y-0.5">
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium hover:bg-white/5"
              style={{ color: selectedModelIds.length >= 2 ? 'var(--text-strong)' : 'var(--text-muted)', opacity: selectedModelIds.length >= 2 ? 1 : 0.6 }}
              disabled={selectedModelIds.length < 2}
              onClick={() => {
                if (selectedModelIds.length < 2 || !onGroupModels) return;
                onGroupModels(selectedModelIds);
                closeContextMenu();
              }}
            >
              <FolderPlus className="h-3.5 w-3.5" />
              <span>Group Selected</span>
            </button>

            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium hover:bg-white/5"
              style={{ color: selectedGroupedCount > 0 ? 'var(--text-strong)' : 'var(--text-muted)', opacity: selectedGroupedCount > 0 ? 1 : 0.6 }}
              disabled={selectedGroupedCount === 0}
              onClick={() => {
                if (selectedGroupedCount === 0 || !onUngroupModels) return;
                onUngroupModels(selectedModelIds);
                closeContextMenu();
              }}
            >
              <FolderMinus className="h-3.5 w-3.5" />
              <span>Ungroup Selected</span>
            </button>

            <div className="my-1 h-px" style={{ background: 'var(--border-subtle)' }} />

            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium hover:bg-white/5"
              style={{ color: contextMenu.groupId ? 'var(--text-strong)' : 'var(--text-muted)', opacity: contextMenu.groupId ? 1 : 0.6 }}
              disabled={!contextMenu.groupId}
              onClick={() => {
                if (!contextMenu.groupId) return;
                const target = contextGroup ?? grouped.find((g) => g.id === contextMenu.groupId);
                if (!target) return;
                selectFolder(target, 'single');
                closeContextMenu();
              }}
            >
              <PanelsTopLeft className="h-3.5 w-3.5" />
              <span>Select Folder</span>
            </button>

            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium hover:bg-white/5"
              style={{ color: contextMenu.groupId && !contextMenu.isSystemGroup ? 'var(--text-strong)' : 'var(--text-muted)', opacity: contextMenu.groupId && !contextMenu.isSystemGroup ? 1 : 0.6 }}
              disabled={!contextMenu.groupId || !!contextMenu.isSystemGroup}
              onClick={() => {
                if (!contextMenu.groupId || !onRenameGroup || contextMenu.isSystemGroup) return;
                beginRenameGroup(contextMenu.groupId, contextMenu.groupName ?? contextGroup?.name ?? 'Group');
              }}
            >
              <Pencil className="h-3.5 w-3.5" />
              <span>Rename Folder</span>
            </button>

            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium hover:bg-white/5"
              style={{ color: contextMenu.groupId && !contextMenu.isSystemGroup ? 'var(--text-strong)' : 'var(--text-muted)', opacity: contextMenu.groupId && !contextMenu.isSystemGroup ? 1 : 0.6 }}
              disabled={!contextMenu.groupId || !!contextMenu.isSystemGroup}
              onClick={() => {
                if (!contextMenu.groupId || !onUngroupGroup || contextMenu.isSystemGroup) return;
                onUngroupGroup(contextMenu.groupId);
                closeContextMenu();
              }}
            >
              <FolderMinus className="h-3.5 w-3.5" />
              <span>Ungroup Folder</span>
            </button>

            {contextModel && onModelContextMenu && (
              <>
                <div className="my-1 h-px" style={{ background: 'var(--border-subtle)' }} />
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium hover:bg-white/5"
                  style={{ color: 'var(--text-strong)' }}
                  onClick={() => {
                    onModelContextMenu(contextModel.id, { x: contextMenu.x, y: contextMenu.y });
                    closeContextMenu();
                  }}
                >
                  <Box className="h-3.5 w-3.5" />
                  <span>Model Actions…</span>
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
