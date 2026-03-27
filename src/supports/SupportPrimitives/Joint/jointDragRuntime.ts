import type { PartDragPreviewKind } from '../../interaction/partDragPreview';
import { clearPartDragUpdate, emitPartDragUpdate } from '../../interaction/partDragPreview';
import { clearJointDragPosition, emitJointDragPosition } from '../../interaction/jointDragPosition';

type JointPosition = { x: number; y: number; z: number };

export function setJointInteractionLock(isDragging: boolean, postGuardMs = 180) {
  if (typeof window === 'undefined') return;

  const w = window as any;
  w.__jointGizmoDragging = isDragging;
  w.__jointGizmoGuardUntil = isDragging ? 0 : (Date.now() + postGuardMs);

  window.dispatchEvent(new CustomEvent('joint-gizmo-interaction-lock', {
    detail: {
      active: isDragging,
      guardUntil: w.__jointGizmoGuardUntil,
    },
  }));
}

export function isJointInteractionLocked() {
  if (typeof window === 'undefined') return false;
  const w = window as any;
  if (w.__jointGizmoDragging) return true;
  const guardUntil = Number(w.__jointGizmoGuardUntil ?? 0);
  return guardUntil > Date.now();
}

export function emitSupportDragPreview<TSupport>(kind: PartDragPreviewKind, supportId: string, support: TSupport | null) {
  emitPartDragUpdate(kind, supportId, support);
}

export function clearSupportDragPreview(kind: PartDragPreviewKind, supportId: string) {
  clearPartDragUpdate(kind, supportId);
}

export function emitJointDragPositionPreview(jointId: string, position: JointPosition) {
  emitJointDragPosition(jointId, position);
}

export function clearJointDragPositionPreview(jointId: string) {
  clearJointDragPosition(jointId);
}
