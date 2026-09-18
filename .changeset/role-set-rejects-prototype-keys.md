---
'group-service': patch
---

A request to change someone's role to something that is not a real role is now always refused.

**Affects:** Client app developers

**Client app developers:** `app.certified.group.role.set` validated its `role` field with a JavaScript `in` check against the role table, which also matches inherited object keys. `role: "toString"` (and any other `Object.prototype` key) therefore passed validation and was written to the member row verbatim, leaving a member with a role no permission check recognises. Such a value is now rejected like any other unknown role, with `400 InvalidRole` and the message `Role must be one of: member, admin, owner`. Valid values (`member`, `admin`) are unaffected, and an existing group that was written a bogus role by the old code keeps it — re-set that member's role to repair the row.
