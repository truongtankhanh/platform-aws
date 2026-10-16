/**
 * What the database bootstrap has to do, as a pure function of what already exists. Kept apart
 * from the handler so it can be tested without a database, and so a re-run is provably harmless.
 */

export interface DatabaseSpec {
  /** Database name, and the name of its owning login role. */
  name: string;
  password: string;
}

export interface ExistingState {
  roles: ReadonlySet<string>;
  databases: ReadonlySet<string>;
}

/** One SQL statement with its identifier and literal arguments, formatted server-side. */
export interface Step {
  /** `format()` template: %I identifiers, %L literals. */
  template: string;
  args: string[];
}

const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;

/**
 * Each system gets a login role named after its database, owning that database, with no access to
 * any other (platform ADR-0003: a system's database is private to it). Re-running sets the
 * password again, which is how a rotated secret reaches the database.
 */
export function plan(specs: readonly DatabaseSpec[], existing: ExistingState): Step[] {
  const steps: Step[] = [];
  for (const { name, password } of specs) {
    if (!IDENTIFIER.test(name)) throw new Error(`Invalid database name "${name}"`);
    if (!password) throw new Error(`Empty password for "${name}"`);

    steps.push(
      existing.roles.has(name)
        ? { template: 'ALTER ROLE %I WITH LOGIN PASSWORD %L', args: [name, password] }
        : { template: 'CREATE ROLE %I WITH LOGIN PASSWORD %L', args: [name, password] },
    );
    // The master user must be a member to create a database owned by the role (PostgreSQL 16+).
    steps.push({ template: 'GRANT %I TO CURRENT_USER', args: [name] });
    if (!existing.databases.has(name)) {
      steps.push({ template: 'CREATE DATABASE %I OWNER %I', args: [name, name] });
    }
    steps.push({ template: 'REVOKE ALL ON DATABASE %I FROM PUBLIC', args: [name] });
  }
  return steps;
}

/** For logs: the steps with every password replaced. */
export function describe(steps: readonly Step[]): string[] {
  return steps.map((step) =>
    step.template.includes('PASSWORD')
      ? `${step.template.replace(' WITH LOGIN PASSWORD %L', '')} (${step.args[0]})`
      : `${step.template} (${step.args.join(', ')})`,
  );
}
