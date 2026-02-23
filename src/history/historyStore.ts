import { HistoryAction, HistoryHandler, HistorySubscriber, HistoryDirection, HistoryDebugEvent, HistoryDebugEventKind } from './types';

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
  });

  while (historyDebugLog.length > HISTORY_DEBUG_LOG_LIMIT) {
    historyDebugLog.shift();
  }

  notifyHistoryDebugSubscribers();
}

export function pushHistory(action: HistoryAction) {
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
  const handled = dispatch(action, 'undo');
  if (handled) {
    redoStack.push(structuredClone(action));
    notifyHistoryOperation('undo', action);
    appendHistoryDebugEvent('undo', action);
    notifySubscribers();
  } else {
    appendHistoryDebugEvent('undo-handler-missing', action);
    console.warn('[HistoryStore] undo handler missing for action', action.type);
  }
}

export function redo() {
  const action = redoStack.pop();
  if (!action) {
    appendHistoryDebugEvent('redo-empty');
    return;
  }
  const handled = dispatch(action, 'redo');
  if (handled) {
    undoStack.push(structuredClone(action));
    notifyHistoryOperation('redo', action);
    appendHistoryDebugEvent('redo', action);
    notifySubscribers();
  } else {
    appendHistoryDebugEvent('redo-handler-missing', action);
    console.warn('[HistoryStore] redo handler missing for action', action.type);
  }
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

export function getUndoCount() {
  return undoStack.length;
}

export function getRedoCount() {
  return redoStack.length;
}

function dispatch(action: HistoryAction, direction: HistoryDirection) {
  const handlers = handlerMap.get(action.type);
  if (!handlers || handlers.size === 0) return false;
  for (const handler of handlers) {
    const result = handler(action, direction);
    if (result === false) {
      return false;
    }
  }
  return true;
}
