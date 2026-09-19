import { DB_NAME, __closeDbForTests } from '../src/storage/db';

export async function resetDb(): Promise<void> {
  await __closeDbForTests();
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}
