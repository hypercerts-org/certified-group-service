# Design: Importing an existing PDS account as a group

Status: **Draft / proposal**

Tracking issues:

- [HYPER-469 — Add `app.certified.group.import` XRPC to promote an existing PDS
  account into a group](https://linear.app/hypercerts/issue/HYPER-469)
  (the work this doc designs)
- [HYPER-442 — Upgrade existing Bluesky accounts to certified
  groups](https://linear.app/hypercerts/issue/HYPER-442)
  (the product-level feature this primitive serves)
- [HYPER-440 — Account migration from normal atproto/Bluesky account to group
  account](https://linear.app/hypercerts/issue/HYPER-440)
  (the concrete case: Mangaroa Farms already had a Bluesky account)
- [HYPER-453 — ePDS DID cache serves genesis doc without
  `#certified_group`](https://linear.app/hypercerts/issue/HYPER-453)
  (why service proxying is **not currently relied upon** — clients call CGS
  directly, which does not depend on the DID-document service entry)

## Motivation

`app.certified.group.register` **creates** a brand-new account on the group's
PDS and brings it under group-service management in one shot. But some accounts
already exist as ordinary atproto/Bluesky accounts before anyone decides to run
them as a group — Mangaroa Farms ([HYPER-440](https://linear.app/hypercerts/issue/HYPER-440))
is the motivating case. Forcing those owners to create a _second_ account and
abandon the first is poor UX and fragments their identity and history.

`app.certified.group.import` is the sibling primitive: take an account that
already exists and **promote** it to a group, reusing the existing DID, handle,
and repo rather than minting new ones.

## Goals

- An owner can bring an **existing** PDS account under group-service management
  without creating a new account.
- The imported group behaves identically to a registered group for all
  subsequent operations (`member.*`, `role.*`, `repo.*`, `audit.*`): same
  per-group DB, same RBAC, same direct-client access path.
- Reuse `register`'s machinery wherever the two genuinely overlap (input
  validation, owner verification, per-group DB seeding, audit logging,
  credential storage) — **do not** duplicate it.
- Do **not** gate import on something that production does not currently
  depend on. In particular, service proxying (and therefore the
  `#certified_group` DID-document entry) is **not** currently in use — see
  _The DID-document entry_ below — so import must not block on it.

## Non-goals (this iteration)

- The client-side "upgrade" UX in certified-app. Tracked under
  [HYPER-442](https://linear.app/hypercerts/issue/HYPER-442).
- Adding the `#certified_group` DID-document service entry as part of `import`.
  It is neither required for current operation nor possible with the
  credentials `import` accepts — see _The DID-document entry_ below.
- Ownership transfer, multi-owner import, or importing an account that is
  already a group.

---

## The DID-document entry (and why import does not gate on it)

For a registered group, `register` adds a `certified_group` service entry to the
group's DID document. This entry exists to support **service proxying** — a
client doing `agent.withProxy("certified_group", groupDid)` resolves that entry
to find the CGS endpoint.

The thing to be clear about up front: **service proxying is not currently in
use, and `import` must not gate on the DID-document entry.** Two independent
reasons, below. The first is why we _need not_; the second is why we _could
not_ even if we wanted to.

### Service proxying is not currently relied upon

Per [HYPER-453](https://linear.app/hypercerts/issue/HYPER-453), proxied calls
break immediately after `register` because the caller's ePDS DID cache serves
the genesis document (which has only `#atproto_pds`) before the second PLC op
adding `#certified_group` has propagated. The **shipped workaround** was to stop
using service proxying and call CGS directly instead — an approach that has no
dependence on the group's `#certified_group` service entry being resolvable.

So in production today, clients reach CGS **directly**, and nothing in the live
path depends on the group's `#certified_group` entry resolving. A group is fully
functional — `member.*`, `role.*`, `repo.*`, `audit.*` all work — without it.
The entry is forward-looking infrastructure for an eventual proxy path, not a
current operational requirement.

It follows that **`import` must not block on the entry being present.** Gating
import on a DID-document precondition that production does not currently depend
on — and that even `register` does not reliably satisfy at call time (the very
cache race HYPER-453 describes) — would reject perfectly importable accounts for
no operational benefit.

### CGS cannot add the entry for an imported account anyway

Even setting aside the above, CGS _could not_ add the entry as part of `import`,
because of how `register` adds it versus what `import` is given.

`register` controls the account **from genesis**: it calls
`com.atproto.server.createAccount` with a `recoveryKey` it generated
(`src/api/group/register.ts`), so that key lands in the new DID's **rotation key
set**. CGS holds it and can therefore sign a PLC operation itself
(`signPlcOperation`, `src/pds/plc.ts`) to add the entry. An **imported**
account's DID already exists with rotation keys CGS does not hold, so that
genesis trick is unavailable.

The atproto-native fallback — `com.atproto.identity.requestPlcOperationSignature`
then `signPlcOperation` — requires the **`ACCESS_FULL`** auth scope on the PDS:

```ts
// packages/pds/src/auth-scope.ts
export enum AuthScope {
  Access = 'com.atproto.access',
  Refresh = 'com.atproto.refresh',
  AppPass = 'com.atproto.appPass',
  AppPassPrivileged = 'com.atproto.appPassPrivileged',
  ...
}
export const ACCESS_FULL = [AuthScope.Access] as const

// packages/pds/src/api/com/atproto/identity/requestPlcOperationSignature.ts
scopes: ACCESS_FULL,
```

An **app-password** login is issued `AppPass` or `AppPassPrivileged` — **never**
`Access`. `ACCESS_FULL` contains only `AuthScope.Access`. Therefore:

> **An app password categorically cannot trigger a DID-document update.** It
> cannot call `requestPlcOperationSignature`, cannot call `signPlcOperation`,
> and cannot otherwise mutate rotation keys or services.

Since `import`'s premise is "the owner hands CGS an app password", CGS cannot add
the entry. This is a deliberate, correct atproto scope boundary — a delegated app
credential should not be able to rewrite an account's identity document.

### Decision: leave the entry to the owner, out-of-band, if and when proxying matters

`import` neither adds nor requires the `certified_group` entry. The imported
group works today via the direct-client path regardless.

If and when service proxying becomes a real requirement (i.e. HYPER-453 is
resolved and clients move back to a proxy client), the entry is added the only
way it can be for an existing account: **by the owner, out-of-band**, using a
credential that carries `ACCESS_FULL` (the account's full password via their
PDS's email-token PLC flow, or their PDS's UI). The entry to add is the same
shape `register` writes:

```json
"certified_group": {
  "type": "CertifiedGroupService",
  "endpoint": "<the CGS serviceUrl>"
}
```

`import` _may_ resolve the DID document and **log a non-fatal advisory** when the
entry is absent (so operators have a breadcrumb if proxying is later switched
on), but it does not fail the import. There is no `MissingServiceEntry` error.

---

## The procedure

### Lexicon: `app.certified.group.import`

```jsonc
{
  "lexicon": 1,
  "id": "app.certified.group.import",
  "defs": {
    "main": {
      "type": "procedure",
      "description": "Import an existing PDS account as a group. Stores the supplied app password so the service can act on the account's behalf, and seeds the caller as owner. (Does not modify the account's DID document.)",
      "input": {
        "encoding": "application/json",
        "schema": {
          "type": "object",
          "required": ["groupDid", "appPassword", "ownerDid"],
          "properties": {
            "groupDid": {
              "type": "string",
              "format": "did",
              "description": "DID of the existing account to import.",
            },
            "appPassword": {
              "type": "string",
              "description": "An app password for the account, so the service can act on its behalf. Stored encrypted, exactly as supplied; the owner manages its lifecycle and may revoke it.",
            },
            "ownerDid": { "type": "string", "format": "did" },
          },
        },
      },
      "output": {
        "encoding": "application/json",
        "schema": {
          "type": "object",
          "required": ["groupDid", "handle"],
          "properties": {
            "groupDid": { "type": "string", "format": "did" },
            "handle": {
              "type": "string",
              "description": "Handle resolved from the imported account.",
            },
          },
        },
      },
      "errors": [
        { "name": "InvalidRequest" },
        { "name": "InvalidAppPassword" },
        { "name": "GroupAlreadyRegistered" },
      ],
    },
  },
}
```

Notes on the shape, contrasted with `register`:

- **No `handle` input.** The account already has one; we resolve it, we don't
  assign it.
- **No `email` input.** No account is being created, so there is no recovery
  email to set. The owner's existing recovery arrangements are untouched.
- **No `accountPassword` output.** `register` returns the primary password it
  generated for credible exit; `import` generates no such password — the owner
  already holds their own credentials. (See _Credible exit_ below.)
- **`appPassword` is a required input** rather than something CGS mints. This is
  the defining difference from `register`.

### Handler: `src/api/group/import.ts`

Flow, with explicit reuse of existing helpers:

1. **Validate inputs.** `groupDid`, `appPassword`, `ownerDid` all present;
   `ensureValidDid` on `groupDid` and `ownerDid`. (Same validation idiom as
   `register`.)
2. **Verify the caller controls the account being imported.** Use
   `verifyServiceAuth`: it checks `aud === serviceDid`, derives `lxm` from the
   request's own NSID, and applies the same lifetime + nonce-replay checks.
   Require **`iss === groupDid`** — the JWT must be signed by the account being
   imported (the grantor), which an app password alone cannot do. `ownerDid`
   (the grantee) is seeded as supplied and is **not** separately authenticated;
   it may differ from `groupDid`. See the auth-model decision below.
3. **Resolve the account's PDS and authenticate.** An imported account may live
   on a different PDS than `config.groupPdsUrl`, so resolve its
   `#atproto_pds` service endpoint from the account's DID document, via
   `ctx.idResolver` (the `IdResolver` constructed in `src/index.ts` — exposed on
   `AppContext` for this; see below). Then `new AtpAgent({ service:
resolvedPdsUrl })` and `agent.login({ identifier: groupDid, password:
appPassword })`. This is a PDS-local `createSession` against the host PDS
   itself — no entryway involved. A failed login (bad/revoked credential, or
   account not on that PDS) → `InvalidAppPassword`. Success yields the resolved
   `handle`. Store `resolvedPdsUrl` in `groups.pds_url` — `PdsAgentPool` reads it
   back verbatim (`src/pds/agent.ts`), so per-group PDS URLs already work.
4. **Encrypt and store.** `encrypt(appPassword, encryptionKey)` →
   `groups.encrypted_app_password`. Set `groups.encrypted_recovery_key = NULL`
   (column is already nullable, migration `002_recovery_key`). Insert into
   `groups`; catch UNIQUE/PK constraint → `GroupAlreadyRegistered` (same
   `ConflictError` mapping as `register`).
5. **Migrate the per-group DB** — `ctx.groupDbs.migrateGroup(groupDid)`.
6. **Seed the owner** — `ctx.memberIndex.add(groupRaw, groupDid, ownerDid,
'owner', ownerDid)`. Identical to `register`.
7. **Audit-log** the operation as `group.import` (new action string alongside
   `group.register`).
8. **Respond** `{ groupDid, handle }`.

Steps 4–8 are byte-for-byte the back half of `register`. The honest reuse story
is: factor that tail (encrypt-store-migrate-seed-audit) into a shared helper
both handlers call, rather than copy-pasting. Step 1 (input validation) is
shared too. The genuinely new logic is step 3 (resolve the account's PDS + log
in to an existing account) and the _absence_ of account creation and PLC
signing. Step 2 differs from `register` in **which DID the JWT must prove
control of**: `register` requires `iss === ownerDid` (the caller seeds
themselves as owner), whereas `import` requires `iss === groupDid` (the account
being imported authorises its own promotion). See the auth-model decision below.

**Plumbing prerequisite:** `IdResolver` is constructed in `src/index.ts` but is
not currently on `AppContext` (only `AuthVerifier` holds a private reference).
`import` needs DID resolution directly, so expose `idResolver` on `AppContext`
and wire it through `src/index.ts` and the test context helper
(`tests/helpers/mock-server.ts`).

`import` does **not** touch the DID document — no PLC op, no service-entry
verification (see _The DID-document entry_ for why neither is needed nor
possible). It may optionally log a non-fatal advisory if the `certified_group`
entry is absent, but never fails on it.

### App-password handling: store as supplied

CGS stores the app password the owner provides, encrypted, exactly as given —
matching how `PdsAgentPool` already logs in (`identifier: groupDid, password:
<decrypted app password>`). We do **not** try to re-mint our own app password
via `createAppPassword`: that endpoint requires a privileged
(`AppPassPrivileged`) session, and a plain app password may not be able to mint
another, so attempting it would be fragile and is unnecessary. The owner owns
the credential's lifecycle and may revoke it; if they do, proxied calls start
failing with auth errors, which is the correct, observable consequence.

---

## Credible exit for imported groups

Registered groups get a strong credible-exit guarantee: CGS generated the
account's recovery key and stores it (`encrypted_recovery_key`), and returns the
primary `accountPassword` to the owner at registration. The owner can walk away
from the service and still control the account.

Imported groups are **deliberately different**, and the difference must be
stated plainly to owners:

- **CGS holds no recovery key for an imported account.**
  `encrypted_recovery_key` is `NULL`. CGS never had genesis control and the app
  password cannot grant key control.
- **The owner already retains their own credentials** — the full account
  password and whatever recovery key/email their PDS set up when the account was
  created. _That_ is their credible exit, and it is arguably stronger than the
  registered-group story, because it never depended on CGS at all.
- **Exit = revoke the app password.** The owner revokes the app password they
  gave CGS, severing CGS's ability to act on the account. This is an owner-side
  action CGS cannot block, which is the point. (If a `certified_group` service
  entry was ever added for proxying, the owner removes that too — but that is a
  no-op today, since nothing is proxied.)

So imported groups are not _worse_ off for exit; the trust model is just
inverted — control was never delegated to CGS in the first place. The
documentation and client UX must make this explicit so owners understand that,
unlike registered groups, CGS is not a custodian of their account keys.

> This section resolves open question #2 from
> [HYPER-469](https://linear.app/hypercerts/issue/HYPER-469): nothing goes in
> `encrypted_recovery_key`; the owner's pre-existing credentials are the exit.

---

## Schema impact

**None required.** `encrypted_recovery_key` is already nullable
(`src/db/schema.ts`, added by `002_recovery_key`), and `pds_url` is already
per-group. Imported and registered groups share the `groups` table unchanged; an
imported group is simply one with `encrypted_recovery_key IS NULL`.

(If we later want to _distinguish_ imported from registered groups for reporting
or for differing exit messaging, a nullable `origin` column would be the place —
not needed for correctness now, noted as a future option.)

---

## Security considerations

- **No privilege escalation via `import`.** `import` cannot do anything to the
  DID document; the scope boundary that blocks the app password from PLC
  operations is the same boundary that means importing an account grants CGS no
  identity-level control over it. CGS gets exactly what an app password grants:
  repo read/write and proxied XRPC, nothing more.
- **Authenticate the grantor, not the grantee.** Unlike `register` (where the
  caller proves control of `ownerDid` and seeds themselves), `import` requires
  the JWT issuer to be **`groupDid`** — the account being imported authorises its
  own promotion. The seeded `ownerDid` is supplied data, not separately proven.
  This is deliberate: an attacker is the natural beneficiary of any privilege
  escalation, so proving control of the recipient DID is no evidence of
  entitlement; the claim worth gating on is the source's consent, which a
  `groupDid`-signed JWT provides and a leaked app password alone cannot. Handing
  ownership to a different `ownerDid` requires already controlling `groupDid`
  (self-harm, not escalation) and should be sanity-checked client-side. See the
  auth-model decision below.
- **The app password is a stored secret.** It is encrypted at rest with the same
  AES-256-GCM scheme as registered groups' app passwords
  (`src/pds/credentials.ts`). Its blast radius is bounded by the app-password
  scope (no identity control), and the owner can revoke it unilaterally.

---

## Open questions (carried from HYPER-469)

1. **DID-document update** — _resolved._ `import` neither adds nor requires the
   `certified_group` entry: service proxying is not currently relied upon, and
   CGS could not add the entry with an app password anyway (scope boundary,
   proven above). Owner adds it out-of-band if and when proxying matters. See
   _The DID-document entry_.
2. **Credible exit** — _resolved._ No CGS-held recovery key; the owner's own
   pre-existing credentials are the exit. See _Credible exit_.
3. **App-password lifecycle** — _resolved._ Store the supplied app password
   as-is; do not re-mint. Owner-managed, revocable. See _App-password handling_.
4. **Which JWT issuer to validate** — _resolved (option a)._ Require
   `iss === groupDid` (the account being imported signs), **not**
   `iss === ownerDid`. See _Auth model_ below.

### Auth model: validate `iss === groupDid` (the grantor)

The import request names both the account to import (`groupDid`) and the DID to
seed as owner (`ownerDid`). The JWT can only prove control of one signer, so we
had to choose which:

- **Option a (chosen): `iss === groupDid`.** The account being imported signs.
  An app password cannot mint a service-auth JWT, so this proves control of
  `groupDid` beyond merely holding its app password — a leaked app password
  alone cannot drive an import. `ownerDid` is seeded as supplied, unauthenticated.
- **Option b (rejected): `iss === ownerDid`.** The recipient signs; the app
  password becomes the _only_ proof of `groupDid`, which is strictly weaker.

The deciding principle is **authenticate the grantor, not the grantee**: an
attacker is the natural beneficiary of any privilege escalation, so proving you
_want_ ownership is no evidence you are entitled to it. Spend the cryptographic
proof on the source's consent. The only thing option a gives up is a deferred
"platform back-end imports on behalf of the account" flow (a back-end holding
only a stored app password cannot sign as `groupDid`) — but that flow would use
the API-key mechanism, and its premise already implies a prior interactive
`groupDid` login to mint the app password in the first place. Full rationale in
the "CGS account import: UX flows" decision (Notion, Decision log).

Remaining smaller decisions:

- Whether `import` should log a non-fatal advisory when the `certified_group`
  entry is absent, or ignore the DID document entirely (leaning advisory — cheap
  breadcrumb for if/when proxying is switched on).
- Whether to add a nullable `origin` column now or defer (deferred above).

## Acceptance criteria

(Mirrors [HYPER-469](https://linear.app/hypercerts/issue/HYPER-469).)

- New lexicon `lexicons/app/certified/group/import.json`.
- New handler `src/api/group/import.ts`, registered in `src/api/index.ts`,
  sharing the encrypt-store-migrate-seed-audit tail with `register`.
- Tests in `tests/import.test.ts`: successful import, invalid/revoked app
  password, already-registered group, owner seeding, per-group PDS URL
  resolution.
- Docs updated (`docs/api-reference.md`, integration guide), including the
  credible-exit difference.
- Changeset added (per the `writing-changesets` skill).
