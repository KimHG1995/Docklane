#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER_NAME="docklane-db-migration-poc"
MYSQL_PORT="33307"
MYSQL_PASSWORD="docklane"
DATABASE_URL="mysql://root:${MYSQL_PASSWORD}@127.0.0.1:${MYSQL_PORT}/docklane"
container_id=""

cleanup() {
  local status="$?"
  trap - EXIT

  if [[ "$status" != "0" && -n "$container_id" ]]; then
    echo "database migration PoC MySQL logs:" >&2
    docker logs "$container_id" >&2 || true
  fi

  if [[ -n "$container_id" ]]; then
    docker rm -f "$container_id" >/dev/null 2>&1 || true
  fi

  exit "$status"
}
trap cleanup EXIT

if docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  echo "database migration PoC refuses to remove pre-existing container: $CONTAINER_NAME" >&2
  exit 1
fi

container_id="$(docker run -d   --name "$CONTAINER_NAME"   -e MYSQL_ROOT_PASSWORD="$MYSQL_PASSWORD"   -e MYSQL_DATABASE=docklane   -p "127.0.0.1:${MYSQL_PORT}:3306"   mysql:8.4)"

for _ in {1..90}; do
  pid_one="$(docker exec "$container_id" sh -c 'cat /proc/1/comm' 2>/dev/null || true)"
  if [[ "$pid_one" == "mysqld" ]] &&
     docker exec "$container_id" mysqladmin ping -uroot -p"$MYSQL_PASSWORD" --silent >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

pid_one="$(docker exec "$container_id" sh -c 'cat /proc/1/comm' 2>/dev/null || true)"
[[ "$pid_one" == "mysqld" ]] || { echo "MySQL entrypoint did not reach final mysqld process" >&2; exit 1; }

docker exec "$container_id" mysqladmin ping -uroot -p"$MYSQL_PASSWORD" --silent >/dev/null 2>&1   || { echo "MySQL did not become ready" >&2; exit 1; }

cd "$ROOT_DIR"

DOCKLANE_DATABASE_URL="$DATABASE_URL" node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { Database } from './apps/api/dist/db/database.js';
import { ClusterRegistrationRepository } from './apps/api/dist/clusters/cluster-registration.repository.js';
import { ClusterBindingPolicy } from './apps/api/dist/clusters/cluster-binding.policy.js';
import { registeredAgentClient } from './apps/api/dist/clusters/registered-agent-client.js';
import { RegisteredOperationLock } from './apps/api/dist/clusters/registered-operation-lock.js';
import { ClusterMaintenanceRepository } from './apps/api/dist/clusters/cluster-maintenance.repository.js';
import { MaintenanceDispatchJournal } from './apps/api/dist/clusters/maintenance-dispatch-journal.js';
import { MaintenanceControlLease } from './apps/api/dist/clusters/maintenance-control-lease.js';
import { MaintenanceEvidenceRecovery } from './apps/api/dist/clusters/maintenance-evidence-recovery.js';
import { OperationRepository } from './apps/api/dist/operations/operation.repository.js';
import { NodeOperationRepository } from './apps/api/dist/operations/node-operation.repository.js';

const db = new Database();

try {
  await db.onModuleInit();

  const legacyTokens = [
    {
      id: 'legacy-valid',
      tokenHash: '1'.repeat(64),
      claimId: 'claim-valid',
    },
    {
      id: 'legacy-wrong-claim',
      tokenHash: '2'.repeat(64),
      claimId: 'claim-current',
    },
    {
      id: 'legacy-duplicate-audit',
      tokenHash: '3'.repeat(64),
      claimId: 'claim-duplicate',
    },
    {
      id: 'legacy-wrong-cluster',
      tokenHash: '4'.repeat(64),
      claimId: 'claim-cluster',
    },
  ];

  for (const token of legacyTokens) {
    await db.pool.execute(
      `INSERT INTO bootstrap_tokens
       (
         id, token_hash, cluster_id, node_role, labels_json, created_by,
         expires_at, used_at, claim_id, completed_node_id
       )
       VALUES (?, ?, 'cluster-1', 'worker', JSON_OBJECT(), 'admin-1',
               DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 1 DAY),
               UTC_TIMESTAMP(6), ?, NULL)`,
      [token.id, token.tokenHash, token.claimId],
    );
  }

  const insertCompletionAudit = async ({
    tokenId,
    clusterId = 'cluster-1',
    claimId,
    nodeId,
  }) => {
    await db.pool.execute(
      `INSERT INTO audit_events
       (
         operation_id, actor_id, cluster_id, service_id,
         resource_type, resource_id, action, before_json, after_json
       )
       VALUES (?, ?, ?, ?, 'bootstrap_token', ?, 'BOOTSTRAP_COMPLETED', NULL, ?)`,
      [
        tokenId,
        `bootstrap:${tokenId}`,
        clusterId,
        tokenId,
        tokenId,
        JSON.stringify({
          claimId,
          nodeId,
          hostname: `${nodeId}.example`,
          role: 'worker',
          labels: {},
          verifiedAt: '2026-09-30T00:01:00.000Z',
        }),
      ],
    );
  };

  await insertCompletionAudit({
    tokenId: 'legacy-valid',
    claimId: 'claim-valid',
    nodeId: 'node-valid',
  });
  await insertCompletionAudit({
    tokenId: 'legacy-wrong-claim',
    claimId: 'claim-stale',
    nodeId: 'node-stale',
  });
  await insertCompletionAudit({
    tokenId: 'legacy-duplicate-audit',
    claimId: 'claim-duplicate',
    nodeId: 'node-a',
  });
  await insertCompletionAudit({
    tokenId: 'legacy-duplicate-audit',
    claimId: 'claim-duplicate',
    nodeId: 'node-b',
  });
  await insertCompletionAudit({
    tokenId: 'legacy-wrong-cluster',
    clusterId: 'cluster-2',
    claimId: 'claim-cluster',
    nodeId: 'node-cluster',
  });

  await db.pool.execute('DELETE FROM schema_migrations WHERE version = 2');

  await db.onModuleInit();
  await db.onModuleInit();

  const [legacyRows] = await db.pool.query(
    `SELECT id, completed_node_id
     FROM bootstrap_tokens
     WHERE id LIKE 'legacy-%'
     ORDER BY id`,
  );
  const completedNodeByToken = new Map(
    legacyRows.map((row) => [row.id, row.completed_node_id]),
  );
  assert.equal(completedNodeByToken.get('legacy-valid'), 'node-valid');
  assert.equal(completedNodeByToken.get('legacy-wrong-claim'), null);
  assert.equal(completedNodeByToken.get('legacy-duplicate-audit'), null);
  assert.equal(completedNodeByToken.get('legacy-wrong-cluster'), null);

  const [migrationRows] = await db.pool.query(
    'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
  );
  assert.equal(migrationRows.length, 11);
  assert.deepEqual(
    migrationRows.map((row) => [Number(row.version), row.name]),
    [
      [1, 'baseline-current-schema'],
      [2, 'backfill-bootstrap-completed-node-id'],
      [3, 'cluster-registration'],
      [4, 'rollback-attempt-history'],
      [5, 'cluster-maintenance-state'],
      [6, 'maintenance-owner-unicode'],
      [7, 'maintenance-dispatch-evidence'],
      [8, 'maintenance-dispatch-uniqueness'],
      [9, 'maintenance-active-admissions'],
      [10, 'maintenance-control-lease'],
      [11, 'maintenance-evidence-resolution'],
    ],
  );
  for (const row of migrationRows) {
    assert.match(row.checksum, /^[a-f0-9]{64}$/);
  }

  const expectedTables = [
    'applications',
    'audit_events',
    'bootstrap_tokens',
    'cluster_registrations',
    'cluster_maintenance_states',
    'maintenance_dispatches',
    'maintenance_agent_barriers',
    'maintenance_active_admissions',
    'maintenance_control_leases',
    'maintenance_evidence_resolutions',
    'deployment_targets',
    'deployments',
    'node_operations',
    'operations',
    'releases',
    'rollback_attempts',
    'schema_migrations',
  ];

  const [tableRows] = await db.pool.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = DATABASE()
       AND table_name IN (${expectedTables.map(() => '?').join(',')})`,
    expectedTables,
  );
  assert.deepEqual(
    tableRows.map((row) => row.TABLE_NAME ?? row.table_name).sort(),
    [...expectedTables].sort(),
  );

  const requiredColumns = [
    ['audit_events', 'resource_type'],
    ['audit_events', 'resource_id'],
    ['bootstrap_tokens', 'claim_id'],
    ['bootstrap_tokens', 'completed_node_id'],
    ['deployments', 'kind'],
    ['deployments', 'source_deployment_id'],
    ['deployments', 'rollback_operation_id'],
    ['node_operations', 'target_labels'],
    ['node_operations', 'label_patch'],
    ['operations', 'target_runtime_spec_hash'],
  ];

  for (const [tableName, columnName] of requiredColumns) {
    const [rows] = await db.pool.query(
      `SELECT COUNT(*) AS count
       FROM information_schema.columns
       WHERE table_schema = DATABASE()
         AND table_name = ?
         AND column_name = ?`,
      [tableName, columnName],
    );
    assert.equal(Number(rows[0].count), 1, `${tableName}.${columnName} missing`);
  }

  await db.pool.execute(
    `INSERT INTO schema_migrations (version, name, checksum)
     VALUES (999, 'future-schema', ?)`,
    ['f'.repeat(64)],
  );

  const futureDb = new Database();
  try {
    await assert.rejects(
      () => futureDb.onModuleInit(),
      /newer than this Docklane build/,
    );
  } finally {
    await futureDb.onModuleDestroy();
  }

  await db.pool.execute('DELETE FROM schema_migrations WHERE version = 999');

  // Reuse this MySQL instance to exercise the actual registration repository.
  // No new Docker topology, workflow or network configuration is introduced.
  const registrations = new ClusterRegistrationRepository(db);
  const registrationInput = { clusterId: 'default', swarmClusterId: 'swarm-test-a',
    displayName: '등록 검증', registeredBy: 'admin-test', verifiedNodeId: 'manager-test' };
  const concurrent = await Promise.all(Array.from({ length: 4 }, () => registrations.register(registrationInput)));
  assert.equal(new Set(concurrent.map((row) => row.id)).size, 1);
  const registration = concurrent[0];
  assert.equal(registration.displayName, registrationInput.displayName);
  assert.match(registration.createdAt, /Z$/);
  assert.deepEqual(await new ClusterRegistrationRepository(db).find('default'), registration);
  const [registrationAudits] = await db.query(
    "SELECT * FROM audit_events WHERE action = 'CLUSTER_REGISTERED' AND operation_id = ?", [registration.id]);
  assert.equal(registrationAudits.length, 1);
  assert.equal(registrationAudits[0].resource_type, 'cluster');
  const snapshot = typeof registrationAudits[0].after_json === 'string'
    ? JSON.parse(registrationAudits[0].after_json) : registrationAudits[0].after_json;
  assert.equal(snapshot.swarmClusterId, registrationInput.swarmClusterId);
  for (const change of [{ swarmClusterId: 'swarm-other' }, { clusterId: 'other' }, { displayName: 'changed' }]) {
    await assert.rejects(registrations.register({ ...registrationInput, ...change }), /already registered/);
  }
  assert.equal(await registrations.find('Default'), null, 'logical IDs must be case-sensitive');
  // Inject a real server-side audit error, then verify the registration INSERT rolled back.
  await db.query(`CREATE TRIGGER reject_test_cluster_audit BEFORE INSERT ON audit_events
    FOR EACH ROW BEGIN
      IF NEW.action = 'CLUSTER_REGISTERED' AND NEW.resource_id = 'audit-failure' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'registration audit failure';
      END IF;
    END`);
  try {
    await assert.rejects(registrations.register({ ...registrationInput,
      clusterId: 'audit-failure', swarmClusterId: 'swarm-audit-failure' }), /registration audit failure/);
    assert.equal(await registrations.find('audit-failure'), null);
  } finally {
    await db.query('DROP TRIGGER reject_test_cluster_audit');
  }
  const [unchanged] = await db.query("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'CLUSTER_REGISTERED'");
  assert.equal(Number(unchanged[0].count), 1);
  // Real InnoDB rollback acceptance: CLOSING and its audit MUST commit together.
  const leases = new MaintenanceControlLease(db);
  const maintenance = new ClusterMaintenanceRepository(db, leases);
  await db.query(`CREATE TRIGGER reject_test_initialization_audit BEFORE INSERT ON audit_events
    FOR EACH ROW BEGIN
      IF NEW.action = 'CLUSTER_MAINTENANCE_INITIALIZED' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'initialize audit failure';
      END IF;
    END`);
  try {
    await assert.rejects(() => maintenance.initializeOpen('default', '관리자', 'audit error'),
      /initialize audit failure/);
  } finally {
    await db.query('DROP TRIGGER reject_test_initialization_audit');
  }
  const [preInitialState] = await db.query(
    "SELECT COUNT(*) AS count FROM cluster_maintenance_states WHERE cluster_id='default'");
  assert.equal(Number(preInitialState[0].count), 0, 'failed audit rolls back OPEN initialization');
  const initialized = await maintenance.initializeOpen('default', '관리자', 'disposable acceptance');
  assert.equal(initialized.state, 'OPEN');
  assert.equal(initialized.ownerId, '관리자');
  assert.equal(initialized.generation, 1n);
  const [initAudits] = await db.query("SELECT COUNT(*) AS count FROM audit_events WHERE cluster_id='default' AND action='CLUSTER_MAINTENANCE_INITIALIZED'");
  assert.equal(Number(initAudits[0].count), 1);
  const repeatInit = await maintenance.initializeOpen('default', '관리자2', 'replay');
  assert.equal(repeatInit.generation, 1n);
  assert.equal(repeatInit.ownerId, '관리자');
  const concurrentClose = await Promise.all(Array.from({ length: 10 }, () =>
    maintenance.requestClosing('default', 1n, '관리자', 'maintenance acceptance')));
  assert.equal(concurrentClose.filter(Boolean).length, 1, 'only one close CAS may succeed');
  let state = await maintenance.requireRecord('default');
  assert.equal(state.state, 'CLOSING');
  assert.equal(state.generation, 2n);
  const [closeAudits] = await db.query(
    "SELECT * FROM audit_events WHERE action = 'CLUSTER_MAINTENANCE_CLOSING' AND cluster_id = 'default'");
  assert.equal(closeAudits.length, 1, 'close transaction must audit exactly once');
  // Reset via SQL only inside this owned disposable fixture; no public re-open API.
  await db.query("UPDATE cluster_maintenance_states SET state = 'OPEN', generation = 3 WHERE cluster_id = 'default'");
  await db.query(`CREATE TRIGGER reject_test_maintenance_audit BEFORE INSERT ON audit_events
    FOR EACH ROW BEGIN
      IF NEW.action = 'CLUSTER_MAINTENANCE_CLOSING' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'maintenance audit failure';
      END IF;
    END`);
  try {
    await assert.rejects(() =>
      maintenance.requestClosing('default', 3n, '관리자', 'audit rollback acceptance'),
      /maintenance audit failure/);
  } finally {
    await db.query('DROP TRIGGER reject_test_maintenance_audit');
  }
  state = await maintenance.requireRecord('default');
  assert.equal(state.state, 'OPEN', 'audit insert failure must roll back close state');
  assert.equal(state.generation, 3n, 'audit failure must roll back generation increment');
  const [stillOneAudit] = await db.query(
    "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'CLUSTER_MAINTENANCE_CLOSING'");
  assert.equal(Number(stillOneAudit[0].count), 1);
  console.log('maintenance real MySQL concurrent CAS, Unicode owner and audit rollback: PASS');

  console.log('cluster registration MySQL transaction/replay/uniqueness: PASS');

  // Real mysql2 pool, actual InnoDB/GET_LOCK sessions and actual registration
  // repository/Agent proxy. A synthetic transport cannot prove pool exhaustion.
  const policy = new ClusterBindingPolicy(registrations, {
    mode: 'enforce', logicalClusterId: 'default', expectedSwarmClusterId: registrationInput.swarmClusterId,
  });
  const mutex = new RegisteredOperationLock(db, policy);
  let forwarded = 0;
  const agent = registeredAgentClient({
    inspectService: async (serviceId) => {
      forwarded += 1;
      return { service: { id: serviceId } };
    },
  }, policy);
  const distinctConnections = new Set();
  let joined = 0;
  let releaseBarrier;
  const barrier = new Promise(resolve => { releaseBarrier = resolve; });
  // Failure must terminate the disposable test process: waiting mysql2 pool
  // requests cannot necessarily be cancelled by Promise.race or db.pool.end().
  const watchdog = setTimeout(() => {
    console.error('registered operation MySQL pool saturated: 10 lock sessions did not complete');
    process.exit(1);
  }, 12000);
  try {
    await Promise.all(Array.from({ length: 10 }, (_, index) =>
      mutex.withServiceLock('default', 'disjoint-service-' + index, async (connection) => {
        const [rows] = await connection.query('SELECT CONNECTION_ID() AS connection_id');
        distinctConnections.add(Number(rows[0].connection_id));
        joined += 1;
        if (joined === 10) releaseBarrier();
        await barrier;
        await agent.inspectService('disjoint-service-' + index);
      }),
    ));
  } finally {
    clearTimeout(watchdog);
  }
  assert.equal(joined, 10);
  assert.equal(distinctConnections.size, 10, 'ten independently held MySQL connections are required');
  assert.equal(forwarded, 10, 'admission and dispatch must finish for every held connection');

  const mismatch = new ClusterBindingPolicy(registrations, {
    mode: 'enforce', logicalClusterId: 'default', expectedSwarmClusterId: 'different-swarm-id',
  });
  await assert.rejects(() => mismatch.assertRegistered(), error =>
    error.getStatus?.() === 503 && error.getResponse?.().code === 'CLUSTER_REGISTRATION_MISMATCH');
  const unregistered = new ClusterBindingPolicy(registrations, {
    mode: 'enforce', logicalClusterId: 'unregistered', expectedSwarmClusterId: registrationInput.swarmClusterId,
  });
  await assert.rejects(() => unregistered.assertRegistered(), error =>
    error.getStatus?.() === 503 && error.getResponse?.().code === 'CLUSTER_REGISTRATION_REQUIRED');
  const [registrationRows] = await db.query(
    'SELECT COUNT(*) AS count FROM cluster_registrations WHERE cluster_id = ?', ['default']);
  assert.equal(Number(registrationRows[0].count), 1, 'admission checks must not modify registrations');
  console.log('registered operation real MySQL pool saturation (10/10), mismatch and absence: PASS');

  // The rollback test deliberately left the cluster OPEN at generation 3.
  // Close it again before checking the enforcement=1 denial branch.
  assert.equal(await maintenance.requestClosing('default', 3n, '관리자', 'enforcement acceptance'), true);
  assert.equal((await maintenance.requireRecord('default')).state, 'CLOSING');

  // Maintenance enforcement ON: real MySQL/GET_LOCK with a held connection.
  // Proves new mutation dispatch stops when CLOSING, while recovery still reads.
  const savedEnforce = process.env.DOCKLANE_MAINTENANCE_ENFORCE;
  process.env.DOCKLANE_MAINTENANCE_ENFORCE = '1';
  try {
    let mutationCalls = 0;
    const protectedAgent = registeredAgentClient({
      restartService: async () => {
        mutationCalls += 1;
        return { serviceId: 'disposable', version: 1, targetSpecHash: 'x' };
      },
      inspectService: async () => ({ service: { id: 'disposable' } }),
    }, policy, db);
    await assert.rejects(
      () => mutex.withServiceLock('default', 'maintenance-block-test',
        () => protectedAgent.restartService('disposable', {})),
      /maintenance/i,
    );
    assert.equal(mutationCalls, 0, 'CLOSING must block Agent mutation before transport');
    let recoveryReads = 0;
    await mutex.withServiceRecoveryLock('default', 'maintenance-block-test', async () => {
      await protectedAgent.inspectService('disposable');
      recoveryReads += 1;
    });
    assert.equal(recoveryReads, 1, 'CLOSING must allow observation-only recovery');
    console.log('maintenance enforcement ON real MySQL lock/dispatch/recovery: PASS');
  } finally {
    if (savedEnforce === undefined) delete process.env.DOCKLANE_MAINTENANCE_ENFORCE;
    else process.env.DOCKLANE_MAINTENANCE_ENFORCE = savedEnforce;
  }

  // Real pool 10/10: journal must use the existing resource-lock session.
  // A SENDING row survives connection release and remains unresolved after
  // a simulated CP crash; never infer an ACK from missing HTTP response.
  const journal = new MaintenanceDispatchJournal(db);
  const heldSessions = new Set();
  const evidenceIds = [];
  let ready = 0;
  let release;
  const readyBarrier = new Promise(resolve => { release = resolve; });
  const journalWatchdog = setTimeout(() => {
    console.error('maintenance journal session reuse deadlocked under 10/10 lock occupancy');
    process.exit(1);
  }, 12000);
  try {
    await Promise.all(Array.from({ length: 10 }, (_, index) =>
      mutex.withServiceRecoveryLock('default', 'journal-session-' + index, async connection => {
        const [sessionRows] = await connection.query('SELECT CONNECTION_ID() AS id');
        heldSessions.add(Number(sessionRows[0].id));
        ready += 1;
        if (ready === 10) release();
        await readyBarrier;
        const id = await journal.prepare('default', 4n, 'agent-disposable', 'operation-' + index, connection);
        await journal.transition(id, 'PREPARED', 'SENDING', connection);
        evidenceIds.push(id);
      }),
    ));
  } finally {
    clearTimeout(journalWatchdog);
  }
  assert.equal(heldSessions.size, 10);
  assert.equal(evidenceIds.length, 10);
  const [persistedDispatch] = await db.query(
    "SELECT COUNT(*) AS count FROM maintenance_dispatches WHERE cluster_id = 'default' AND phase = 'SENDING'");
  assert.equal(Number(persistedDispatch[0].count), 10);
  await assert.rejects(() => journal.transition(evidenceIds[0], 'UNCERTAIN', 'ACKNOWLEDGED'),
    /Invalid dispatch evidence transition/);
  console.log('maintenance journal durable SENDING + 10/10 locked MySQL session reuse: PASS');

  // Real InnoDB generation CAS at the final send boundary. This is separate
  // from the actual Agent HTTP transport, which is not yet journal-wired.
  await db.query("UPDATE cluster_maintenance_states SET state='OPEN', generation=5 WHERE cluster_id='default'");
  const allowedId = await journal.prepare('default', 5n, 'agent-disposable', 'accepted-op');
  await journal.beginSend(allowedId, 'default', 5n, 'agent-disposable', 'accepted-op');
  assert.equal(await maintenance.requestClosing('default', 5n, '관리자', 'block stale sends'), true);
  const deniedId = await journal.prepare('default', 5n, 'agent-disposable', 'denied-op');
  await assert.rejects(
    () => journal.beginSend(deniedId, 'default', 5n, 'agent-disposable', 'denied-op'),
    /generation or maintenance state changed/,
  );
  const [phaseRows] = await db.query(
    "SELECT operation_id, phase FROM maintenance_dispatches WHERE id IN (?, ?) ORDER BY operation_id",
    [allowedId, deniedId],
  );
  assert.deepEqual(phaseRows.map(row => [row.operation_id, row.phase]), [
    ['accepted-op', 'SENDING'],
    ['denied-op', 'PREPARED'],
  ]);
  console.log('maintenance real MySQL beginSend generation race rejection: PASS');

  // A second Control Plane must not create a fresh dispatch lineage for
  // an operation whose earlier HTTP transmission may be uncertain.
  const duplicateResults = await Promise.allSettled(Array.from({ length: 8 }, () =>
    journal.prepare('default', 5n, 'agent-disposable', 'duplicate-op')));
  assert.equal(duplicateResults.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(duplicateResults.filter(r => r.status === 'rejected').length, 7);
  const [duplicateRows] = await db.query(
    "SELECT COUNT(*) AS count FROM maintenance_dispatches WHERE cluster_id = 'default' AND operation_id = 'duplicate-op'");
  assert.equal(Number(duplicateRows[0].count), 1);
  console.log('maintenance real MySQL duplicate operation lineage 1/8 accepted: PASS');



  // Durable in-flight admission must survive until the callback exits.
  // A CLOSING transition cannot consider a still-running callback safe.
  await db.query("UPDATE cluster_maintenance_states SET state='OPEN', generation=7 WHERE cluster_id='default'");
  const liveAdmissions = [];
  const admissionLock = new RegisteredOperationLock(db, policy);
  process.env.DOCKLANE_MAINTENANCE_ENFORCE = '1';
  try {
    await admissionLock.withServiceLock('default', 'live-admission-test', async () => {
      const [active] = await db.query(
        "SELECT COUNT(*) AS count FROM maintenance_active_admissions WHERE cluster_id='default'");
      assert.equal(Number(active[0].count), 1);
      liveAdmissions.push(Number(active[0].count));
    });
    const [cleared] = await db.query(
      "SELECT COUNT(*) AS count FROM maintenance_active_admissions WHERE cluster_id='default'");
    assert.equal(Number(cleared[0].count), 0);
    assert.equal(await maintenance.requestClosing('default', 7n, '관리자', 'admission test'), true);
    const closeLease = await leases.acquire('default', 30);
    // The previous simulated CP failures deliberately left SENDING/UNCERTAIN
    // evidence. CLOSED must refuse to erase or ignore it, even when active
    // callback admissions have drained.
    await assert.rejects(
      () => maintenance.commitClosed('default', 8n, '관리자', 'unsafe close test', ['manager-0'], closeLease),
      /unresolved admission, operation or dispatch/);
    const stillClosing = await maintenance.requireRecord('default');
    assert.equal(stillClosing.state, 'CLOSING');
    assert.equal(stillClosing.generation, 8n);
    // Only in this disposable fixture: explicitly reconcile synthetic SENDING
    // records, then test atomic CLOSED+audit. Never auto-delete such rows in
    // product code or mistake one mocked manager ACK for real Swarm coverage.
    await db.query("DELETE FROM maintenance_dispatches WHERE cluster_id='default'");
    await db.query(`INSERT INTO maintenance_agent_barriers
      (cluster_id, agent_id, generation, state)
      VALUES ('default', 'manager-0', 8, 'ACKNOWLEDGED')`);
    await db.query(`CREATE TRIGGER reject_test_closed_audit BEFORE INSERT ON audit_events
      FOR EACH ROW BEGIN
        IF NEW.action = 'CLUSTER_MAINTENANCE_CLOSED' THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'closed audit failure';
        END IF;
      END`);
    try {
      await assert.rejects(() =>
        maintenance.commitClosed('default', 8n, '관리자', 'audited closure', ['manager-0'], closeLease),
        /closed audit failure/);
    } finally {
      await db.query('DROP TRIGGER reject_test_closed_audit');
    }
    assert.equal((await maintenance.requireRecord('default')).state, 'CLOSING');
    assert.equal((await maintenance.requireRecord('default')).generation, 8n);
    assert.equal(await maintenance.commitClosed('default', 8n, '관리자',
      'audited closure', ['manager-0'], closeLease), true);
    assert.equal((await maintenance.requireRecord('default')).state, 'CLOSED');
    assert.equal(await maintenance.commitClosed('default', 8n, '관리자',
      'stale replay', ['manager-0'], closeLease), false);
    await leases.release(closeLease);
    console.log('maintenance real MySQL atomic CLOSED evidence/audit rollback/CAS: PASS');

    await assert.rejects(
      () => admissionLock.withServiceLock('default', 'new-admission-test', async () => {}),
      /maintenance/i);
    const [afterClose] = await db.query(
      "SELECT COUNT(*) AS count FROM maintenance_active_admissions WHERE cluster_id='default'");
    assert.equal(Number(afterClose[0].count), 0);
  } finally {
    if (savedEnforce === undefined) delete process.env.DOCKLANE_MAINTENANCE_ENFORCE;
    else process.env.DOCKLANE_MAINTENANCE_ENFORCE = savedEnforce;
  }
  assert.deepEqual(liveAdmissions, [1]);
  console.log('maintenance real MySQL active admission lifecycle: PASS');

  const initialLease = await leases.acquire('default', 30);
  assert.equal(initialLease.token, 2n);
  await assert.rejects(() => leases.acquire('default', 30), /Another Control Plane/);
  const conn = await db.getConnection();
  try {
    await leases.assertOwner(conn, initialLease);
  } finally {
    conn.release();
  }
  await leases.release(initialLease);
  const nextLease = await leases.acquire('default', 30);
  assert.equal(nextLease.token, 3n);
  const conn2 = await db.getConnection();
  try {
    await assert.rejects(() => leases.assertOwner(conn2, initialLease), /fenced/);
    await leases.assertOwner(conn2, nextLease);
  } finally {
    conn2.release();
  }
  await assert.rejects(() => leases.release(initialLease), /ownership lost/);
  await leases.release(nextLease);
  console.log('maintenance lease real MySQL monotonic fencing and takeover: PASS');

  // Fixture-only reconciliation: operators first reconcile every unresolved
  // mutation, and manager BLOCKED ACKs are refreshed for the new generation.
  const recoveryLease = await leases.acquire('default', 30);
  assert.equal(recoveryLease.token, 4n);
  assert.equal(await maintenance.commitRecoveryTransition(
    'default', 9n, '관리자', 'start reconciliation', 'CLOSED', recoveryLease), true);
  assert.equal((await maintenance.requireRecord('default')).state, 'RECONCILING');
  assert.equal((await maintenance.requireRecord('default')).generation, 10n);
  await db.query(`UPDATE maintenance_agent_barriers SET generation=10
    WHERE cluster_id='default' AND agent_id='manager-0'`);
  await db.query(`CREATE TRIGGER reject_test_open_audit BEFORE INSERT ON audit_events
    FOR EACH ROW BEGIN
      IF NEW.action = 'CLUSTER_MAINTENANCE_OPEN' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'open audit failure';
      END IF;
    END`);
  try {
    await assert.rejects(() => maintenance.commitRecoveryTransition(
      'default', 10n, '관리자', 'resume test', 'RECONCILING', recoveryLease, ['manager-0']),
      /open audit failure/);
  } finally {
    await db.query('DROP TRIGGER reject_test_open_audit');
  }
  assert.equal((await maintenance.requireRecord('default')).state, 'RECONCILING');
  assert.equal((await maintenance.requireRecord('default')).generation, 10n);
  assert.equal(await maintenance.commitRecoveryTransition(
    'default', 10n, '관리자', 'resume test', 'RECONCILING', recoveryLease, ['manager-0']), true);
  assert.equal((await maintenance.requireRecord('default')).state, 'OPEN');
  assert.equal((await maintenance.requireRecord('default')).generation, 11n);
  assert.equal(await maintenance.commitRecoveryTransition(
    'default', 10n, '관리자', 'replayed resume', 'RECONCILING', recoveryLease, ['manager-0']), false);
  await leases.release(recoveryLease);
  console.log('maintenance real MySQL CLOSED→RECONCILING→OPEN atomic audit and fencing: PASS');


  // Failure-recovery acceptance. Raw orphan admission is NEVER deleted;
  // an operator-backed resolution and audit must commit together.
  await db.query("UPDATE cluster_maintenance_states SET state='CLOSING', generation=12 WHERE cluster_id='default'");
  const recoveryEvidenceId = '88888888-8888-4888-8888-888888888888';
  await db.query(`INSERT INTO maintenance_active_admissions
    (id,cluster_id,generation,owner_id,resource_type,resource_id)
    VALUES (?, 'default', 11, '99999999-9999-4999-9999-999999999999','service','orphan-test')`,
    [recoveryEvidenceId]);
  const evidence = new MaintenanceEvidenceRecovery(db, maintenance, leases, admissionLock);
  assert.equal(await maintenance.countActiveAdmissions('default'), 1n);
  const evidenceLease = await leases.acquire('default',30);
  const resolveInput = {clusterId:'default',generation:12n,type:'ADMISSION',
    evidenceId:recoveryEvidenceId,actorId:'관리자',reason:'CP SIGKILL observed',
    observation:'all managers blocked, prior CP terminated and resource examined',lease:evidenceLease};
  await db.query(`CREATE TRIGGER reject_test_resolution_audit BEFORE INSERT ON audit_events
    FOR EACH ROW BEGIN
      IF NEW.action = 'CLUSTER_MAINTENANCE_EVIDENCE_RESOLVED' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'evidence audit failure';
      END IF;
    END`);
  try {
    await assert.rejects(() => evidence.resolve(resolveInput), /evidence audit failure/);
  } finally {
    await db.query('DROP TRIGGER reject_test_resolution_audit');
  }
  assert.equal(await maintenance.countActiveAdmissions('default'),1n);
  await evidence.resolve(resolveInput);
  assert.equal(await maintenance.countActiveAdmissions('default'),0n);
  await assert.rejects(() => evidence.resolve(resolveInput), /Duplicate entry/);
  const [rawAdmission] = await db.query(
    'SELECT id FROM maintenance_active_admissions WHERE id=?',[recoveryEvidenceId]);
  assert.equal(rawAdmission.length,1, 'original evidence must remain immutable');
  await leases.release(evidenceLease);
  console.log('maintenance evidence MySQL audit rollback, immutable record, manual recovery: PASS');

  // Node admission must link the same durable operation ID as service paths.
  await db.query("UPDATE cluster_maintenance_states SET state='OPEN', generation=15 WHERE cluster_id='default'");
  process.env.DOCKLANE_MAINTENANCE_ENFORCE='1';
  try {
    for (const type of ['service','drain','activate','labels']) {
      const resourceType = type === 'service' ? 'service' : 'node';
      const operationId = 'admission-link-' + type;
      const callback = async (connection) => {
        const journalId = await journal.prepare('default', 15n, 'agent-disposable', operationId, connection);
        const [rows] = await connection.query(
          'SELECT operation_id, resource_type FROM maintenance_active_admissions WHERE cluster_id=? AND resource_id=?',
          ['default','test-'+type]);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].operation_id, operationId);
        assert.equal(rows[0].resource_type, resourceType);
        await journal.transition(journalId,'PREPARED','REJECTED',connection);
      };
      if(type==='service') await admissionLock.withServiceLock('default','test-'+type,callback);
      else await admissionLock.withNodeAndServiceLocks('default','test-'+type,[],callback);
    }
  } finally {
    if(savedEnforce===undefined) delete process.env.DOCKLANE_MAINTENANCE_ENFORCE;
    else process.env.DOCKLANE_MAINTENANCE_ENFORCE=savedEnforce;
  }
  console.log('maintenance real MySQL service/node admission operation linkage: PASS');

  // Isolated MySQL acceptance for the previously deadlocked
  // NEEDS_ATTENTION / MUTATION_NOT_OBSERVED / UNCERTAIN case.
  // Fingerprint evidence is fixture data; real endpoint fetches it from Agent
  // after the complete manager barrier is confirmed.
  assert.equal(await maintenance.requestClosing('default',15n,'관리자','recovery acceptance'),true);
  const uncertainOpId='manual-unobserved-svc';
  await db.query(`INSERT INTO operations
    (id,cluster_id,service_id,type,status,actor_id,expected_version,
     before_spec_hash,target_spec_hash,target_force_update,error_code,error_message)
    VALUES (?,'default','svc-fixture','RESTART','NEEDS_ATTENTION','operator',1,
      'before','after',1,'MUTATION_NOT_OBSERVED','response lost')`,[uncertainOpId]);
  const uncertainDispatchId=await journal.prepare('default',16n,'agent-fixture',uncertainOpId);
  await journal.transition(uncertainDispatchId,'PREPARED','SENDING');
  await journal.transition(uncertainDispatchId,'SENDING','UNCERTAIN');
  const resolveLease=await leases.acquire('default',30);
  await assert.rejects(()=>evidence.resolve({
    clusterId:'default',generation:16n,type:'DISPATCH',
    evidenceId:uncertainDispatchId,actorId:'관리자',reason:'verified not applied',
    observation:'all managers blocked, resource unchanged; CP stopped',lease:resolveLease,
    observedUnchanged:{version:2,specHash:'before'},
  }),/verified unchanged resource fingerprint/);
  await db.query(`CREATE TRIGGER reject_test_manual_recovery_audit BEFORE INSERT ON audit_events
    FOR EACH ROW BEGIN
      IF NEW.action = 'MUTATION_MANUALLY_RECONCILED' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'manual recovery audit failure';
      END IF;
    END`);
  try {
    await assert.rejects(() => evidence.resolve({
      clusterId:'default',generation:16n,type:'DISPATCH',
      evidenceId:uncertainDispatchId,actorId:'관리자',reason:'verified not applied',
      observation:'all managers blocked, resource unchanged; CP stopped',lease:resolveLease,
      observedUnchanged:{version:1,specHash:'before'},
    }), /manual recovery audit failure/);
  } finally {
    await db.query('DROP TRIGGER reject_test_manual_recovery_audit');
  }
  const [failedRecovery] = await db.query('SELECT status FROM operations WHERE id=?',[uncertainOpId]);
  assert.equal(failedRecovery[0].status,'NEEDS_ATTENTION','audit failure rolls back terminalization');
  await evidence.resolve({
    clusterId:'default',generation:16n,type:'DISPATCH',
    evidenceId:uncertainDispatchId,actorId:'관리자',reason:'verified not applied',
    observation:'all managers blocked, resource unchanged; CP stopped',lease:resolveLease,
    observedUnchanged:{version:1,specHash:'before'},
  });
  const [terminalSvc]=await db.query('SELECT status,error_code FROM operations WHERE id=?',[uncertainOpId]);
  assert.equal(terminalSvc[0].status,'FAILED');
  assert.equal(terminalSvc[0].error_code,'MANUAL_MUTATION_NOT_OBSERVED');
  const [originalDispatch]=await db.query('SELECT phase FROM maintenance_dispatches WHERE id=?',[uncertainDispatchId]);
  assert.equal(originalDispatch[0].phase,'UNCERTAIN');
  await assert.rejects(()=>evidence.resolve({
    clusterId:'default',generation:16n,type:'DISPATCH',
    evidenceId:uncertainDispatchId,actorId:'관리자',reason:'duplicate',
    observation:'duplicate',lease:resolveLease,
    observedUnchanged:{version:1,specHash:'before'},
  }),/Duplicate entry/);
  // Node reconciliation uses the same audited terminalization contract.
  const nodeUnobservedId='manual-unobserved-node';
  await db.query(`INSERT INTO node_operations
    (id,cluster_id,node_id,type,status,actor_id,expected_version,
      before_spec_hash,target_spec_hash,target_availability,affected_service_ids,error_code,error_message)
    VALUES (?,'default','node-fixture','DRAIN','NEEDS_ATTENTION','operator',1,
      'node-before','node-after','drain','[]','NODE_MUTATION_NOT_OBSERVED','response lost')`,
    [nodeUnobservedId]);
  const nodeDispatchId=await journal.prepare('default',16n,'agent-fixture',nodeUnobservedId);
  await journal.transition(nodeDispatchId,'PREPARED','SENDING');
  await journal.transition(nodeDispatchId,'SENDING','UNCERTAIN');
  await evidence.resolve({
    clusterId:'default',generation:16n,type:'DISPATCH',evidenceId:nodeDispatchId,
    actorId:'관리자',reason:'node unchanged after blocking all managers',
    observation:'node version and spec remain unchanged; old CP stopped',
    lease:resolveLease,observedUnchanged:{version:1,specHash:'node-before'},
  });
  const [terminalNode]=await db.query('SELECT status,error_code FROM node_operations WHERE id=?',[nodeUnobservedId]);
  assert.equal(terminalNode[0].status,'FAILED');
  assert.equal(terminalNode[0].error_code,'MANUAL_MUTATION_NOT_OBSERVED');
  // Simulate late persistence from a second CP using the actual repository
  // state writers. A committed manual FAILED outcome must be terminal even if
  // an observation made before the resolution arrives afterward.
  const serviceOperations = new OperationRepository(db);
  const nodeOperations = new NodeOperationRepository(db);
  const staleWrites = [
    () => serviceOperations.markRunning(staleConnection, uncertainOpId),
    () => serviceOperations.markVerifying(staleConnection, uncertainOpId, 2),
    () => serviceOperations.markVerificationPending(staleConnection, uncertainOpId, 'STALE', 'stale observation'),
    () => serviceOperations.markSuccess(staleConnection, uncertainOpId, 2),
    () => serviceOperations.markNeedsAttention(staleConnection, uncertainOpId, 'MUTATION_NOT_OBSERVED', 'stale observation'),
    () => serviceOperations.markFailed(staleConnection, uncertainOpId, 'STALE', 'stale observation'),
    () => nodeOperations.markRunning(staleConnection, nodeUnobservedId),
    () => nodeOperations.markVerifying(staleConnection, nodeUnobservedId, 2),
    () => nodeOperations.markSuccess(staleConnection, nodeUnobservedId, 2),
    () => nodeOperations.markNeedsAttention(staleConnection, nodeUnobservedId, 'NODE_MUTATION_NOT_OBSERVED', 'stale observation'),
    () => nodeOperations.markFailed(staleConnection, nodeUnobservedId, 'STALE', 'stale observation'),
  ];
  const staleConnection = await db.getConnection();
  try {
    for (const write of staleWrites) {
      await write();
      const [service] = await staleConnection.query(
        'SELECT status,error_code FROM operations WHERE id=?',[uncertainOpId]);
      const [node] = await staleConnection.query(
        'SELECT status,error_code FROM node_operations WHERE id=?',[nodeUnobservedId]);
      assert.equal(service[0].status,'FAILED');
      assert.equal(service[0].error_code,'MANUAL_MUTATION_NOT_OBSERVED');
      assert.equal(node[0].status,'FAILED');
      assert.equal(node[0].error_code,'MANUAL_MUTATION_NOT_OBSERVED');
    }
  } finally {
    staleConnection.release();
  }
  console.log('maintenance real MySQL 11 stale service/node state updates retain terminal FAILED: PASS');
  await leases.release(resolveLease);
  console.log('maintenance actual MySQL unobserved service/node + uncertain dispatch manual recovery: PASS');


  // Regression: startup reconciliation holds the real MySQL resource lock.
  // Manual resolution must not perform Agent observation until it acquires
  // the same lock. Retrying after release must succeed without re-sending.
  const raceServiceId = 'maintenance-race-svc';
  const raceOperationId = 'maintenance-race-operation';
  await db.query(\`INSERT INTO operations
    (id,cluster_id,service_id,type,status,actor_id,expected_version,
      before_spec_hash,target_spec_hash,target_force_update,error_code,error_message)
    VALUES (?,'default',?,'RESTART','NEEDS_ATTENTION','operator',1,
      'race-before','race-after',1,'MUTATION_NOT_OBSERVED','response lost')\`,
    [raceOperationId,raceServiceId]);
  const raceDispatchId = await journal.prepare('default',16n,'agent-fixture',raceOperationId);
  await journal.transition(raceDispatchId,'PREPARED','SENDING');
  await journal.transition(raceDispatchId,'SENDING','UNCERTAIN');
  const raceLease = await leases.acquire('default',30);
  let releaseServiceLock;
  let enteredServiceLock;
  const serviceEntered = new Promise(resolve => { enteredServiceLock=resolve; });
  const holdService = new Promise(resolve => { releaseServiceLock=resolve; });
  const holder = admissionLock.withServiceRecoveryLock('default',raceServiceId,async()=>{
    enteredServiceLock();
    await holdService;
  });
  await serviceEntered;
  let serviceObservations = 0;
  const raceResolve = {
    clusterId:'default',generation:16n,type:'DISPATCH',evidenceId:raceDispatchId,
    actorId:'관리자',reason:'observed unchanged after CP termination',
    observation:'all managers BLOCKED and service fingerprint unchanged',
    lease:raceLease,
    observeResource:async()=>{
      serviceObservations++;
      return {version:1,specHash:'race-before'};
    },
  };
  try {
    await assert.rejects(()=>evidence.resolve(raceResolve),/Another mutation is in progress/);
    assert.equal(serviceObservations,0,'manual recovery cannot observe before resource lock');
    const [heldState]=await db.query('SELECT status FROM operations WHERE id=?',[raceOperationId]);
    assert.equal(heldState[0].status,'NEEDS_ATTENTION');
  } finally {
    releaseServiceLock();
    await holder;
  }
  await evidence.resolve(raceResolve);
  assert.equal(serviceObservations,1);
  const [raceTerminal]=await db.query('SELECT status,error_code FROM operations WHERE id=?',[raceOperationId]);
  assert.equal(raceTerminal[0].status,'FAILED');
  assert.equal(raceTerminal[0].error_code,'MANUAL_MUTATION_NOT_OBSERVED');
  const lateConn=await db.getConnection();
  try {
    await new OperationRepository(db).markSuccess(lateConn,raceOperationId,2);
    const [protectedState]=await lateConn.query('SELECT status,error_code FROM operations WHERE id=?',[raceOperationId]);
    assert.equal(protectedState[0].status,'FAILED');
    assert.equal(protectedState[0].error_code,'MANUAL_MUTATION_NOT_OBSERVED');
  } finally { lateConn.release(); }

  // Node recovery also locks every affected service. A simultaneous service
  // recovery must prevent node manual terminalization before observation.
  const raceNodeId='maintenance-race-node';
  const raceNodeOp='maintenance-race-node-operation';
  const affectedService='maintenance-shared-service';
  await db.query(\`INSERT INTO node_operations
    (id,cluster_id,node_id,type,status,actor_id,expected_version,
      before_spec_hash,target_spec_hash,target_availability,affected_service_ids,
      error_code,error_message)
    VALUES (?,'default',?,'DRAIN','NEEDS_ATTENTION','operator',1,
      'node-race-before','node-race-after','drain',?,
      'NODE_MUTATION_NOT_OBSERVED','response lost')\`,
    [raceNodeOp,raceNodeId,JSON.stringify([affectedService])]);
  const nodeRaceDispatchId=await journal.prepare('default',16n,'agent-fixture',raceNodeOp);
  await journal.transition(nodeRaceDispatchId,'PREPARED','SENDING');
  await journal.transition(nodeRaceDispatchId,'SENDING','UNCERTAIN');
  let releaseSharedLock;
  let enteredSharedLock;
  const sharedEntered=new Promise(resolve=>{enteredSharedLock=resolve;});
  const holdShared=new Promise(resolve=>{releaseSharedLock=resolve;});
  const sharedHolder=admissionLock.withServiceRecoveryLock('default',affectedService,async()=>{
    enteredSharedLock();await holdShared;
  });
  await sharedEntered;
  let nodeObservations=0;
  const nodeRaceResolve={
    clusterId:'default',generation:16n,type:'DISPATCH',
    evidenceId:nodeRaceDispatchId,actorId:'관리자',
    reason:'node unchanged after confirmed CP termination',
    observation:'all manager barriers BLOCKED, node and affected service checked',
    lease:raceLease,
    observeResource:async()=>{
      nodeObservations++;return {version:1,specHash:'node-race-before'};
    },
  };
  try {
    await assert.rejects(()=>evidence.resolve(nodeRaceResolve),/Another mutation is in progress/);
    assert.equal(nodeObservations,0,'node recovery must wait for affected service lock');
  } finally { releaseSharedLock();await sharedHolder; }
  await evidence.resolve(nodeRaceResolve);
  assert.equal(nodeObservations,1);
  const [nodeRaceTerminal]=await db.query('SELECT status,error_code FROM node_operations WHERE id=?',[raceNodeOp]);
  assert.equal(nodeRaceTerminal[0].status,'FAILED');
  assert.equal(nodeRaceTerminal[0].error_code,'MANUAL_MUTATION_NOT_OBSERVED');
  await leases.release(raceLease);
  console.log('maintenance real MySQL service/node recovery lock contention, observation ordering, terminal CAS: PASS');

  console.log('database migration PoC: PASS');
} finally {
  await db.onModuleDestroy();
}
NODE
