import { getSnapshot as getSupportSnapshot } from '@/supports/state';
import { getKickstandSnapshot } from '@/supports/SupportTypes/Kickstand/kickstandStore';

export type HomeSupportSnapshot = ReturnType<typeof getSupportSnapshot>;
export type HomeSupportCollectionsSnapshot = Pick<
  HomeSupportSnapshot,
  'trunks' | 'branches' | 'leaves' | 'twigs' | 'sticks' | 'braces' | 'roots' | 'knots'
>;

export type HomeKickstandSnapshot = ReturnType<typeof getKickstandSnapshot>;
export type HomeKickstandCollectionsSnapshot = Pick<
  HomeKickstandSnapshot,
  'kickstands' | 'roots' | 'knots'
>;

export const EMPTY_HOME_SUPPORT_COLLECTIONS_SNAPSHOT: HomeSupportCollectionsSnapshot = {
  trunks: {},
  branches: {},
  leaves: {},
  twigs: {},
  sticks: {},
  braces: {},
  roots: {},
  knots: {},
};

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

  if (
    cached
    && cached.trunks === snapshot.trunks
    && cached.branches === snapshot.branches
    && cached.leaves === snapshot.leaves
    && cached.twigs === snapshot.twigs
    && cached.sticks === snapshot.sticks
    && cached.braces === snapshot.braces
    && cached.roots === snapshot.roots
    && cached.knots === snapshot.knots
  ) {
    return cached;
  }

  const next: HomeSupportCollectionsSnapshot = {
    trunks: snapshot.trunks,
    branches: snapshot.branches,
    leaves: snapshot.leaves,
    twigs: snapshot.twigs,
    sticks: snapshot.sticks,
    braces: snapshot.braces,
    roots: snapshot.roots,
    knots: snapshot.knots,
  };

  cachedHomeSupportCollectionsSnapshot = next;
  return next;
}

export function getHomeKickstandCollectionsSnapshot(): HomeKickstandCollectionsSnapshot {
  const snapshot = getKickstandSnapshot();
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
