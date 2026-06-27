# Targeting a group: `repo` + the `aud` form (#27)

> Read this file when choosing where `repo` goes and which `aud` to mint on the
> JWT path. It carries the rule and the trap; the full migration walkthrough and
> service-DID derivation are in `docs/aud-migration.md`. API-key targeting
> differs — see [api-keys.md](api-keys.md).

## Where `repo` goes (an `at-identifier`: handle or DID)

| Method kind                                                                                           | `repo` location            |
| ----------------------------------------------------------------------------------------------------- | -------------------------- |
| JSON-body procedures (createRecord, putRecord, deleteRecord, member.\*, role.set, keys.create/delete) | **body**                   |
| Queries + raw/body-less (member.list, audit.query, keys.list, uploadBlob, destroy)                    | **querystring** (`?repo=`) |

Unknown group → `401 Unknown group`; handle that doesn't resolve at all →
`401 Could not resolve repo to a DID`.

## The one rule: mint `aud` = service DID, and for queries send `repo` with it

CGS used to read the target group from the JWT `aud`. That's **deprecated but
still accepted**. The trap: **`repo` and `aud` change together** — a half-migrated
mix is _rejected_, not downgraded.

- **Queries / uploadBlob / destroy:** the verifier sees querystring `repo` and
  then **requires** `aud` = service DID. `repo` + group-DID `aud` →
  `401 jwt audience does not match service did`. No "add `repo` now, fix `aud`
  later".
- **JSON-body procedures:** body `repo` is invisible at auth; the verifier decides
  on `aud` alone. `aud` = service DID → supported. Group-DID `aud` is legacy
  regardless of any body `repo`.

Setting `aud`:

- **Non-proxied:** `getServiceAuth({ aud: cgsServiceDid, lxm })` — you choose it.
- **Proxied:** the PDS sets it from the DID you proxy to. Use
  `withProxy('certified_group_service', cgsServiceDid)`. (PDS delivers `aud` bare,
  `did:web:<host>`; CGS also accepts the `#certified_group_service` fragment.)

`Deprecation: true` response header = you're still on the legacy form.

Service-DID derivation, proxied-vs-non-proxied, per-method walkthrough:
[aud-migration.md](https://github.com/hypercerts-org/certified-group-service/blob/main/docs/aud-migration.md).
