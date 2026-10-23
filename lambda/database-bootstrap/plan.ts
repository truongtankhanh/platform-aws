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
  /**
   * The only form of this step that may be logged. A step whose arguments include a secret writes
   * it by hand, leaving the secret out; every other step gets it from `plain()`. Being required, a
   * new step cannot reach the logs without someone deciding what is safe to print.
   */
  log: string;
}

/** A step whose arguments are all safe to log. Never use it when any argument is a secret. */
const plain = (template: string, args: string[]): Step => ({
  template,
  args,
  log: `${template} (${args.join(', ')})`,
});

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

    // The password is a literal in the statement text, so a server that logs a failing or slow
    // statement would log it too (see the logging audit); `log` leaves it out.
    steps.push(
      existing.roles.has(name)
        ? {
            template: 'ALTER ROLE %I WITH LOGIN PASSWORD %L',
            args: [name, password],
            log: `ALTER ROLE %I (${name})`,
          }
        : {
            template: 'CREATE ROLE %I WITH LOGIN PASSWORD %L',
            args: [name, password],
            log: `CREATE ROLE %I (${name})`,
          },
    );
    // The master user must be a member to create a database owned by the role (PostgreSQL 16+).
    steps.push(plain('GRANT %I TO CURRENT_USER', [name]));
    if (!existing.databases.has(name)) {
      steps.push(plain('CREATE DATABASE %I OWNER %I', [name, name]));
    }
    steps.push(plain('REVOKE ALL ON DATABASE %I FROM PUBLIC', [name]));
  }
  return steps;
}

/** For logs: each step as its own `log` form, which never contains a password. */
export function summarise(steps: readonly Step[]): string[] {
  return steps.map((step) => step.log);
}
