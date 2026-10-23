import { Aws, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iot from 'aws-cdk-lib/aws-iot';
import type * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cr from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';
import type { StageConfig } from '../config.js';
import type { AlarmTopic } from '../constructs/alarm-topic.js';
import { IotClientCertificate } from '../constructs/iot-client-certificate.js';
import { MetricsSidecar } from '../constructs/metrics-sidecar.js';
import { allowDatabaseAccess } from '../database-access.js';
import { logGroup, logPolicy } from '../retention.js';
import { runningTaskCount } from '../service-metrics.js';

export interface TelemetryStackProps extends StackProps {
  config: StageConfig;
  /** ops-command-center's API and Keycloak, which alert delivery calls over Service Connect. */
  commandCenter: { api: ec2.ISecurityGroup; keycloak: ec2.ISecurityGroup };
  vpc: ec2.IVpc;
  cluster: ecs.ICluster;
  database: rds.DatabaseInstance;
  telemetryLogin: secretsmanager.ISecret;
  ingestRepository: ecr.IRepository;
  alarms: AlarmTopic;
}

/** Topic layout and share group of iot-telemetry-pipeline (its ADR-0001). */
export const TELEMETRY_TOPIC_FILTER = 'campus/+/+/telemetry';
export const SHARE_GROUP = 'ingest';
export const INGEST_CLIENT_ID_PREFIX = 'ingest';
const INGEST_PORT = 3100;
const PIPELINE_CLIENT_ID = 'telemetry-pipeline';

/**
 * iot-telemetry-pipeline on AWS: AWS IoT Core is the broker, the ingest service runs on Fargate
 * and joins one MQTT 5 shared subscription from every task (docs/adr/0003).
 */
export class TelemetryStack extends Stack {
  readonly ingestPolicy: iot.CfnPolicy;
  readonly devicePolicy: iot.CfnPolicy;

  constructor(scope: Construct, id: string, props: TelemetryStackProps) {
    super(scope, id, props);
    const { config } = props;
    const ingest = config.telemetry.ingest;
    const logs = logPolicy(config.observability);
    const arn = (resource: string) =>
      `arn:${Aws.PARTITION}:iot:${Aws.REGION}:${Aws.ACCOUNT_ID}:${resource}`;

    // ---------------------------------------------------------------- IoT policies

    // In IoT policies, MQTT's + and # are literal characters, so the subscribe resource below
    // allows exactly this one shared filter; `*` is the policy wildcard for received topics.
    this.ingestPolicy = new iot.CfnPolicy(this, 'IngestPolicy', {
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: 'iot:Connect',
            Resource: arn(`client/${INGEST_CLIENT_ID_PREFIX}-*`),
          },
          {
            Effect: 'Allow',
            Action: 'iot:Subscribe',
            Resource: arn(`topicfilter/$share/${SHARE_GROUP}/${TELEMETRY_TOPIC_FILTER}`),
          },
          { Effect: 'Allow', Action: 'iot:Receive', Resource: arn('topic/campus/*/*/telemetry') },
        ],
      },
    });

    // Devices are things named after their device id, with a `zone` attribute. Each may connect
    // only as itself and publish only to its own topic — a stolen device certificate cannot
    // impersonate another device or zone.
    this.devicePolicy = new iot.CfnPolicy(this, 'DevicePolicy', {
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: 'iot:Connect',
            Resource: arn('client/${iot:Connection.Thing.ThingName}'),
            Condition: { Bool: { 'iot:Connection.Thing.IsAttached': 'true' } },
          },
          {
            Effect: 'Allow',
            Action: 'iot:Publish',
            Resource: arn(
              'topic/campus/${iot:Connection.Thing.Attributes[zone]}/${iot:Connection.Thing.ThingName}/telemetry',
            ),
          },
        ],
      },
    });

    const certificate = new IotClientCertificate(this, 'IngestCertificate', {
      policy: this.ingestPolicy,
      logs,
    });

    const endpoint = new cr.AwsCustomResource(this, 'IotEndpoint', {
      onUpdate: {
        service: 'Iot',
        action: 'describeEndpoint',
        parameters: { endpointType: 'iot:Data-ATS' },
        physicalResourceId: cr.PhysicalResourceId.of('iot-data-ats-endpoint'),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
      installLatestAwsSdk: false,
    });
    const iotEndpoint = endpoint.getResponseField('endpointAddress');

    // ---------------------------------------------------------------- ingest service

    // Keycloak generates this client's secret when it imports the realm (scripts/prepare-realm.sh
    // removes the demo value); an administrator copies it here once (docs/runbook.md). Until then
    // deliveries fail with invalid_client and the outbox keeps them for retry.
    const clientSecret = new secretsmanager.Secret(this, 'PipelineClientSecret', {
      description: `Keycloak client secret of ${PIPELINE_CLIENT_ID} (occ realm), copied from Keycloak`,
    });

    const task = new ecs.FargateTaskDefinition(this, 'IngestTask', {
      cpu: ingest.cpu,
      memoryLimitMiB: ingest.memoryMiB,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64 },
    });
    task.addContainer('ingest', {
      image: ecs.ContainerImage.fromEcrRepository(props.ingestRepository, config.imageTag),
      portMappings: [{ containerPort: INGEST_PORT }],
      environment: {
        // No password in the URL: node-postgres falls back to PGPASSWORD, which is a secret.
        DATABASE_URL: `postgres://telemetry@${props.database.dbInstanceEndpointAddress}:5432/telemetry?sslmode=verify-full`,
        // Amazon Root CA 1 is in Node's bundled trust store, so no MQTT_CA_PEM is needed.
        MQTT_URL: `mqtts://${iotEndpoint}:8883`,
        MQTT_SHARE_GROUP: SHARE_GROUP,
        MQTT_CLIENT_ID_PREFIX: INGEST_CLIENT_ID_PREFIX,
        MQTT_CONNECTIONS: String(ingest.mqttConnections),
        MIGRATE_ON_BOOT: 'true',
        // Alerts become incidents in ops-command-center, over Service Connect, authenticated with
        // the pipeline's client credentials (its ADR-0006). Keycloak's hostname is fixed to the
        // public URL, so a token fetched on this internal address still carries the public issuer.
        OCC_API_URL: `http://occ-api:3000/api`,
        OCC_TOKEN_URL: `http://keycloak:8080/auth/realms/occ/protocol/openid-connect/token`,
        OCC_CLIENT_ID: PIPELINE_CLIENT_ID,
      },
      secrets: {
        PGPASSWORD: ecs.Secret.fromSecretsManager(props.telemetryLogin, 'password'),
        MQTT_CERT_PEM: ecs.Secret.fromSecretsManager(certificate.secret, 'certificatePem'),
        MQTT_KEY_PEM: ecs.Secret.fromSecretsManager(certificate.secret, 'privateKey'),
        OCC_CLIENT_SECRET: ecs.Secret.fromSecretsManager(clientSecret),
      },
      healthCheck: {
        command: [
          'CMD-SHELL',
          `wget -qO- http://127.0.0.1:${INGEST_PORT}/api/health > /dev/null || exit 1`,
        ],
        interval: Duration.seconds(10),
        timeout: Duration.seconds(3),
        startPeriod: Duration.seconds(30),
        retries: 3,
      },
      // Readings received in the last flush window are written on SIGTERM (its ADR-0002).
      stopTimeout: Duration.seconds(30),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'ingest',
        logGroup: logGroup(this, 'IngestLogs', logs),
      }),
    });

    new MetricsSidecar(this, 'IngestMetrics', {
      taskDefinition: task,
      target: `localhost:${INGEST_PORT}`,
      namespace: 'Platform/Telemetry',
      declarations: [
        {
          dimensions: [[]],
          metricNameSelectors: ['^telemetry_sequence_gaps_total$', '^telemetry_readings_total$'],
        },
        { dimensions: [['result']], metricNameSelectors: ['^telemetry_messages_total$'] },
        { dimensions: [['reason']], metricNameSelectors: ['^telemetry_rejections_total$'] },
        { dimensions: [[]], metricNameSelectors: ['^telemetry_buffered_readings$'] },
      ],
      logs,
    });

    const securityGroup = new ec2.SecurityGroup(this, 'IngestSecurityGroup', {
      vpc: props.vpc,
      description: 'Telemetry ingest tasks: outbound only',
    });
    const service = new ecs.FargateService(this, 'Ingest', {
      cluster: props.cluster,
      taskDefinition: task,
      desiredCount: ingest.minTasks,
      // Keep the shared-subscription group populated during deploys: a group with no member
      // drops QoS 1 messages unless a member holds a persistent session.
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      securityGroups: [securityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      // A Service Connect client: resolves `occ-api` and `keycloak`, publishes nothing.
      serviceConnectConfiguration: {},
    });
    service.node.addDependency(certificate);
    // Created here, not on the command center's side, so that stack never depends on this one.
    for (const [id, target, port] of [
      ['IngestToApi', props.commandCenter.api, 3000],
      ['IngestToKeycloak', props.commandCenter.keycloak, 8080],
    ] as const) {
      new ec2.CfnSecurityGroupIngress(this, id, {
        groupId: target.securityGroupId,
        sourceSecurityGroupId: securityGroup.securityGroupId,
        ipProtocol: 'tcp',
        fromPort: port,
        toPort: port,
        description: 'Telemetry ingest delivers alerts',
      });
    }
    allowDatabaseAccess(
      this,
      'IngestToDatabase',
      props.database,
      securityGroup,
      'Telemetry ingest',
    );

    const scaling = service.autoScaleTaskCount({
      minCapacity: ingest.minTasks,
      maxCapacity: ingest.maxTasks,
    });
    scaling.scaleOnCpuUtilization('Cpu', { targetUtilizationPercent: ingest.targetCpuPercent });

    // ---------------------------------------------------------------- alarms

    // Any lost message is worth a look: the pipeline's completeness is measured, not assumed.
    props.alarms.alarm(this, 'SequenceGaps', {
      metric: new cloudwatch.Metric({
        namespace: 'Platform/Telemetry',
        metricName: 'telemetry_sequence_gaps_total',
        statistic: 'Sum',
        period: Duration.minutes(5),
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        'Devices reported sequence gaps: messages were lost between device and database',
    });
    // The service itself, not only what it reports: a dead ingest also stops its own metrics, so
    // the alarms above and below cannot tell "no messages" from "nobody listening". Deploys keep
    // the running count at the minimum or above (minimum healthy 100%), and autoscaling never goes
    // below it. No data means no task.
    props.alarms.alarm(this, 'IngestTasksLow', {
      metric: runningTaskCount(props.cluster, service),
      threshold: ingest.minTasks,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 5,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      alarmDescription: `Fewer than ${ingest.minTasks} ingest task(s) running for 5 minutes: telemetry is not consumed at full capacity`,
    });
    // Only where devices are expected: a demo stage has none, and would alarm for ever.
    if (config.telemetry.devicesExpected) {
      props.alarms.alarm(this, 'NoReadings', {
        metric: new cloudwatch.Metric({
          namespace: 'Platform/Telemetry',
          metricName: 'telemetry_readings_total',
          statistic: 'Sum',
          period: Duration.minutes(5),
        }),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        evaluationPeriods: 3,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
        alarmDescription: 'No readings stored for 15 minutes',
      });
    }
  }
}
