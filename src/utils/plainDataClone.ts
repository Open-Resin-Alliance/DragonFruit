/**
 * Deep-copy plain data: records, arrays and primitives.
 *
 * `structuredClone` costs several microseconds per call whatever the size, and
 * the history and paste paths copy thousands of small records — a support
 * snapshot is a walk over every entity in the scene — so the walk is hand-rolled
 * here. Object identity is kept, so a record reachable from two places (a
 * state's `supports` map and the collection view derived from it) is one object
 * in the copy as well.
 *
 * Anything that is not plain data — a Map, a typed array, a class instance —
 * goes to `structuredClone` rather than being guessed at.
 */
export function clonePlainData<T>(value: T, seen?: Map<object, unknown>): T {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item) => clonePlainData(item, seen)) as unknown as T;

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return structuredClone(value);

    // Shared objects (and cycles) resolve to the one copy already made.
    const memo = seen ?? new Map<object, unknown>();
    const copied = memo.get(value as object);
    if (copied) return copied as T;

    const next: Record<string, unknown> = {};
    memo.set(value as object, next);
    for (const key in value as Record<string, unknown>) {
        next[key] = clonePlainData((value as Record<string, unknown>)[key], memo);
    }
    return next as T;
}
