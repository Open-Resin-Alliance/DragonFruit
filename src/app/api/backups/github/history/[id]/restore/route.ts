import { NextRequest, NextResponse } from 'next/server';
import {
  BACKUP_REPO_NAME,
  GITHUB_OAUTH_COOKIE,
  backupHistoryFilePath,
  decryptToken,
  getBackupDocument,
  getGithubEnv,
  getGithubViewer,
  isValidBackupHistoryId,
  normalizeBackupRepoName,
  upsertBackupDocument,
  writeBackupHistoryDocument,
} from '@/features/backups/githubBackup';

type Params = {
  params: Promise<{ id: string }>;
};

export async function POST(request: NextRequest, { params }: Params) {
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

  const { id } = await params;
  if (!isValidBackupHistoryId(id)) {
    return NextResponse.json({ ok: false, error: 'Invalid backup history id.' }, { status: 400 });
  }

  try {
    const viewer = await getGithubViewer(token);
    const repoName = normalizeBackupRepoName(request.nextUrl.searchParams.get('repoName') ?? BACKUP_REPO_NAME);

    const source = await getBackupDocument(token, viewer.login, repoName, backupHistoryFilePath(id));
    if (!source.document) {
      return NextResponse.json({ ok: false, error: 'Backup history item not found.' }, { status: 404 });
    }

    const current = await getBackupDocument(token, viewer.login, repoName);
    const restoredAt = new Date().toISOString();

    const restoredDocument = {
      ...source.document,
      updatedAt: restoredAt,
      snapshot: {
        ...source.document.snapshot,
        updatedAt: restoredAt,
      },
    };

    await upsertBackupDocument({
      token,
      owner: viewer.login,
      repo: repoName,
      document: restoredDocument,
      sha: current.sha,
    });

    await writeBackupHistoryDocument({
      token,
      owner: viewer.login,
      repo: repoName,
      document: restoredDocument,
    });

    return NextResponse.json({
      ok: true,
      restoredFrom: id,
      restoredAt,
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to restore backup history item.',
    }, { status: 500 });
  }
}
