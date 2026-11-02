import { isTauriRuntime } from '@/utils/tauriRuntime';
import {
  resolveGithubPluginManifest,
  type GithubManifestResult,
  type ManifestFetch,
  type ManifestFetchResponse,
} from './githubPluginManifest';

type TauriCoreModule = {
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
};

type NativeResourcePayload = {
  status: number;
  contentType: string;
  bodyBase64: string;
};

let tauriCorePromise: Promise<TauriCoreModule | null> | null = null;
let nativeFetchPromise: Promise<ManifestFetch | null> | null = null;

async function loadTauriCore(): Promise<TauriCoreModule | null> {
  if (!isTauriRuntime()) return null;
  if (!tauriCorePromise) {
    tauriCorePromise = import('@tauri-apps/api/core')
      .then((mod) => ({ invoke: mod.invoke }))
      .catch(() => null);
  }
  return tauriCorePromise;
}

function decodeBase64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function toManifestFetchResponse(payload: NativeResourcePayload): ManifestFetchResponse {
  const bytes = decodeBase64ToBytes(payload.bodyBase64);
  const contentType = typeof payload.contentType === 'string' ? payload.contentType : '';
  const decodeText = () => new TextDecoder().decode(bytes);

  return {
    ok: payload.status >= 200 && payload.status <= 299,
    status: payload.status,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => decodeText(),
    json: async () => JSON.parse(decodeText()) as unknown,
    arrayBuffer: async () => {
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      return buffer;
    },
  };
}

/**
 * Desktop transport for the plugin manifest resolver.
 *
 * The production desktop build serves only static assets from Tauri, so the
 * `/api/plugins/github-manifest` route does not exist there. Every request goes
 * through the `fetch_github_plugin_resource` command instead, which also avoids
 * WebView CORS rules. The command owns the network policy (GitHub hosts only,
 * 15 s timeout), so the `init` the resolver passes is not forwarded: only the
 * URL crosses the IPC boundary. Assets hosted off GitHub therefore stay remote
 * URLs instead of being inlined into a data URL.
 */
async function loadNativeManifestFetch(): Promise<ManifestFetch | null> {
  if (!nativeFetchPromise) {
    nativeFetchPromise = (async () => {
      const core = await loadTauriCore();
      if (!core) return null;

      return async (url: string) => {
        const payload = await core.invoke<NativeResourcePayload>('fetch_github_plugin_resource', { url });
        return toManifestFetchResponse(payload);
      };
    })();
  }
  return nativeFetchPromise;
}

/**
 * Resolve a plugin manifest from a GitHub repository URL.
 *
 * Prefers the native transport in the desktop app and falls back to the
 * Next.js API route for the web build and `next dev` without Tauri.
 */
export async function requestPluginManifest(
  payload: Record<string, unknown>,
): Promise<GithubManifestResult> {
  const nativeFetch = await loadNativeManifestFetch();
  if (nativeFetch) {
    return resolveGithubPluginManifest(payload, { fetchImpl: nativeFetch });
  }

  const response = await fetch('/api/plugins/github-manifest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null);

  return {
    status: response.status,
    body: body && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {},
  };
}
