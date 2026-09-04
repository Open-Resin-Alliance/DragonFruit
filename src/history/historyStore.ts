import { HistoryAction, HistoryHandler, HistoryOrigin, HistorySubscriber, HistoryDirection, HistoryDebugEvent, HistoryDebugEventKind } from './types';

const undoStack: HistoryAction[] = [];
const redoStack: HistoryAction[] = [];
const handlerMap = new Map<string, Set<HistoryHandler>>();
const subscribers = new Set<HistorySubscriber>();
const historyOperationSubscribers = new Set<(payload: { direction: HistoryDirection; action: HistoryAction }) => void>();
const historyDebugSubscribers = new Set<HistorySubscriber>();
const historyDebugLog: HistoryDebugEvent[] = [];
const HISTORY_DEBUG_LOG_LIMIT = 600;
let historyDebugIdCounter = 1;

function notifySubscribers() {
  subscribers.forEach((listener) => {
    try {
      listener();
    } catch (err) {
      console.error('[HistoryStore] subscriber error', err);
    }
  });
}

function notifyHistoryOperation(direction: HistoryDirection, action: HistoryAction) {
  historyOperationSubscribers.forEach((listener) => {
    try {
      listener({ direction, action: structuredClone(action) });
    } catch (err) {
      console.error('[HistoryStore] operation subscriber error', err);
    }
  });
}

function notifyHistoryDebugSubscribers() {
  historyDebugSubscribers.forEach((listener) => {
    try {
      listener();
    } catch (err) {
      console.error('[HistoryStore] debug subscriber error', err);
    }
  });
}

function appendHistoryDebugEvent(kind: HistoryDebugEventKind, action?: HistoryAction) {
  historyDebugLog.push({
    id: historyDebugIdCounter++,
    timestamp: Date.now(),
    kind,
    actionType: action?.type,
    actionDescription: action?.description,
    undoCount: undoStack.length,
    redoCount: redoStack.length,
    payloadBytes: action ? estimatePayloadBytes(action.payload) : undefined,
    stackBytes: undoStack.reduce((sum, a) => sum + estimatePayloadBytes(a.payload), 0)
      + redoStack.reduce((sum, a) => sum + estimatePayloadBytes(a.payload), 0),
  });

  while (historyDebugLog.length > HISTORY_DEBUG_LOG_LIMIT) {
    historyDebugLog.shift();
  }

  notifyHistoryDebugSubscribers();
}

/**
 * Supplies the tool the user is in right now. Installed once by the app shell;
 * `pushHistory` uses it to stamp every entry, so no domain has to remember to
 * pass its own origin (the ones that would forget are exactly the ones that
 * need it). Absent (tests, early startup) → entries simply carry no origin.
 */
let originProvider: (() => HistoryOrigin) | null = null;

export function setHistoryOriginProvider(provider: (() => HistoryOrigin) | null) {
  originProvider = provider;
  return () => {
    if (originProvider === provider) originProvider = null;
  };
}

export function pushHistory(action: HistoryAction) {
  // An explicit origin wins — a domain that knows better than "wherever the user
  // happens to be" can say so; everything else gets stamped here.
  if (!action.origin && originProvider) {
    action = { ...action, origin: originProvider() };
  }
  undoStack.push(structuredClone(action));
  redoStack.length = 0;
  appendHistoryDebugEvent('push', action);
  notifySubscribers();
}

export function undo() {
  const action = undoStack.pop();
  if (!action) {
    appendHistoryDebugEvent('undo-empty');
    return;
  }
  const outcome = dispatch(action, 'undo');
  if (outcome === 'applied') {
    redoStack.push(structuredClone(action));
    notifyHistoryOperation('undo', action);
    appendHistoryDebugEvent('undo', action);
    notifySubscribers();
    return;
  }
  if (outcome === 'no-handler') {
    // Registration can lag the push, so keep the entry — it replays once a
    // handler appears. Dropping it would be silent, unrecoverable loss.
    undoStack.push(action);
    appendHistoryDebugEvent('undo-handler-missing', action);
    console.warn('[HistoryStore] undo handler missing for action', action.type);
    return;
  }
  // declined: a handler ran but refused (e.g. the state it needed is gone).
  // Stable across retries, so discard it rather than let it pin the top of the
  // stack and block undo of every entry beneath it.
  appendHistoryDebugEvent('undo-declined', action);
  console.warn('[HistoryStore] undo handler declined; discarding action', action.type);
  notifySubscribers();
}

export function redo() {
  const action = redoStack.pop();
  if (!action) {
    appendHistoryDebugEvent('redo-empty');
    return;
  }
  const outcome = dispatch(action, 'redo');
  if (outcome === 'applied') {
    undoStack.push(structuredClone(action));
    notifyHistoryOperation('redo', action);
    appendHistoryDebugEvent('redo', action);
    notifySubscribers();
    return;
  }
  if (outcome === 'no-handler') {
    // See undo(): keep unhandled entries for a late-registering handler.
    redoStack.push(action);
    appendHistoryDebugEvent('redo-handler-missing', action);
    console.warn('[HistoryStore] redo handler missing for action', action.type);
    return;
  }
  // declined: unrecoverable, so discard rather than pin the redo stack.
  appendHistoryDebugEvent('redo-declined', action);
  console.warn('[HistoryStore] redo handler declined; discarding action', action.type);
  notifySubscribers();
}

export function clearHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
  appendHistoryDebugEvent('clear-history');
  notifySubscribers();
}

export function getHistoryDebugEvents() {
  return historyDebugLog.map((event) => ({ ...event }));
}

export function clearHistoryDebugEvents() {
  historyDebugLog.length = 0;
  historyDebugIdCounter = 1;
  appendHistoryDebugEvent('clear-debug-log');
}

export function registerHistoryHandler(type: string, handler: HistoryHandler) {
  if (!handlerMap.has(type)) {
    handlerMap.set(type, new Set());
  }
  handlerMap.get(type)!.add(handler);
  return () => {
    handlerMap.get(type)?.delete(handler);
    if (handlerMap.get(type)?.size === 0) {
      handlerMap.delete(type);
    }
  };
}

export function subscribeHistory(listener: HistorySubscriber) {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

export function subscribeHistoryOperations(listener: (payload: { direction: HistoryDirection; action: HistoryAction }) => void) {
  historyOperationSubscribers.add(listener);
  return () => historyOperationSubscribers.delete(listener);
}

export function subscribeHistoryDebug(listener: HistorySubscriber) {
  historyDebugSubscribers.add(listener);
  return () => historyDebugSubscribers.delete(listener);
}

/**
 * Rough size of one entry's payload, in bytes.
 *
 * Rough on purpose: the exact retained size is a question only the engine can
 * answer. This counts what actually dominates — typed arrays (mesh data) at their
 * real byte length, strings at 2 bytes a character — and gives everything else a
 * flat word. Shared objects are counted ONCE per payload (a payload that carries
 * the same array twice is holding one array), which is the same rule the scene
 * snapshot registry uses.
 *
 * NOTE what it does NOT see: a payload that stores a KEY into a side registry (as
 * the scene snapshots do) reports only the key. That is honest for this number —
 * dropping the entry frees only its payload — and the registry reports its own
 * total separately.
 */
function estimatePayloadBytes(value: unknown): number {
  const seen = new WeakSet<object>();

  const walk = (v: unknown): number => {
    if (v === null || v === undefined) return 0;
    if (typeof v === 'string') return v.length * 2;
    if (typeof v === 'number' || typeof v === 'boolean') return 8;
    if (typeof v !== 'object') return 8;

    const obj = v as object;
    if (seen.has(obj)) return 0;
    seen.add(obj);

    if (ArrayBuffer.isView(obj)) return (obj as ArrayBufferView).byteLength;
    if (obj instanceof ArrayBuffer) return obj.byteLength;
    if (Array.isArray(obj)) return obj.reduce<number>((sum, item) => sum + walk(item), 0);

    let total = 0;
    for (const [key, item] of Object.entries(obj)) {
      total += key.length * 2 + walk(item);
    }
    return total;
  };

  return walk(value);
}

/** Payload bytes held by each stack, and their sum. */
export function getHistoryStackBytes(): { undo: number; redo: number; total: number } {
  const undo = undoStack.reduce((sum, a) => sum + estimatePayloadBytes(a.payload), 0);
  const redo = redoStack.reduce((sum, a) => sum + estimatePayloadBytes(a.payload), 0);
  return { undo, redo, total: undo + redo };
}

export function getUndoCount() {
  return undoStack.length;
}

export function getRedoCount() {
  return redoStack.length;
}

/**
 * Result of routing an action to its registered handlers.
 *
 * - `applied` — a handler ran and reported success.
 * - `no-handler` — no handler is registered for this type. Usually transient:
 *   registration can lag the first push, so callers keep the entry to replay.
 * - `declined` — a handler ran but refused (e.g. the state it needed is gone).
 *   Stable across retries, so callers discard the entry rather than let it pin
 *   the stack.
 *
 * The two failure cases were a single `false` before; conflating them made an
 * unrecoverable entry masquerade as a retryable one and jam the stack.
 */
type DispatchOutcome = 'applied' | 'no-handler' | 'declined';

function dispatch(action: HistoryAction, direction: HistoryDirection): DispatchOutcome {
  const handlers = handlerMap.get(action.type);
  if (!handlers || handlers.size === 0) return 'no-handler';
  for (const handler of handlers) {
    if (handler(action, direction) === false) {
      return 'declined';
    }
  }
  return 'applied';
}
