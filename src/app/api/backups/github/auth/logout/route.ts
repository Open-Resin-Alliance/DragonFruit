import { NextResponse } from 'next/server';
import { GITHUB_OAUTH_COOKIE, GITHUB_OAUTH_PKCE_COOKIE, GITHUB_OAUTH_STATE_COOKIE } from '@/features/backups/githubBackup';

export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.delete(GITHUB_OAUTH_COOKIE);
  response.cookies.delete(GITHUB_OAUTH_STATE_COOKIE);
  response.cookies.delete(GITHUB_OAUTH_PKCE_COOKIE);
  response.cookies.delete('df_github_backup_connected');
  return response;
}
