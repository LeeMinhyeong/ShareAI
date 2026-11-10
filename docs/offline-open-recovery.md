# Offline OPEN recovery

This is a manual, offline operation; it is never run by application startup. An OPEN fence may represent a request that reached the provider. Clearing it without establishing the external outcome can cause duplicate work, charges, or other effects. **If the outcome or absence of in-flight work cannot be confirmed, do not recover.** There is no automatic expiry or remote verification.

## Before any write

Stop every router and prevent all versions from reconnecting until the operation and verification are complete. Establish from provider-side evidence that no request is in flight and whether the exact attempt completed or never started. Take and verify a consistent SQLite backup, including WAL content (for example, via SQLite's backup API). The flags are operator attestations, not proof of any of these facts. Coordinate external access and protect the database directory and its parents from replacement. The path checks reject missing files, symlinks/junctions and nonregular files and check file identity repeatedly, but opening SQLite by pathname leaves a TOCTOU window; they do not defend against a privileged or concurrent filesystem attacker or unsafe WAL/SHM sidecars. Use a trusted local directory and OS permissions.

Explicitly specify an existing database with `--db`. Never point the command at an unverified target. Run from the repository root. Inspection opens read-only and prints only JSON objects with `kind`, `account_id`, and `attempt_id`; treat even identifiers as sensitive operational metadata. It refuses nonconforming identifiers rather than printing arbitrary stored data.

```sh
node scripts/offline-open-recovery.mjs inspect --db /protected/path/router.db
```

## First-time audit initialization only

An absent audit table and marker cannot distinguish never provisioned from deleted history. Only an operator with independent provenance can make this attestation. **Never use it to recreate a lost or removed audit history**; restore and investigate instead. Partial or conflicting audit objects are refused. This does not clear an OPEN.

```sh
node scripts/offline-open-recovery.mjs initialize-audit --db /protected/path/router.db \
  --audit-never-provisioned --routers-stopped --provider-no-inflight \
  --backup-verified --accept-unverified-remote-evidence
```

## Clear one exact attempt

Use the exact tuple from inspection. `--actor` is a non-sensitive operator identifier, not a credential or free-text explanation; account and actor identifiers allow 1–128 ASCII letters, digits, `_`, `.`, `:`, `-`, starting with a letter or digit. Attempt IDs must be UUID v4. `--reason` must be `REMOTE_COMPLETED` or `REMOTE_NOT_STARTED`, according to independently established evidence. The acceptance flag acknowledges that this tool does not verify remote evidence; it is **not** permission to act on an unknown outcome.

```sh
node scripts/offline-open-recovery.mjs recover --db /protected/path/router.db \
  --kind ordinary --account-id ACCOUNT_ID --attempt-id ATTEMPT_UUID \
  --actor OPERATOR_ID --reason REMOTE_COMPLETED --routers-stopped \
  --provider-no-inflight --backup-verified --accept-unverified-remote-evidence
```

`--kind` is `ordinary` or `siwc`. The command checks the production fence and marker schemas, both singleton version rows, the audit schema and marker, and existing audit rows. A single `BEGIN IMMEDIATE` transaction deletes only the matching account and attempt and appends a `CLEARED` audit row; stale IDs fail. Insert or commit failure rolls back when possible. Cooldowns are not cleared. If commit outcome is uncertain, keep routers stopped and independently inspect database and backup; do not blindly repeat. Inspect again before restarting.

Audit update/delete, replacement of an existing audit ID (including with recursive triggers disabled), and marker modification/deletion are blocked by SQLite triggers, not tamper-proof protection: a database administrator can drop triggers, alter the database, or restore a backup. **Even without removing triggers, another connection with database write access can insert a fabricated, correctly formatted `CLEARED` record under a new ID. An audit row alone therefore does not prove that a recovery occurred.** Protect and export audit records under separate controls. Existing audit schemas without the replacement guard are refused; do not reinitialize them or discard their history. Preserve the database and verified backup and arrange a separately reviewed offline migration before using this version. Schema checks and attestation cannot prove history, backup integrity, provider state, or that routers stay stopped. No secrets, request payloads, or free-text reasons belong in command arguments or audit records.
