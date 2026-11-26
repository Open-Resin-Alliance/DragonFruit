/**
 * `throw` and `finally` written as calls, for code inside components and hooks.
 *
 * The React Compiler (1.0) skips a component or hook whose body, callbacks
 * included, contains a `try…finally`, a `try` without `catch`, or a `throw`
 * directly inside `try/catch`. A skipped function gets no memoisation and its
 * dependency lists are taken literally (#941). The compiler cannot see into
 * these helpers, so the same control flow written through them compiles.
 */

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
