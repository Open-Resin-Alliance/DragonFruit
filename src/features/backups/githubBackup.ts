import crypto from 'crypto';

export const GITHUB_OAUTH_COOKIE = 'df_github_backup_token';
export const GITHUB_OAUTH_STATE_COOKIE = 'df_github_backup_state';
export const GITHUB_OAUTH_PKCE_COOKIE = 'df_github_backup_pkce';
export const BACKUP_REPO_NAME = 'dragonfruit-backups';
export const BACKUP_REPO_PREFIX = 'dragonfruit-backups';
export const BACKUP_FILE_PATH = 'dragonfruit-backups/state.json';
export const BACKUP_HISTORY_DIR = 'dragonfruit-backups/history';
export const BACKUP_README_PATH = 'README.md';

const BACKUP_README_MARKER = '<!-- dragonfruit-backups-readme:v1 -->';
const BACKUP_README_CONTENT = `# DragonFruit Backups Repository

${BACKUP_README_MARKER}

> [!WARNING]
> **Do not manually edit or delete files in this repository unless you fully understand the recovery implications.**
>
> DragonFruit uses this repository as machine-managed backup storage. Manual edits can corrupt backup history or cause restore/sync conflicts.

## What this repository is

This private repository stores backup snapshots created by DragonFruit for settings/profile recovery and cross-device sync.

## What you should not do

- Do **not** manually edit dragonfruit-backups/state.json.
- Do **not** rename or move backup files.
- Do **not** force-push history rewrites unless you are intentionally resetting all backup history.

## Consequences of deletion or destructive changes

- If this repository is deleted, your remote DragonFruit backups are permanently lost unless you have another copy.
- If backup files are manually modified, DragonFruit may detect conflicts, fail sync, or restore malformed data.
- If commit history is rewritten, expected backup continuity is broken and conflict resolution may become unreliable.

## Safe actions

- Keep this repository private.
- Let DragonFruit manage file updates.
- If something looks wrong, use DragonFruit's backup conflict tools instead of editing files manually.

## Need to reset backups intentionally?

If you intentionally want a clean slate, do it from DragonFruit controls (or by creating a fresh backup repository and reconnecting) rather than editing backup files directly.
`;

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_API_BASE = 'https://api.github.com';
const OAUTH_SCOPES = ['repo', 'read:user'];

const COOKIE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const OAUTH_STATE_TTL_SECONDS = 60 * 10; // 10 minutes

type OctokitUser = {
  login: string;
  name: string | null;
  avatar_url: string;
};

type GithubContentResponse = {
  sha: string;
  content: string;
  encoding: 'base64';
};

type GithubContentListEntry = {
  name: string;
  path: string;
  sha: string;
  type: 'file' | 'dir';
};

export type BackupSnapshot = {
  version: number;
  updatedAt: string;
  clientId: string;
  localStorage: Record<string, string>;
  profiles?: unknown;
};

export type BackupDocument = {
  source: 'dragonfruit';
  schemaVersion: 1;
  updatedAt: string;
  snapshot: BackupSnapshot;
};

export type BackupHistoryEntry = {
  id: string;
  path: string;
  sha: string;
  createdAt: string;
};

function isPlaceholderEnv(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return true;

  return (
    normalized.includes('your_github_oauth_client_id')
    || normalized.includes('your_github_oauth_client_secret')
    || normalized.includes('replace_with')
    || normalized.includes('changeme')
    || normalized.includes('example')
  );
}

export function getGithubEnv() {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID?.trim() ?? '';
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET?.trim() ?? '';
  const redirectUri = process.env.GITHUB_OAUTH_REDIRECT_URI?.trim() ?? '';
  const cookieSecret = process.env.BACKUP_COOKIE_SECRET?.trim() ?? '';

  const hasRealClientId = clientId.length > 0 && !isPlaceholderEnv(clientId);
  const hasRealClientSecret = clientSecret.length > 0 && !isPlaceholderEnv(clientSecret);
  const hasRealCookieSecret = cookieSecret.length >= 32 && !isPlaceholderEnv(cookieSecret);
  const hasRealRedirectUri = (() => {
    if (!redirectUri || isPlaceholderEnv(redirectUri)) return false;
    try {
      const parsed = new URL(redirectUri);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  })();

  return {
    clientId,
    clientSecret,
    redirectUri,
    cookieSecret,
    configured: hasRealClientId && hasRealClientSecret && hasRealRedirectUri && hasRealCookieSecret,
  };
}

export function resolveGithubRedirectUri(origin: string, configuredRedirectUri?: string): string | null {
  void origin;
  if (!configuredRedirectUri) {
    return null;
  }

  try {
    const configured = new URL(configuredRedirectUri);
    return configured.toString();
  } catch {
    return null;
  }
}

export function generatePkceVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function generatePkceChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier, 'utf8').digest('base64url');
}

type OAuthStatePayload = {
  n: string;
  v: string;
  t: number;
};

function signStatePayload(payloadB64: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

export function createSignedOAuthState(secret: string, pkceVerifier: string): string {
  const payload: OAuthStatePayload = {
    n: crypto.randomBytes(18).toString('base64url'),
    v: pkceVerifier,
    t: Date.now(),
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = signStatePayload(payloadB64, secret);
  return `${payloadB64}.${sig}`;
}

export function parseSignedOAuthState(state: string, secret: string): { valid: boolean; pkceVerifier?: string; reason?: string } {
  const parts = state.split('.');
  if (parts.length !== 2) return { valid: false, reason: 'state_format' };

  const [payloadB64, sigB64] = parts;
  const expected = signStatePayload(payloadB64, secret);
  const providedSig = Buffer.from(sigB64);
  const expectedSig = Buffer.from(expected);
  if (providedSig.length !== expectedSig.length) {
    return { valid: false, reason: 'state_signature' };
  }

  const sigOk = crypto.timingSafeEqual(providedSig, expectedSig);
  if (!sigOk) return { valid: false, reason: 'state_signature' };

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as OAuthStatePayload;
    if (!payload?.v || !payload?.t) return { valid: false, reason: 'state_payload' };

    const ageMs = Date.now() - payload.t;
    if (ageMs < 0 || ageMs > OAUTH_STATE_TTL_SECONDS * 1000) {
      return { valid: false, reason: 'state_expired' };
    }

    return { valid: true, pkceVerifier: payload.v };
  } catch {
    return { valid: false, reason: 'state_parse' };
  }
}

function toBase64Url(value: Buffer): string {
  return value.toString('base64url');
}

function fromBase64Url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

function deriveKey(secret: string): Buffer {
  return crypto.createHash('sha256').update(secret).digest();
}

export function encryptToken(token: string, secret: string): string {
  const iv = crypto.randomBytes(12);
  const key = deriveKey(secret);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${toBase64Url(iv)}.${toBase64Url(authTag)}.${toBase64Url(ciphertext)}`;
}

export function decryptToken(value: string, secret: string): string | null {
  const parts = value.split('.');
  if (parts.length !== 3) return null;

  try {
    const [ivB64, authTagB64, payloadB64] = parts;
    const iv = fromBase64Url(ivB64);
    const authTag = fromBase64Url(authTagB64);
    const payload = fromBase64Url(payloadB64);

    const key = deriveKey(secret);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const clear = Buffer.concat([decipher.update(payload), decipher.final()]);
    return clear.toString('utf8');
  } catch {
    return null;
  }
}

export function buildGithubAuthUrl(args: {
  clientId: string;
  redirectUri?: string;
  state: string;
  codeChallenge?: string;
  prompt?: 'select_account';
}): string {
  const url = new URL(GITHUB_AUTHORIZE_URL);
  url.searchParams.set('client_id', args.clientId);
  if (args.redirectUri) {
    url.searchParams.set('redirect_uri', args.redirectUri);
  }
  url.searchParams.set('scope', OAUTH_SCOPES.join(' '));
  url.searchParams.set('state', args.state);

  if (args.codeChallenge) {
    url.searchParams.set('code_challenge', args.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }

  if (args.prompt) {
    url.searchParams.set('prompt', args.prompt);
  }

  url.searchParams.set('allow_signup', 'true');
  return url.toString();
}

export async function exchangeGithubCodeForAccessToken(args: {
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
  code: string;
  codeVerifier?: string;
}): Promise<string> {
  const body: Record<string, string> = {
    client_id: args.clientId,
    client_secret: args.clientSecret,
    code: args.code,
  };

  if (args.redirectUri) {
    body.redirect_uri = args.redirectUri;
  }

  if (args.codeVerifier) {
    body.code_verifier = args.codeVerifier;
  }

  const response = await fetch(GITHUB_ACCESS_TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => null) as { access_token?: string; error_description?: string } | null;
  if (!response.ok || !payload?.access_token) {
    throw new Error(payload?.error_description || `GitHub token exchange failed (HTTP ${response.status})`);
  }

  return payload.access_token;
}

async function githubRequest<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${GITHUB_API_BASE}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'DragonFruit-Backups',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    const payload = await response.text().catch(() => '');
    throw new Error(`GitHub API ${path} failed (${response.status}): ${payload}`);
  }

  return response.json() as Promise<T>;
}

export async function getGithubViewer(token: string): Promise<OctokitUser> {
  return githubRequest<OctokitUser>(token, '/user');
}

export async function getRepoIfExists(token: string, owner: string, repo: string): Promise<{ exists: boolean; private?: boolean }> {
  const response = await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'DragonFruit-Backups',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    cache: 'no-store',
  });

  if (response.status === 404) return { exists: false };
  if (!response.ok) {
    const payload = await response.text().catch(() => '');
    throw new Error(`Failed to check repository (${response.status}): ${payload}`);
  }

  const payload = await response.json().catch(() => null) as { private?: boolean } | null;
  return { exists: true, private: payload?.private === true };
}

export function normalizeBackupRepoName(input?: string | null): string {
  const raw = (input ?? '').trim().toLowerCase();
  if (!raw) return BACKUP_REPO_NAME;

  const normalized = raw
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!normalized) return BACKUP_REPO_NAME;
  if (!normalized.startsWith(BACKUP_REPO_PREFIX)) return BACKUP_REPO_NAME;

  return normalized.slice(0, 100);
}

export async function suggestNextBackupRepoName(token: string, owner: string, base = BACKUP_REPO_PREFIX): Promise<string> {
  for (let index = 1; index <= 50; index += 1) {
    const candidate = `${base}-${index}`;
    const check = await getRepoIfExists(token, owner, candidate);
    if (!check.exists) return candidate;
  }

  return `${base}-${Date.now()}`;
}

export async function ensurePrivateBackupRepo(token: string, repoName = BACKUP_REPO_NAME): Promise<void> {
  const viewer = await getGithubViewer(token);
  const repo = await getRepoIfExists(token, viewer.login, repoName);
  if (!repo.exists) {
    await githubRequest(token, '/user/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: repoName,
        private: true,
        auto_init: true,
        description: 'Encrypted-ish DragonFruit settings and profile backups.',
      }),
    });
  }

  await ensureBackupRepositoryReadme(token, viewer.login, repoName);
}

async function getRepositoryTextFile(args: {
  token: string;
  owner: string;
  repo: string;
  filePath: string;
}): Promise<{ sha: string | null; text: string | null }> {
  const encodedPath = encodeURIComponent(args.filePath);
  const response = await fetch(`${GITHUB_API_BASE}/repos/${args.owner}/${args.repo}/contents/${encodedPath}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${args.token}`,
      'User-Agent': 'DragonFruit-Backups',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    cache: 'no-store',
  });

  if (response.status === 404) {
    return { sha: null, text: null };
  }

  if (!response.ok) {
    const payload = await response.text().catch(() => '');
    throw new Error(`Failed to fetch repository file ${args.filePath} (${response.status}): ${payload}`);
  }

  const payload = await response.json().catch(() => null) as GithubContentResponse | null;
  if (!payload?.content || payload.encoding !== 'base64') {
    return { sha: payload?.sha ?? null, text: null };
  }

  const text = Buffer.from(payload.content.replace(/\n/g, ''), 'base64').toString('utf8');
  return { sha: payload.sha, text };
}

async function ensureBackupRepositoryReadme(token: string, owner: string, repo: string): Promise<void> {
  const existing = await getRepositoryTextFile({ token, owner, repo, filePath: BACKUP_README_PATH });
  const alreadyManaged = existing.text?.includes(BACKUP_README_MARKER) ?? false;
  if (alreadyManaged) {
    return;
  }

  await githubRequest(token, `/repos/${owner}/${repo}/contents/${encodeURIComponent(BACKUP_README_PATH)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'docs: add DragonFruit backup repository warning README',
      content: Buffer.from(BACKUP_README_CONTENT, 'utf8').toString('base64'),
      sha: existing.sha ?? undefined,
    }),
  });
}

export function isValidBackupHistoryId(id: string): boolean {
  return /^[0-9]{13}$/.test(id);
}

export function backupHistoryFilePath(id: string): string {
  return `${BACKUP_HISTORY_DIR}/${id}.json`;
}

function createBackupHistoryId(): string {
  return String(Date.now());
}

export async function writeBackupHistoryDocument(args: {
  token: string;
  owner: string;
  repo: string;
  document: BackupDocument;
  historyId?: string;
}): Promise<{ historyId: string; filePath: string }> {
  const historyId = args.historyId ?? createBackupHistoryId();
  const filePath = backupHistoryFilePath(historyId);

  await upsertBackupDocument({
    token: args.token,
    owner: args.owner,
    repo: args.repo,
    filePath,
    document: args.document,
  });

  return { historyId, filePath };
}

export async function listBackupHistory(args: {
  token: string;
  owner: string;
  repo: string;
}): Promise<BackupHistoryEntry[]> {
  const encodedPath = encodeURIComponent(BACKUP_HISTORY_DIR);
  const response = await fetch(`${GITHUB_API_BASE}/repos/${args.owner}/${args.repo}/contents/${encodedPath}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${args.token}`,
      'User-Agent': 'DragonFruit-Backups',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    cache: 'no-store',
  });

  if (response.status === 404) {
    return [];
  }

  if (!response.ok) {
    const payload = await response.text().catch(() => '');
    throw new Error(`Failed to list backup history (${response.status}): ${payload}`);
  }

  const payload = await response.json().catch(() => null) as GithubContentListEntry[] | null;
  if (!Array.isArray(payload)) {
    return [];
  }

  const entries = payload
    .filter((entry) => entry.type === 'file' && entry.name.endsWith('.json'))
    .map((entry) => {
      const id = entry.name.replace(/\.json$/i, '');
      if (!isValidBackupHistoryId(id)) return null;

      const createdAt = new Date(Number(id)).toISOString();
      return {
        id,
        path: entry.path,
        sha: entry.sha,
        createdAt,
      } satisfies BackupHistoryEntry;
    })
    .filter((entry): entry is BackupHistoryEntry => entry !== null)
    .sort((a, b) => Number(b.id) - Number(a.id));

  return entries;
}

export async function deleteRepositoryFile(args: {
  token: string;
  owner: string;
  repo: string;
  filePath: string;
  sha: string;
  message: string;
}): Promise<void> {
  const encodedPath = encodeURIComponent(args.filePath);
  await githubRequest(args.token, `/repos/${args.owner}/${args.repo}/contents/${encodedPath}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: args.message,
      sha: args.sha,
    }),
  });
}

export async function getBackupDocument(token: string, owner: string, repo: string, filePath = BACKUP_FILE_PATH): Promise<{ document: BackupDocument | null; sha: string | null }> {
  const encodedPath = encodeURIComponent(filePath);
  const response = await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${encodedPath}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'DragonFruit-Backups',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    cache: 'no-store',
  });

  if (response.status === 404) {
    return { document: null, sha: null };
  }

  if (!response.ok) {
    const payload = await response.text().catch(() => '');
    throw new Error(`Failed to fetch backup file (${response.status}): ${payload}`);
  }

  const payload = await response.json().catch(() => null) as GithubContentResponse | null;
  if (!payload?.content || payload.encoding !== 'base64') {
    return { document: null, sha: payload?.sha ?? null };
  }

  const raw = Buffer.from(payload.content.replace(/\n/g, ''), 'base64').toString('utf8');
  try {
    const parsed = JSON.parse(raw) as BackupDocument;
    if (parsed?.source !== 'dragonfruit' || parsed?.schemaVersion !== 1 || !parsed.snapshot) {
      return { document: null, sha: payload.sha };
    }
    return { document: parsed, sha: payload.sha };
  } catch {
    return { document: null, sha: payload.sha };
  }
}

export async function upsertBackupDocument(args: {
  token: string;
  owner: string;
  repo: string;
  filePath?: string;
  document: BackupDocument;
  sha?: string | null;
}): Promise<void> {
  const filePath = args.filePath ?? BACKUP_FILE_PATH;
  const encodedPath = encodeURIComponent(filePath);
  const content = Buffer.from(JSON.stringify(args.document, null, 2), 'utf8').toString('base64');

  await githubRequest(args.token, `/repos/${args.owner}/${args.repo}/contents/${encodedPath}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `backup: ${new Date().toISOString()}`,
      content,
      sha: args.sha ?? undefined,
    }),
  });
}

export function isRemoteNewer(remoteUpdatedAt: string | undefined, localUpdatedAt: string | undefined): boolean {
  if (!remoteUpdatedAt) return false;
  if (!localUpdatedAt) return true;

  const remoteTs = Date.parse(remoteUpdatedAt);
  const localTs = Date.parse(localUpdatedAt);

  if (!Number.isFinite(remoteTs)) return false;
  if (!Number.isFinite(localTs)) return true;

  return remoteTs > localTs;
}

export const backupCookieConfig = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
  maxAge: COOKIE_TTL_SECONDS,
};

export const oauthStateCookieConfig = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
  maxAge: OAUTH_STATE_TTL_SECONDS,
};
