import { getSnapshot as getSupportSnapshot } from '@/supports/state';
import { SUPPORT_COLLECTION_KEYS, type SupportCollectionKey } from '@/supports/supportTypeRegistry';

export type HomeSupportSnapshot = ReturnType<typeof getSupportSnapshot>;

/** Every entity collection, derived from the registry. */
export type HomeSupportCollectionsSnapshot = Pick<HomeSupportSnapshot, SupportCollectionKey>;

export type HomeKickstandCollectionsSnapshot = Pick<
  HomeSupportSnapshot,
  'kickstands' | 'roots' | 'knots'
>;

export const EMPTY_HOME_SUPPORT_COLLECTIONS_SNAPSHOT: HomeSupportCollectionsSnapshot = (() => {
  const empty = {} as Record<SupportCollectionKey, Record<string, never>>;
  for (const key of SUPPORT_COLLECTION_KEYS) empty[key] = {};
  return empty as HomeSupportCollectionsSnapshot;
})();

export const EMPTY_HOME_KICKSTAND_COLLECTIONS_SNAPSHOT: HomeKickstandCollectionsSnapshot = {
  kickstands: {},
  roots: {},
  knots: {},
};

let cachedHomeSupportCollectionsSnapshot: HomeSupportCollectionsSnapshot | null = null;
let cachedHomeKickstandCollectionsSnapshot: HomeKickstandCollectionsSnapshot | null = null;

export function getHomeSupportCollectionsSnapshot(): HomeSupportCollectionsSnapshot {
  const snapshot = getSupportSnapshot();
  const cached = cachedHomeSupportCollectionsSnapshot;

  // Identity comparison per collection: the snapshot is handed to
  // useSyncExternalStore, which re-renders whenever the object changes.
  if (cached && SUPPORT_COLLECTION_KEYS.every((key) => cached[key] === snapshot[key])) {
    return cached;
  }

  const next = {} as Record<SupportCollectionKey, unknown>;
  for (const key of SUPPORT_COLLECTION_KEYS) next[key] = snapshot[key];

  cachedHomeSupportCollectionsSnapshot = next as HomeSupportCollectionsSnapshot;
  return cachedHomeSupportCollectionsSnapshot;
}

export function getHomeKickstandCollectionsSnapshot(): HomeKickstandCollectionsSnapshot {
  const snapshot = getSupportSnapshot();
  const cached = cachedHomeKickstandCollectionsSnapshot;

  if (
    cached
    && cached.kickstands === snapshot.kickstands
    && cached.roots === snapshot.roots
    && cached.knots === snapshot.knots
  ) {
    return cached;
  }

  const next: HomeKickstandCollectionsSnapshot = {
    kickstands: snapshot.kickstands,
    roots: snapshot.roots,
    knots: snapshot.knots,
  };

  cachedHomeKickstandCollectionsSnapshot = next;
  return next;
}
