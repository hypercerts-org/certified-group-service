# Listing a user's groups (cross-group)

> Read this file for "which groups am I in" UI. It carries just the targeting
> quirk; the shape is in `docs/api-reference.md`.

`app.certified.groups.membership.list` (note the **plural** `groups`) is
**service-level**, not group-scoped: it lists every group the authenticated user
belongs to. So `aud` = the **service DID** and there is **no `repo`** (it isn't
about one group). Any authenticated user can list their own memberships.

Shape and response:
[api-reference.md#cross-group-queries](https://github.com/hypercerts-org/certified-group-service/blob/main/docs/api-reference.md#cross-group-queries).
