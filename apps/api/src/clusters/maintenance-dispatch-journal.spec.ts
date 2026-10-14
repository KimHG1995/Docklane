import assert from 'node:assert/strict';
import test from 'node:test';
import { MaintenanceDispatchJournal } from './maintenance-dispatch-journal.js';

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
