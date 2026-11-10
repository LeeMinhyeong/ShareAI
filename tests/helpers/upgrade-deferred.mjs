// Shared skip reason for legacy-database upgrade tests deferred by ADR 0018.
// Phase 4 refuses an existing database that lacks the attested safety schema (429 v2, OPEN
// markers) and does not yet provide an enabled upgrade path. Rejection itself stays covered
// (account-429-migration, phase2-quota-migration-safety, phase4-ordinary-attempt-migration,
// phase4-open-marker-integrity); only the upgrade-success paths below are deferred.
export const UPGRADE_DEFERRED = 'deferred (ADR 0018): legacy DB upgrade to the v2/OPEN safety schema is not in Phase 4; see BACKLOG "기존 DB 업그레이드 경로"';
