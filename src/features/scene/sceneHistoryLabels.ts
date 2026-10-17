/**
 * Names of the scene's undo history entries, as the undo/redo toast shows them.
 *
 * Module level on purpose: React Compiler renames locals inside the scene hooks
 * before the Lingui macro derives the message id, so a message that interpolates
 * a model name has to be built out here (see AGENTS.md).
 */

import type { MessageDescriptor } from '@lingui/core';
import { msg, plural } from '@lingui/core/macro';

export const SCENE_CHANGE_LABEL = msg({ message: 'Scene change', context: 'Undo history entry' });
export const MARK_AS_SUPPORT_LABEL = msg({ message: 'Mark as support', context: 'Undo history entry' });
export const MARK_AS_MODEL_LABEL = msg({ message: 'Mark as model', context: 'Undo history entry' });
export const SWITCH_PRINTER_LABEL = msg({ message: 'Switch printer', context: 'Undo history entry' });
export const DELETE_MODELS_AND_PLATES_LABEL = msg({
  message: 'Delete models and plates',
  context: 'Undo history entry',
});
export const APPLY_ORIENTATION_SUGGESTION_LABEL = msg({
  message: 'Apply orientation suggestion',
  context: 'Undo history entry',
});
export const ORGANIC_CUT_LABEL = msg({ message: 'Organic cut', context: 'Undo history entry' });
export const HOLLOWING_SETTINGS_LABEL = msg({ message: 'Hollowing settings', context: 'Undo history entry' });

export const PICK_OPEN_FACE_LABEL = msg({ message: 'Pick open face', context: 'Undo history entry' });
export const ADD_HOLE_LABEL = msg({ message: 'Add hole', context: 'Undo history entry' });
export const MOVE_HOLE_LABEL = msg({ message: 'Move hole', context: 'Undo history entry' });
export const ROTATE_HOLE_LABEL = msg({ message: 'Rotate hole', context: 'Undo history entry' });
export const DELETE_HOLE_LABEL = msg({ message: 'Delete hole', context: 'Undo history entry' });
export const EDIT_HOLE_LABEL = msg({ message: 'Edit hole', context: 'Undo history entry' });
export const RESET_HOLE_PUNCHING_LABEL = msg({ message: 'Reset hole punching', context: 'Undo history entry' });
export const REMOVE_HOLE_PUNCHING_LABEL = msg({ message: 'Remove hole punching', context: 'Undo history entry' });
export const PUNCH_HOLES_LABEL = msg({ message: 'Punch holes', context: 'Undo history entry' });
export const SHELL_HOLLOWING_LABEL = msg({ message: 'Shell hollowing', context: 'Undo history entry' });
export const INFILL_HOLLOWING_LABEL = msg({ message: 'Infill hollowing', context: 'Undo history entry' });
export const CAVITY_HOLLOWING_LABEL = msg({ message: 'Cavity hollowing', context: 'Undo history entry' });
export const RESET_HOLLOWING_LABEL = msg({ message: 'Reset hollowing', context: 'Undo history entry' });
export const CLEAR_HOLLOWING_LABEL = msg({ message: 'Clear hollowing', context: 'Undo history entry' });

/** `axes` is the list of mirrored axes, e.g. "X, Z". */
export function mirrorModelLabel(axes: string): MessageDescriptor {
  return msg({ message: `Mirror in ${axes}`, context: 'Undo history entry' });
}

export function transformModelLabel(modelName: string): MessageDescriptor {
  return msg({ message: `Transform ${modelName}`, context: 'Undo history entry' });
}

export function moveModelLabel(modelName: string): MessageDescriptor {
  return msg({ message: `Move ${modelName}`, context: 'Undo history entry' });
}

export function rotateModelLabel(modelName: string): MessageDescriptor {
  return msg({ message: `Rotate ${modelName}`, context: 'Undo history entry' });
}

export function scaleModelLabel(modelName: string): MessageDescriptor {
  return msg({ message: `Scale ${modelName}`, context: 'Undo history entry' });
}

/** The gizmo's or the panel's move, rotate or scale of one model. */
export function modelTransformLabel(operation: 'move' | 'rotate' | 'scale', modelName: string): MessageDescriptor {
  if (operation === 'move') return moveModelLabel(modelName);
  if (operation === 'rotate') return rotateModelLabel(modelName);
  return scaleModelLabel(modelName);
}

export function transformModelsLabel(count: number): MessageDescriptor {
  return msg({
    message: plural(count, { one: 'Transform # model', other: 'Transform # models' }),
    context: 'Undo history entry',
  });
}

export function moveModelsLabel(count: number): MessageDescriptor {
  return msg({
    message: plural(count, { one: 'Move # model', other: 'Move # models' }),
    context: 'Undo history entry',
  });
}

export function rotateModelsLabel(count: number): MessageDescriptor {
  return msg({
    message: plural(count, { one: 'Rotate # model', other: 'Rotate # models' }),
    context: 'Undo history entry',
  });
}

export function scaleModelsLabel(count: number): MessageDescriptor {
  return msg({
    message: plural(count, { one: 'Scale # model', other: 'Scale # models' }),
    context: 'Undo history entry',
  });
}

export type SelectionEditKind = 'move' | 'rotate' | 'scale';

/** The panel's move, rotate or scale of a multi-model selection. */
export function selectionEditLabel(kind: SelectionEditKind, count: number): MessageDescriptor {
  if (kind === 'move') return moveModelsLabel(count);
  if (kind === 'rotate') return rotateModelsLabel(count);
  return scaleModelsLabel(count);
}

export function showModelLabel(modelName: string): MessageDescriptor {
  return msg({ message: `Show ${modelName}`, context: 'Undo history entry' });
}

export function hideModelLabel(modelName: string): MessageDescriptor {
  return msg({ message: `Hide ${modelName}`, context: 'Undo history entry' });
}

export function renameLabel(name: string): MessageDescriptor {
  return msg({ message: `Rename ${name}`, context: 'Undo history entry' });
}

export function splitModelLabel(modelName: string): MessageDescriptor {
  return msg({ message: `Split ${modelName}`, context: 'Undo history entry' });
}

export function splitSupportsLabel(modelName: string): MessageDescriptor {
  return msg({ message: `Split supports from ${modelName}`, context: 'Undo history entry' });
}

export function mergeSupportsLabel(modelName: string): MessageDescriptor {
  return msg({ message: `Merge supports into ${modelName}`, context: 'Undo history entry' });
}

export function deleteModelLabel(modelName: string): MessageDescriptor {
  return msg({ message: `Delete ${modelName}`, context: 'Undo history entry' });
}

export function deleteModelsLabel(count: number): MessageDescriptor {
  return msg({
    message: plural(count, { one: 'Delete # model', other: 'Delete # models' }),
    context: 'Undo history entry',
  });
}

export function deleteSupportsForModelLabel(modelName: string): MessageDescriptor {
  return msg({ message: `Delete supports of ${modelName}`, context: 'Undo history entry' });
}

export function deleteSupportsForModelsLabel(count: number): MessageDescriptor {
  return msg({
    message: plural(count, { one: 'Delete supports of # model', other: 'Delete supports of # models' }),
    context: 'Undo history entry',
  });
}

export function pasteModelLabel(modelName: string): MessageDescriptor {
  return msg({ message: `Paste ${modelName}`, context: 'Undo history entry' });
}

export function pasteModelsLabel(count: number): MessageDescriptor {
  return msg({
    message: plural(count, { one: 'Paste # model', other: 'Paste # models' }),
    context: 'Undo history entry',
  });
}

export function duplicateModelLabel(modelName: string): MessageDescriptor {
  return msg({ message: `Duplicate ${modelName}`, context: 'Undo history entry' });
}

export function duplicateModelsLabel(count: number): MessageDescriptor {
  return msg({
    message: plural(count, { one: 'Duplicate # model', other: 'Duplicate # models' }),
    context: 'Undo history entry',
  });
}

export function colorModelLabel(modelName: string): MessageDescriptor {
  return msg({ message: `Color ${modelName}`, context: 'Undo history entry' });
}

export function linkModelsLabel(count: number): MessageDescriptor {
  return msg({
    message: plural(count, { one: 'Link # model', other: 'Link # models' }),
    context: 'Undo history entry',
  });
}

export function unlinkModelsLabel(count: number): MessageDescriptor {
  return msg({
    message: plural(count, { one: 'Unlink # model', other: 'Unlink # models' }),
    context: 'Undo history entry',
  });
}

export function repairModelLabel(modelName: string): MessageDescriptor {
  return msg({ message: `Repair ${modelName}`, context: 'Undo history entry' });
}

export function repairModelsLabel(count: number): MessageDescriptor {
  return msg({
    message: plural(count, { one: 'Repair # model', other: 'Repair # models' }),
    context: 'Undo history entry',
  });
}

export function switchPrinterLabel(printerName: string): MessageDescriptor {
  return msg({ message: `Switch to ${printerName}`, context: 'Undo history entry' });
}

export function addPlateLabel(plateNumber: number): MessageDescriptor {
  return msg({ message: `Add plate ${plateNumber}`, context: 'Undo history entry' });
}

export function deletePlateLabel(plateNumber: number): MessageDescriptor {
  return msg({ message: `Delete plate ${plateNumber}`, context: 'Undo history entry' });
}

export function groupModelLabel(modelName: string): MessageDescriptor {
  return msg({ message: `Group ${modelName}`, context: 'Undo history entry' });
}

export function groupModelsLabel(count: number): MessageDescriptor {
  return msg({
    message: plural(count, { one: 'Group # model', other: 'Group # models' }),
    context: 'Undo history entry',
  });
}

export function ungroupLabel(name: string): MessageDescriptor {
  return msg({ message: `Ungroup ${name}`, context: 'Undo history entry' });
}

export function ungroupModelsLabel(count: number): MessageDescriptor {
  return msg({
    message: plural(count, { one: 'Ungroup # model', other: 'Ungroup # models' }),
    context: 'Undo history entry',
  });
}
