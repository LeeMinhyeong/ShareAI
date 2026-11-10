# Today's token aggregate completeness

The admin user-detail and ordinary account-detail `todayStats` retain the numeric
`totalTokens` field for existing clients. It is based on the SQL total of the
persisted rows, bounded to the safe-integer range when oversized or non-finite;
a null total uses the positive safe-integer bound as a sentinel. It is not
necessarily a measured total or a lower bound: legacy and
current ordinary writers can store zero for unknown usage, and invalid stored
values are not corrected. A partial SIWC pair does not contribute to the sum.

The additive `totalTokensComplete` field describes **only the matching persisted
logs** in the current UTC day through the query's captured time. It is true for
no matching rows, or when all matching rows are SIWC records with valid paired
non-negative safe-integer token counts and a safe-integer aggregate. It is false
for unknown, partial, invalid or oversized SIWC usage and whenever any ordinary
row is present, regardless of its value. This conservative treatment does not
classify historical zeros as either measured or unknown. Ordinary account-detail
statistics contain only ordinary records, so their flag is true only if there
are no matching records.

Usage logging is best effort; even a true flag does not guarantee that every
invocation produced a persisted log. Clients must not label a false-flagged sum
as complete. Older clients that ignore the new flag retain their former behavior.
This additive field does not fix ordinary persistence or per-log values; older
writers continue to coerce unknown ordinary usage to zero. Nullable storage
requires a safe schema migration and a deployment/old-writer fencing strategy,
including preservation of unknown legacy provenance and compatible readers.

## Regression fixture status

The regression fixture uses an owned in-memory SQLite database and loads the
production repository and schema through a strict TypeScript VM loader. It does
not create a temporary directory or launch a build process. It includes a
SIWC-only safe-sum boundary and discriminating mutation controls. It does not
verify file-backed persistence, real provider usage, or complete log delivery.
