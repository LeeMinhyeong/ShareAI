# Experimental app-schema 429 stopwatch — prototype only

`AppStopwatch` is an isolated experiment, not connected to routing, a scheduler, HTTP, providers, migrations, or production admission. Each instance observes exactly one fixed account kind and ID. A caller must repeatedly call `check()`; without calls, expiry does not happen. Concurrent checks on one instance are rejected.

A new instance (including after a process restart) starts the full duration again. NULL never expires. SQLite contention and cancellation fail closed; a caller may retry the same instance. The prototype relies on the existing experimental schema validator and cooperating generation writers, a trustworthy local monotonic clock, and no database or VM rollback. It is not an authorization or dispatch fence, and does not claim fairness across accounts or complete verification of arbitrary SQLite schema behavior. A clock that pauses during suspend delays expiry.
