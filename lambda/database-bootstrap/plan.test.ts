import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { bootstrap } from './index.js';
import { describe as describeSteps, plan } from './plan.js';

const none = { roles: new Set<string>(), databases: new Set<string>() };

describe('database bootstrap plan', () => {
  it('creates role and database for a new system, and closes the database to others', () => {
    expect(plan([{ name: 'ops', password: 'p' }], none).map((s) => s.template)).toEqual([
      'CREATE ROLE %I WITH LOGIN PASSWORD %L',
      'GRANT %I TO CURRENT_USER',
      'CREATE DATABASE %I OWNER %I',
      'REVOKE ALL ON DATABASE %I FROM PUBLIC',
    ]);
  });

  it('only resets the password when everything exists, so a re-run is harmless', () => {
    const existing = { roles: new Set(['ops']), databases: new Set(['ops']) };
    expect(plan([{ name: 'ops', password: 'p' }], existing).map((s) => s.template)).toEqual([
      'ALTER ROLE %I WITH LOGIN PASSWORD %L',
      'GRANT %I TO CURRENT_USER',
      'REVOKE ALL ON DATABASE %I FROM PUBLIC',
    ]);
  });

  it('rejects names that are not plain identifiers, and empty passwords', () => {
    expect(() => plan([{ name: 'ops; drop', password: 'p' }], none)).toThrow(
      /Invalid database name/,
    );
    expect(() => plan([{ name: 'Ops', password: 'p' }], none)).toThrow(/Invalid database name/);
    expect(() => plan([{ name: 'ops', password: '' }], none)).toThrow(/Empty password/);
  });

  it('never logs a password', () => {
    const log = describeSteps(plan([{ name: 'ops', password: 'hunter2' }], none)).join('\n');
    expect(log).not.toContain('hunter2');
    expect(log).toContain('CREATE ROLE %I (ops)');
  });
});

// Runs against a real PostgreSQL when one is provided (CI starts one); skipped otherwise.
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('database bootstrap against PostgreSQL', () => {
  it('creates isolated databases, applies twice without error, and rotates passwords', async () => {
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    try {
      const suffix = Date.now().toString(36);
      const names = [`ops_${suffix}`, `telemetry_${suffix}`];
      await bootstrap(
        admin,
        names.map((name) => ({ name, password: 'first-password' })),
      );
      await bootstrap(
        admin,
        names.map((name) => ({ name, password: 'second-password' })),
      );

      const login = async (user: string, database: string, password: string) => {
        // Not via connectionString: node-postgres lets the URL's credentials win over these.
        const { hostname, port } = new URL(url!);
        const client = new pg.Client({
          host: hostname,
          port: Number(port || 5432),
          user,
          database,
          password,
        });
        await client.connect();
        await client.end();
      };
      await login(names[0]!, names[0]!, 'second-password');
      await expect(login(names[0]!, names[0]!, 'first-password')).rejects.toThrow();
      // A system cannot connect to another system's database.
      await expect(login(names[0]!, names[1]!, 'second-password')).rejects.toThrow(
        /permission denied/,
      );

      for (const name of names) {
        await admin.query(`DROP DATABASE ${name}`);
        await admin.query(`DROP ROLE ${name}`);
      }
    } finally {
      await admin.end();
    }
  });
});
