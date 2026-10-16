import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';
import pg from 'pg';
import { describe, plan, type DatabaseSpec } from './plan.js';

/**
 * Custom resource: creates one database and one owning login per system on the shared RDS
 * instance, with passwords from each system's own secret. Idempotent; deleting the resource keeps
 * the databases (data outlives the stack).
 */

interface Properties {
  host: string;
  port: string;
  masterSecretArn: string;
  /** name → secret ARN holding `{ "username": name, "password": … }` */
  databases: Record<string, string>;
}

const secrets = new SecretsManagerClient({});

async function readSecret(arn: string): Promise<{ username: string; password: string }> {
  const { SecretString } = await secrets.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!SecretString) throw new Error(`Secret ${arn} has no string value`);
  return JSON.parse(SecretString) as { username: string; password: string };
}

export async function handler(event: CloudFormationCustomResourceEvent) {
  const physicalResourceId = 'database-bootstrap';
  if (event.RequestType === 'Delete') return { PhysicalResourceId: physicalResourceId };

  const props = event.ResourceProperties as unknown as Properties & { ServiceToken: string };
  const master = await readSecret(props.masterSecretArn);
  const specs: DatabaseSpec[] = [];
  for (const [name, arn] of Object.entries(props.databases)) {
    const { username, password } = await readSecret(arn);
    if (username !== name) throw new Error(`Secret for "${name}" names user "${username}"`);
    specs.push({ name, password });
  }

  const client = new pg.Client({
    host: props.host,
    port: Number(props.port),
    user: master.username,
    password: master.password,
    database: 'postgres',
    // The Lambda Node.js runtime ships the RDS certificate authorities in /var/runtime/ca-cert.pem,
    // loaded through NODE_EXTRA_CA_CERTS (set on the function), so the server is verified.
    ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  try {
    await bootstrap(client, specs);
  } finally {
    await client.end();
  }
  return { PhysicalResourceId: physicalResourceId };
}

/** Exported for the integration test, which runs it against a real PostgreSQL. */
export async function bootstrap(client: pg.Client, specs: DatabaseSpec[]): Promise<string[]> {
  const roles = await client.query<{ rolname: string }>('SELECT rolname FROM pg_roles');
  const databases = await client.query<{ datname: string }>('SELECT datname FROM pg_database');
  const steps = plan(specs, {
    roles: new Set(roles.rows.map((r) => r.rolname)),
    databases: new Set(databases.rows.map((d) => d.datname)),
  });
  for (const step of steps) {
    // format() quotes identifiers and literals server-side; nothing is concatenated here.
    const placeholders = step.args.map((_, i) => `$${i + 1}::text`).join(', ');
    const { rows } = await client.query<{ sql: string }>(
      `SELECT format($${step.args.length + 1}::text, ${placeholders}) AS sql`,
      [...step.args, step.template],
    );
    await client.query(rows[0]!.sql);
  }
  const log = describe(steps);
  console.log(JSON.stringify({ message: 'database bootstrap applied', steps: log }));
  return log;
}
