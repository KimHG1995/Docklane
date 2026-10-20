import { Database } from '../../apps/api/dist/db/database.js';
import { MaintenanceControlLease } from '../../apps/api/dist/clusters/maintenance-control-lease.js';
const db = new Database();
try {
  await db.onModuleInit();
  const lease = new MaintenanceControlLease(db);
  const acquired = await lease.acquire('default',30);
  await lease.release(acquired);
  process.stdout.write(JSON.stringify({token:acquired.token.toString()})+'\n');
} catch(error) {
  process.stderr.write(String(error)+'\n');
  process.exitCode=2;
} finally { await db.onModuleDestroy(); }
