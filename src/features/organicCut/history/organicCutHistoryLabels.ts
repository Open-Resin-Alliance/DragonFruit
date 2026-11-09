/**
 * Names of the organic cut's undo history entries. Constants, so a burst of
 * same-kind edits can still be coalesced by comparing them.
 */

import { msg } from '@lingui/core/macro';
import type { HistoryLabels } from '@/history/typedHistory';
import type { OrganicCutHistoryPayloadMap } from './actionTypes';

export const ORGANIC_CUT_HISTORY_LABELS: HistoryLabels<OrganicCutHistoryPayloadMap> = {
  'organic-cut:edit': msg({ message: 'Edit cut', context: 'Undo history entry' }),
};

export const CUT_EDIT_LABELS = {
  drag: msg({ message: 'Drag cut point', context: 'Undo history entry' }),
  settings: msg({ message: 'Change cut settings', context: 'Undo history entry' }),
  tenonSettings: msg({ message: 'Change tenon settings', context: 'Undo history entry' }),
  placePoint: msg({ message: 'Place cut point', context: 'Undo history entry' }),
  deletePoint: msg({ message: 'Delete cut point', context: 'Undo history entry' }),
  movePoint: msg({ message: 'Move cut point', context: 'Undo history entry' }),
  lockPoint: msg({ message: 'Lock cut point', context: 'Undo history entry' }),
  lockWaypoint: msg({ message: 'Lock waypoint', context: 'Undo history entry' }),
  snapToEdges: msg({ message: 'Snap cut to edges', context: 'Undo history entry' }),
  clearAll: msg({ message: 'Clear cut', context: 'Undo history entry' }),
  addLoop: msg({ message: 'Add cut loop', context: 'Undo history entry' }),
  removeLoop: msg({ message: 'Remove cut loop', context: 'Undo history entry' }),
};
