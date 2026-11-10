# Preview builds and CI permissions

What you can trigger in this repository once you have write access, what each
thing costs, and the one case where you should stop and ask.

## Preview builds

A **preview build** compiles any branch on demand and publishes it as a rolling
`preview_{branch}` prerelease, so a reviewer can download and run an exact
commit. It is not a nightly, it is not on a schedule, and it is not wired to
the auto-updater — see [Releases and channels](releases.md) for how real
releases work.

Previews are built with the `devtools` Cargo feature (`src-tauri/Cargo.toml`,
enabled only in `.github/workflows/build-preview.yml`), so a tester can
right-click the window and choose **Inspect Element** to read the webview
console. On macOS this works below 13.3 too, through a private WebKit
preference. Releases are built without it.

### On a pull request from this repository

Comment `/preview` on the pull request:

```text
/preview
/preview Feature: organic cut          ← optional custom release name
```

The build starts immediately, and the `preview-build` label goes on the pull
request. From then on **every push rebuilds it** once the macOS check passes.
Remove the label to stop.

### On a pull request from a fork

`/preview` will not build it. You get a comment pointing you here instead.

The reason is worth understanding rather than working around: a preview build
runs the branch's own code — `npm ci` lifecycle scripts, `build.rs` scripts,
the whole toolchain — in jobs that hold the updater signing key, the Apple
Developer ID certificate and an Azure Artifact Signing login. Building a branch
is running its code with those secrets in reach.

Once you have **read the diff**, run:

```text
/create-preview-external
```

That resolves the pull request's current head SHA, points `preview/pr-<number>`
at that exact commit, and builds that branch. It imports **one commit**. Later
pushes do not rebuild — you run the command again, which means you look again.
The acknowledgement comment records the SHA that was imported, so anyone can
check afterwards what was actually built.

Preview branches are deleted automatically once their pull request closes.

> [!WARNING]
> **If you are not sure, ask.** If you feel pressured to create a preview, and/or you are not sure if an
> external PR's code is safe, please ask a senior member of the dev team
> before risking our keys.
>
> Nobody will mind the delay. A contributor waiting an extra day for a test
> build costs us nothing; a signing certificate used to sign someone else's
> malware costs us the certificate, every release ever signed with it, and
> the trust of everyone running DragonFruit on macOS.

### What to look for in an external diff

You are not being asked to audit the whole change for correctness — the code
review does that. You are asking one narrower question: **does this branch try
to run something at build time?** In particular:

- new or changed `scripts` in `package.json` (`preinstall`, `postinstall`,
  `prepare`) — these run during `npm ci`
- new or changed `build.rs`, or `[build-dependencies]` in a `Cargo.toml`
- new dependencies pulled from somewhere other than the usual registries, or a
  submodule pointed at an unfamiliar repository
- changes to anything under `.github/`, or to `scripts/`

None of these are automatically suspicious — plugins legitimately add build
scripts. They are the places to slow down and read properly.

## Other things write access lets you trigger

| What | How | What it does |
|------|-----|--------------|
| Preview build | `/preview` comment | Builds the branch, publishes a `preview_{branch}` prerelease |
| External preview | `/create-preview-external` comment | Imports one commit to `preview/pr-N` and builds it |
| Rebuild on every push | `preview-build` label | Same as `/preview`, standing until the label is removed |
| Manual workflow run | Actions tab → *Run workflow* | `build-preview`, `release`, `docs-pages`, `plugin-registry-guardrails`, `warm-rust-cache` |

`/preview` and `/create-preview-external` check your permission when you run
them: repository `write`, `maintain` or `admin`, or membership of the
`@Open-Resin-Alliance/administrators` team. Anyone else gets a polite refusal
comment. Applying the `preview-build` label needs `triage` or above, which is
GitHub's own gate rather than ours.

**`release.yml` is not a preview.** It publishes a real release, and it fires
on a push to `main` or `dev` that touches `package.json`, `src-tauri/`,
`scripts/`, `flatpak/` or the workflow itself — not only when someone dispatches
it by hand. Keep that in mind when merging.

## Why external pull requests get no secrets at all

GitHub does not give repository secrets to a workflow triggered by a
`pull_request` event from a fork. That is deliberate on GitHub's part and we
rely on it: the macOS check that runs on every pull request builds fork code
with no keys and proves the app compiles. Nothing more.

## What gets signed

| Build | Workflow | macOS | Windows |
|---|---|---|---|
| Pull request check (this repo or a fork) | `pr-check-build.yml` | ad-hoc, not notarized | not built |
| `/preview` and `/create-preview-external` | `build-preview.yml` | Developer ID, notarized | Azure Artifact Signing |
| Release and pre-release | `release.yml` | Developer ID, notarized | Azure Artifact Signing |

Apple throttles a team that signs and notarizes too often, and the check runs
on every push to every pull request, so the check never signs (#980). It
rewrites the identity in `src-tauri/tauri.macos.conf.json` to `-` before
building. The rewrite is inlined in the workflow rather than kept in a helper
script: a `pull_request` run takes its workflow from the base branch but checks
out the pull request head, so a branch that predates a helper would fail on a
missing module before it compiled anything.

Ad-hoc rather than unsigned: Tauri skips signing altogether when no identity is
configured, and an unsigned `.app` does not launch on Apple Silicon. Ad-hoc
keeps the bundle loadable on the machine that built it, but a downloaded one
fails Gatekeeper. The check publishes no DMG for that reason; previews build
their own, signed.

Every preview signs and notarizes once per platform, and so does every push to
a pull request carrying the `preview-build` label. Remove the label when you no
longer need a rebuild on each push.

The Windows preview logs in to Azure with the run's OIDC token, whose subject
is the ref the preview was dispatched on: the pull request's base branch. The
federated credential trusts `dev` and `main` (see
[Releases and channels](releases.md)), so a preview of a pull request stacked
on another feature branch fails at the Azure login. Retarget it to `dev`, or
dispatch `build-preview` by hand from `dev`.

A branch that predates the Windows signing overlay (#966) fails the preview
with a message asking to merge `dev` in.
