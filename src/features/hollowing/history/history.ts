import { createTypedHistory } from '@/history/typedHistory';

import type { HollowingHistoryPayloadMap } from './actionTypes';
import { HOLLOWING_HISTORY_LABELS } from './historyLabels';

const hollowingHistory = createTypedHistory<HollowingHistoryPayloadMap>(HOLLOWING_HISTORY_LABELS);

export const pushHollowingHistory = hollowingHistory.push;
export const registerHollowingHistoryHandler = hollowingHistory.register;
