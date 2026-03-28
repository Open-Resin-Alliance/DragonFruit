import type { KickstandState } from '../SupportTypes/Kickstand/types';
import type { SupportState } from '../types';
import type { SupportRenderLookupInput, SupportRenderLookupSnapshot } from './supportRenderLookupMath';

type SupportLookupStateInput = SupportRenderLookupInput['state'];
type SupportLookupKickstandStateInput = SupportRenderLookupInput['kickstandState'];

export type RecordDelta<T> = {
  upserts: Record<string, T>;
  deleteIds: string[];
};

export type SupportLookupStateDelta = Partial<{
  roots: RecordDelta<SupportLookupStateInput['roots'][string]>;
  trunks: RecordDelta<SupportLookupStateInput['trunks'][string]>;
  branches: RecordDelta<SupportLookupStateInput['branches'][string]>;
  leaves: RecordDelta<SupportLookupStateInput['leaves'][string]>;
  twigs: RecordDelta<SupportLookupStateInput['twigs'][string]>;
  sticks: RecordDelta<SupportLookupStateInput['sticks'][string]>;
  braces: RecordDelta<SupportLookupStateInput['braces'][string]>;
  knots: RecordDelta<SupportLookupStateInput['knots'][string]>;
}>;

export type SupportLookupKickstandStateDelta = Partial<{
  kickstands: RecordDelta<SupportLookupKickstandStateInput['kickstands'][string]>;
  knots: RecordDelta<SupportLookupKickstandStateInput['knots'][string]>;
}>;

export type SupportLookupInputDelta = {
  state?: SupportLookupStateDelta;
  kickstandState?: SupportLookupKickstandStateDelta;
  activePreviewSupport?: SupportRenderLookupInput['activePreviewSupport'];
  activePreviewSupportChanged?: boolean;
};

export type SupportRenderLookupWorkerRequestMessage = {
  requestId: number;
  delta?: SupportLookupInputDelta;
  cancelSignal?: SharedArrayBuffer;
  cancelEpoch?: number;
};

export type SupportRenderLookupWorkerResponseMessage = {
  requestId: number;
  snapshot: SupportRenderLookupSnapshot;
};

export type SupportLookupCollections = Pick<SupportState, 'roots' | 'trunks' | 'branches' | 'leaves' | 'twigs' | 'sticks' | 'braces' | 'knots'>;
export type SupportLookupKickstandCollections = Pick<KickstandState, 'kickstands' | 'knots'>;
