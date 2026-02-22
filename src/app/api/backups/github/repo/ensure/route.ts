import { NextRequest, NextResponse } from 'next/server';
import {
  BACKUP_REPO_NAME,
  GITHUB_OAUTH_COOKIE,
  decryptToken,
  ensurePrivateBackupRepo,
  getGithubEnv,
  getGithubViewer,
  normalizeBackupRepoName,
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

  let repoName: string;
  try {
    const payload = await request.json().catch(() => null) as { repoName?: string } | null;
    repoName = normalizeBackupRepoName(payload?.repoName ?? BACKUP_REPO_NAME);
  } catch {
    repoName = BACKUP_REPO_NAME;
  }

  try {
    await ensurePrivateBackupRepo(token, repoName);
    const viewer = await getGithubViewer(token);

    return NextResponse.json({
      ok: true,
      repository: {
        owner: viewer.login,
        name: repoName,
        url: `https://github.com/${viewer.login}/${repoName}`,
      },
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to ensure backup repository.',
    }, { status: 500 });
  }
}
