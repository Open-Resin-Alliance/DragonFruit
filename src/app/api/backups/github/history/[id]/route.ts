import { NextRequest, NextResponse } from 'next/server';
import {
  BACKUP_REPO_NAME,
  GITHUB_OAUTH_COOKIE,
  backupHistoryFilePath,
  decryptToken,
  deleteRepositoryFile,
  getBackupDocument,
  getGithubEnv,
  getGithubViewer,
  isValidBackupHistoryId,
  normalizeBackupRepoName,
} from '@/features/backups/githubBackup';

type Params = {
  params: Promise<{ id: string }>;
};

async function resolveToken(request: NextRequest): Promise<{ token: string } | { error: string; status: number }> {
  const env = getGithubEnv();
  if (!env.configured) {
    return { error: 'GitHub backups are not configured.', status: 500 };
  }

  const encrypted = request.cookies.get(GITHUB_OAUTH_COOKIE)?.value;
  if (!encrypted) {
    return { error: 'Not authenticated with GitHub.', status: 401 };
  }

  const token = decryptToken(encrypted, env.cookieSecret);
  if (!token) {
    return { error: 'Invalid authentication token.', status: 401 };
  }

  return { token };
}

export async function GET(request: NextRequest, { params }: Params) {
  const auth = await resolveToken(request);
  if ('error' in auth) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const { id } = await params;
  if (!isValidBackupHistoryId(id)) {
    return NextResponse.json({ ok: false, error: 'Invalid backup history id.' }, { status: 400 });
  }

  try {
    const viewer = await getGithubViewer(auth.token);
    const repoName = normalizeBackupRepoName(request.nextUrl.searchParams.get('repoName') ?? BACKUP_REPO_NAME);
    const filePath = backupHistoryFilePath(id);
    const { document } = await getBackupDocument(auth.token, viewer.login, repoName, filePath);

    if (!document) {
      return NextResponse.json({ ok: false, error: 'Backup history item not found.' }, { status: 404 });
    }

    return NextResponse.json({
      ok: true,
      item: {
        id,
        createdAt: new Date(Number(id)).toISOString(),
        document,
      },
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to read backup history item.',
    }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const auth = await resolveToken(request);
  if ('error' in auth) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const { id } = await params;
  if (!isValidBackupHistoryId(id)) {
    return NextResponse.json({ ok: false, error: 'Invalid backup history id.' }, { status: 400 });
  }

  try {
    const viewer = await getGithubViewer(auth.token);
    const repoName = normalizeBackupRepoName(request.nextUrl.searchParams.get('repoName') ?? BACKUP_REPO_NAME);
    const filePath = backupHistoryFilePath(id);
    const { sha } = await getBackupDocument(auth.token, viewer.login, repoName, filePath);

    if (!sha) {
      return NextResponse.json({ ok: false, error: 'Backup history item not found.' }, { status: 404 });
    }

    await deleteRepositoryFile({
      token: auth.token,
      owner: viewer.login,
      repo: repoName,
      filePath,
      sha,
      message: `backup: delete history ${id}`,
    });

    return NextResponse.json({ ok: true, id });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to delete backup history item.',
    }, { status: 500 });
  }
}
