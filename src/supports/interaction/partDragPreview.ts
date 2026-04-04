import React from 'react';

const EVENT_NAME = 'dragonfruit-part-drag-update';

export type PartDragPreviewKind = 'trunk' | 'branch' | 'twig' | 'stick' | 'kickstand';

export interface PartDragPreviewPayload<TSupport = unknown> {
  kind: PartDragPreviewKind;
  supportId: string;
  support: TSupport | null;
}

export function emitPartDragUpdate<TSupport>(kind: PartDragPreviewKind, supportId: string, support: TSupport | null) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<PartDragPreviewPayload<TSupport>>(EVENT_NAME, { detail: { kind, supportId, support } }));
}

export function clearPartDragUpdate(kind: PartDragPreviewKind, supportId: string) {
  emitPartDragUpdate(kind, supportId, null);
}

export function usePartDragUpdate<T>(kind: PartDragPreviewKind, supportId: string): T | null {
  const [preview, setPreview] = React.useState<T | null>(null);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const handlePreview = (event: Event) => {
      const detail = (event as CustomEvent<PartDragPreviewPayload<T>>).detail;
      if (!detail) return;
      if (detail.kind !== kind || detail.supportId !== supportId) return;
      setPreview(detail.support ?? null);
    };

    window.addEventListener(EVENT_NAME, handlePreview);
    return () => window.removeEventListener(EVENT_NAME, handlePreview);
  }, [kind, supportId]);

  return preview;
}
