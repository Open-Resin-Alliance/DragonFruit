# Backups (GitHub Private Repository)

DragonFruit provides a privacy-first backup mechanism that stores backup data in a private GitHub repository owned by the user.

## Overview

- Authentication: GitHub OAuth (user-controlled account)
- Storage location: `dragonfruit-backups` private repository
- Backup file path: `dragonfruit-backups/state.json`
- Data included:
  - Known settings localStorage keys
  - DragonFruit profile storage payloads
  - Additional DragonFruit/app-scoped localStorage keys

## Environment Variables

Set these in `.env`:

- `GITHUB_OAUTH_CLIENT_ID`
- `GITHUB_OAUTH_CLIENT_SECRET`
- `GITHUB_OAUTH_REDIRECT_URI`
- `BACKUP_COOKIE_SECRET` (32+ chars)

### Callback URL guidance

- Register callback URL in your OAuth app settings as:
  - `http://127.0.0.1:3005/api/backups/github/auth/callback` (dev example)
  - `https://your-domain/api/backups/github/auth/callback` (production)
- For local loopback development, using `127.0.0.1` is preferred.
- Use the same host in your browser as your callback host. Example: if callback is `127.0.0.1`, open DragonFruit at `http://127.0.0.1:3005` (not `localhost`).

## Conflict Resolution

When syncing:

- If remote backup is newer than local snapshot, sync returns a conflict.
- UI allows:
  - Restore remote snapshot locally
  - Force-push local snapshot over remote

## API Endpoints

- `GET /api/backups/github/auth/start`
- `GET /api/backups/github/auth/callback`
- `GET /api/backups/github/auth/status`
- `POST /api/backups/github/auth/logout`
- `POST /api/backups/github/repo/ensure`
- `POST /api/backups/github/sync`
