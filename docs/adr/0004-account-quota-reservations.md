# ADR 0004: Upstream account daily quota reservations

Status: **implemented for ordinary inference; targeted verification, not exhaustive**.

## Context

The existing upstream account `used_today` counter advances after success, not before an outbound attempt. Concurrent requests can both pass candidate filtering, and failed, aborted, or interrupted requests may never be charged. Its legacy reset uses local time and does not establish a reliable UTC accounting day. SIWC accounts are a separate path with separate access control and invocation fencing; this decision does not grant SIWC access or change SIWC quotas.

## Proposed decision

Use a durable, atomic, per-upstream-account, per-UTC-day reservation before **each** outbound provider inference attempt, including a retry after a 401. A limit of zero means unlimited; a positive limit is a hard cap. Failed, cancelled, and uncertain attempts are not refunded. Reserve even for unlimited accounts so changes to the limit during the day cannot create untracked attempts. Resolve invalid or unknown accounting state by refusing dispatch, not by assuming zero usage. Candidate selection is advisory; the atomic claim is authoritative.

A claim must commit durably before starting the provider call. In particular, starting a network call inside an uncommitted claim transaction is unsafe: a later commit failure can roll back the charge after the call was sent. A separate short, cancellation-aware, zero-busy writer fence must recheck account status and credential generation immediately before initiating dispatch, without retrying the callback or an uncertain commit. A committed reservation remains charged if the fence or cancellation prevents dispatch. Test races between claim, credential changes, disablement and dispatch, including separate processes and lock contention. Do not weaken existing SIWC ACL and invocation fencing.

Migration must be additive, transactional and idempotent, preserving legacy rows and history. Existing `used_today`, timestamps and logs do not reliably reveal all earlier attempts; do not claim historical hard-cap accuracy or silently interpret ambiguity as zero. A conservative cutover may block limited legacy accounts for the rest of the migration UTC day, even if their actual usage was lower; an implementation must validate this behavior and document how unlimited legacy accounts and later limit changes are handled. Keep legacy display fields intact unless their revised semantics are explicitly documented and tested. Test restarts, legacy data, UTC midnight, concurrent processes, failures and cancellation.

## Operational prerequisite

An offline cutover is required: drain requests, stop **all** old binaries and writers, verify a backup, migrate, and start only the new version. An old writer can send an unreserved attempt after a one-time migration. This prerequisite is not yet technically enforced; mixed-version operation is unsafe. Compatibility with arbitrary pre-existing or customized schemas remains unverified.

## Alternatives and consequences

Counting only successful usage logs cannot enforce an attempt cap, especially after process crashes. A process-local counter cannot coordinate multiple processes. Refunding ambiguous failures can exceed the cap. Conservative charging and blocking may reduce availability, but favor the requested hard cap over utilization. The proposed two-stage claim/fence adds an additional write acquisition and must be tested under cancellation and contention without blocking the event loop.

## Implementation and limits

`account_daily_reservations` holds one bounded row per account. A transactional one-time migration marks every pre-existing account ambiguous for the cutover UTC day. Unlimited accounts may still dispatch, with attempts counted, but changing such an account to a positive limit blocks it for that day; the next UTC day clears the ambiguity. Legacy `used_today` remains a success-display counter and does not enforce the reservation quota. The system clock must be correct and consistent between processes. A candidate can lose a race after selection and receive a 503 rather than automatically trying another account.

Focused file-backed mock-HTTP tests exercise concurrent processes, 401 retry, migration/restart, prior-day rollover and credential replacement between claim and fence; existing SIWC ACL and writer tests also pass. These do not establish exhaustive correctness under power loss, every schema variant, or every cancellation/lock interleaving.

## Sources

Project implementation: `src/account-pool/manager.ts`, `src/db/repositories/accounts.ts`, `src/upstream/forward-chat.ts`, `src/upstream/account-quota.ts`, `src/db/async-writer.ts`, and `src/upstream/inference.ts`. No upstream source code was copied for this implementation.
