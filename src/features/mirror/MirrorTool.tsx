import React from 'react';
import { MirrorHandles } from './components/MirrorHandles';
import type { MirrorAxis } from './types';

interface MirrorToolProps {
  activeModelId: string | null;
  onMirror: (axis: MirrorAxis) => void;
}

export function MirrorTool({ activeModelId, onMirror }: MirrorToolProps) {
  if (!activeModelId) return null;
  return <MirrorHandles activeModelId={activeModelId} onMirror={onMirror} />;
}
