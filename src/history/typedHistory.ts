import { pushHistory, registerHistoryHandler } from './historyStore';
import type { HistoryDirection } from './types';

export interface TypedHistory<M> {
  /** Push an entry whose payload must match its action type. */
  push<K extends keyof M & string>(action: { type: K; payload: M[K]; description?: string }): void;
  /** Register a handler that receives its action's payload already narrowed. */
  register<K extends keyof M & string>(
    type: K,
    handler: (payload: M[K], direction: HistoryDirection) => boolean | void,
  ): () => void;
}

/**
 * A typed façade over the untyped history store for one domain's action→payload
 * map `M`. It binds each action type to its payload — so a push can't drift from
 * the handler that inverts it — and confines the store-boundary cast the untyped
 * store forces to this one place, instead of once per handler.
 */
export function createTypedHistory<M>(): TypedHistory<M> {
  return {
    push(action) {
      pushHistory(action);
    },
    register(type, handler) {
      return registerHistoryHandler(type, (action, direction) =>
        handler(action.payload as M[typeof type], direction),
      );
    },
  };
}
