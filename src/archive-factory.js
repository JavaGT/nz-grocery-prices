import { JsonlObservationRepository } from './repository.js';
import { SqliteArchiveRepository } from './sqlite/archive-repository.js';

/**
 * Pick archive backend from path extension.
 * .db / .sqlite → normalized SQLite archive (Option 4)
 * otherwise → legacy JSONL
 */
export function createObservationRepository(filePath = 'data/archive.db') {
  const path = String(filePath);
  if (/\.(db|sqlite|sqlite3)$/i.test(path)) {
    return new SqliteArchiveRepository(path);
  }
  return new JsonlObservationRepository(path);
}

export { SqliteArchiveRepository, JsonlObservationRepository };
