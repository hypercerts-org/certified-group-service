---
name: app-development-with-cgs
description: 'Build AT Protocol apps that read and write group-owned records through the Certified Group Service (CGS). Use when an app needs shared, role-gated control of a single atproto account — registering or importing a group, adding/removing members, setting roles, creating/updating/deleting records in the group''s repo, uploading blobs, querying the audit log, or issuing API keys for a backend daemon. Triggers: "group account", "shared atproto repo", "certified group service", "app.certified.group.*", "atproto-proxy to a group", "X-API-Key cgsk_".'
---

# Building apps on the Certified Group Service

You are an agent writing app code against a **Certified Group Service (CGS)**
deployment. CGS puts role-based access control (owner / admin / member) in front
of a single shared atproto account (the "group"), so several people can write to
one repo without sharing its signing key.

This file is a **router**: it makes the first decision (which auth mode) and
points you at the one reference file for your task. Each reference file holds the
decisions and traps for its topic; the canonical request shapes live in the
repo's `docs/` and are linked from there. Read the relevant reference file (and
the `docs/` link it carries) before writing code — don't reconstruct request
shapes from memory.

> Terminology (match it): "group service" (never "GPDS"), "group's PDS" (never
> "group PDS").

## Canonical references in `docs/` (the full how-to, behind the reference files)

All URLs point at `main` and resolve with no CGS checkout present.

- **Integration guide** (primary how-to, working TypeScript):
  https://github.com/hypercerts-org/certified-group-service/blob/main/docs/integration-guide.md
- **API reference** (every NSID, request/response, error, action value):
  https://github.com/hypercerts-org/certified-group-service/blob/main/docs/api-reference.md
- **Architecture** (why proxying, where data lives, trust model):
  https://github.com/hypercerts-org/certified-group-service/blob/main/docs/architecture.md
- **API-key design** (rationale + full scope grammar):
  https://github.com/hypercerts-org/certified-group-service/blob/main/docs/design/api-keys.md
- **`aud` → `repo` migration (#27)** (group-targeting walkthrough):
  https://github.com/hypercerts-org/certified-group-service/blob/main/docs/aud-migration.md
- **`aud` deprecation design** (unsigned `repo`, resolution round-trip, security):
  https://github.com/hypercerts-org/certified-group-service/blob/main/docs/design/aud-deprecation.md

## Decide first: which auth mode

CGS accepts two credential kinds. Pick before writing anything — it selects your
path through the reference files below.

- **Service-auth JWT** (default). Interactive, user-driven actions where a real
  user's DID is the actor. Short-lived (≤ 120s, the nonce window), single-use.
  Almost all app flows, via service proxying. If a human is in the loop and you
  have their OAuth session, use this.
- **API key** (`X-API-Key: cgsk_…`). A **backend daemon** acting repeatedly with
  no user session and no per-request JWT. Member-issued, long-lived, scope-limited.
  If a server runs unattended, use a key → [references/api-keys.md](references/api-keys.md).

## Find your task

| Task                                                                | Read                                                               |
| ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Wire the proxy agent; choose the write NSID; reads vs writes        | [references/proxy-and-records.md](references/proxy-and-records.md) |
| Target a group: where `repo` goes, which `aud` to mint (#27)        | [references/targeting.md](references/targeting.md)                 |
| Create a group (register vs import) or destroy one                  | [references/group-lifecycle.md](references/group-lifecycle.md)     |
| Add/remove members, set roles, query the audit log                  | [references/members-and-roles.md](references/members-and-roles.md) |
| List which groups a user belongs to                                 | [references/cross-group.md](references/cross-group.md)             |
| Backend daemon access via API key (+ the querystring-`repo` gotcha) | [references/api-keys.md](references/api-keys.md)                   |
| Check which version a deployment runs, and what the number means    | [references/versioning.md](references/versioning.md)               |

## Errors that signal a wrong decision

Standard XRPC `{ "error", "message" }`. The ones that mean you took the wrong
path (full list:
[integration-guide.md#error-handling](https://github.com/hypercerts-org/certified-group-service/blob/main/docs/integration-guide.md#error-handling)):

- `Deprecation: true` response header — legacy `aud` targeting. Move to
  service-DID `aud` **and** send `repo` (both together). See
  [references/targeting.md](references/targeting.md).
- `401 jwt audience does not match service did` — half-migrated: you sent `repo`
  on a query but `aud` is still the group DID. Set `aud` = service DID.
- `401 Unknown group` — `repo` named no registered group. Check the handle/DID.
- `401 Could not resolve repo to a DID` — the `repo` handle doesn't resolve at all.
- `401 Missing repo for API-key request` — forgot querystring `repo` on a key
  request. See [references/api-keys.md](references/api-keys.md).
- `403 Forbidden` — caller's role (or key's scope) doesn't permit it; the denial
  is in the audit log. See [references/members-and-roles.md](references/members-and-roles.md).

## A worked example

The repo's `demo/` app is **one** working example of the wiring — OAuth login,
a proxy agent with custom lexicons, the proxy route, group registration. It is a
demo, not a prescribed architecture or the only way to build on CGS; treat it as
a concrete reference for the mechanics, not a blueprint to copy. When unsure how
a piece fits together, read it rather than guessing:
https://github.com/hypercerts-org/certified-group-service/tree/main/demo
