import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import type { DatabaseName, StageConfig } from '../config.js';
import type { AlarmTopic } from '../constructs/alarm-topic.js';
import { DatabaseBootstrap } from '../constructs/database-bootstrap.js';
import { logPolicy, retention } from '../retention.js';

export interface DataStackProps extends StackProps {
  config: StageConfig;
  vpc: ec2.IVpc;
  alarms: AlarmTopic;
}

/**
 * One PostgreSQL instance per stage, one database and one login per system on it.
 *
 * Systems never share a database (platform ADR-0003); sharing an instance is a cost decision that
 * a stage can reverse by running this stack once per system (docs/adr/0002).
 */
export class DataStack extends Stack {
  readonly instance: rds.DatabaseInstance;
  /** Per-system login: `{ "username": <database name>, "password": … }`. */
  readonly secrets: Record<DatabaseName, secretsmanager.Secret>;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { config } = props;
    const db = config.database;

    const parameters = new rds.ParameterGroup(this, 'Parameters', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_17_9 }),
      parameters: {
        // Every client verifies the server certificate; plaintext is refused.
        'rds.force_ssl': '1',
        log_min_duration_statement: '1000',
        // A slow statement is logged with its text but not with the values bound to it: those are
        // the services' data (incident text, identifiers), and the log goes to CloudWatch for the
        // stage's retention. The default would log them in full (docs/adr/0008).
        log_parameter_max_length: '0',
        log_lock_waits: '1',
      },
    });

    this.instance = new rds.DatabaseInstance(this, 'Postgres', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_17_9 }),
      instanceType: new ec2.InstanceType(db.instanceType),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      multiAz: db.multiAz,
      allocatedStorage: db.allocatedStorageGiB,
      maxAllocatedStorage: db.maxAllocatedStorageGiB,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      credentials: rds.Credentials.fromGeneratedSecret('platform_admin'),
      parameterGroup: parameters,
      caCertificate: rds.CaCertificate.RDS_CA_RSA2048_G1,
      backupRetention: Duration.days(db.backupRetentionDays),
      deletionProtection: db.deletionProtection,
      removalPolicy: db.deletionProtection ? RemovalPolicy.RETAIN : RemovalPolicy.SNAPSHOT,
      cloudwatchLogsExports: ['postgresql', 'upgrade'],
      cloudwatchLogsRetention: retention(config.observability.logRetentionDays),
      monitoringInterval: Duration.seconds(60),
      autoMinorVersionUpgrade: true,
      publiclyAccessible: false,
    });

    // The admin login rotates on its own; system logins are rotated by re-running the bootstrap
    // (docs/runbook.md), because their new password has to reach the database and the service.
    this.instance.addRotationSingleUser({
      automaticallyAfter: Duration.days(30),
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    const secrets = {} as Record<DatabaseName, secretsmanager.Secret>;
    for (const name of db.databases) {
      secrets[name] = new secretsmanager.Secret(this, `${name}-login`, {
        description: `PostgreSQL login for the ${name} database`,
        generateSecretString: {
          secretStringTemplate: JSON.stringify({ username: name }),
          generateStringKey: 'password',
          passwordLength: 40,
          excludePunctuation: true,
        },
      });
    }
    this.secrets = secrets;

    new DatabaseBootstrap(this, 'Bootstrap', {
      instance: this.instance,
      vpc: props.vpc,
      databases: secrets,
      logs: logPolicy(config.observability),
      generation: db.loginGeneration,
    });

    // Three periods of five minutes. A gap in the data is "breaching": an instance that reports
    // nothing is not healthy.
    const sustained = {
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    };
    props.alarms.alarm(this, 'CpuHigh', {
      ...sustained,
      metric: this.instance.metricCPUUtilization({ period: Duration.minutes(5) }),
      threshold: 80,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'Database CPU above 80% for 15 minutes',
    });
    // FreeStorageSpace is the free space of the volume as it is now, and RDS publishes no metric for
    // how big that volume currently is, so "used more than X% of the maximum" cannot be computed.
    // What can be seen is the failure that matters: autoscaling grows the volume when free space
    // drops to 10% of it, so free space staying under 10% of the *initial* size for a quarter of
    // an hour means autoscaling is not keeping up (its cooldown, or the maximum was reached).
    // Comparing with the maximum instead fires while the first volume is still mostly empty.
    props.alarms.alarm(this, 'StorageLow', {
      ...sustained,
      metric: this.instance.metricFreeStorageSpace({ period: Duration.minutes(5) }),
      // Bytes.
      threshold: (db.allocatedStorageGiB / 10) * 1024 ** 3,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      alarmDescription:
        'Free storage under 10% of the initial volume for 15 minutes: storage autoscaling is not keeping up, or has reached its maximum',
    });
  }
}
