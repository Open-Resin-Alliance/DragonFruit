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
  json: () => Promise<unknown>;
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
  const startedAt = Date.now();
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
      const operation = typeof payload.operation === 'string'
        ? payload.operation
        : Array.isArray(payload.operation)
          ? payload.operation.join('/')
          : '<unknown-operation>';
      console.warn('[PluginNetworkBridge] Tauri IPC request failed', {
        pluginId: payload.pluginId ?? '<unknown-plugin>',
        operation,
        elapsedMs: Date.now() - startedAt,
        error: String(err),
      });
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

export async function readNativeFileSize(sourcePath: string): Promise<number | null> {
  const core = await loadTauriCore();
  if (!core) return null;

  try {
    const size = await core.invoke<number>('read_print_file_size', {
      sourcePath,
    });
    return Number.isFinite(size) && size >= 0 ? size : null;
  } catch {
    return null;
  }
}

export async function readNativeFileChunk(
  sourcePath: string,
  offset: number,
  length: number,
): Promise<Uint8Array | null> {
  const core = await loadTauriCore();
  if (!core) return null;

  try {
    const result = await core.invoke<ArrayBuffer>('read_print_file_chunk', {
      sourcePath,
      offset,
      length,
    });
    return new Uint8Array(result);
  } catch {
    return null;
  }
}
