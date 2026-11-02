/**
 * What the undo/redo toast calls each support history entry that is pushed
 * without a description of its own. Keyed by every action type, so declaring a
 * new support type is a compile error here until its entries have a name.
 */

import type { MessageDescriptor } from '@lingui/core';
import { msg, plural, select } from '@lingui/core/macro';
import type { HistoryLabels } from '@/history/typedHistory';
import type { SupportTypeId } from '../supportTypeRegistry';
import type { SupportHistoryPayloadMap } from './actionTypes';

export const SUPPORT_HISTORY_LABELS: HistoryLabels<SupportHistoryPayloadMap> = {
  'support:add-trunk': msg({ message: 'Add trunk', context: 'Undo history entry' }),
  'support:add-branch': msg({ message: 'Add branch', context: 'Undo history entry' }),
  'support:add-leaf': msg({ message: 'Add leaf', context: 'Undo history entry' }),
  'support:add-twig': msg({ message: 'Add twig', context: 'Undo history entry' }),
  'support:add-stick': msg({ message: 'Add stick', context: 'Undo history entry' }),
  'support:add-brace': msg({ message: 'Add brace', context: 'Undo history entry' }),
  'support:add-stump': msg({ message: 'Add stump', context: 'Undo history entry' }),
  'support:add-kickstand': msg({ message: 'Add kickstand', context: 'Undo history entry' }),
  'support:remove-trunk': msg({ message: 'Remove trunk', context: 'Undo history entry' }),
  'support:remove-branch': msg({ message: 'Remove branch', context: 'Undo history entry' }),
  'support:remove-leaf': msg({ message: 'Remove leaf', context: 'Undo history entry' }),
  'support:remove-twig': msg({ message: 'Remove twig', context: 'Undo history entry' }),
  'support:remove-stick': msg({ message: 'Remove stick', context: 'Undo history entry' }),
  'support:remove-brace': msg({ message: 'Remove brace', context: 'Undo history entry' }),
  'support:remove-stump': msg({ message: 'Remove stump', context: 'Undo history entry' }),
  'support:remove-kickstand': msg({ message: 'Remove kickstand', context: 'Undo history entry' }),
  'support:update-trunk': msg({ message: 'Edit trunk', context: 'Undo history entry' }),
  'support:update-branch': msg({ message: 'Edit branch', context: 'Undo history entry' }),
  'support:edit-replace': msg({ message: 'Edit supports', context: 'Undo history entry' }),
  'support:multi-delete': msg({ message: 'Delete supports', context: 'Undo history entry' }),
  'support:auto-brace-replace': msg({ message: 'Auto bracing', context: 'Undo history entry' }),
  'support:auto-place': msg({ message: 'Auto supports', context: 'Undo history entry' }),
  'support:blocker-stroke': msg({ message: 'Paint support blocker', context: 'Undo history entry' }),
};

// Entries that name a support type. One message per action, with the type as
// an ICU select, so each language writes the whole phrase (and its articles and
// agreement) rather than having an English noun dropped into it.

export function moveJointLabel(supportType: SupportTypeId): MessageDescriptor {
  return msg({
    message: select(supportType, {
      trunk: 'Move trunk joint',
      branch: 'Move branch joint',
      leaf: 'Move leaf joint',
      twig: 'Move twig joint',
      stick: 'Move stick joint',
      brace: 'Move brace joint',
      stump: 'Move stump joint',
      kickstand: 'Move kickstand joint',
      other: 'Move support joint',
    }),
    context: 'Undo history entry',
  });
}

export function deleteJointLabel(supportType: SupportTypeId): MessageDescriptor {
  return msg({
    message: select(supportType, {
      trunk: 'Delete trunk joint',
      branch: 'Delete branch joint',
      leaf: 'Delete leaf joint',
      twig: 'Delete twig joint',
      stick: 'Delete stick joint',
      brace: 'Delete brace joint',
      stump: 'Delete stump joint',
      kickstand: 'Delete kickstand joint',
      other: 'Delete support joint',
    }),
    context: 'Undo history entry',
  });
}

export function createJointLabel(supportType: SupportTypeId): MessageDescriptor {
  return msg({
    message: select(supportType, {
      trunk: 'Create trunk joint',
      branch: 'Create branch joint',
      leaf: 'Create leaf joint',
      twig: 'Create twig joint',
      stick: 'Create stick joint',
      brace: 'Create brace joint',
      stump: 'Create stump joint',
      kickstand: 'Create kickstand joint',
      other: 'Create support joint',
    }),
    context: 'Undo history entry',
  });
}

export function editCurveLabel(supportType: SupportTypeId): MessageDescriptor {
  return msg({
    message: select(supportType, {
      trunk: 'Edit trunk curve',
      branch: 'Edit branch curve',
      leaf: 'Edit leaf curve',
      twig: 'Edit twig curve',
      stick: 'Edit stick curve',
      brace: 'Edit brace curve',
      stump: 'Edit stump curve',
      kickstand: 'Edit kickstand curve',
      other: 'Edit support curve',
    }),
    context: 'Undo history entry',
  });
}

export function moveTipLabel(supportType: SupportTypeId): MessageDescriptor {
  return msg({
    message: select(supportType, {
      trunk: 'Move trunk tip',
      branch: 'Move branch tip',
      leaf: 'Move leaf tip',
      twig: 'Move twig tip',
      stick: 'Move stick tip',
      brace: 'Move brace tip',
      stump: 'Move stump tip',
      kickstand: 'Move kickstand tip',
      other: 'Move support tip',
    }),
    context: 'Undo history entry',
  });
}

export function moveHostKnotLabel(supportType: SupportTypeId): MessageDescriptor {
  return msg({
    message: select(supportType, {
      trunk: 'Move trunk knot',
      branch: 'Move branch knot',
      leaf: 'Move leaf knot',
      twig: 'Move twig knot',
      stick: 'Move stick knot',
      brace: 'Move brace knot',
      stump: 'Move stump knot',
      kickstand: 'Move kickstand knot',
      other: 'Move support knot',
    }),
    context: 'Undo history entry',
  });
}

export function adjustSupportSettingsLabel(supportType: SupportTypeId): MessageDescriptor {
  return msg({
    message: select(supportType, {
      trunk: 'Adjust trunk settings',
      branch: 'Adjust branch settings',
      leaf: 'Adjust leaf settings',
      twig: 'Adjust twig settings',
      stick: 'Adjust stick settings',
      brace: 'Adjust brace settings',
      stump: 'Adjust stump settings',
      kickstand: 'Adjust kickstand settings',
      other: 'Adjust support settings',
    }),
    context: 'Undo history entry',
  });
}

export const MOVE_SUPPORT_KNOT_LABEL = msg({ message: 'Move support knot', context: 'Undo history entry' });
export const MOVE_TIP_KNOT_LABEL = msg({ message: 'Move tip knot', context: 'Undo history entry' });
export const PASTE_SUPPORTS_LABEL = msg({ message: 'Paste supports', context: 'Undo history entry' });
export const ADJUST_CURVE_TENSION_LABEL = msg({ message: 'Adjust curve tension', context: 'Undo history entry' });
export const ADJUST_CURVE_BIAS_LABEL = msg({ message: 'Adjust curve bias', context: 'Undo history entry' });
export const REMOVE_CURVE_LABEL = msg({ message: 'Remove curve', context: 'Undo history entry' });
export const REPLACE_SUPPORTS_LABEL = msg({ message: 'Replace supports', context: 'Undo history entry' });

export function deleteSupportsLabel(count: number): MessageDescriptor {
  return msg({
    message: plural(count, { one: 'Delete # support', other: 'Delete # supports' }),
    context: 'Undo history entry',
  });
}
