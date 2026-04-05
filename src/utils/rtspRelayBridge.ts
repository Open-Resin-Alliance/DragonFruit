type TauriCoreModule = {
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
};

type RtspRelayTransportDebug = {
  clientPort: number | null;
  serverPort: number | null;
  transportHeader: string | null;
  updatedAtEpochMs: number | null;
};

type RtspRelayReclaimDebug = {
  activeSessionId: string | null;
  clientRtpPort: number | null;
  serverRtpPort: number | null;
  lastClaimStatus: string | null;
  lastClaimAtMs: number | null;
  updatedAtMs: number | null;
};

export type RtspRelayStatusPayload = {
  ok?: boolean;
  message?: string;
  wsBaseUrl?: string | null;
  rtspDebugTransport?: RtspRelayTransportDebug | null;
  rtspReclaimDebug?: RtspRelayReclaimDebug | null;
  error?: string | null;
};

let tauriCorePromise: Promise<TauriCoreModule | null> | null = null;

function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  return '__TAURI_INTERNALS__' in window;
}

async function loadTauriCore(): Promise<TauriCoreModule | null> {
  if (!isTauriRuntime()) return null;
  if (!tauriCorePromise) {
    tauriCorePromise = import('@tauri-apps/api/core')
      .then((mod) => ({ invoke: mod.invoke }))
      .catch(() => null);
  }
  return tauriCorePromise;
}

export async function fetchRtspRelayStatus(rtspUrl: string): Promise<{
  ok: boolean;
  status: number;
  payload: RtspRelayStatusPayload;
}> {
  const core = await loadTauriCore();

  if (core) {
    try {
      const payload = await core.invoke<RtspRelayStatusPayload>('ensure_rtsp_relay', {
        rtspUrl,
      });

      const status = payload?.ok === false ? 500 : 200;
      return {
        ok: status >= 200 && status <= 299,
        status,
        payload: payload ?? {},
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? 'Unknown relay error');
      return {
        ok: false,
        status: 500,
        payload: {
          ok: false,
          error: message,
          message,
        },
      };
    }
  }

  const response = await fetch(`/api/rtsp-relay?url=${encodeURIComponent(rtspUrl)}`, {
    cache: 'no-store',
  });

  const payload = await response.json().catch(() => ({} as RtspRelayStatusPayload));

  return {
    ok: response.ok,
    status: response.status,
    payload,
  };
}
