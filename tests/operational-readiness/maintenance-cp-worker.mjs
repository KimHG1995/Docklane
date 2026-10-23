import { Database } from '../../apps/api/dist/db/database.js';
import { MaintenanceControlLease } from '../../apps/api/dist/clusters/maintenance-control-lease.js';
const db = new Database();
try {
  await db.onModuleInit();
  const lease = new MaintenanceControlLease(db);
  const holding = process.argv.includes('--hold-for-sigkill');
  const acquired = await lease.acquire('default',holding ? 5 : 30);
  process.stdout.write(JSON.stringify({token:acquired.token.toString(),holding})+'\n');
  if (holding) {
    // The parent kills this *separate* CP process with SIGKILL. No finally
    // cleanup runs: the DB lease must expire without becoming reusable early.
    await new Promise(()=>{});
  } else {
    await lease.release(acquired);
  }
} catch(error) {
  process.stderr.write(String(error)+'\n');
  process.exitCode=2;
} finally { await db.onModuleDestroy(); }
