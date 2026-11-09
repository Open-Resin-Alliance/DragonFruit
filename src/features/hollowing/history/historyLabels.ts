import { msg } from '@lingui/core/macro';
import type { HistoryLabels } from '@/history/typedHistory';
import type { HollowingHistoryPayloadMap } from './actionTypes';

/** Names of the hollowing tool's undo history entries. */
export const HOLLOWING_HISTORY_LABELS: HistoryLabels<HollowingHistoryPayloadMap> = {
  'hollowing:blockers-edit': msg({ message: 'Edit solid areas', context: 'Undo history entry' }),
};
