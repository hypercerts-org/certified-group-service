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

- **Behaviour change to adapt to now:** `repo` is the group selector, not a cross-check — the old `403` "repo field must match the group DID" is gone; a `repo` naming no registered group returns `401 Unknown group`. RBAC is unchanged: you can only target groups you have a role in.
- **How to migrate** (per-method `repo` placement, the coupled `repo`+`aud` switch, non-proxied vs proxied calls, detecting un-migrated calls): see **`docs/aud-migration.md`**. Design rationale and security analysis: `docs/design/aud-deprecation.md`.

**Operators:** no new environment variables and no migration; `SERVICE_DID` is unchanged. The service now serves its `did:web` document at `GET /.well-known/did.json` (a public, unauthenticated route, sibling to `/health`); it must be publicly reachable, since that is how the service DID resolves and how service proxying targets the service. A rate-limited `warn` log flags any client still on the legacy form — one line per caller per 15 minutes.
