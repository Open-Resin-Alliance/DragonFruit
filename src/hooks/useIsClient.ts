import { useSyncExternalStore } from 'react';

const subscribeNever = () => () => {};

/**
 * `false` during prerender and hydration, `true` once on the client. Replaces
 * the `useEffect(() => setMounted(true), [])` idiom without a cascading render.
 */
export function useIsClient(): boolean {
  return useSyncExternalStore(subscribeNever, () => true, () => false);
}
