---
name: writing-changesets
description: Create changeset files for changes to the group service that affect end users, client app developers, or operators. Use when adding features, changing configuration, altering the XRPC API or RBAC rules, or any change a downstream consumer needs to adapt to.
---

# Writing Changesets

Create a changeset file to document changes for release that affect
end users, client app developers, or operators.

## When to Use

Add a changeset when making changes that affect anyone consuming or
running the group service:

- Adding, removing, or renaming environment variables
- Changing default behaviour that operators would notice
- Adding, removing, or changing XRPC endpoints, lexicons, request
  or response shapes
- Changing RBAC rules (who can perform which operation), role
  semantics, or authorization requirements
- Changing migration requirements or per-group database behaviour
- Changing default ports, URL schemes, or healthcheck behaviour
- A change a client app integrating against the service would have
  to adapt to

Skip changesets for:

- Internal refactors with no observable behaviour change
- Tests-only changes
- CI / infra / tooling changes that do not affect anyone running or
  consuming the group service
- Docs-only changes (unless they document a new operator-facing or
  developer-facing workflow)
- Changes to `demo/` that do not reflect a change in the service
  itself

If in doubt, add one. An "empty" changeset (intentionally no
release) can be created with `pnpm changeset add --empty` to
document the decision.

## Audiences

Group-service changesets should call out which of the following
audiences a change affects, **listed in this order** — from the
person closest to the running software outward to the person
maintaining it:

- **End users** — members of a group whose records live on the
  group's PDS. Most changes are transparent to them, but changes to
  what they can do with their own records, or to membership/role
  semantics they would observe through a client app, are worth
  mentioning so that operators and app developers can write their
  own release announcements.
- **Client app developers** — people building apps that call the
  group service's XRPC API. They care about endpoints, lexicons,
  request/response shapes, auth requirements (service-auth JWTs,
  nonces), and RBAC errors visible at the HTTP boundary.
- **Operators** — people deploying and running a group service
  instance. They care about environment variables, the configured
  group PDS, migrations, healthchecks, container/Railway config, and
  breaking validation.

List only the audiences that actually need to adapt or will notice
the change. Omit audiences that are not affected.

## Format

The group service is a single-package repository. Changesets is
configured to track the root `group-service` package, so every
changeset has a single frontmatter entry and the resulting CHANGELOG
is a single file at the repo root.

Create a file in `.changeset/` with a descriptive kebab-case name
(e.g. `cross-author-mutation-gate.md`, `profile-edit-admin-only.md`).
Do not use the random name Changesets generates — give it a name
that reflects the change.

```markdown
---
'group-service': minor
---

One-sentence summary in the voice of the final changelog entry.

**Affects:** End users, Client app developers, Operators

Longer explanation with enough concrete detail that each listed audience can adapt their environment or code without reading the PR or source. Use concrete names, values, file paths, and example snippets where applicable. Write the per-audience sections in the same order as the `**Affects:**` line: end users first, then client app developers, then operators.
```

### Frontmatter

The frontmatter is always just `"group-service": <bump>`.

Bump types:

- `patch` — bug fixes, non-breaking internal-behaviour changes that
  downstream consumers can observe.
- `minor` — new features, new config options, additive API changes.
  Also used for breaking changes while `group-service` is still at a
  `0.x.y` version, following the semver-for-0.x convention.
- `major` — breaking changes, only after `group-service` reaches
  `1.0.0`. Avoid for now.

If a single changeset mixes a feature and a bug fix, pick `minor`
(the larger bump wins anyway when aggregated).

### Body structure

Every non-trivial changeset **must** contain, in this order:

1. **Summary sentence** — one physical line, in the voice of the
   final changelog entry (not a commit message).

   **The summary line is read by everyone listed in `**Affects:**`,
   not just the most technical audience.** It is the text that
   appears in the "Who should read this release" block at the top of
   the release section, grouped by audience — so End users, Client
   app developers, and Operators all see the same summary line under
   their own heading. Write the summary in language the **least
   technical listed audience** can understand.

   Concretely: if the changeset affects End users (even as one of
   several audiences), the summary must be written in end-user
   language. Avoid:
   - Acronyms and protocol terms (`DID`, `XRPC`, `JWT`, `NSID`,
     `PLC`, `RBAC`) — spell them out or rephrase.
   - Endpoint, lexicon, and field names (`app.certified.group.member.add`,
     `putAnyRecord`, `role.set`) — the user doesn't know these
     exist.
   - Implementation concepts (`authorship row`, `member index`,
     `nonce cache`) — describe the observable effect instead.

   Technical naming belongs in the per-audience sections further
   down, where a client-app developer or operator reading _their_
   section expects to see exact endpoint and env var names. The
   summary line is not the place for it.

   Examples of the same change written badly and then well:
   - ❌ "Gate `putAnyRecord` / `deleteAnyRecord` behind the admin role."
   - ✅ "Only admins can edit or delete records they didn't create."

   - ❌ "Profile edits use the `putRecord:profile` operation requiring admin."
   - ✅ "Only admins can change the group's profile."

   If the change is purely operator-facing (no End users in the
   `**Affects:**` line), operator language is fine in the summary —
   the only audience reading it is operators.

2. **`**Affects:**` line** — required, comma-separated list of
   audiences from the list above, in that order: End users, Client
   app developers, Operators. Omit audiences that are not affected,
   but never omit the `**Affects:**` line itself — the release
   workflow fails hard if a changeset has no `**Affects:**` line,
   because the "Who should read this release" block generation has
   nothing to aggregate. If a change genuinely affects nobody
   listed, it probably doesn't need a changeset at all.

3. **Per-audience adaptation detail** — one short section per
   affected audience, in the same order as the `**Affects:**` line,
   with concrete names and examples. Use **bold inline audience
   labels** rather than headings to keep generated changelogs
   readable. Inside each per-audience section you can and should use
   exact technical terms that the listed audience will recognise
   (endpoint names, lexicon NSIDs, env var names) — the
   plain-language rule only applies to the summary line above.

   Each paragraph in the changeset body must be **unwrapped**: one
   paragraph per physical line. Do not manually hard-wrap prose
   inside the changeset file. Wrapped source lines get preserved by
   GitHub when release notes are rendered from generated changelog
   bullets, which makes the published notes look awkwardly
   line-broken. Keep prose unwrapped so the rendered release notes
   can wrap naturally.

   **Do not restate the summary in the per-audience sections.** The
   reader has already seen the summary once at the top of the bullet
   and once in the "Who should read this release" block. Per-audience
   sections should **extend** the summary with the information that
   audience specifically needs — not translate it into their
   vocabulary and repeat it.

Do **not** use `##` or `###` markdown headings anywhere in the
changeset body. `@changesets/changelog-github` renders each
changeset as a single bullet: the first line becomes the bullet,
every subsequent line is indented by two spaces to stay inside the
list item. An indented `##` will either break out of the list
(GitHub) or render as literal text (other renderers), mangling the
changelog. Use bold inline labels (`**End users:**`, `**Operators:**`)
instead. Fenced code blocks and nested bullet lists are fine because
they survive the 2-space indent cleanly.

The goal: a reader in one of the listed audiences should be able to
adapt their environment or code **without reading the PR or the
source**. Changesets are not release-note marketing copy — they are
migration instructions.

### What "concrete detail" means

Good adaptation detail includes:

- **Exact env var names** and their accepted values, defaults,
  ranges, and validation errors.
- **Exact endpoint / lexicon NSIDs** and the request/response fields
  that changed.
- **The RBAC operation name** and which role is now required.
- **The error message** that callers or operators will see if they
  hit a new fail-fast path or a denied operation, quoted verbatim.
- **The old behaviour vs the new behaviour**, explicitly, whenever
  defaults change.

Bad (avoid):

- "Various improvements to record handling." — tells the reader
  nothing actionable.
- "Now configurable via env var." — which env var? What values?
- Paraphrased names like "the add-member endpoint" when the actual
  NSID is `app.certified.group.member.add`.

It is fine to reference documentation (e.g. `docs/api-reference.md`,
`.env.example`) for long details, but the changeset itself must
still name the thing and describe the change.

### Depth check: adaptation detail, not architecture detail

Per-audience sections answer "what do I need to do differently" for
that audience. They are **not** PR descriptions or design docs. Even
for a technical audience, keep the focus on the adaptation surface
and resist explaining how the change is implemented.

The bar to clear before including any technical detail in a
per-audience section: **does the reader's adaptation depend on
knowing this?** If they could change their config / code correctly
without it, leave it out.

**Do not reproduce the API reference.** A changeset is a release note,
not endpoint documentation. Name the new/changed endpoint and describe
what it does at a high level, then point to the API reference for the
contract. Do **not** paste full request/response JSON shapes, `curl`
invocations, `Authorization` header formats, field-by-field response
descriptions, or exhaustive error-code tables into a changeset — that
detail belongs in `docs/api-reference.md` and only drifts out of date
when duplicated here. A common failure mode is an "Operators" or
"Client app developers" bullet that reads like a mini API doc; compress
it to the functional summary plus a link. (Env var names, their
defaults/validation, and the observable behaviour change are adaptation
detail and DO belong — the line to cut is the wire-level request/response
mechanics.)

### Structure dense sections as bullets

When a per-audience section has 3+ distinct points (a behaviour
change, a config knob, a fallback condition, a caveat), structure
them as a bullet list under the bold audience label rather than one
wall-of-text paragraph. One short bullet per point is much easier to
scan. Two- or one-point sections can stay as inline prose.

Bullet lists survive the 2-space indent that
`@changesets/changelog-github` applies to changeset body lines, so
they render correctly in the generated `CHANGELOG.md` and on GitHub
release pages.

## Example

```markdown
---
'group-service': minor
---

Only admins can edit or delete records they didn't create.

**Affects:** End users, Client app developers

**End users:** you can still freely edit and delete your own records. Editing or deleting a record created by someone else now requires an admin role; if you're a regular member the action is refused.

**Client app developers:** `putRecord` and `deleteRecord` against a record authored by a different DID now return a `403` unless the caller has the admin role. The admin-only variants are surfaced as the `putAnyRecord` / `deleteAnyRecord` operations in the RBAC layer. Record authorship is immutable, so the original author is preserved even when an admin overwrites a record. Editing the group profile (`app.bsky.actor.profile`, rkey `self`) always requires admin regardless of who created it.
```

## What the `**Affects:**` line feeds

After `changeset version` runs,
`scripts/changelog-audience-summary.mjs` post-processes the
newly-written release section of `CHANGELOG.md`. For every changeset
bullet it reads the `**Affects:**` line, groups summaries by
audience, and prepends a "Who should read this release" block at the
top of the release section. Each summary bullet in the block is a
markdown link to an HTML anchor on the corresponding detailed entry
below, so a reader can click through from their audience to the
specific adaptation instructions.

You do not need to do anything special to feed this — as long as
each changeset has a valid `**Affects:**` line, the block is
generated automatically on release. If a changeset omits the line,
the script fails and the release workflow stops, which is
intentional: it means "forgot to tag your changeset" is a loud,
fixable error, not silently-missing release notes.

## Publishing

See `docs/PUBLISHING.md` for how changesets are consumed at release
time and how the release workflow (manual phase 1 to open the
Release PR, automatic phase 2 to tag + publish the GitHub Release on
Release-PR merge) produces the git tag and GitHub Release.

## Key files

- `.changeset/config.json` — Changesets configuration.
- `.changeset/*.md` — existing changesets are the best reference for
  naming and format.
- `scripts/changelog-audience-summary.mjs` — post-processor that
  reads `**Affects:**` lines and builds the "Who should read this
  release" block.
- `docs/PUBLISHING.md` — full publishing / release workflow guide.
- `.github/workflows/release.yml` — the workflow that consumes
  changesets.
