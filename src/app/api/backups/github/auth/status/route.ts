import { NextRequest, NextResponse } from 'next/server';
import {
  BACKUP_REPO_NAME,
  GITHUB_OAUTH_COOKIE,
  backupCookieConfig,
  decryptToken,
  getBackupDocument,
  getGithubEnv,
  getGithubViewer,
  getRepoIfExists,
} from '@/features/backups/githubBackup';

export async function GET(request: NextRequest) {
  const env = getGithubEnv();
  const expectedOrigin = (() => {
    try {
      return env.redirectUri ? new URL(env.redirectUri).origin : null;
    } catch {
      return null;
    }
  })();

  if (!env.configured) {
    return NextResponse.json({ ok: true, configured: false, authenticated: false, expectedOrigin });
  }

  const encrypted = request.cookies.get(GITHUB_OAUTH_COOKIE)?.value;
  if (!encrypted) {
    return NextResponse.json({ ok: true, configured: true, authenticated: false, expectedOrigin });
  }

  const token = decryptToken(encrypted, env.cookieSecret);
  if (!token) {
    const response = NextResponse.json({ ok: true, configured: true, authenticated: false, expectedOrigin });
    response.cookies.delete(GITHUB_OAUTH_COOKIE);
    response.cookies.set('df_github_backup_connected', '0', backupCookieConfig);
    return response;
  }

  try {
    const viewer = await getGithubViewer(token);
    const repo = await getRepoIfExists(token, viewer.login, BACKUP_REPO_NAME);

    let remoteUpdatedAt: string | null = null;
    if (repo.exists) {
      const remote = await getBackupDocument(token, viewer.login, BACKUP_REPO_NAME);
      remoteUpdatedAt = remote.document?.updatedAt ?? null;
    }

    return NextResponse.json({
      ok: true,
      configured: true,
      authenticated: true,
      user: {
        login: viewer.login,
        name: viewer.name,
        avatarUrl: viewer.avatar_url,
      },
      repository: {
        name: BACKUP_REPO_NAME,
        exists: repo.exists,
        private: repo.private ?? null,
      },
      remoteUpdatedAt,
      expectedOrigin,
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      configured: true,
      authenticated: false,
      expectedOrigin,
      error: error instanceof Error ? error.message : 'Failed to fetch GitHub backup status.',
    }, { status: 500 });
  }
}
