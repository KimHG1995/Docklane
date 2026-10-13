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

## 2026-10-13 regression corrections (PR #137)
- Startup and periodic **observation-only** service/node/deployment reconciliation now use distinct recovery locks. They retain resource lock and registration checks, but do not use the OPEN admission check. The recovery callbacks must never dispatch a new Docker mutation. Existing client-request paths still require admission.
- Migration v6 converts `owner_id` to utf8mb4 while preserving migration v5's historical checksum. Authentication actor IDs such as `관리자` can be persisted without ASCII conversion failure.
- Maintenance generation is read via `CAST(generation AS CHAR)` before `BigInt`, avoiding mysql2 BIGINT-to-number precision loss. CAS continues to submit decimal strings.
- This does **not** yet block a callback that passed admission before the CLOSING transition, and does not provide an all-manager Agent mutation barrier. The feature stays opt-in and PR remains Draft.
- CI and disposable MySQL acceptance must verify the recovery paths, Unicode migration, large generation and the 10-connection lock scenario before the feature can be promoted.

## Final mutation dispatch read (experimental)
When enforcement is enabled, the registered Agent client now rechecks maintenance `OPEN` immediately before the seven mutating Agent methods. If a resource lock callback is active, the same MySQL connection is used to avoid pool starvation. Inspect, plan and observation-only reconciliation remain permitted. Missing/invalid state and database failure are rejected. The check does not atomically fence an already dispatched HTTP request, a later OPEN→CLOSING transition, or external Docker CLI writers.

**This is not sufficient for closing a cluster:** generation ownership is not yet propagated into an Agent-enforced barrier; already-sent Docker requests remain uncertain. Scoped ADMIN transitions, audit transaction and all-manager acknowledgment still block production rollout. The integration tests for these guarantees must succeed before enabling enforcement.

## Pre-dispatch deterministic denial
A maintenance check executed *before* sending any Agent HTTP mutation now throws `MaintenancePreDispatchRejection`. Only this branded error is added to deterministic rejection classification; generic 409/503 responses or unknown transmission outcomes remain unchanged. Existing durable operation rejection handlers persist FAILED and audit; service/node errors are tagged MAINTENANCE_DISPATCH_REJECTED. Docker request count must be zero. This does not mean the database check and outbound HTTP call are atomic, nor does it make the all-manager barrier complete.

## Operator close request (OPEN → CLOSING only)
Scoped ADMIN may POST `/v1/clusters/:clusterId/maintenance/close-request` with decimal-string `generation` and nonempty `reason`. A single InnoDB transaction updates the expected OPEN generation and inserts the audit event; if the audit insert fails, the transition rolls back. A stale generation fails closed. No API exists yet to enter CLOSED or to reopen: that requires proof of completed in-flight work and acknowledgment from **every manager Agent**, not merely absence of DB operation rows. Existing operations marked NEEDS_ATTENTION and unknown transmitted requests must block automatic rejoin.

This is a partial operator API. It must not be described as a complete maintenance lifecycle or as Docker-native fencing. Production enforcement stays disabled until the remaining acceptance checks pass.

## Unresolved operation readiness snapshot
The maintenance repository can count all service and node operations in PENDING/RUNNING/VERIFYING/NEEDS_ATTENTION using the actual MySQL DB. Missing data, malformed counts, and query failure cause a 503 instead of an optimistic zero. The count is advisory and does **not** grant CLOSED: a zero count does not prove HTTP transmissions or all-manager Agent barriers have drained. In-flight dispatch lease/fencing and manager acknowledgements must be persisted and checked before introducing a CLOSED transition API.

## Readiness API
Scoped ADMIN `GET /v1/clusters/:clusterId/maintenance/readiness` reports durable nonterminal operation count and maintenance generation as decimal strings. `agentBarrierVerified`, `inFlightDispatchVerified`, and `safeToClose` remain **false**, including when the DB count is zero. This is diagnostic only; it is not a manager-barrier implementation, nor authorization to leave/reinitialize the Swarm.

## Durable dispatch and barrier evidence (migration v7)
Two additive tables, `maintenance_dispatches` and `maintenance_agent_barriers`, retain operation send phase and per-manager generation acknowledgements. PREPARED is not proof that a request was never sent after process crash; SENDING/UNCERTAIN must remain unresolved without inspection and operator reconciliation. An ACK row is not sufficient until manager identity and generation are checked against a fixed expected manager membership set. Migration v7 creates no rows, exposes no CLOSED transition, and does not change Agent behavior. Wiring dispatch journaling, lease ownership, generation fencing, multi-Agent acknowledgments, stale process handling and real Docker acceptance remains required. Do not use row counts as a safe-to-close decision.

## Dispatch readiness diagnostic
The readiness API now reports `unresolvedDispatches` as a decimal string from persisted PREPARED/SENDING/UNCERTAIN rows. Query failures deny readiness instead of treating absence of evidence as safe. No runtime writer currently journals these rows and no manager barrier acknowledgements are verified, therefore `safeToClose` remains false even when both counts are zero. Do not enable CLOSED or perform Swarm rejoin based on these diagnostic counts.
