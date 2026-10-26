# Upload Service

Bug reports often need the user's file: a 350 MB STL that GitHub will not
attach, or a paid model whose licence forbids posting it publicly. The upload
service gives the reporter a private place to send it. A developer comments
`/upload` on the issue, a bot replies with a link, and the reporter uploads
through that link without an account. Only developers with an account on the
service can open or download what was uploaded. When the issue is closed the
files are deleted and the link starts answering 404, which tells the reporter
the files are gone.

The service is a stock [FileBrowser Quantum](https://github.com/gtsteffaniak/filebrowser)
instance with nothing patched: its upload-only share links do the work. The
history is in issue #597.

## The pieces

| File | Role |
| ---- | ---- |
| `infra/uploads/compose.yml` | The container: image version, volumes, the loopback port. |
| `infra/uploads/config.yaml` | FileBrowser's config: the `uploads` source, password + enforced TOTP, the public address. |
| `infra/uploads/.env.example` | The values the host must supply. Copied to `.env`, never committed. |
| `.github/uploads/uploads.mjs` | Opens (or reuses) and closes an issue's link through FileBrowser's API. |
| `.github/workflows/uploads.yml` | Runs the script on `/upload` comments and on closed issues, and posts the replies. |

## How it works

Each issue gets the folder `/issues/<number>/` in the `uploads` source and one
share link of type `upload` pointing at it.

- **`/upload`**: a comment starting with `/upload` on an open issue, written by
  someone whose association with the repository is `OWNER`, `MEMBER` or
  `COLLABORATOR`. Comments from anyone else are ignored, so the service only
  takes files the team asked for. The script creates the folder first: the
  browser uploads in chunks, and a chunk cannot land in a missing folder. It
  reuses the issue's link if it has one, so repeating the command posts the
  same address again.
- **Closing the issue**, whichever way it is closed, deletes the link and then
  the folder, and the bot says so in a comment. It stays quiet on issues that
  never had a link.

### What the link allows

Checked against 2.0.2-stable with the link and no account:

| Request | Answer |
| ------- | ------ |
| Upload a file | Allowed. A file whose name is already taken is refused (409). |
| Download, view, preview or stream a file | 501 |
| Read a file's or folder's details | 501 |
| List the folder (`/public/api/resources/items`) | **Allowed: returns the file names**, not their contents. |
| Anything under `/api/` | 401 |
| The link after the issue is closed | 404 (`share hash not found`) |

The file names are the one thing an outsider with the link can learn, and the
bot's comment says so.

### Deleting files by hand

Delete the **share**, not only the folder. A link whose folder is missing
stays alive: a file small enough to go in one chunk (5 MB) recreates the
folder, and a larger one fails with an error. Neither is the 404 the reporter
is told to expect; only a deleted share gives that. Closing the issue deletes
both.

## Running it

The service runs on a small always-on machine. The compose file binds the port
to `127.0.0.1:8080`, so a tunnel or reverse proxy on the same machine has to
publish it over HTTPS.

1. Copy `infra/uploads/` to the machine, then `cp .env.example .env` and fill
   it in. `UPLOADS_EXTERNAL_URL` is the public HTTPS address: FileBrowser
   builds the share links from it.
2. `mkdir data`, owned by UID 1000 (the container's user): the database lives
   there, on local disk. The files go to `UPLOADS_FILES_DIR`, normally a
   folder on a NAS share, which UID 1000 must be able to write.

   Point `UPLOADS_FILES_DIR` at a folder *inside* the share, not at its mount
   point. With the share unmounted that folder does not exist, and the
   container refuses to start instead of filling the local disk. Keep it that
   way: never create the folder on the local disk by hand.
3. `docker compose up -d`, then point the tunnel or proxy at
   `http://127.0.0.1:8080`. The upload page sends 5 MB chunks, well under
   Cloudflare's 100 MB limit per request.
4. Log in as `admin` with `UPLOADS_ADMIN_PASSWORD` and set up TOTP: it is
   enforced for every account.

### Accounts

| Account | Global permissions | On the `uploads` source |
| ------- | ------------------ | ----------------------- |
| `github-bot` | api, share | view, create, delete (no download) |
| A developer | none | view, download |

Set the source permissions after creating the user and check them: the user
API ignores the ones sent with the creation request. Log in once as
`github-bot` to set up its TOTP, then create an API token for it with the
`api` and `share` permissions.

### The GitHub side

| Name | Kind | Value |
| ---- | ---- | ----- |
| `UPLOADS_URL` | Actions variable | The same public address as `UPLOADS_EXTERNAL_URL`. |
| `UPLOADS_TOKEN` | Actions secret | The bot's API token. |

`issue_comment` and `issues` workflows run the copy of the workflow on the
default branch, so `/upload` does nothing until `uploads.yml` and `uploads.mjs`
are on `main`.

## Constraints

- **The bot's token expires** after the number of days chosen when creating it.
  When it does, `/upload` answers that the service didn't answer. Create a new
  token and replace the secret.
- **The stable line has no size limit per link.** Per-share quotas exist in the
  2.1 beta line. Until then, only the team can hand out links, and the disk is
  the limit.
- **Updating** means changing the image tag in `compose.yml` and running
  `docker compose pull && docker compose up -d`. Stay on the `-stable-slim`
  tags: they carry no ffmpeg, which this service never needs.
- Uploaded files are evidence for one issue. Never commit them as fixtures or
  test data.

## Related pages

- [Issue Guts Labels](issue-guts.md), the other workflow that acts on issues.
