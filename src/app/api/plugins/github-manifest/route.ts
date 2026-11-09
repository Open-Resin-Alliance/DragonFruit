import { NextResponse } from 'next/server';
import { resolveGithubPluginManifest } from '@/features/plugins/githubPluginManifest';

/**
 * Web/dev transport for the plugin manifest resolver.
 *
 * The desktop build has no Next.js server (Tauri embeds only `index.html` and
 * `_next/static`), so `PluginsSettingsTab` reaches the same resolver through
 * `src/features/plugins/pluginManifestClient.ts` instead of this route.
 */
export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request JSON' }, { status: 400 });
  }

  const result = await resolveGithubPluginManifest(payload, {
    allowlistConfig: process.env.DRAGONFRUIT_PLUGIN_GITHUB_ALLOWLIST,
  });

  return NextResponse.json(result.body, { status: result.status });
}
