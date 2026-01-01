export type HistoryDirection = 'undo' | 'redo';

export interface HistoryAction<Type extends string = string, Payload = unknown> {
  /** Unique action identifier understood by the registered history handlers. */
  type: Type;
  /** Serialized payload required to undo/redo the action. */
  payload: Payload;
}

export type HistoryHandler = (action: HistoryAction, direction: HistoryDirection) => boolean | void;

export type HistorySubscriber = () => void;
