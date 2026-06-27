# Proxy wiring, reading and writing records (JWT path)

> Read this file when wiring the proxy agent or choosing the NSID to read or
> write a record. It carries the decisions and traps; the full how-to with
> TypeScript is in `docs/integration-guide.md`.

## Your app is server-side; the PDS mints the JWT

Your app runs server-side and does **not** mint service-auth JWTs. It sends XRPC
to the _user's_ PDS with an `atproto-proxy` header; the PDS authenticates the
user, mints the JWT, and forwards to CGS, which writes to the group's PDS.

```
Your app ──proxy header──▶ User's PDS ──service auth──▶ CGS ──▶ Group's PDS
```

**Trap — the proxy target.** Use `withProxy('certified_group_service',
cgsServiceDid)` (supported: mints `aud` = service DID). The older
`withProxy('certified_group', groupDid)` mints `aud` = the **group** DID and
drops you on the deprecated path — see [targeting.md](targeting.md). The two
proxy ids name entries in **different** DID documents; not interchangeable.

Agent setup + loading the custom lexicons (required, or `@atproto/api` won't know
the `app.certified.group.repo.*` NSIDs):
[integration-guide.md#step-2](https://github.com/hypercerts-org/certified-group-service/blob/main/docs/integration-guide.md#step-2-create-a-proxy-agent-with-custom-lexicons).

## Writes use `app.certified.group.repo.*`, never `com.atproto.repo.*`

| Operation   | NSID                                    |
| ----------- | --------------------------------------- |
| Create      | `app.certified.group.repo.createRecord` |
| Update      | `app.certified.group.repo.putRecord`    |
| Delete      | `app.certified.group.repo.deleteRecord` |
| Upload blob | `app.certified.group.repo.uploadBlob`   |

**Why it's not optional:** a PDS handles `com.atproto.repo.createRecord`
**itself** and never proxies it. Only an NSID the PDS doesn't recognise gets
proxied to CGS. So a `com.atproto.repo.*` write through the proxy **never reaches
CGS** — it lands in the wrong repo with no RBAC and no audit entry. (CGS accepts
`com.atproto.repo.*` on non-proxied calls for backwards-compat only.)

## Reads are the opposite — don't route them through CGS

`getRecord` / `listRecords` use **standard** `com.atproto.repo.*`. Group data
lives on a real PDS, which serves reads directly: no RBAC, no custom lexicon, no
CGS. Routing reads through CGS is wrong.

Why the split, with examples:
[integration-guide.md#reading-records](https://github.com/hypercerts-org/certified-group-service/blob/main/docs/integration-guide.md#reading-records).
