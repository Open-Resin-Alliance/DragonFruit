import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Eye,
  EyeOff,
  Box,
  AlertTriangle,

  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  Pencil,
  FolderPlus,
  FolderMinus,
  PanelsTopLeft,
  Info,
  Crosshair,
  Wrench,
  Scissors,
} from 'lucide-react';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { Card, CardHeader, IconButton } from '@/components/ui/primitives';
import { formatMeshStatsForDisplay } from '@/utils/meshStatsFormatting';
import { useFloatingPanelCollapse } from '@/components/layout/FloatingPanelStack';

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
  /** Splits a multi-body 3MF model into independent models (pre-computed split bodies). */
  onSplitImportGroup?: (modelId: string) => void;
  onRenameGroup?: (groupId: string, nextName: string) => void;
  onRenameModel?: (id: string, nextName: string) => void;
  onModelContextMenu?: (id: string, position: { x: number; y: number }) => void;
  onRepairModel?: (id: string) => void;
  onOpenSupportsInfo?: (id: string) => void;
  onDelete: (id: string) => void;
  onVisibilityChange: (id: string, visible: boolean) => void;

  dimmed?: boolean;
  bottomClearancePx?: number;
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

const splitModelNameSuffix = (name: string): { base: string; suffix: string } => {
  const trimmed = name.trim();
  const match = trimmed.match(/^(.*?)(\.[^.\s]+)$/);
  if (!match) {
    return { base: trimmed, suffix: '' };
  }

  const base = match[1].trim();
  return {
    base: base.length > 0 ? base : 'Model',
    suffix: match[2],
  };
};

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
  onSplitImportGroup,
  onRenameGroup,
  onRenameModel,
  onModelContextMenu,
  onRepairModel,
  onOpenSupportsInfo,
  onDelete: _onDelete,
  onVisibilityChange,
  dimmed = false,
  bottomClearancePx = 220,
}: ModelManagerPanelProps) {
  const [expanded, setExpanded] = useFloatingPanelCollapse(true);
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Record<string, boolean>>({});
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [renamingGroupName, setRenamingGroupName] = useState('');
  const [renamingModelId, setRenamingModelId] = useState<string | null>(null);
  const [renamingModelName, setRenamingModelName] = useState('');
  const [renamingModelSuffix, setRenamingModelSuffix] = useState('');
  const [contextMenu, setContextMenu] = useState<PanelContextMenuState | null>(null);
  void _onDelete;
  const cardRef = useRef<HTMLDivElement | null>(null);
  const resizeDragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const getParentPanel = (el: HTMLElement): HTMLElement | null =>
    el.closest('.absolute.pointer-events-auto') as HTMLElement | null;

  const handleResizePointerDown = React.useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget as HTMLElement;
    const parent = getParentPanel(handle);
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    resizeDragRef.current = { startX: e.clientX, startWidth: rect.width };
    handle.setPointerCapture(e.pointerId);
  }, []);

  const handleResizePointerMove = React.useCallback((e: React.PointerEvent) => {
    const drag = resizeDragRef.current;
    if (!drag) return;
    const handle = e.currentTarget as HTMLElement;
    const parent = getParentPanel(handle);
    if (!parent) return;
    const dx = e.clientX - drag.startX;
    const newWidth = Math.max(280, Math.min(600, drag.startWidth + dx));
    parent.style.width = `${newWidth}px`;
  }, []);

  const handleResizePointerUp = React.useCallback((e: React.PointerEvent) => {
    resizeDragRef.current = null;
  }, []);

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

  const contextModelId = contextMenu?.modelId;
  const contextGroupId = contextMenu?.groupId;

  const contextModel = useMemo(() => {
    if (!contextModelId) return null;
    return models.find((m) => m.id === contextModelId) ?? null;
  }, [contextModelId, models]);

  const contextGroup = useMemo(() => {
    if (!contextGroupId) return null;
    return grouped.find((g) => g.id === contextGroupId) ?? null;
  }, [contextGroupId, grouped]);

  const selectedGroupedCount = useMemo(() => {
    if (selectedModelIds.length === 0) return 0;
    const selected = models.filter((m) => selectedSet.has(m.id));
    return selected.filter((m) => !!m.groupId).length;
  }, [models, selectedModelIds.length, selectedSet]);

  const closeContextMenu = () => setContextMenu(null);

  // Smart context menu visibility:
  // showGroupSection — show Group/Ungroup Selected only when there are grouped/multi-selected models or a folder is involved
  // showFolderSection — show folder actions only when the right-clicked item has a group context
  const showGroupSection = !!(contextMenu?.groupId || selectedModelIds.length >= 2 || selectedGroupedCount > 0 || !contextMenu?.modelId);
  const showFolderSection = !!contextMenu?.groupId;

  const orderedModelIds = useMemo(() => grouped.flatMap((group) => group.models.map((model) => model.id)), [grouped]);
  const computedBottomClearance = Math.max(140, Math.round(bottomClearancePx));
  const panelMaxHeight = `calc(100vh - var(--topbar-height) - ${computedBottomClearance}px)`;
  const panelClassName = dimmed
    ? 'opacity-60 pointer-events-none transition-opacity duration-150 flex flex-col relative'
    : 'transition-opacity duration-150 flex flex-col relative';
  const panelStyle: React.CSSProperties = {
    ...(dimmed ? { filter: 'grayscale(0.25)' } : {}),
    ...(expanded ? { maxHeight: panelMaxHeight } : {}),
  };

  const toggleGroupCollapsed = (groupId: string) => {
    setCollapsedGroupIds((prev) => ({
      ...prev,
      [groupId]: !prev[groupId],
    }));
  };

  const beginRenameGroup = (groupId: string, currentName: string) => {
    setRenamingModelId(null);
    setRenamingModelName('');
    setRenamingModelSuffix('');
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

  const beginRenameModel = (modelId: string, currentName: string) => {
    const { base, suffix } = splitModelNameSuffix(currentName);
    setRenamingGroupId(null);
    setRenamingGroupName('');
    setRenamingModelId(modelId);
    setRenamingModelName(base);
    setRenamingModelSuffix(suffix);
    closeContextMenu();
  };

  const cancelRenameModel = () => {
    setRenamingModelId(null);
    setRenamingModelName('');
    setRenamingModelSuffix('');
  };

  const commitRenameModel = () => {
    if (!renamingModelId || !onRenameModel) {
      cancelRenameModel();
      return;
    }

    const trimmedBase = renamingModelName.trim();
    if (trimmedBase.length > 0) {
      onRenameModel(renamingModelId, `${trimmedBase}${renamingModelSuffix}`);
    }
    cancelRenameModel();
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
    const handleEscape = (e: CustomEvent) => {
      if (e.detail.key === 'Escape') closeContextMenu();
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('app-hotkey-keydown', handleEscape as EventListener);

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('app-hotkey-keydown', handleEscape as EventListener);
    };
  }, [contextMenu]);


  return (
    <Card
      className={panelClassName}
      style={panelStyle}
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
        <div className="px-2.5 pt-1 pb-2.5 space-y-2 flex flex-col flex-1 min-h-0">
          <div className="space-y-1 overflow-y-auto custom-scrollbar pr-0.5 flex-1 min-h-0">
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
                const showChildren = !showHeader || !isCollapsed;

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
                        className="px-1.5 py-1 rounded border flex items-center gap-1.5 cursor-pointer transition-colors"
                        style={isGroupFullySelected
                          ? {
                              background: 'color-mix(in srgb, var(--accent), var(--surface-2) 90%)',
                              borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 45%)',
                            }
                          : isGroupPartiallySelected
                            ? {
                                background: 'color-mix(in srgb, var(--accent), var(--surface-2) 94%)',
                                borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 30%)',
                              }
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

                    {showChildren && (
                      <div
                        className={showHeader ? 'ml-1.5 space-y-1 pl-1' : 'space-y-1'}
                      >
                        {group.models.map((model) => {
                      const isActive = model.id === activeModelId;
                      const isSelected = selectedSet.has(model.id);

                      return (
                        <div
                          key={model.id}
                            className="p-2 rounded border transition-colors flex items-center gap-2 cursor-pointer"
                            style={isSelected
                              ? {
                                  background: 'color-mix(in srgb, var(--accent), var(--surface-1) 92%)',
                                  borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 40%)',
                                }
                              : {
                                  background: 'var(--surface-1)',
                                  borderColor: 'var(--border-subtle)',
                                }}
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
                          {isActive
                            ? (
                              <div className="p-1 rounded" style={{ background: 'color-mix(in srgb, var(--accent), var(--surface-2) 72%)', color: 'var(--accent)' }}>
                                <Crosshair className="w-3.5 h-3.5" />
                              </div>
                            ) : (
                              <div className="p-1 rounded" style={isSelected ? { background: 'color-mix(in srgb, var(--accent), var(--surface-2) 82%)', color: 'var(--accent)' } : { background: 'var(--surface-2)', color: 'var(--text-muted)' }}>
                                <Box className="w-3.5 h-3.5" />
                              </div>
                            )}

                          <div className="flex-1 min-w-0">
                            {renamingModelId === model.id ? (
                              <div className="flex w-full min-w-0 items-center gap-1">
                                <input
                                  value={renamingModelName}
                                  onChange={(e) => setRenamingModelName(e.target.value)}
                                  onClick={(e) => e.stopPropagation()}
                                  onPointerDown={(e) => e.stopPropagation()}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      e.preventDefault();
                                      commitRenameModel();
                                    }
                                    if (e.key === 'Escape') {
                                      e.preventDefault();
                                      cancelRenameModel();
                                    }
                                  }}
                                  onBlur={commitRenameModel}
                                  autoFocus
                                  className="min-w-0 flex-1 rounded border px-1.5 py-0.5 text-xs font-medium"
                                  style={{
                                    borderColor: 'var(--border-subtle)',
                                    background: 'var(--surface-0)',
                                    color: 'var(--text-strong)',
                                  }}
                                  aria-label="Rename model base name"
                                />
                                {renamingModelSuffix && (
                                  <span className="shrink-0 text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
                                    {renamingModelSuffix}
                                  </span>
                                )}
                              </div>
                            ) : (
                              <div className="text-xs font-medium truncate" style={{ color: 'var(--text-strong)' }}>
                                {model.name}
                              </div>
                            )}
                            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                              {formatMeshStatsForDisplay({
                                polygonCount: model.polygonCount,
                                componentCount: model.geometry.meshDefects?.nativeRepairReport?.post.component_count,
                              })}
                            </div>
                          </div>

                          <div className="flex items-center gap-1">
                            {onOpenSupportsInfo && (
                              <IconButton
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onOpenSupportsInfo(model.id);
                                }}
                                className="!p-1.5"
                                title="Supports for model"
                              >
                                <Info className="w-3.5 h-3.5" />
                              </IconButton>
                            )}
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
            {showGroupSection && (
              <>
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
              </>
            )}

            {showFolderSection && (
              <>
                {showGroupSection && <div className="my-1 h-px" style={{ background: 'var(--border-subtle)' }} />}

                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium hover:bg-white/5"
                  style={{ color: 'var(--text-strong)' }}
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
                  style={{ color: !contextMenu.isSystemGroup ? 'var(--text-strong)' : 'var(--text-muted)', opacity: !contextMenu.isSystemGroup ? 1 : 0.6 }}
                  disabled={!!contextMenu.isSystemGroup}
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
                  style={{ color: !contextMenu.isSystemGroup ? 'var(--text-strong)' : 'var(--text-muted)', opacity: !contextMenu.isSystemGroup ? 1 : 0.6 }}
                  disabled={!!contextMenu.isSystemGroup}
                  onClick={() => {
                    if (!contextMenu.groupId || !onUngroupGroup || contextMenu.isSystemGroup) return;
                    onUngroupGroup(contextMenu.groupId);
                    closeContextMenu();
                  }}
                >
                  <FolderMinus className="h-3.5 w-3.5" />
                  <span>Ungroup Folder</span>
                </button>
              </>
            )}

            {contextModel && (onRenameModel || onModelContextMenu || onRepairModel) && (
              <>
                {(showGroupSection || showFolderSection) && <div className="my-1 h-px" style={{ background: 'var(--border-subtle)' }} />}

                {onRenameModel && (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium hover:bg-white/5"
                    style={{ color: 'var(--text-strong)' }}
                    onClick={() => {
                      beginRenameModel(contextModel.id, contextModel.name ?? 'Model');
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    <span>Rename Model</span>
                  </button>
                )}

                {onRepairModel && (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium hover:bg-white/5"
                    style={{ color: 'var(--text-strong)' }}
                    onClick={() => {
                      onRepairModel(contextModel.id);
                      closeContextMenu();
                    }}
                  >
                    <Wrench className="h-3.5 w-3.5" />
                    <span>Repair Mesh…</span>
                  </button>
                )}

                {contextModel.splitBodies && onSplitImportGroup && (
                  <>
                    <div className="my-1 h-px" style={{ background: 'var(--border-subtle)' }} />
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium hover:bg-white/5"
                      style={{ color: 'var(--text-strong)' }}
                      onClick={() => {
                        onSplitImportGroup(contextModel.id);
                        closeContextMenu();
                      }}
                    >
                      <Scissors className="h-3.5 w-3.5" />
                      <span>Split to Bodies</span>
                    </button>
                  </>
                )}

                {onModelContextMenu && (
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
                )}
              </>
            )}
          </div>
        </div>
      )}
      {/* Horizontal resize handle on the right edge */}
      <div
        className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:opacity-100 opacity-0 transition-opacity"
        style={{
          background: 'transparent',
        }}
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerUp}
        onPointerCancel={handleResizePointerUp}
      >
        <div
          className="absolute right-0 top-0 bottom-0 w-[3px] rounded-full transition-colors"
          style={{
            background: 'color-mix(in srgb, var(--accent), transparent 60%)',
          }}
        />
      </div>
    </Card>
  );
}
