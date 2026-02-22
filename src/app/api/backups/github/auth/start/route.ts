import { NextRequest, NextResponse } from 'next/server';
import {
  GITHUB_OAUTH_PKCE_COOKIE,
  GITHUB_OAUTH_STATE_COOKIE,
  backupCookieConfig,
  buildGithubAuthUrl,
  createSignedOAuthState,
  generatePkceChallenge,
  generatePkceVerifier,
  getGithubEnv,
  oauthStateCookieConfig,
  resolveGithubRedirectUri,
} from '@/features/backups/githubBackup';

export async function GET(request: NextRequest) {
  const env = getGithubEnv();
  if (!env.configured) {
    return NextResponse.json({ ok: false, error: 'GitHub backups are not configured on this server.' }, { status: 500 });
  }

  const verifier = generatePkceVerifier();
  const state = createSignedOAuthState(env.cookieSecret, verifier);
  const challenge = generatePkceChallenge(verifier);
  const redirectUri = resolveGithubRedirectUri(request.nextUrl.origin, env.redirectUri);
  if (!redirectUri) {
    return NextResponse.json({ ok: false, error: 'Invalid GITHUB_OAUTH_REDIRECT_URI configuration.' }, { status: 500 });
  }

  const authUrl = buildGithubAuthUrl({
    clientId: env.clientId,
    redirectUri,
    state,
    codeChallenge: challenge,
    prompt: 'select_account',
  });

  const prefersPopup = request.nextUrl.searchParams.get('popup') === '1';
  if (prefersPopup) {
    const response = NextResponse.json({ ok: true, authUrl });
    response.cookies.set(GITHUB_OAUTH_STATE_COOKIE, state, oauthStateCookieConfig);
    response.cookies.set(GITHUB_OAUTH_PKCE_COOKIE, verifier, oauthStateCookieConfig);
    return response;
  }

  const response = NextResponse.redirect(authUrl);
  response.cookies.set(GITHUB_OAUTH_STATE_COOKIE, state, oauthStateCookieConfig);
  response.cookies.set(GITHUB_OAUTH_PKCE_COOKIE, verifier, oauthStateCookieConfig);
  response.cookies.set('df_github_backup_connected', '0', backupCookieConfig);
  return response;
}
