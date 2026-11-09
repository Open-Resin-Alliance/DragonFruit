import { createTypedHistory } from '@/history/typedHistory';
import type { SupportHistoryPayloadMap } from './actionTypes';
import { SUPPORT_HISTORY_LABELS } from './supportHistoryLabels';

const supportHistory = createTypedHistory<SupportHistoryPayloadMap>(SUPPORT_HISTORY_LABELS);

/**
 * Push a support history entry with the payload its type requires. The compiler
 * rejects a payload that doesn't match the action type, so a push site can't
 * drift from the handler that inverts it.
 */
export const pushSupportHistory = supportHistory.push;

/**
 * Register a handler that receives its action's payload already narrowed, so no
 * handler body has to cast `action.payload`.
 */
export const registerSupportHistoryHandler = supportHistory.register;
