import assert from 'node:assert/strict';
import test from 'node:test';
import { MaintenanceDispatchJournal } from './maintenance-dispatch-journal.js';
import { isDeterministicAgentRejection, MaintenancePreDispatchRejection } from '../agent/agent-client.js';

test('dispatch must durably prepare before any send', async () => {
  const calls: string[] = [];
  const journal = new MaintenanceDispatchJournal({
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.startsWith('INSERT')) return [{ affectedRows: 1 }];
      return [{ affectedRows: 1 }];
    },
  } as never);
  const id = await journal.prepare('default', 9007199254740993n, 'agent1', 'operation1');
  assert.match(id, /^[0-9a-f-]{36}$/);
  await journal.transition(id, 'PREPARED', 'SENDING');
  await journal.transition(id, 'SENDING', 'UNCERTAIN');
  assert.equal(calls.length, 3);
});

test('journal failure before send must fail closed', async () => {
  const journal = new MaintenanceDispatchJournal({
    query: async () => { throw new Error('db down'); },
  } as never);
  await assert.rejects(() => journal.prepare('default', 1n, 'agent1', 'operation1'), /journal unavailable before send/);
});

test('uncertain dispatch cannot be acknowledged later', async () => {
  const journal = new MaintenanceDispatchJournal({ query: async () => [{ affectedRows: 1 }] } as never);
  await assert.rejects(() => journal.transition('id', 'UNCERTAIN', 'ACKNOWLEDGED'), /Invalid dispatch evidence transition/);
});

test('journal uses provided lock session without acquiring another pool connection', async () => {
  const captured: unknown[][] = [];
  const connection = { query: async (_sql: string, args: unknown[]) => {
    captured.push(args);
    return [{ affectedRows: 1 }];
  }};
  const journal = new MaintenanceDispatchJournal({
    query: async () => { throw new Error('unexpected extra pool checkout'); },
  } as never);
  const id = await journal.prepare('default', 3n, 'agent1', 'operation1', connection as never);
  await journal.transition(id, 'PREPARED', 'SENDING', connection as never);
  assert.equal(captured.length, 2);
  assert.equal(captured[0]?.[2], '3');
});

test('beginSend binds prepared dispatch to OPEN maintenance generation and operation', async () => {
  const statements: string[] = [];
  const parameters: unknown[][] = [];
  const journal = new MaintenanceDispatchJournal({
    query: async (sql: string, args: unknown[]) => {
      statements.push(sql);
      parameters.push(args);
      return [{ affectedRows: statements.length === 1 ? 1 : 0 }];
    },
  } as never);
  await journal.beginSend('id', 'default', 5n, 'agent-a', 'operation-a');
  assert.match(statements[0]!, /maintenance.state = 'OPEN'/);
  assert.match(statements[0]!, /maintenance.generation = \?/);
  assert.deepEqual(parameters[0], ['id','default','agent-a','operation-a','5','5']);
  await assert.rejects(
    () => journal.beginSend('id','default',5n,'agent-a','operation-a'),
    /generation or maintenance state changed/,
  );
});

test('journaled transport preserves uncertain response and does not resend', async () => {
  const phases: string[] = [];
  let sends = 0;
  const journal = new MaintenanceDispatchJournal({
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith('UPDATE maintenance_dispatches SET phase')) phases.push(String(params[0]));
      return [{ affectedRows: 1 }];
    },
  } as never);
  await assert.rejects(() => journal.execute('default', 4n, 'manager-a', 'operation-1',
    async () => { sends++; throw new Error('response lost'); }, () => false), /response lost/);
  assert.equal(sends, 1);
  assert.deepEqual(phases, ['UNCERTAIN']);
});

test('journaled transport does not send if beginSend fails', async () => {
  let sends = 0;
  const journal = new MaintenanceDispatchJournal({
    query: async (sql: string) => [{ affectedRows: sql.startsWith('UPDATE') ? 0 : 1 }],
  } as never);
  await assert.rejects(() => journal.execute('default', 4n, 'manager-a', 'operation-2',
    async () => { sends++; }, () => false), /generation or maintenance state changed/);
  assert.equal(sends, 0);
});

test('failed journal acknowledgement after successful transport never replays HTTP', async () => {
  let sends = 0;
  const journal = new MaintenanceDispatchJournal({
    query: async (sql: string, args: unknown[] = []) => {
      if (sql.startsWith('UPDATE maintenance_dispatches SET phase') && args[0] === 'ACKNOWLEDGED') {
        throw new Error('commit response lost');
      }
      return [{ affectedRows: 1 }];
    },
  } as never);
  await assert.rejects(() => journal.execute('default', 1n, 'manager-a', 'op',
    async () => { sends++; return { accepted: true }; }, () => false),
    /commit response lost/);
  assert.equal(sends, 1);
});
test('journal prepare failure is definite pre-dispatch denial and HTTP is never called', async () => {
  let sends = 0;
  const journal = new MaintenanceDispatchJournal({
    query: async () => { throw new Error('db unavailable'); },
  } as never);
  await assert.rejects(() => journal.execute('default', 1n, 'manager-a', 'op',
    async () => { sends++; }, () => false),
    (error: unknown) => error instanceof MaintenancePreDispatchRejection &&
      isDeterministicAgentRejection(error));
  assert.equal(sends, 0);
});
