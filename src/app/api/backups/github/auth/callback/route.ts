import { NextRequest, NextResponse } from 'next/server';
import {
  GITHUB_OAUTH_COOKIE,
  GITHUB_OAUTH_PKCE_COOKIE,
  GITHUB_OAUTH_STATE_COOKIE,
  backupCookieConfig,
  encryptToken,
  exchangeGithubCodeForAccessToken,
  getGithubEnv,
  getGithubViewer,
  parseSignedOAuthState,
  resolveGithubRedirectUri,
} from '@/features/backups/githubBackup';

function callbackHtml(success: boolean, message: string) {
  const safeMessage = message.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>DragonFruit Backups</title></head>
  <body style="font-family: ui-sans-serif, system-ui; background:#0b0f15; color:#e8eef7; padding:24px;">
    <h2 style="margin:0 0 8px;">${success ? 'GitHub linked' : 'GitHub link failed'}</h2>
    <p style="margin:0 0 12px; color:#9fb0c7;">${safeMessage}</p>
    ${success
    ? '<p style="margin:0 0 12px; color:#7dd3fc; font-size:12px;">This window will close automatically.</p>'
    : '<p style="margin:0 0 12px; color:#fca5a5; font-size:12px;">This window will stay open so you can read the error details.</p>'}
    <button
      type="button"
      onclick="window.close()"
      style="border:1px solid #2b3648; background:#151d2b; color:#e8eef7; border-radius:8px; padding:8px 12px; cursor:pointer;"
    >
      Close window
    </button>
    <script>
      try {
        if (window.opener) {
          window.opener.postMessage({ type: 'dragonfruit:backup-auth', success: ${success ? 'true' : 'false'}, message: ${JSON.stringify(message)}, sourceOrigin: window.location.origin }, '*');

          if (${success ? 'true' : 'false'}) {
            try {
              if (window.opener.location.origin !== window.location.origin) {
                window.opener.location = window.location.origin + '/';
              }
            } catch {
              // Cross-origin access can throw; setting location is still allowed in most browsers.
              try {
                window.opener.location = window.location.origin + '/';
              } catch {}
            }
          }
        }
      } catch {}
      if (${success ? 'true' : 'false'}) {
        setTimeout(() => window.close(), 1200);
      }
    </script>
  </body>
</html>`;
}

export async function GET(request: NextRequest) {
  const env = getGithubEnv();
  if (!env.configured) {
    return new NextResponse(callbackHtml(false, 'GitHub backups are not configured yet.'), { status: 500, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  const code = request.nextUrl.searchParams.get('code') ?? '';
  const state = request.nextUrl.searchParams.get('state') ?? '';
  const stateCookie = request.cookies.get(GITHUB_OAUTH_STATE_COOKIE)?.value ?? '';
  const pkceCookieVerifier = request.cookies.get(GITHUB_OAUTH_PKCE_COOKIE)?.value ?? '';

  const parsedState = state ? parseSignedOAuthState(state, env.cookieSecret) : { valid: false };
  const stateFromCookieValid = Boolean(stateCookie && state && stateCookie === state);
  const stateValid = stateFromCookieValid || parsedState.valid;
  const pkceVerifier = pkceCookieVerifier || parsedState.pkceVerifier || '';

  if (!code || !state || !stateValid || !pkceVerifier) {
    let detail = 'OAuth state validation failed.';

    const configuredHost = (() => {
      try {
        return env.redirectUri ? new URL(env.redirectUri).host : null;
      } catch {
        return null;
      }
    })();

    const callbackHost = request.nextUrl.host;
    if (configuredHost && configuredHost !== callbackHost) {
      detail = `OAuth state validation failed. Host mismatch detected: callback arrived on ${callbackHost} but configured callback host is ${configuredHost}. Open DragonFruit using the same host as your configured callback URL and try again.`;
    } else if (!stateValid || !pkceVerifier) {
      detail = 'OAuth state validation failed because setup cookies were missing. This usually means the app was opened on a different host (for example localhost vs 127.0.0.1) during the OAuth flow. Open DragonFruit with the exact callback host and retry.';
    }

    return new NextResponse(callbackHtml(false, detail), { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  try {
    const redirectUri = resolveGithubRedirectUri(request.nextUrl.origin, env.redirectUri);
    if (!redirectUri) {
      return new NextResponse(callbackHtml(false, 'Invalid GITHUB_OAUTH_REDIRECT_URI configuration.'), { status: 500, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    const accessToken = await exchangeGithubCodeForAccessToken({
      clientId: env.clientId,
      clientSecret: env.clientSecret,
      redirectUri,
      code,
      codeVerifier: pkceVerifier,
    });

    const viewer = await getGithubViewer(accessToken);
    const encrypted = encryptToken(accessToken, env.cookieSecret);

    const response = new NextResponse(callbackHtml(true, `Connected as @${viewer.login}.`), {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });

    response.cookies.set(GITHUB_OAUTH_COOKIE, encrypted, backupCookieConfig);
    response.cookies.set('df_github_backup_connected', '1', backupCookieConfig);
    response.cookies.delete(GITHUB_OAUTH_STATE_COOKIE);
    response.cookies.delete(GITHUB_OAUTH_PKCE_COOKIE);
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to complete OAuth flow.';
    const response = new NextResponse(callbackHtml(false, message), { status: 500, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    response.cookies.delete(GITHUB_OAUTH_PKCE_COOKIE);
    return response;
  }
}
