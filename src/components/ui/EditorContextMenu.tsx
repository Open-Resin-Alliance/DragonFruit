"use client";

import React from 'react';
import {
  Wrench,
  Copy,
  Scissors,
  ClipboardPaste,
  Trash2,
  type LucideIcon,
} from 'lucide-react';

export type EditorMenuAction =
  | 'delete'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'repair'
  | 'supports-toggle-curve'
  | 'supports-add-joint';

export type EditorContextMenuPosition = {
  x: number;
  y: number;
};

type EditorContextMenuProps = {
  position: EditorContextMenuPosition | null;
  onAction: (action: EditorMenuAction) => void;
  disabledActions?: EditorMenuAction[];
  title?: string;
  items?: MenuItemDef[];
};

type MenuItemDef = {
  id: EditorMenuAction;
  label: string;
  icon: LucideIcon;
};

const MENU_ITEMS: MenuItemDef[] = [
  { id: 'delete', label: 'Delete', icon: Trash2 },
  { id: 'cut', label: 'Cut', icon: Scissors },
  { id: 'copy', label: 'Copy', icon: Copy },
  { id: 'paste', label: 'Paste', icon: ClipboardPaste },
  { id: 'repair', label: 'Repair', icon: Wrench },
];

const MENU_WIDTH = 176;
const BASE_MENU_HEIGHT = 44;
const MENU_ITEM_HEIGHT = 32;

export function EditorContextMenu({ position, onAction, disabledActions = [], title = 'Editor', items = MENU_ITEMS }: EditorContextMenuProps) {
  if (!position) return null;

  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1920;
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 1080;

  const menuHeight = BASE_MENU_HEIGHT + (items.length * MENU_ITEM_HEIGHT);
  const left = Math.max(8, Math.min(position.x, viewportWidth - MENU_WIDTH - 8));
  const top = Math.max(8, Math.min(position.y, viewportHeight - menuHeight - 8));

  return (
    <div
      className="fixed z-[120] w-44 rounded-lg border p-1.5 shadow-xl backdrop-blur-sm"
      style={{
        left,
        top,
        borderColor: 'var(--border-subtle)',
        background: 'color-mix(in srgb, var(--surface-0), #000 10%)',
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
      }}
      role="menu"
      aria-label="Editor context menu"
    >
      <div className="mb-1 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
        {title}
      </div>
      <div className="space-y-0.5">
        {items.map((item) => {
          const Icon = item.icon;
          const isDisabled = disabledActions.includes(item.id);
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                if (isDisabled) return;
                onAction(item.id);
              }}
              disabled={isDisabled}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium transition-colors"
              style={{
                color: isDisabled ? 'var(--text-muted)' : 'var(--text-strong)',
                opacity: isDisabled ? 0.55 : 1,
                cursor: isDisabled ? 'not-allowed' : 'pointer',
              }}
              onMouseEnter={(e) => {
                if (isDisabled) return;
                e.currentTarget.style.background = 'color-mix(in srgb, var(--accent), var(--surface-1) 82%)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
              }}
              role="menuitem"
            >
              <span
                className="inline-flex h-5 w-5 items-center justify-center rounded border"
                style={{
                  borderColor: 'var(--border-subtle)',
                  background: 'var(--surface-1)',
                  opacity: isDisabled ? 0.8 : 1,
                }}
              >
                <Icon className="h-3.5 w-3.5" />
              </span>
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
