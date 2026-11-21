/**
 * One console argument as a line of text for the log file.
 *
 * Two things went wrong with the obvious `error.stack` / `JSON.stringify`:
 *
 * - JavaScriptCore's `stack` is the frames alone. V8 starts it with
 *   `Name: message`, so on Chrome the message came along for free; on WebKit
 *   (macOS, Linux) the log got a stack and never said what failed.
 * - `JSON.stringify` calls `toJSON` before anything else sees the value, and
 *   three's geometries have one that writes out every vertex. MeshBVH warns with
 *   the geometry as the second argument, so a 4-million-triangle model was
 *   serialised in full on the main thread, threw, and came out as
 *   `[object Object]`.
 *
 * So errors lead with their name and message, and other objects are walked here
 * with a budget instead of handed to `JSON.stringify` whole.
 */

const MAX_DEPTH = 4;
const MAX_KEYS = 30;
const MAX_ITEMS = 20;
/** Values visited per argument; past it the walk writes `…` and stops descending. */
const MAX_NODES = 400;

export function describeLogValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return describeError(value);
  if (value === undefined) return 'undefined';
  const state = { nodes: 0, seen: new WeakSet<object>() };
  try {
    return JSON.stringify(summarize(value, 0, state)) ?? String(value);
  } catch {
    return `[${typeName(value)}]`;
  }
}

/** `Name: message`, then the stack when there is one and it does not already start with that. */
export function describeError(error: Error): string {
  const head = `${error.name}: ${error.message}`;
  const stack = typeof error.stack === 'string' ? error.stack.trim() : '';
  if (!stack) return head;
  return stack.startsWith(head) ? stack : `${head}\n${stack}`;
}

type WalkState = { nodes: number; seen: WeakSet<object> };

function summarize(value: unknown, depth: number, state: WalkState): unknown {
  state.nodes += 1;
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'undefined') return '[undefined]';
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'symbol') return value.toString();
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;

  const object = value as object;
  if (object instanceof Error) return describeError(object);
  if (ArrayBuffer.isView(object)) {
    const length = 'length' in object ? (object as { length: number }).length : object.byteLength;
    return `[${typeName(object)}(${length})]`;
  }
  if (object instanceof ArrayBuffer) return `[ArrayBuffer(${object.byteLength})]`;
  if (typeof Element !== 'undefined' && object instanceof Element) return describeElement(object);
  if (state.seen.has(object)) return '[Circular]';
  if (depth >= MAX_DEPTH || state.nodes > MAX_NODES) return `[${typeName(object)}]`;
  state.seen.add(object);

  if (Array.isArray(object)) {
    const items = object.slice(0, MAX_ITEMS).map((item) => summarize(item, depth + 1, state));
    if (object.length > MAX_ITEMS) items.push(`… ${object.length - MAX_ITEMS} more`);
    return items;
  }
  if (object instanceof Map) return { [`[Map(${object.size})]`]: summarize([...object.entries()].slice(0, MAX_ITEMS), depth + 1, state) };
  if (object instanceof Set) return { [`[Set(${object.size})]`]: summarize([...object].slice(0, MAX_ITEMS), depth + 1, state) };

  const out: Record<string, unknown> = {};
  const name = typeName(object);
  if (name !== 'Object') out['[type]'] = name;
  const keys = Object.keys(object);
  for (const key of keys.slice(0, MAX_KEYS)) {
    if (state.nodes > MAX_NODES) {
      out['…'] = `${keys.length - Object.keys(out).length} more`;
      break;
    }
    try {
      out[key] = summarize((object as Record<string, unknown>)[key], depth + 1, state);
    } catch {
      out[key] = '[unreadable]';
    }
  }
  if (keys.length > MAX_KEYS && !('…' in out)) out['…'] = `${keys.length - MAX_KEYS} more keys`;
  return out;
}

function typeName(value: unknown): string {
  if (value === null || typeof value !== 'object') return typeof value;
  const proto = Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null;
  return proto?.constructor?.name || 'Object';
}

function describeElement(element: Element): string {
  const id = element.id ? `#${element.id}` : '';
  const classes = typeof element.className === 'string' && element.className.trim()
    ? `.${element.className.trim().split(/\s+/).slice(0, 3).join('.')}`
    : '';
  return `<${element.tagName.toLowerCase()}${id}${classes}>`;
}
