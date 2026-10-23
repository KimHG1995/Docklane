import assert from 'node:assert/strict';

// All Docker commands are scoped to the three containers already owned by the
// parent harness. Restore the member to the original Swarm before continuing.
export async function runClosedRejoinAcceptance({
  docker, containers, raw, maintenance, expected, targetNode, postMutationTo,
}) {
  const record = await maintenance.requireRecord('default');
  assert.equal(record.state, 'CLOSED');
  assert.equal(record.generation, 3n);
  const oldNodeId = targetNode.nodeId;
  const manager = containers['manager-03'];
  const address = container => docker('inspect', '--format',
    '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', container);
  const managerIp = address(manager);
  const leaderIp = address(containers['manager-01']);
  docker('exec', manager, 'docker', 'swarm', 'leave', '--force');
  docker('exec', manager, 'docker', 'swarm', 'init', '--advertise-addr', managerIp);
  const foreign = docker('exec', manager, 'docker', 'info', '--format', '{{.Swarm.Cluster.ID}}');
  assert.notEqual(foreign, expected);
  await assert.rejects(() => raw.inspectManagerBarrier('manager-03', oldNodeId, expected, 2n, 'BLOCKED'));
  await assert.rejects(() => raw.inspectConfiguredManagers(expected));
  // Give the foreign Swarm a real target, so refusal cannot pass merely
  // because the original service ID does not exist in that Swarm.
  const foreignService = docker('exec', manager, 'docker', 'service', 'create',
    '--detach=true', '--replicas', '0', '--no-resolve-image',
    '--name', 'docklane-closed-rejoin-probe', 'alpine:3.20', 'sleep', '3600');
  assert.match(foreignService, /^[0-9a-z]{12,}$/);
  const foreignVersion = docker('exec', manager, 'docker', 'service', 'inspect',
    foreignService, '--format', '{{.Version.Index}}');
  const denied = await postMutationTo('manager-03',
    `/v2/services/${foreignService}/restart`, foreign, 2n);
  assert.equal(denied.status, 409);
  assert.equal(JSON.parse(denied.body).code, 'MAINTENANCE_AGENT_BLOCKED');
  assert.equal(docker('exec', manager, 'docker', 'service', 'inspect',
    foreignService, '--format', '{{.Version.Index}}'), foreignVersion);
  const stillClosed = await maintenance.requireRecord('default');
  assert.equal(stillClosed.state, 'CLOSED');
  assert.equal(stillClosed.generation, 3n);

  // The old manager is permanently down. Demotion/removal only affects its
  // exact captured ID in the parent-owned disposable Swarm.
  const downDeadline = Date.now() + 60000;
  while (docker('exec', containers['manager-01'], 'docker', 'node', 'inspect',
    oldNodeId, '--format', '{{.Status.State}}') !== 'down') {
    if (Date.now() >= downDeadline) throw new Error('Departed manager did not become down');
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  docker('exec', containers['manager-01'], 'docker', 'node', 'demote', oldNodeId);
  docker('exec', containers['manager-01'], 'docker', 'node', 'rm', oldNodeId);
  docker('exec', manager, 'docker', 'swarm', 'leave', '--force');
  const token = docker('exec', containers['manager-01'], 'docker', 'swarm', 'join-token', '-q', 'manager');
  docker('exec', manager, 'docker', 'swarm', 'join', '--token', token,
    '--advertise-addr', managerIp, `${leaderIp}:2377`);
  const deadline = Date.now() + 60000;
  let restored;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const managers = await raw.inspectConfiguredManagers(expected);
      restored = managers.find(item => item.agentId === 'manager-03');
      assert.equal(managers.length, 3);
      assert.ok(restored);
      assert.notEqual(restored.nodeId, oldNodeId);
      await raw.inspectManagerBarrier('manager-03', restored.nodeId, expected, 2n, 'BLOCKED');
      break;
    } catch (error) {
      restored = undefined;
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
  if (!restored) throw new Error('Original Swarm member did not recover while CLOSED', {cause: lastError});
  // Callers must replace their old node baseline: a rejoined node is a new
  // canonical resource, not a new version of the removed node.
  Object.assign(targetNode, restored);
  return {
    state: 'CLOSED', generation: '3', oldNodeId, replacementNodeId: restored.nodeId,
    originalSwarmId: expected, foreignSwarmId: foreign,
    foreignBarrierRejected: true, mutationCode: JSON.parse(denied.body).code,
    restoredBlocked: true, foreignService, unchangedForeignVersion: foreignVersion,
  };
}
