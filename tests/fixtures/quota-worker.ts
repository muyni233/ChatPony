import { reserveCall } from '../../src/lib/quota';
import { closeDb } from '../../src/lib/db';
try {
  reserveCall(process.argv[2], process.argv[3], process.argv[4]);
  console.log('reserved');
} catch (error) {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : 'UNKNOWN';
  if (code === 'QUOTA_EXCEEDED') console.log('limited');
  else {
    console.error(error);
    process.exitCode = 1;
  }
} finally {
  closeDb();
}
