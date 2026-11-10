# Global UTC usage statistics and optional indexes

The global-today query uses separate binary lexical ranges for the two supported UTC timestamp formats, then retains the strict UTC parser and inclusive captured as-of bound. It works without timestamp indexes; startup does not add them.

**No offline timestamp-index provisioner is supplied.** The synthetic benchmark creates indexes only in an isolated in-memory database; it is not an operator provisioning procedure. Do not infer that adding indexes to a production database is safe from the benchmark alone.

The existing `offline-open-upgrade.mjs` compares strict schema signatures and can reject extra indexes. Any future index provisioning must happen only after the required offline OPEN upgrade, and an indexed schema is currently incompatible with re-running that upgrader. A future provisioner must first address stopped-writer/backup/path attestation, existing initialized schema validation, index collisions, rollback and path safety; it must not automatically upgrade or touch a production database.

For a synthetic measurement, run `node --import tsx scripts/benchmark-usage-global.mjs`. It opens only an in-memory SQLite database, populates 100,000 synthetic rows across 11 actual UTC date buckets (the 10-day offsets can cross midnight), reports the measured per-day counts, and asserts equal results for the prior parser-only query and the new query both without and with indexes. One warmup and 11 timed runs are used for each median. Page-count times page-size estimates database bytes in memory, not production disk usage.

On one local run before the tighter as-of bounds, median milliseconds were 302.43 for parser-only, 52.04 without indexes, and 33.02 with indexes; afterwards, 296.79, 50.82, and 47.37 respectively. Both runs returned 5,681 total and 3,786 successful rows. These single-run, in-memory measurements are noisy, do not establish a speedup from the bound change, and do not predict production workloads, disk costs, or index safety.
