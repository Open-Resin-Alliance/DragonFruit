import { HistoryAction, HistoryHandler, HistorySubscriber, HistoryDirection } from './types';

const undoStack: HistoryAction[] = [];
const redoStack: HistoryAction[] = [];
const handlerMap = new Map<string, Set<HistoryHandler>>();
const subscribers = new Set<HistorySubscriber>();

function notifySubscribers() {
  subscribers.forEach((listener) => {
    try {
      listener();
    } catch (err) {
      console.error('[HistoryStore] subscriber error', err);
    }
  });
}

export function pushHistory(action: HistoryAction) {
  undoStack.push(structuredClone(action));
  redoStack.length = 0;
  notifySubscribers();
}

export function undo() {
  const action = undoStack.pop();
  if (!action) return;
  const handled = dispatch(action, 'undo');
  if (handled) {
    redoStack.push(structuredClone(action));
    notifySubscribers();
  } else {
    console.warn('[HistoryStore] undo handler missing for action', action.type);
  }
}

export function redo() {
  const action = redoStack.pop();
  if (!action) return;
  const handled = dispatch(action, 'redo');
  if (handled) {
    undoStack.push(structuredClone(action));
    notifySubscribers();
  } else {
    console.warn('[HistoryStore] redo handler missing for action', action.type);
  }
}

export function clearHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
  notifySubscribers();
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
