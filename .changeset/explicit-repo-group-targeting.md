---
'group-service': minor
---

Apps now name the target group with an explicit `repo` field instead of overloading the service-auth token's audience.

**Affects:** Client app developers, Operators

**Client app developers:** group-scoped methods take a `repo` field (a handle or DID) naming the target group, with the JWT `aud` set to the service DID — the shape a stock `@atproto/api` client already emits. The old form (group in `aud`, no `repo`) still works but is deprecated.

|                    | Legacy (deprecated)          | New (supported)     |
| ------------------ | ---------------------------- | ------------------- |
| Group named by     | JWT `aud`                    | explicit `repo`     |
| JWT `aud`          | the **group** DID            | the **service** DID |
| `repo` field       | absent                       | present             |
| Deprecation header | `Deprecation: true` + `Link` | none                |

- **Where `repo` goes:** body for the JSON procedures (`createRecord`, `putRecord`, `deleteRecord`, `member.add`, `member.remove`, `role.set`); querystring for queries (`member.list`, `audit.query`) and raw/body-less methods (`repo.uploadBlob`, `group.destroy`).
- **Migrating off the legacy path:** set `aud` = the service DID and send `repo` **together** — they are not independently switchable. For queries, sending `repo` on the querystring while `aud` is still the group DID is rejected with `401 jwt audience does not match service did` (a half-migrated call is a hard error, not a silently-accepted one); the call succeeds only with `repo` **and** `aud` = service DID. For JSON-body procedures the verifier decides legacy-vs-new from `aud` alone (the body is parsed later), so the lever is `aud` = service DID. The fully legacy form (`aud` = group DID, no `repo`) keeps working and carries RFC 8594 `Deprecation: true` + a `Link` header; no `Sunset` date is set yet.
- **The service DID** for `aud` is `did:web:<service-host>`, derived from the service URL (no lookup); discover it from a group's `certified_group` DID-document entry if you only hold the `groupDid`.
- **Both direct and proxied calls can migrate.** Direct: mint `aud` = the service DID yourself. Proxied: target the service DID — `withProxy('certified_group_service', cgsServiceDid)` — so the PDS mints `aud` = the service DID; the service now publishes a resolvable `did:web` document at `/.well-known/did.json` so the PDS can resolve it (#29). The legacy `withProxy('certified_group', groupDid)` stays on the deprecated `aud` = group DID form.
- **Behaviour change:** `repo` is now the group selector, not a cross-check — the old `403` "repo field must match the group DID" is gone; a `repo` naming no registered group returns `401 Unknown group`. RBAC is unchanged: you can only target groups you have a role in.
- Full migration reference (service-DID derivation, per-method `repo` placement, direct vs proxied, detecting un-migrated calls): `docs/aud-migration.md`. Design rationale and security analysis: `docs/design/aud-deprecation.md`.

**Operators:** no new environment variables and no migration; `SERVICE_DID` is unchanged. The service now serves its `did:web` document at `GET /.well-known/did.json` (a public, unauthenticated route, sibling to `/health`) so the service DID resolves and service proxying can target it (#29) — ensure any proxy/CDN in front of the service does not block `/.well-known/`. A rate-limited `warn` log flags any client still on the legacy form — one line per caller per 15 minutes.
