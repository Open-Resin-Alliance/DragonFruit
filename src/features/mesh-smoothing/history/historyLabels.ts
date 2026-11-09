import { msg } from '@lingui/core/macro';
import type { HistoryLabels } from '@/history/typedHistory';
import type { MeshSmoothingHistoryPayloadMap } from './actionTypes';

/** Names of the brush tool's undo history entries. */
export const MESH_SMOOTHING_HISTORY_LABELS: HistoryLabels<MeshSmoothingHistoryPayloadMap> = {
  'mesh-smoothing:stroke': msg({ message: 'Brush stroke', context: 'Undo history entry' }),
};
