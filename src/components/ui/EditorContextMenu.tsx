"use client";

import React from 'react';
import type { MessageDescriptor } from '@lingui/core';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import {
  Wrench,
  Copy,
  Scissors,
  ClipboardPaste,
  RefreshCw,
  Pyramid,
  Trash2,
  Split,
  LifeBuoy,
  Box,
  Link,
  Unlink,
  Search,
  Plus,
  Blocks,
  Shapes,
  type LucideIcon,
} from 'lucide-react';
import { ContextMenu, type ContextMenuEntry } from '@/components/ui/ContextMenu';

export type EditorMenuAction =
  | 'delete'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'repair'
  | 'show-repair-report'
  | 'undo-repairs'
  | 'remesh'
  | 'shrinkwrap'
  | 'split-supports'
  | 'merge-supports'
  | 'supports-toggle-curve'
  | 'supports-add-joint'
  | 'mark-as-support-geometry'
  | 'mark-as-model-geometry'
  | 'link-models'
  | 'unlink-models'
  | 'scan-for-supports'
  /** Assign a tank's material to the selected models: `assign-material:<materialId>`. */
  | `assign-material:${string}`
  // Organic-cut tool actions.
  | 'organic-cut-add-waypoint'
  | 'organic-cut-delete-waypoint';

export type EditorContextMenuPosition = {
  x: number;
  y: number;
};

type EditorContextMenuProps = {
  position: EditorContextMenuPosition | null;
  onAction: (action: EditorMenuAction) => void;
  onClose: () => void;
  disabledActions?: EditorMenuAction[];
  title?: string;
  items?: MenuItemDef[];
};

type MenuLeafDef = {
  id: EditorMenuAction;
  /** A descriptor for fixed rows; a plain string for rows built from data (a material name). */
  label: MessageDescriptor | string;
  icon: LucideIcon;
  /** Rule above this row, breaking the flyout into groups. Ignored on the first row. */
  startsGroup?: boolean;
  /** Tick this row — a material the selection already prints in. */
  checked?: boolean;
  /** Custom icon-slot content (e.g. a colour chip); wins over `icon`. */
  iconNode?: React.ReactNode;
  /** Draw `iconNode` outside the framed icon slot — see ContextMenuEntry.iconBare. */
  iconBare?: boolean;
};

type MenuSubmenuDef = {
  /** Row key. A submenu runs no action itself — its children carry the actions. */
  id: string;
  label: MessageDescriptor;
  icon: LucideIcon;
  children: MenuLeafDef[];
};

type MenuItemDef = (MenuLeafDef | MenuSubmenuDef) & {
  /** Draw a separator above this item to break the list into groups. Ignored on the first item. */
  startsGroup?: boolean;
};

/** Menu item shape, re-exported so feature callers can build custom item lists. */
export type EditorMenuItemDef = MenuItemDef;

/** Convenience: the "Add waypoint here" item for the Organic Cut tool. */
export const ORGANIC_CUT_ADD_WAYPOINT_ITEM: EditorMenuItemDef = {
  id: 'organic-cut-add-waypoint',
  label: msg`Add waypoint here`,
  icon: Plus,
};

/** Convenience: the "Delete waypoint" item for the Organic Cut tool. */
export const ORGANIC_CUT_DELETE_WAYPOINT_ITEM: EditorMenuItemDef = {
  id: 'organic-cut-delete-waypoint',
  label: msg`Delete waypoint`,
  icon: Trash2,
};

// msg`` marks strings for extraction without evaluating them immediately;
// the _ helper resolves each descriptor against the active locale at render time.
export const MENU_ITEMS: MenuItemDef[] = [
  // Selection / clipboard.
  { id: 'delete', label: msg`Delete`, icon: Trash2 },
  { id: 'cut',    label: msg`Cut`,    icon: Scissors },
  { id: 'copy',   label: msg`Copy`,   icon: Copy },
  { id: 'paste',  label: msg`Paste`,  icon: ClipboardPaste },
  // Mesh repair, fanned out like supports and geometry. The first entry reads "Repair Again" and
  // the report entry only appears once the model has one, so the caller builds this submenu from
  // these items; this is the shape it starts from.
  {
    id: 'repair-menu',
    label: msg`Repair`,
    icon: Wrench,
    startsGroup: true,
    children: [
      { id: 'repair', label: msg`Auto-Repair`, icon: Wrench },
      { id: 'remesh', label: msg`Remesh`, icon: Pyramid },
      { id: 'shrinkwrap', label: msg`Shrink-Wrap`, icon: RefreshCw },
    ],
  },
  // Support scaffolding and geometry designation, each fanned out into a flyout
  // so the top level stays short.
  {
    id: 'supports-menu',
    label: msg`Supports`,
    icon: Blocks,
    startsGroup: true,
    children: [
      { id: 'split-supports', label: msg({ message: 'Split supports', comment: 'Context-menu command that detaches the generated support scaffolding at the clicked point. "Supports" = the temporary print scaffolding structures, not customer support.' }), icon: Split },
      { id: 'merge-supports', label: msg({ message: 'Merge supports', comment: 'Context-menu command that re-attaches the support scaffolding back to the model.' }), icon: Link },
      { id: 'scan-for-supports', label: msg`Scan for Supports`, icon: Search },
    ],
  },
  {
    id: 'geometry-menu',
    label: msg`Geometry`,
    icon: Shapes,
    children: [
      { id: 'mark-as-support-geometry', label: msg`Mark as Support`, icon: LifeBuoy },
      { id: 'mark-as-model-geometry',   label: msg`Mark as Model`,   icon: Box },
    ],
  },
  // { id: 'link-models',   label: msg`Link Selected Models`,   icon: Link },
  // { id: 'unlink-models', label: msg`Unlink Selected Models`, icon: Unlink },
];

/**
 * The editor canvas menu: the shared {@link ContextMenu} over the editor's
 * action vocabulary, where `disabledActions` and the item list are the caller's
 * (page.tsx switches on the action id; the Organic Cut tool supplies its own
 * one-item lists).
 */
export function EditorContextMenu({ position, onAction, onClose, disabledActions = [], title, items = MENU_ITEMS }: EditorContextMenuProps) {
  const { _ } = useLingui();

  const entries = React.useMemo<ContextMenuEntry[]>(() => items.map((item) => ({
    id: item.id,
    label: typeof item.label === 'string' ? item.label : _(item.label),
    icon: item.icon,
    startsGroup: item.startsGroup,
    checked: 'children' in item ? undefined : item.checked,
    iconNode: 'children' in item ? undefined : item.iconNode,
    iconBare: 'children' in item ? undefined : item.iconBare,
    disabled: 'children' in item
      ? item.children.every((child) => disabledActions.includes(child.id))
      : disabledActions.includes(item.id),
    children: 'children' in item
      ? item.children.map((child) => ({
          id: child.id,
          label: typeof child.label === 'string' ? child.label : _(child.label),
          icon: child.icon,
          startsGroup: child.startsGroup,
          checked: child.checked,
          iconNode: child.iconNode,
          iconBare: child.iconBare,
          disabled: disabledActions.includes(child.id),
        }))
      : undefined,
  })), [_, disabledActions, items]);

  return (
    <ContextMenu
      position={position}
      entries={entries}
      title={title}
      ariaLabel={_(msg`Editor context menu`)}
      onSelect={(id) => onAction(id as EditorMenuAction)}
      onClose={onClose}
    />
  );
}
