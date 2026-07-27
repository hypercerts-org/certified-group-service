# Group lifecycle: register / import / destroy

> Read this file when creating or tearing down a group. It carries the
> choose-which and the traps; full params and request shapes are in
> `docs/integration-guide.md` and `docs/api-reference.md`. All three are
> service-scoped (`aud` = service DID, no `repo` for register/import; `repo` on
> the querystring for destroy).

## register vs import — which to use

- **`app.certified.group.register`** — provisions a **fresh** PDS account and
  seeds the owner. JWT signed by the prospective owner; `iss` must equal
  `ownerDid`. CGS holds a recovery key (credible exit).
- **`app.certified.group.import`** — promotes an **existing** account to a group,
  keeping its DID/handle/repo/history. JWT must be signed by **the account being
  imported** (the grantor), _not_ the owner — an app password alone can't produce
  that signature, so you need an authenticated session for that account plus a
  revocable app password. `ownerDid` is **not** separately authenticated and may
  differ from the imported account — validate it client-side first.

Rule: **import** only when the account already exists and the user wants to keep
its DID/history; otherwise **register**.

Full params:
[integration-guide.md#step-1](https://github.com/hypercerts-org/certified-group-service/blob/main/docs/integration-guide.md#step-1-register-a-group)
/ [#step-1b](https://github.com/hypercerts-org/certified-group-service/blob/main/docs/integration-guide.md#step-1b-alternative-import-an-existing-account).

## destroy — what it does NOT do

`app.certified.group.destroy` (owner-only, `repo` on querystring) drops CGS's
stored credentials, membership, and per-group data. **Trap:** it does **not**
delete the underlying PDS account — the DID/handle/records/blobs persist and stay
publicly readable. Destroy ≠ account deletion; tear the account down separately
if that's the intent.

Destroy is **lossy and irreversible.** More traps:

- **Audit log is dropped with the DB.** Readable via `audit.query` only while
  the group lives; export it first if it matters. The destroy is **not** in the
  group's audit log (deleted in the same step) — only the service's operational
  log.
- **Re-import ≠ resurrection.** The account can be re-imported, but authorship is
  gone: surviving PDS records become unowned, so the first member to `putRecord`
  a known `rkey` becomes its recorded author and can overwrite it.
- **DID doc + app password linger.** For `register`ed groups the `certified_group`
  DID-doc entry stays (route still points at CGS); the PDS app password is not
  revoked (CGS can't). Both are the DID/account controller's job to clean up.

Shape:
[api-reference.md#group-lifecycle](https://github.com/hypercerts-org/certified-group-service/blob/main/docs/api-reference.md#group-lifecycle).
