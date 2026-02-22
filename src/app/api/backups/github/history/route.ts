import { NextRequest, NextResponse } from 'next/server';
import {
  BACKUP_REPO_NAME,
  GITHUB_OAUTH_COOKIE,
  decryptToken,
  getGithubEnv,
  getGithubViewer,
  listBackupHistory,
  normalizeBackupRepoName,
} from '@/features/backups/githubBackup';

export async function GET(request: NextRequest) {
  const repoName = normalizeBackupRepoName(request.nextUrl.searchParams.get('repoName') ?? BACKUP_REPO_NAME);
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
    const viewer = await getGithubViewer(token);
    const items = await listBackupHistory({
      token,
      owner: viewer.login,
      repo: repoName,
    });

    return NextResponse.json({
      ok: true,
      items,
      count: items.length,
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to fetch backup history.',
    }, { status: 500 });
  }
}
