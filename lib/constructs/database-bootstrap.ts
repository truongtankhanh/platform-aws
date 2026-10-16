import { CustomResource, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as rds from 'aws-cdk-lib/aws-rds';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { fileURLToPath } from 'node:url';

export interface DatabaseBootstrapProps {
  instance: rds.DatabaseInstance;
  vpc: ec2.IVpc;
  /** Database (and owning login) name → secret with `{ username, password }`. */
  databases: Record<string, secretsmanager.ISecret>;
  logRetention: logs.RetentionDays;
  /** Changing it re-runs the bootstrap (new passwords in the system secrets reach PostgreSQL). */
  generation: number;
}

/**
 * Creates each system's database and login on the shared instance (lambda/database-bootstrap).
 * Runs when the set of databases or the generation changes, and is safe to run again.
 */
export class DatabaseBootstrap extends Construct {
  readonly function: NodejsFunction;

  constructor(scope: Construct, id: string, props: DatabaseBootstrapProps) {
    super(scope, id);

    const securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc: props.vpc,
      description: 'Database bootstrap function',
      allowAllOutbound: true,
    });
    props.instance.connections.allowDefaultPortFrom(securityGroup, 'Database bootstrap');

    this.function = new NodejsFunction(this, 'Function', {
      entry: fileURLToPath(new URL('../../lambda/database-bootstrap/index.ts', import.meta.url)),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: Duration.minutes(2),
      memorySize: 256,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [securityGroup],
      environment: { NODE_EXTRA_CA_CERTS: '/var/runtime/ca-cert.pem' },
      logGroup: new logs.LogGroup(this, 'Logs', {
        retention: props.logRetention,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      bundling: {
        format: OutputFormat.ESM,
        externalModules: ['@aws-sdk/*', 'pg-native'],
        // pg is CommonJS; give the ESM bundle a `require` for it.
        banner:
          "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
    });

    props.instance.secret?.grantRead(this.function);
    for (const secret of Object.values(props.databases)) secret.grantRead(this.function);

    const provider = new cr.Provider(this, 'Provider', {
      onEventHandler: this.function,
      logGroup: new logs.LogGroup(this, 'ProviderLogs', {
        retention: props.logRetention,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });

    const resource = new CustomResource(this, 'Resource', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::DatabaseBootstrap',
      properties: {
        host: props.instance.dbInstanceEndpointAddress,
        port: props.instance.dbInstanceEndpointPort,
        masterSecretArn: props.instance.secret!.secretArn,
        generation: String(props.generation),
        databases: Object.fromEntries(
          Object.entries(props.databases).map(([name, secret]) => [name, secret.secretArn]),
        ),
      },
    });
    resource.node.addDependency(props.instance);
  }
}
