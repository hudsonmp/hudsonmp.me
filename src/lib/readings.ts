import fs from 'node:fs';
import path from 'node:path';

export type Reading = { title: string; url: string };

/**
 * Read at build time (and per request in dev). Deliberately not an `import`: the /readings/add editor
 * rewrites this file, and an import would make the dev server reload the editor on every save.
 */
export function loadReadings(): Reading[] {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'src', 'data', 'readings.json'), 'utf8'));
  } catch {
    return [];
  }
}
