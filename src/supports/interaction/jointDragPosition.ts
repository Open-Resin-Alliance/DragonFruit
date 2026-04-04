import React from 'react';

const EVENT_NAME = 'dragonfruit-joint-drag-position';

export interface JointDragPositionPayload {
  jointId: string;
  position: { x: number; y: number; z: number } | null;
}

export function emitJointDragPosition(jointId: string, position: { x: number; y: number; z: number } | null) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<JointDragPositionPayload>(EVENT_NAME, { detail: { jointId, position } }));
}

export function clearJointDragPosition(jointId: string) {
  emitJointDragPosition(jointId, null);
}

export function useJointDragPosition(jointId: string) {
  const [position, setPosition] = React.useState<{ x: number; y: number; z: number } | null>(null);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const handle = (event: Event) => {
      const detail = (event as CustomEvent<JointDragPositionPayload>).detail;
      if (!detail || detail.jointId !== jointId) return;
      setPosition(detail.position);
    };

    window.addEventListener(EVENT_NAME, handle);
    return () => window.removeEventListener(EVENT_NAME, handle);
  }, [jointId]);

  return position;
}