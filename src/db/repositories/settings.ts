/**
 * 설정 Repository (key/value)
 */
import { getDb } from '../client.js';
import type { SelectionStrategy } from '../../account-pool/manager.js';

const STRATEGIES: SelectionStrategy[] = ['round_robin', 'priority', 'least_used'];

export class SettingsRepository {
  get(key: string): string | null {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    getDb()
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  getStrategy(provider: string): SelectionStrategy {
    const v = this.get(`strategy.${provider}`);
    return v && (STRATEGIES as string[]).includes(v) ? (v as SelectionStrategy) : 'priority';
  }

  setStrategy(provider: string, strategy: string): void {
    if (!(STRATEGIES as string[]).includes(strategy)) {
      throw new Error(`Invalid strategy: ${strategy}. Use one of ${STRATEGIES.join(', ')}`);
    }
    this.set(`strategy.${provider}`, strategy);
  }

  getAll(): Record<string, string> {
    const rows = getDb().prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
  }
}

export { STRATEGIES };
