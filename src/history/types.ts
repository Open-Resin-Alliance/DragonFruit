import type { MessageDescriptor } from '@lingui/core';

export type HistoryDirection = 'undo' | 'redo';

/**
 * Where an entry came from: the app mode + tool that was active when it was
 * pushed. Undoing an edit made in another tool used to leave the user staring at
 * the current tool's gizmo while unrelated geometry jumped around, with no way to
 * tell what had just changed; with this the app can follow the stack back.
 *
 * Deliberately plain strings: the history store is infrastructure and must not
 * depend on the app's mode/tool unions. The app stamps and interprets them.
 */
export interface HistoryOrigin {
  appMode: string;
  transformMode: string;
}

export interface HistoryAction<Type extends string = string, Payload = unknown> {
  /** Unique action identifier understood by the registered history handlers. */
  type: Type;
  /**
   * What the undo/redo toast names the entry by. A catalog message rather than a
   * string, so the toast speaks the user's language; the store has no language of
   * its own, so whoever shows it translates it. Interpolated values must be plain
   * strings or numbers, since entries are structured-cloned.
   */
  description: MessageDescriptor;
  /** Serialized payload required to undo/redo the action. */
  payload: Payload;
  /**
   * The payload is a fresh copy owned by the store, so pushing and moving it
   * between the undo and redo stacks need not clone it again. Set by a domain
   * that has just built a private snapshot (support-edit history does); never set
   * it on a payload that is still referenced by live state.
   */
  payloadOwned?: boolean;
  /**
   * Tool the entry was made in. Stamped by `pushHistory` from the app-installed
   * provider, so every domain gets it without opting in — the same reason the
   * cut tool snapshots its whole state instead of wiring each edit by hand.
   */
  origin?: HistoryOrigin;
}

export type HistoryHandler = (action: HistoryAction, direction: HistoryDirection) => boolean | void;

export type HistorySubscriber = () => void;

/** One entry that changed the scene; see `subscribeHistoryChanges`. */
export interface HistoryChange {
  kind: 'push' | HistoryDirection;
  actionType: string;
}

export type HistoryDebugEventKind =
  | 'push'
  | 'undo'
  | 'redo'
  | 'clear-history'
  | 'clear-debug-log'
  | 'undo-empty'
  | 'redo-empty'
  | 'undo-handler-missing'
  | 'redo-handler-missing'
  | 'undo-declined'
  | 'redo-declined';

export interface HistoryDebugEvent {
  id: number;
  timestamp: number;
  kind: HistoryDebugEventKind;
  actionType?: string;
  actionDescription?: MessageDescriptor;
  undoCount: number;
  redoCount: number;
  /** Payload bytes of the entry this event is about (absent for stack-wide events). */
  payloadBytes?: number;
  /** Payload bytes held by both stacks together, right after this event. */
  stackBytes?: number;
}
