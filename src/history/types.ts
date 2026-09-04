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
  /** Optional human-readable description shown in undo/redo UI feedback. */
  description?: string;
  /** Serialized payload required to undo/redo the action. */
  payload: Payload;
  /**
   * Tool the entry was made in. Stamped by `pushHistory` from the app-installed
   * provider, so every domain gets it without opting in — the same reason the
   * cut tool snapshots its whole state instead of wiring each edit by hand.
   */
  origin?: HistoryOrigin;
}

export type HistoryHandler = (action: HistoryAction, direction: HistoryDirection) => boolean | void;

export type HistorySubscriber = () => void;

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
  actionDescription?: string;
  undoCount: number;
  redoCount: number;
  /** Payload bytes of the entry this event is about (absent for stack-wide events). */
  payloadBytes?: number;
  /** Payload bytes held by both stacks together, right after this event. */
  stackBytes?: number;
}
