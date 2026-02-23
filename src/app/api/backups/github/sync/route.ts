import { NextRequest, NextResponse } from 'next/server';
import {
  BACKUP_REPO_NAME,
  BackupDocument,
  BackupSnapshot,
  GITHUB_OAUTH_COOKIE,
  decryptToken,
  ensurePrivateBackupRepo,
  getBackupDocument,
  getGithubEnv,
  getGithubViewer,
  isRemoteNewer,
  normalizeBackupRepoName,
  upsertBackupDocument,
  writeBackupHistoryDocument,
} from '@/features/backups/githubBackup';

type SyncPayload = {
  snapshot?: BackupSnapshot;
  forcePush?: boolean;
  repoName?: string;
};

function isValidSnapshot(value: unknown): value is BackupSnapshot {
  if (!value || typeof value !== 'object') return false;
  const maybe = value as BackupSnapshot;
  return (
    Number.isFinite(Number(maybe.version))
    && typeof maybe.updatedAt === 'string'
    && typeof maybe.clientId === 'string'
    && !!maybe.clientId.trim()
    && maybe.localStorage !== null
    && typeof maybe.localStorage === 'object'
    && !Array.isArray(maybe.localStorage)
  );
}

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

  let payload: SyncPayload;
  try {
    payload = await request.json() as SyncPayload;
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request JSON.' }, { status: 400 });
  }

  if (!isValidSnapshot(payload.snapshot)) {
    return NextResponse.json({ ok: false, error: 'Invalid snapshot payload.' }, { status: 400 });
  }

  const localSnapshot = payload.snapshot;
  const repoName = normalizeBackupRepoName(payload.repoName ?? BACKUP_REPO_NAME);

  try {
    const viewer = await getGithubViewer(token);
    await ensurePrivateBackupRepo(token, repoName);

    const remote = await getBackupDocument(token, viewer.login, repoName);
    const remoteSnapshot = remote.document?.snapshot;
    const remoteUpdatedAt = remote.document?.updatedAt;

    const conflict = isRemoteNewer(remoteUpdatedAt, localSnapshot.updatedAt) && payload.forcePush !== true;
    if (conflict && remoteSnapshot) {
      return NextResponse.json({
        ok: true,
        conflict: true,
        reason: 'Remote backup is newer than local snapshot.',
        remoteSnapshot,
        remoteUpdatedAt,
        localUpdatedAt: localSnapshot.updatedAt,
      });
    }

    const chosenSnapshot = localSnapshot;
    const nowIso = new Date().toISOString();

    const document: BackupDocument = {
      source: 'dragonfruit',
      schemaVersion: 1,
      updatedAt: nowIso,
      snapshot: {
        ...chosenSnapshot,
        updatedAt: nowIso,
      },
    };

    await upsertBackupDocument({
      token,
      owner: viewer.login,
      repo: repoName,
      document,
      sha: remote.sha,
    });

    await writeBackupHistoryDocument({
      token,
      owner: viewer.login,
      repo: repoName,
      document,
    });

    return NextResponse.json({
      ok: true,
      conflict: false,
      syncedAt: nowIso,
      repositoryUrl: `https://github.com/${viewer.login}/${repoName}`,
      repositoryName: repoName,
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Backup sync failed.',
    }, { status: 500 });
  }
}
