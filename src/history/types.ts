export type HistoryDirection = 'undo' | 'redo';

export interface HistoryAction<Type extends string = string, Payload = unknown> {
  /** Unique action identifier understood by the registered history handlers. */
  type: Type;
  /** Optional human-readable description shown in undo/redo UI feedback. */
  description?: string;
  /** Serialized payload required to undo/redo the action. */
  payload: Payload;
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
  | 'redo-handler-missing';

export interface HistoryDebugEvent {
  id: number;
  timestamp: number;
  kind: HistoryDebugEventKind;
  actionType?: string;
  actionDescription?: string;
  undoCount: number;
  redoCount: number;
}
