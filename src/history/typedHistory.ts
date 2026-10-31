import type { MessageDescriptor } from '@lingui/core';
import { pushHistory, registerHistoryHandler } from './historyStore';
import type { HistoryDirection } from './types';

/** The undo/redo toast's name for each of a domain's action types. */
export type HistoryLabels<M> = { [K in keyof M & string]: MessageDescriptor };

export interface TypedHistory<M> {
  /**
   * Push an entry whose payload must match its action type. The toast names it by
   * `description` when given, else by the domain's label for its type.
   */
  push<K extends keyof M & string>(
    action: { type: K; payload: M[K]; description?: MessageDescriptor },
    options?: { payloadOwned?: boolean },
  ): void;
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
 *
 * `labels` names every action type, so an entry pushed without a description
 * still reaches the toast in the user's language, and a new type cannot be
 * declared without one.
 */
export function createTypedHistory<M>(labels: HistoryLabels<M>): TypedHistory<M> {
  return {
    push(action, options) {
      pushHistory({
        ...action,
        description: action.description ?? labels[action.type],
        ...(options?.payloadOwned ? { payloadOwned: true } : {}),
      });
    },
    register(type, handler) {
      return registerHistoryHandler(type, (action, direction) =>
        handler(action.payload as M[typeof type], direction),
      );
    },
  };
}
