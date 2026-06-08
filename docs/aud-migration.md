# Migrating group targeting: legacy `aud` → explicit `repo` (#27)

The group a request targets used to be read from the JWT `aud` claim — a misuse of
`aud`, whose [RFC 7519](https://www.rfc-editor.org/rfc/rfc7519) meaning is the
**service** receiving the token, not the resource acted on. That overload is now
**deprecated** ([#27](https://github.com/hypercerts-org/certified-group-service/issues/27)).
Both forms are accepted during the migration window.

This is the canonical migration reference. The [integration guide](./integration-guide.md)
and [API reference](./api-reference.md) link here; for the design rationale (why
`repo` is unsigned, the resolution round-trip, security analysis) see
[`design/aud-deprecation.md`](./design/aud-deprecation.md).

## The two forms at a glance

|                    | Legacy (deprecated)          | New (supported)                                        |
| ------------------ | ---------------------------- | ------------------------------------------------------ |
| Group named by     | JWT `aud`                    | explicit `repo`                                        |
| JWT `aud`          | the **group** DID            | the **service** DID                                    |
| `repo` field       | absent                       | present (querystring for queries, body for procedures) |
| Deprecation header | `Deprecation: true` + `Link` | none                                                   |

A request must be **fully** one form or the other; a half-migrated mix is rejected
(see [Migrate `repo` and `aud` together](#migrate-repo-and-aud-together)).

## The service DID

The new form sets `aud` to the **service DID**. Finding it is part of calling the
service at all (not specific to this migration): resolve the group's DID document,
read its `certified_group` service entry for the service URL, and derive
`did:web:<host>` from that URL's host. See
[Determining the service DID](./api-reference.md#determining-the-service-did) for
the steps.

Set the result as `aud`.

## Where `repo` goes

`repo` is an `at-identifier` (a handle **or** a DID), resolved to the group DID
server-side. Its location is fixed by atproto's method-kind convention:

- **Query methods** (`member.list`, `audit.query`) and **raw / body-less methods**
  (`repo.uploadBlob`, `group.destroy`): on the **querystring** (`?repo=<handle-or-did>`).
  A query has no request body (an atproto `query` declares no `input` schema), so the
  querystring is the only place a stock SDK can put it.
- **JSON-body procedures** (`createRecord`, `putRecord`, `deleteRecord`, `member.add`,
  `member.remove`, `role.set`): in the request **body**. A typed SDK procedure call has
  no way to add a querystring param, so the body is the only place.

A `repo` that names no registered group is rejected with `401 Unknown group`; a handle
that does not resolve, with `401 Could not resolve repo to a DID`.

## Migrate `repo` and `aud` together

A request is either fully legacy (`aud` = group DID, no `repo`) or fully new
(`aud` = service DID, with `repo`). The mix is **not** a graceful in-between — it is
rejected. The service decides this at the **auth layer**, which sees the querystring
but not the request body (auth runs before body parsing), so the rule differs by kind:

- **Queries** (and `uploadBlob` / `destroy`): the verifier sees `repo`, and when it is
  present it **requires** `aud` = the service DID. Sending `repo` while `aud` is still
  the group DID is rejected with `401 jwt audience does not match service did`. You
  cannot "add `repo` now, fix `aud` later" — change both at once.
- **JSON-body procedures**: the body `repo` is invisible at auth time, so the verifier
  decides purely on `aud`. Setting `aud` = the service DID takes the call off the legacy
  path; the handler then reads the body `repo` as the group selector. (A token with
  `aud` = group DID is treated as legacy regardless of a body `repo`.)

In all cases, the reliable way off the deprecated path is to mint `aud` = the service
DID (and, for queries, send `repo` in the same call — never one without the other).

## Non-proxied vs. proxied calls

A client reaches the service one of two ways (the user's PDS signs the token in
**both**; they differ in who chooses `aud` and who sends the final request):

- **Non-proxied call** — the client fetches a service-auth token from the user's
  PDS (`getServiceAuth`) and sends the request to the group service itself.
- **Proxied call** — the client sends the request to its PDS with an
  `atproto-proxy` header; the PDS forwards it. The standard AT Protocol pattern.

Both can fully migrate:

- **Non-proxied** — fetch the token with `getServiceAuth({ aud: cgsServiceDid, lxm })`,
  then send the request to the group service with that token and `repo`. Fully
  supported and covered by the live e2e suite.
- **Proxied** — proxy to the **service** DID:
  `agent.withProxy('certified_group_service', cgsServiceDid)`. The proxy id
  (`certified_group_service`) must match the service entry in the **service's** own
  DID document; the user's PDS resolves that document (the service publishes it at
  `/.well-known/did.json`), mints `aud` = the service DID, and forwards. The legacy
  `withProxy('certified_group', groupDid)` targets the **group** DID instead, whose
  document advertises the `certified_group` entry, so the PDS mints `aud` = the group
  DID — the deprecated form.

The two proxy ids differ by design: `certified_group` marks a **group's** document,
`certified_group_service` the **service's** own.

**`aud` delivery under proxying.** The supported `aud` arrives **bare**
(`did:web:<host>`) — that is what a PDS emits, because `getServiceAuth`'s `aud` is
lexicon-typed as a bare DID and the reference PDS strips the service-id fragment when
proxying. The service also accepts the fragment-qualified form
(`did:web:<host>#certified_group_service`) for forward-compatibility with the planned
change where PDSs stop stripping it; a token carrying a _different_ service's fragment
is rejected.

## Detecting un-migrated calls

Every response served via the legacy path carries
[RFC 8594](https://www.rfc-editor.org/rfc/rfc8594) deprecation headers:

```text
Deprecation: true
Link: <https://github.com/hypercerts-org/certified-group-service/issues/27>; rel="deprecation"
```

There is no `Sunset` header yet — a removal date is undecided. Watch for
`Deprecation: true` on your responses to find calls still on the legacy form. The
legacy form keeps working for now and will be removed in a later release once clients
have migrated.
