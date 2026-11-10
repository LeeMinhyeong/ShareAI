# ADR 0010: Explicit v1 authentication scope boundary (partial)

Status: provisional; not an approval of shutdown safety or Phase 4.

## Decision

The controlled v1 router passes its admission scope directly to the intended authentication endpoint. A separate invocation of the public authentication middleware, even with the same request object, does not consume that scope. Ordinary public authentication continues to use ordinary work admission. Unexpected values thrown by v1 authentication and route work are replaced with a fixed internal error before forwarding; the original value is not inspected or forwarded by these boundaries.

## Scope and outstanding work

The router still looks up its scope by request at its own endpoints; this is not a proof that arbitrary callers of those endpoints cannot impersonate dispatch. Error claims remain transferable to another tracked error handler, and the audited terminal/dispatch-out graph is incomplete. SIWC refresh needs explicit child capabilities after admission stops, and all admin, OAuth, listener and token producers must be accounted for before connecting a global drain. The server's existing shutdown must not be considered safe: it can close the database while work remains active. Error handling elsewhere, including the server handler, still needs a confidentiality audit. Independent review and acceptance testing are outstanding. Do not deploy this work as a completed shutdown solution.
