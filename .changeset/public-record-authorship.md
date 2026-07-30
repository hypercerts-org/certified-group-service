---
'group-service': minor
---

Publish record authorship publicly and interoperably via `app.certified.group.authorship` sidecar records.

Every record created through the service now gets an attribution sidecar written into the group's own repo — in the **same `applyWrites` commit** as the record itself — containing the subject at-uri, the author's DID, an optional `via` API-key ref, and a timestamp. Attribution is therefore readable by any atproto client via plain `com.atproto.repo.getRecord` (deterministic rkey `<collection>:<rkey>`), flows over the firehose, survives CAR exports and migrations, and no longer depends on this service's internal database: `group_record_authors` is demoted to a derived RBAC index, and `group.import` rehydrates it from the repo's sidecars.

Also included:

- The `app.certified.group.authorship` collection is service-managed — direct `createRecord`/`putRecord`/`deleteRecord` calls against it are rejected with `InvalidRequest` (they could forge or erase attribution).
- `deleteRecord` cleans up the subject's sidecar (best-effort, idempotent).
- New operator endpoint `app.certified.group.admin.backfillAuthorship` (HTTP Basic, idempotent) publishes sidecars for records created before this feature, preserving original author and creation time.
- `validate: true` on create paths degrades to the PDS default (validate known lexicons), since the commit-wide flag would reject the sidecar's lexicon; `validate: false` passes through unchanged.

See `docs/design/record-authorship.md` for the full design.
