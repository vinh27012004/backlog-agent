// Journal bền ở checkoutRoot/.team-work/journal.json (05 §4). Không chứa secret.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './util.mjs';

export class Journal {
  constructor(teamWork) {
    this.path = join(teamWork, 'journal.json');
    this.data = { version: 1, preparation: {}, items: {} };
    if (existsSync(this.path)) {
      try { this.data = { ...this.data, ...JSON.parse(readFileSync(this.path, 'utf8')) }; } catch { /* hỏng thì làm lại */ }
    }
  }

  item(key) {
    this.data.items[key] ??= { attempts: 0 };
    return this.data.items[key];
  }

  save() { writeFileAtomic(this.path, `${JSON.stringify(this.data, null, 2)}\n`); }
}
