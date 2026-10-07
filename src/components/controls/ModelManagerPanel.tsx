import React, { useMemo, useRef, useState } from 'react';
import {
  Eye,
  EyeOff,
  Box,
  Plus,
  LayoutGrid,
  AlertTriangle,

  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  Pencil,
  Trash2,
  FolderPlus,
  FolderMinus,
  PanelsTopLeft,
  Info,
  Wrench,
  Scissors,
} from 'lucide-react';
import { useLingui } from '@lingui/react';
import { msg, plural } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { MessageDescriptor } from '@lingui/core';
import { formatFileSize } from '@/utils/meshStatsFormatting';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { Button, Card, CardHeader, IconButton } from '@/components/atoms';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';
import { plateNumberPlaceholder } from '@/features/scene/plates/plateMessages';
import type { ScenePlate } from '@/features/scene/useSceneCollectionManager';
import { PanelCollapseToggle } from '@/components/atoms/PanelCollapseToggle';
import { useFloatingPanelCollapse } from '@/components/layout/FloatingPanelStack';
import { Tooltip } from '@/components/ui/Tooltip';
import { ContextMenu, type ContextMenuEntry } from '@/components/ui/ContextMenu';

type SelectMode = 'single' | 'toggle' | 'add';

type Translate = (descriptor: MessageDescriptor, values?: Record<string, unknown>) => string;

/**
 * What the model row's info button explains: how big the mesh is and how many
 * polygons it has. Built at module scope because React Compiler renames locals
 * ahead of the Lingui macro, which desyncs an interpolated message id and leaves
 * the placeholders raw in production — the same reason page.tsx keeps its
 * formatters out here.
 */
function formatModelInfoTooltip(translate: Translate, model: LoadedModel): string {
  const polygons = translate(msg`${plural(model.polygonCount, { one: '# polygon', other: '# polygons' })}`);
  const size = formatFileSize(model.fileSizeBytes);
  return size ? translate(msg`${size} · ${polygons}`) : polygons;
}

type GroupSelectMode = 'single' | 'add';

interface ModelManagerPanelProps {
  models: LoadedModel[];
  outsidePlateModelIds?: string[];
  /** The scene's plates, listed above the models that stand on them. */
  plates?: readonly ScenePlate[];
  activePlateId?: string;
  onActivatePlate?: (plateId: string) => void;
  onAddPlate?: () => void;
  onRenamePlate?: (plateId: string, name: string) => void;
  /** Deleting a plate takes its models with it, so the panel asks first. */
  onRemovePlate?: (plateId: string) => void;
  /** Which plate a model stands on, resolved by the scene rather than the hint. */
  resolveModelPlateId?: (model: LoadedModel) => string;
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
  /** Opens the mesh picker: the plus in the panel header. */
  onAddModels?: () => void;
  onDelete: (id: string) => void;
  onVisibilityChange: (id: string, visible: boolean) => void;

  dimmed?: boolean;
  /** Kept mounted but not shown, so the window layout keeps its left column. */
  hidden?: boolean;
  bottomClearancePx?: number;
  /**
   * Collapsible only while the tool rail is a bar under the app bar. Pinned under
   * a rail down the left edge the panel is shown and hidden from that rail alone,
   * so a 48px collapsed strip would only be a way to lose the list.
   */
  collapsible?: boolean;
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
  plates,
  activePlateId,
  onActivatePlate,
  onAddPlate,
  onRenamePlate,
  onRemovePlate,
  resolveModelPlateId,
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
  onAddModels,
  onDelete: _onDelete,
  onVisibilityChange,
  dimmed = false,
  hidden = false,
  bottomClearancePx = 220,
  collapsible = true,
}: ModelManagerPanelProps) {
  const { _ } = useLingui();
  const [collapseExpanded, setCollapseExpanded] = useFloatingPanelCollapse(true);
  // Where collapse is not offered the panel is pinned expanded. This has to be a
  // fallback, not a conjunction: `collapsible && collapseExpanded` reads false in
  // the column layout and hides the whole body, which is an empty model list.
  const expanded = collapsible ? collapseExpanded : true;
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Record<string, boolean>>({});
  /** The plate being renamed inline, and the text being typed. */
  const [renamingPlateId, setRenamingPlateId] = useState<string | null>(null);
  const [plateNameDraft, setPlateNameDraft] = useState('');
  /** The plate whose deletion is waiting on an answer. */
  const [platePendingDelete, setPlatePendingDelete] = useState<ScenePlate | null>(null);
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
            name: _(msg({ message: 'Outside plate', comment: 'Name of the automatic folder collecting models that sit outside the build plate.' })),
            models: [...outsideModels].sort((a, b) => a.name.localeCompare(b.name)),
            isGrouped: true,
            isSystemGroup: true,
          }]
        : []);
  }, [_, models, outsidePlateModelIds]);

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
    // Hidden rather than unmounted: the window layout profiles resolve against
    // the set of mounted panels, so unmounting this one would move every panel
    // that is anchored to it.
    ...(hidden ? { display: 'none' } : {}),
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

  // Rebuilt per render: which sections exist depends on what was right-clicked —
  // a model, a folder, or a multi-selection. Dismissal belongs to ContextMenu.
  const contextMenuEntries: ContextMenuEntry[] = [];
  if (showGroupSection) {
    contextMenuEntries.push(
      {
        id: 'group-selected',
        label: <Trans>Group selected</Trans>,
        icon: FolderPlus,
        disabled: selectedModelIds.length < 2,
      },
      {
        id: 'ungroup-selected',
        label: <Trans>Ungroup selected</Trans>,
        icon: FolderMinus,
        disabled: selectedGroupedCount === 0,
      },
    );
  }
  if (showFolderSection) {
    contextMenuEntries.push(
      { id: 'select-folder', label: <Trans>Select folder</Trans>, icon: PanelsTopLeft, startsGroup: true },
      { id: 'rename-folder', label: <Trans>Rename folder</Trans>, icon: Pencil, disabled: !!contextMenu?.isSystemGroup },
      { id: 'ungroup-folder', label: <Trans>Ungroup folder</Trans>, icon: FolderMinus, disabled: !!contextMenu?.isSystemGroup },
    );
  }
  if (contextModel && (onRenameModel || onModelContextMenu || onRepairModel)) {
    if (onRenameModel) {
      contextMenuEntries.push({ id: 'rename-model', label: <Trans>Rename model</Trans>, icon: Pencil, startsGroup: true });
    }
    if (onRepairModel) {
      contextMenuEntries.push({ id: 'repair-model', label: <Trans>Repair mesh…</Trans>, icon: Wrench });
    }
    if (contextModel.splitBodies && onSplitImportGroup) {
      contextMenuEntries.push({
        id: 'split-bodies',
        label: <Trans comment="Context menu action: split a multi-body 3MF import into independent models.">Split to bodies</Trans>,
        icon: Scissors,
        startsGroup: true,
      });
    }
    if (onModelContextMenu) {
      contextMenuEntries.push({ id: 'model-actions', label: <Trans>Model actions…</Trans>, icon: Box });
    }
  }

  const handleContextMenuSelect = (id: string) => {
    switch (id) {
      case 'group-selected':
        if (onGroupModels && selectedModelIds.length >= 2) onGroupModels(selectedModelIds);
        break;
      case 'ungroup-selected':
        if (onUngroupModels && selectedGroupedCount > 0) onUngroupModels(selectedModelIds);
        break;
      case 'select-folder': {
        const target = contextGroup ?? grouped.find((g) => g.id === contextMenu?.groupId);
        if (target) selectFolder(target, 'single');
        break;
      }
      case 'rename-folder':
        if (contextMenu?.groupId && onRenameGroup && !contextMenu.isSystemGroup) {
          beginRenameGroup(contextMenu.groupId, contextMenu.groupName ?? contextGroup?.name ?? 'Group');
        }
        break;
      case 'ungroup-folder':
        if (contextMenu?.groupId && onUngroupGroup && !contextMenu.isSystemGroup) onUngroupGroup(contextMenu.groupId);
        break;
      case 'rename-model':
        if (contextModel) beginRenameModel(contextModel.id, contextModel.name ?? 'Model');
        break;
      case 'repair-model':
        if (contextModel && onRepairModel) onRepairModel(contextModel.id);
        break;
      case 'split-bodies':
        if (contextModel && onSplitImportGroup) onSplitImportGroup(contextModel.id);
        break;
      case 'model-actions':
        if (contextModel && onModelContextMenu && contextMenu) onModelContextMenu(contextModel.id, { x: contextMenu.x, y: contextMenu.y });
        break;
      default:
        break;
    }
    closeContextMenu();
  };

  return (
    <Card
      className={panelClassName}
      style={panelStyle}
    >
      <CardHeader
        left={(
          <>
            {collapsible && (
              <PanelCollapseToggle expanded={expanded} onToggle={() => setCollapseExpanded((prev) => !prev)} />
            )}
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
              <Trans comment="Title of the panel listing every model loaded into the scene.">Models</Trans>
            </h3>
          </>
        )}
        right={onAddModels ? (
          // The count that used to sit here repeated what the list below already
          // says, line by line. The slot earns its keep as the way to add more.
          <IconButton
            onClick={onAddModels}
            className="!p-0.5 !text-[var(--text-muted)] hover:!text-[var(--text-strong)] hover:!bg-[var(--surface-2)]"
            title={_(msg({ message: 'Add models to the plate', comment: 'Tooltip on the plus in the Models panel header, which opens the mesh picker.' }))}
          >
            <Plus className="h-3.5 w-3.5" />
          </IconButton>
        ) : undefined}
      />

      {/* The plates the models below stand on. One row each: click to work on
          that plate, rename it in place, or delete it and its models. */}
      {expanded && plates && plates.length > 0 && (
        <div className="px-2.5 pt-1 pb-1 space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
              <Trans comment="Heading of the plate list at the top of the Models panel.">Plates</Trans>
            </span>
            {onAddPlate && (
              <IconButton
                onClick={onAddPlate}
                className="!p-0.5 !text-[var(--text-muted)] hover:!text-[var(--text-strong)] hover:!bg-[var(--surface-2)]"
                title={_(msg({ message: 'Add a plate', comment: 'Tooltip on the plus in the Plates heading, which adds an empty build plate.' }))}
              >
                <Plus className="h-3.5 w-3.5" />
              </IconButton>
            )}
          </div>

          {plates.map((plate, index) => {
            const isActive = plate.id === activePlateId;
            const isRenaming = renamingPlateId === plate.id;
            const modelCount = resolveModelPlateId
              ? models.filter((model) => resolveModelPlateId(model) === plate.id).length
              : 0;
            return (
              <div
                key={plate.id}
                className="px-1.5 py-1 rounded border flex items-center gap-1.5 cursor-pointer transition-colors"
                style={isActive
                  ? {
                      background: 'color-mix(in srgb, var(--accent), var(--surface-2) 90%)',
                      borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 45%)',
                    }
                  : { borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}
                onClick={() => onActivatePlate?.(plate.id)}
              >
                <LayoutGrid className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--accent)' }} />

                {isRenaming ? (
                  <input
                    autoFocus
                    value={plateNameDraft}
                    onChange={(event) => setPlateNameDraft(event.target.value)}
                    onBlur={() => {
                      onRenamePlate?.(plate.id, plateNameDraft.trim());
                      setRenamingPlateId(null);
                    }}
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        onRenamePlate?.(plate.id, plateNameDraft.trim());
                        setRenamingPlateId(null);
                      } else if (event.key === 'Escape') {
                        setRenamingPlateId(null);
                      }
                    }}
                    className="min-w-0 flex-1 rounded border px-1 py-0.5 text-xs"
                    style={{ background: 'var(--surface-0)', borderColor: 'var(--border-subtle)', color: 'var(--text-strong)' }}
                    aria-label={_(msg`Plate name`)}
                  />
                ) : (
                  <span
                    className="text-[10px] font-semibold uppercase tracking-wide truncate"
                    style={{ color: 'var(--text-muted)' }}
                    title={_(msg`Work on this plate`)}
                  >
                    {plate.name.trim() || plateNumberPlaceholder(index + 1, _)}
                  </span>
                )}

                {onRenamePlate && !isRenaming && (
                  <IconButton
                    onClick={(event) => {
                      event.stopPropagation();
                      setPlateNameDraft(plate.name);
                      setRenamingPlateId(plate.id);
                    }}
                    className="!p-0.5 !text-[var(--text-muted)] hover:!text-[var(--text-strong)] hover:!bg-[var(--surface-2)]"
                    title={_(msg`Rename plate`)}
                  >
                    <Pencil className="h-3 w-3" />
                  </IconButton>
                )}

                {onRemovePlate && (
                  <IconButton
                    onClick={(event) => {
                      event.stopPropagation();
                      setPlatePendingDelete(plate);
                    }}
                    disabled={plates.length <= 1}
                    className="!p-0.5 !text-[var(--text-muted)] hover:!text-[var(--text-strong)] hover:!bg-[var(--surface-2)] disabled:!opacity-35"
                    title={plates.length <= 1
                      ? _(msg`The scene needs one plate`)
                      : _(msg`Delete this plate and the models on it`)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </IconButton>
                )}

                <span className="ml-auto text-[10px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
                  {modelCount}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {platePendingDelete && (
        <StructuredDialogModal
          open
          ariaLabel={_(msg`Delete plate`)}
          title={_(msg`Delete this plate?`)}
          subtitle={platePendingDelete.name.trim() || plateNumberPlaceholder(plates?.findIndex((plate) => plate.id === platePendingDelete.id) ?? 0, _)}
          icon={<Trash2 className="h-4 w-4" />}
          iconTone="danger"
          zIndexClassName="z-[130]"
          closeAriaLabel={_(msg`Close modal`)}
          onClose={() => setPlatePendingDelete(null)}
          onBackdropClick={() => setPlatePendingDelete(null)}
          actions={(
            <>
              <Button variant="secondary" onClick={() => setPlatePendingDelete(null)}>
                <Trans>Cancel</Trans>
              </Button>
              <Button
                variant="tinted-danger"
                onClick={() => {
                  onRemovePlate?.(platePendingDelete.id);
                  setPlatePendingDelete(null);
                }}
              >
                <Trans>Delete plate</Trans>
              </Button>
            </>
          )}
        >
          <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            <Trans comment="The count is how many models stand on the plate being deleted.">
              The models on this plate are deleted with it. Undo brings them back.
            </Trans>
          </p>
        </StructuredDialogModal>
      )}

      {expanded && (
        <div className="px-2.5 pt-1 pb-2.5 space-y-2 flex flex-col flex-1 min-h-0">
          <div className="space-y-1 overflow-y-auto custom-scrollbar pr-0.5 flex-1 min-h-0">
            {models.length === 0 ? (
              <div className="text-xs text-center py-2 italic" style={{ color: 'var(--text-muted)' }}>
                <Trans>No models loaded</Trans>
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
                          title={isCollapsed ? _(msg`Expand folder`) : _(msg`Collapse folder`)}
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
                            aria-label={_(msg`Rename folder`)}
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
                        const isSelected = selectedSet.has(model.id);

                      return (
                        <div
                          key={model.id}
                            className="px-2 py-1.5 rounded border transition-colors flex items-center gap-2 cursor-pointer"
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
                                  aria-label={_(msg`Rename model base name`)}
                                />
                                {renamingModelSuffix && (
                                  <span className="shrink-0 text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
                                    {renamingModelSuffix}
                                  </span>
                                )}
                              </div>
                            ) : (
                              <Tooltip content={model.name} fullWidth>
                                <div className="min-w-0 text-sm font-medium truncate" style={{ color: 'var(--text-strong)' }}>
                                  {model.name}
                                </div>
                              </Tooltip>
                            )}
                          </div>

                          <div className="flex items-center gap-1">
                            {onOpenSupportsInfo && (
                              <Tooltip content={formatModelInfoTooltip(_, model)}>
                                <IconButton
                                  variant="ghost"
                                  size="sm"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onOpenSupportsInfo(model.id);
                                  }}
                                  aria-label={_(msg({ message: 'Model details', comment: 'Accessible name of the info button on a model row. The tooltip beside it lists the mesh size and polygon count.' }))}
                                >
                                  <Info className="w-3.5 h-3.5" />
                                </IconButton>
                              </Tooltip>
                            )}
                            <IconButton
                              variant="ghost"
                              size="sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                onVisibilityChange(model.id, !model.visible);
                              }}
                              title={model.visible ? _(msg`Hide`) : _(msg`Show`)}
                            >
                              {model.visible ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
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

      <ContextMenu
        position={contextMenu}
        entries={contextMenuEntries}
        onSelect={handleContextMenuSelect}
        onClose={closeContextMenu}
        title={<Trans comment="Section heading of the models context menu. Rendered uppercase.">Models</Trans>}
        ariaLabel={_(msg`Models context menu`)}
      />
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
