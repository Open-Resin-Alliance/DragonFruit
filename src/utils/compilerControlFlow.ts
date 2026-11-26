/**
 * `throw`, `try` and `finally` written as calls, for code inside components and hooks.
 *
 * The React Compiler (1.0) skips a component or hook whose body, callbacks
 * included, contains a `try…finally`, a `try` without `catch`, a `throw`
 * directly inside `try/catch`, or a conditional, `&&`/`||`/`??` or `?.` inside
 * a `try/catch`. A skipped function gets no memoisation and its dependency
 * lists are taken literally (#941). The compiler cannot see into these
 * helpers, so the same control flow written through them compiles.
 */

/** What `attempt` hands back: the work's value, or what it threw. */
export type Attempt<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * `try { value = work(); } catch (error) { … }`, as a call. The caller branches
 * on `ok`, so a `return` that belonged in the `catch` stays in the caller.
 */
export function attempt<T>(work: () => T): Attempt<T> {
  try {
    return { ok: true, value: work() };
  } catch (error) {
    return { ok: false, error };
  }
}

/** `attempt` for async work: a rejection lands in `error`. */
export async function attemptAsync<T>(work: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, error };
  }
}

/** `throw error`, as a call. TypeScript narrows after it as it does after a throw. */
export function raise(error: unknown): never {
  throw error;
}

/** `try { return work(); } finally { cleanup(); }` for synchronous work. */
export function withCleanup<T>(work: () => T, cleanup: () => void): T {
  try {
    return work();
  } finally {
    cleanup();
  }
}

/** `try { return await work(); } finally { await cleanup(); }`: the cleanup waits for the work to settle. */
export async function withCleanupAsync<T>(
  work: () => Promise<T>,
  cleanup: () => void | Promise<void>,
): Promise<T> {
  try {
    return await work();
  } finally {
    await cleanup();
  }
}
