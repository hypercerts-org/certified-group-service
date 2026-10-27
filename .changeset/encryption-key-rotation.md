---
'group-service': minor
---

Operators can now rotate `ENCRYPTION_KEY` without needing to read the current key.

**Affects:** Operators

**Operators:**

- New optional env var `ENCRYPTION_KEY_NEXT` (64 hex characters, must differ from `ENCRYPTION_KEY`). When set, startup re-encrypts every stored app password and recovery key to it in one transaction, logs `Encryption key rotation complete`, and uses it from then on. Restarts with it still set are no-ops.
- To rotate: back up the volume, set `ENCRYPTION_KEY_NEXT` and redeploy, then move the value into `ENCRYPTION_KEY`, remove `ENCRYPTION_KEY_NEXT`, and redeploy. Do not roll back to an earlier build or the old key once the re-key has committed. Full runbook: `docs/deployment.md#rotating-encryption_key`.
- New startup check: with `ENCRYPTION_KEY_NEXT` unset, startup now fails if there are stored app passwords and `ENCRYPTION_KEY` can decrypt none of them (previously the service started and failed per group). To recover from a bad cut-over, put `ENCRYPTION_KEY_NEXT` back and redeploy.
- Rotation does not replace credentials that may already have been decrypted; if the old key and data were both exposed, rotate the groups' app passwords and recovery keys too.
