# Publishing Guide for Maintainers

This document describes how the group service versions itself and
produces release notes using
[Changesets](https://github.com/changesets/changesets) and a GitHub
Actions workflow.

Like the [ePDS](https://github.com/hypercerts-org/ePDS) repository,
**the group service does not publish to any registry** (not npm, not
GitHub Packages). The release workflow is purely version-only: it
bumps the root `group-service` version, generates a changelog,
creates a git tag, and publishes a GitHub Release. The deployable
artifact is the container image built by
`.github/workflows/publish-image.yml`; registry publishing of the
package itself could be added later without changing the authoring
workflow.

## Versioning model

The group service is a single-package repository and is versioned
and released as a **single product**.

Concretely:

- There is one version number, stored in the root `package.json`.
- There is one `CHANGELOG.md`, at the repo root.
- There is one git tag per release, of the form `v<major>.<minor>.<patch>`.
- There is one GitHub Release per tag.
- Every changeset has a single frontmatter entry: `"group-service": minor`
  (or `patch` / `major`).

The `demo/` directory is a standalone example app with its own
`package.json` and is **not** tracked by Changesets — changes to the
demo do not on their own warrant a group-service changeset unless
they reflect an observable change in the service.

## Branch strategy

- **`main` branch**: the only release branch. Releases are tagged
  and GitHub Releases are published from this branch.
- **`feat/*` / `fix/*` branches**: short-lived branches for
  development work, merged into `main` via PR.

There is no beta / prerelease channel yet. If one is needed later,
it can be added following the standard Changesets `pre` mode; the
release workflow already guards against an active prerelease mode
leaking into a stable release.

## Authoring changesets

When you make a change that affects operators running the group
service, client apps building on top of it, or end users of those
apps, add a changeset in the same PR:

```bash
pnpm changeset
```

The CLI will:

1. Detect that there is only one tracked package (`group-service`)
   and bump it automatically without asking which packages changed.
2. Ask for the bump type (`major` / `minor` / `patch`). When
   multiple changesets accumulate, the largest bump wins (one
   `minor` + three `patch` changesets → one `minor` release).
3. Prompt for a short markdown description. Write it in the voice
   of the final changelog entry, not as a commit message — assume
   the reader has never heard of the internal refactor and just
   wants to know what changed for them.
4. Create a randomly-named markdown file in `.changeset/`. Rename
   it to something descriptive (e.g. `cross-author-mutation-gate.md`)
   and commit it as part of your PR.

See the `writing-changesets` skill in
`.claude/skills/writing-changesets/SKILL.md` for the required body
structure (audience header, per-audience adaptation detail) and what
level of concrete detail is expected.

### What deserves a changeset

- New features, behaviour changes, configuration changes, env var
  additions, migration requirements, XRPC/API changes, RBAC or
  authorization changes, new lexicons, developer-workflow changes
  (e.g. a new required build step).
- Bug fixes that a user or operator would notice.

### What does not

- Pure internal refactors with no behaviour change.
- Tests-only changes.
- CI / infrastructure / tooling changes that do not affect anyone
  consuming or running the group service.
- Docs-only changes, unless they document a new developer or
  operator workflow.
- Changes to `demo/` that do not reflect a change in the service
  itself.

If in doubt, add one. An "empty" changeset (intentionally no
release) can be created with `pnpm changeset add --empty` to
document the decision.

### Bump type guide

- **patch** (`0.2.0` → `0.2.1`): bug fixes, internal-behaviour
  changes that users should not notice.
- **minor** (`0.2.0` → `0.3.0`): new features, new configuration
  options, additive API changes.
- **major** (`0.2.0` → `1.0.0`): breaking changes — removed or
  renamed env vars, changed defaults that require operator action,
  removed XRPC endpoints, migration-required database changes. Use
  deliberately; the group service is pre-1.0 so most breaking
  changes can still land as minor, but call them out in the
  changeset body.

## Cutting a release

Releases happen in two phases:

- **Phase 1 (open the Release PR)** is triggered manually by a
  maintainer via `workflow_dispatch`. This gives you control over
  _when_ a release starts collecting changesets into a PR.
- **Phase 2 (tag + publish the GitHub Release)** is triggered
  automatically when the Release PR is merged. No second manual
  click is needed.

1. **Prerequisites (one-time setup):**
   - A release-bot GitHub App must be installed on this repository
     with Contents and Pull requests read/write permissions. Its
     App ID and private key must be stored in the
     `RELEASE_BOT_APP_ID` and `RELEASE_BOT_APP_PRIVATE_KEY`
     repository secrets. This bot is used by the release workflow so
     that its automated "Version Packages" PR can bypass branch
     protection on `main`.
2. **Run the workflow (phase 1 — open the Release PR):**
   - Navigate to the **Release** workflow in the repository's
     Actions tab.
   - Click "Run workflow" and select the `main` branch.
3. **What happens in phase 1:**
   - The workflow checks out the repo using the release-bot app
     token, runs the `build`, `format:check`, `lint`, `typecheck`,
     and `test` pnpm scripts as a fail-fast gate, and then invokes
     `changesets/action`.
   - If there are pending changesets in `.changeset/`, the action
     opens (or updates) a **Release PR** against `main` from the
     `changeset-release/main` branch. This PR applies the pending
     changesets: it bumps the root `group-service` version,
     consumes the changeset files, and updates the root
     `CHANGELOG.md`. After `changeset version` has written the new
     release section, `scripts/changelog-audience-summary.mjs` runs
     as part of `pnpm version-packages` to post-process the section
     — it reads the `**Affects:**` line from each changeset bullet,
     groups summaries by audience (End users → Client app developers
     → Operators), prepends a "Who should read this release" block
     at the top of the section, and injects per-bullet HTML anchors
     so the summary links click through to the detailed entries.
     **If any changeset in the release lacks an `**Affects:**` line
     the script fails and the release workflow stops** — this is
     intentional so that a missed audience tag is surfaced
     immediately rather than becoming silently-missing release
     notes.
   - If there are no pending changesets and the tag is up to date,
     phase 1 is a no-op.
4. **Phase 2 — automatic tag + GitHub Release:**
   - Review and merge the Release PR when you're happy with the
     generated changelog and version number. This is the checkpoint
     where you verify them before they become permanent.
   - When the Release PR (head branch `changeset-release/main`)
     merges into `main`, the workflow re-runs automatically via its
     `pull_request: closed` trigger. There are no pending changesets
     at this point but the git tag is behind the `package.json`
     version, so the action runs `pnpm release` (`changeset tag`),
     creates a `v<version>` git tag, and publishes a single GitHub
     Release whose body is the matching section of `CHANGELOG.md`.
   - The auto-trigger only fires for PRs whose head ref is
     `changeset-release/main`. Merging any other PR into `main` does
     **not** start a release run.
   - You can re-trigger phase 2 manually via `workflow_dispatch` if
     the auto-run failed transiently.

## Validating PRs

The release workflow includes the fail-fast test/lint/build gate,
and the same gate runs on every PR via `.github/workflows/ci.yml`.
`changeset status` is not currently run as a required PR check.
Day-to-day we rely on reviewers noticing when a PR makes a
user/operator-facing change without adding a changeset. A bot-based
changeset-check on PRs may be added later to automate this.

If you discover a merged PR that should have had a changeset but did
not, add the missing changeset as a follow-up PR — the next release
will pick it up.

## Troubleshooting

- **`changeset status` complains that packages have been changed
  without a changeset:** add a changeset (or an empty one) for the
  change you made. Note: this can fire for any commit since the last
  release, not just yours.
- **The Release PR does not appear after running the workflow:**
  check that there are committed changeset files in `.changeset/` on
  `main`, and that the workflow run succeeded past the fail-fast
  gate.
- **The Release PR appears but cannot be merged due to branch
  protection:** verify that the release bot GitHub App is installed
  and that its required-reviewer / required-status-check exemptions
  are configured correctly. The bot's app token is what the workflow
  uses to push the PR branch; merging still requires a human
  reviewer.
- **The workflow fails at `pnpm version-packages` with "changeset
  bullet(s) in the topmost release section have no `**Affects:**`
  line":** one or more changesets in this release are missing the
  required audience header. Find the offending changeset(s) named in
  the error output, add an `**Affects:**` line under the summary
  sentence listing the affected audiences (End users, Client app
  developers, Operators — in that order), commit, and re-run the
  workflow. The `scripts/changelog-audience-summary.mjs`
  post-processor refuses to generate the "Who should read this
  release" block if any entry is untagged.
