"use client";

import React from 'react';
import { Html } from '@react-three/drei';
import { Pencil } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';

/**
 * The build plate's name, written on the plate itself and clicked to change it.
 *
 * It is laid flat in world space rather than billboarded at the camera: the name
 * belongs to the plate, so it should slide and turn with it the way the grid
 * does, and only be readable from above — the view the plate is worked from.
 *
 * This runs inside the r3f reconciler, where the i18n provider is out of scope,
 * so every string arrives already translated, exactly as the plate's front-edge
 * label does.
 */
export function PlateNameLabel({
  name,
  placeholder,
  editTitle,
  emptyTitle,
  position,
  /**
   * In-plane rotation about Z. Left at 0 by default because the scene is Z-up:
   * the plate lies in XY, which is the plane drei's transformed `Html` already
   * occupies, with the text's up along +Y — the direction that reads correctly
   * from the front. Rotating it about X (the obvious "lay it flat") is what turns
   * the text upside down.
   */
  facingRotation = 0,
  /** World units per CSS pixel of the label, i.e. how large it sits on the plate. */
  labelScale = 5,
  onCommit,
}: {
  name: string;
  placeholder: string;
  /** Tooltip on the edit affordance. */
  editTitle: string;
  /** Tooltip while the plate has no name yet. */
  emptyTitle: string;
  /** World position of the label's anchor point. */
  position: [number, number, number];
  facingRotation?: number;
  /** World units per CSS pixel of the label, i.e. how large it sits on the plate. */
  labelScale?: number;
  onCommit: (next: string) => void;
}) {
  // `null` means "not editing"; the draft is only meaningful while editing, so
  // the name shown otherwise is always the plate's own.
  const [draft, setDraft] = React.useState<string | null>(null);
  const isEditing = draft !== null;

  const commitDraft = () => {
    if (draft === null) return;
    const next = draft.trim();
    setDraft(null);
    if (next !== name) onCommit(next);
  };

  return (
    <Html
      position={position}
      transform
      rotation={[0, 0, facingRotation]}
      scale={labelScale}
      zIndexRange={[8, 0]}
      style={{ pointerEvents: 'auto' }}
    >
      {/* `Html` centres its content on the anchor, so without this the anchor is the
          label's middle. Shifting by half its own size makes the anchor its
          bottom-left corner: the label then starts exactly at the plate's left
          edge and sits entirely behind its back edge (and the width is whatever
          the name needs, so this cannot be a fixed offset). */}
      <div className="flex items-center gap-2 select-none whitespace-nowrap" style={{ transform: 'translate(50%, -50%)' }}>
        {isEditing ? (
          <input
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitDraft}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              // The editor is a real text field: the app's single-letter hotkeys
              // must not fire while a name is being typed.
              event.stopPropagation();
              if (event.key === 'Enter') {
                event.preventDefault();
                commitDraft();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                setDraft(null);
              }
            }}
            placeholder={placeholder}
            className="rounded-[5.5px] border px-2 py-1 text-[30px] font-bold outline-none"
            style={{
              borderColor: 'var(--accent)',
              background: 'color-mix(in srgb, var(--surface-0), transparent 10%)',
              color: 'var(--text-strong)',
              width: `${Math.max(6, (draft.length || placeholder.length) + 2)}ch`,
            }}
          />
        ) : (
          <Tooltip content={name ? editTitle : emptyTitle} maxWidth={220}>
            <button
              type="button"
              onClick={() => setDraft(name)}
              onPointerDown={(event) => event.stopPropagation()}
              aria-label={name ? editTitle : emptyTitle}
              className="cursor-text rounded-[5.5px] px-1 text-left text-[36px] font-bold leading-tight"
              style={{ color: name ? 'var(--accent)' : 'var(--text-muted)' }}
            >
              {name || placeholder}
            </button>
          </Tooltip>
        )}

        {!isEditing && (
          <Tooltip content={editTitle} maxWidth={220}>
            <button
              type="button"
              onClick={() => setDraft(name)}
              onPointerDown={(event) => event.stopPropagation()}
              aria-label={editTitle}
              className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-[5.5px] border"
            style={{
              borderColor: 'color-mix(in srgb, var(--text-muted), transparent 45%)',
              background: 'color-mix(in srgb, var(--surface-0), transparent 45%)',
              color: 'var(--text-muted)',
            }}
          >
              <Pencil className="h-5 w-5" />
            </button>
          </Tooltip>
        )}
      </div>
    </Html>
  );
}
