# Maintenance enforcement rollout

## Current implementation
The registered service/node operation lock checks the persisted maintenance row using the **same MySQL connection already holding resource locks** when `DOCKLANE_MAINTENANCE_ENFORCE=1`. A missing row, DB read failure, invalid generation, or non-OPEN state denies the lock callback. The default is disabled to preserve existing installations until initialization and management authorization exist.

This check is an admission control, **not** an atomic Docker compare-and-update primitive. A mutation already executing past the lock check may still dispatch. Another CP, another manager Agent, external Docker CLI, and a concurrent OPEN→CLOSING transition can race with an in-flight Docker Update.

## Mandatory prerequisites before production enablement
- Scoped ADMIN-only initialization with registered real Swarm identity, audit and irreversible idempotent replay.
- State-transition service checks: CLOSING must close new and queued dispatch; CLOSED requires proof all in-flight requests have settled and manager barriers acknowledged.
- Durable generation/fencing coordination across CP instances; Agent mutation barrier on all managers; restart fail-closed.
- Maintenance release requires reconciliation, cluster binding reassessment and explicit approval.
- MySQL integration tests including 10-connection saturation and stale state transitions; real Docker disposable acceptance.
- Enforcement must be gated at the actual Agent dispatch boundary for long-running operations, not solely at lock acquisition.

Do not enable `DOCKLANE_MAINTENANCE_ENFORCE` in production or declare maintenance complete until those prerequisites pass.
