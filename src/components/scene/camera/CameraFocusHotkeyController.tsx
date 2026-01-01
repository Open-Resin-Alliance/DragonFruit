import * as React from 'react';
import * as THREE from 'three';
import { useCameraFocusHotkey } from '@/hotkeys/useCameraFocusHotkey';

type CameraFocusHotkeyControllerProps = {
  hoverPointRef: React.MutableRefObject<THREE.Vector3 | null>;
  setOrbitTargetFromPoint: (point: THREE.Vector3) => void;
};

export function CameraFocusHotkeyController({
  hoverPointRef,
  setOrbitTargetFromPoint,
}: CameraFocusHotkeyControllerProps) {
  useCameraFocusHotkey(() => {
    const point = hoverPointRef.current;
    if (!point) return;
    setOrbitTargetFromPoint(point);
  });

  return null;
}
