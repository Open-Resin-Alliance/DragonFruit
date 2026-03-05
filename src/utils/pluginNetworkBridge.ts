type TauriCoreModule = {
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
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

type FetchLikeResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<any>;
};

/**
 * Send a plugin network operation through the Tauri IPC bridge when running
 * inside the desktop app, or fall back to the Next.js API route in dev/web mode.
 *
 * Returns a fetch-Response-like object so callers can use the same
 * `.ok`, `.status`, `.json()` interface they already rely on.
 */
export async function pluginNetworkFetch(
  payload: Record<string, unknown>,
): Promise<FetchLikeResponse> {
  const core = await loadTauriCore();

  if (core) {
    try {
      const result = await core.invoke<{ status: number; body: unknown }>(
        'plugin_network_request',
        { requestJson: JSON.stringify(payload) },
      );
      const status = typeof result?.status === 'number' ? result.status : 200;
      const body = result?.body ?? {};
      return {
        ok: status >= 200 && status <= 299,
        status,
        json: async () => body,
      };
    } catch (err) {
      return {
        ok: false,
        status: 500,
        json: async () => ({ error: String(err) }),
      };
    }
  }

  // Fallback: Next.js API route (dev mode without Tauri, or plain web)
  const response = await fetch('/api/network/plugin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response;
}
