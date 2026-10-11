import { saveUserCharacter } from '../../src/lib/user-characters';
import { closeDb, getDb } from '../../src/lib/db';
import { AppError } from '../../src/lib/errors';
import { existsSync, writeFileSync } from 'node:fs';

const [userId, gate, ready] = process.argv.slice(2);
getDb();
writeFileSync(ready, 'ready');
while (!existsSync(gate)) await Bun.sleep(5);
try {
  await saveUserCharacter(userId, null, {
    name: 'Concurrent draft',
    personality: 'Test persona',
    active: false,
  });
  console.log('created');
} catch (error) {
  if (!(error instanceof AppError && error.code === 'CHARACTER_SLOTS_FULL')) throw error;
  console.log('full');
} finally {
  closeDb();
}
