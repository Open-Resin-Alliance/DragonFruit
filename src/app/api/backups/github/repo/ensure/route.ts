import { NextRequest, NextResponse } from 'next/server';
import {
  BACKUP_REPO_NAME,
  GITHUB_OAUTH_COOKIE,
  decryptToken,
  ensurePrivateBackupRepo,
  getGithubEnv,
  getGithubViewer,
} from '@/features/backups/githubBackup';

export async function POST(request: NextRequest) {
  const env = getGithubEnv();
  if (!env.configured) {
    return NextResponse.json({ ok: false, error: 'GitHub backups are not configured.' }, { status: 500 });
  }

  const encrypted = request.cookies.get(GITHUB_OAUTH_COOKIE)?.value;
  if (!encrypted) {
    return NextResponse.json({ ok: false, error: 'Not authenticated with GitHub.' }, { status: 401 });
  }

  const token = decryptToken(encrypted, env.cookieSecret);
  if (!token) {
    return NextResponse.json({ ok: false, error: 'Invalid authentication token.' }, { status: 401 });
  }

  try {
    await ensurePrivateBackupRepo(token, BACKUP_REPO_NAME);
    const viewer = await getGithubViewer(token);

    return NextResponse.json({
      ok: true,
      repository: {
        owner: viewer.login,
        name: BACKUP_REPO_NAME,
        url: `https://github.com/${viewer.login}/${BACKUP_REPO_NAME}`,
      },
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to ensure backup repository.',
    }, { status: 500 });
  }
}
