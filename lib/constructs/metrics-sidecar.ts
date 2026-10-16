import type { RemovalPolicy } from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

/** Pinned: the collector's config format changes between releases. */
export const ADOT_COLLECTOR_IMAGE = 'public.ecr.aws/aws-observability/aws-otel-collector:v0.50.0';

export interface MetricDeclaration {
  /** Label sets to publish as CloudWatch dimensions, e.g. `[['service'], ['service', 'route']]`. */
  dimensions: string[][];
  /** Regular expressions on metric names. */
  metricNameSelectors: string[];
}

export interface MetricsSidecarProps {
  taskDefinition: ecs.TaskDefinition;
  /** Prometheus endpoint inside the task, e.g. `localhost:9464`. */
  target: string;
  metricsPath?: string;
  /** CloudWatch namespace, e.g. `Platform/CommandCenter`. */
  namespace: string;
  /** Only declared metrics become CloudWatch metrics; everything stays queryable in the log group. */
  declarations: MetricDeclaration[];
  retention: logs.RetentionDays;
  removalPolicy: RemovalPolicy;
}

/**
 * Turns a service's Prometheus endpoint into CloudWatch metrics with no Prometheus server: an
 * OpenTelemetry collector in the same task scrapes `localhost` and writes Embedded Metric Format
 * records, which CloudWatch extracts into metrics (docs/adr/0005).
 *
 * The scrape never leaves the task, so the metrics port needs no security-group rule — the same
 * "internal network only" rule the services' own ADRs set for it.
 */
export class MetricsSidecar extends Construct {
  readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: MetricsSidecarProps) {
    super(scope, id);

    this.logGroup = new logs.LogGroup(this, 'EmfLogGroup', {
      retention: props.retention,
      removalPolicy: props.removalPolicy,
    });

    const config = {
      receivers: {
        prometheus: {
          config: {
            scrape_configs: [
              {
                job_name: props.namespace,
                scrape_interval: '30s',
                metrics_path: props.metricsPath ?? '/metrics',
                static_configs: [{ targets: [props.target] }],
              },
            ],
          },
        },
      },
      exporters: {
        awsemf: {
          namespace: props.namespace,
          log_group_name: this.logGroup.logGroupName,
          dimension_rollup_option: 'NoDimensionRollup',
          metric_declarations: props.declarations.map((d) => ({
            dimensions: d.dimensions,
            metric_name_selectors: d.metricNameSelectors,
          })),
        },
      },
      service: {
        pipelines: { metrics: { receivers: ['prometheus'], exporters: ['awsemf'] } },
      },
    };

    props.taskDefinition.addContainer('metrics-collector', {
      image: ecs.ContainerImage.fromRegistry(ADOT_COLLECTOR_IMAGE),
      essential: false,
      cpu: 64,
      memoryReservationMiB: 128,
      environment: { AOT_CONFIG_CONTENT: JSON.stringify(config) },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'collector',
        logGroup: new logs.LogGroup(this, 'CollectorLogs', {
          retention: props.retention,
          removalPolicy: props.removalPolicy,
        }),
      }),
    });

    props.taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
        resources: [this.logGroup.logGroupArn, `${this.logGroup.logGroupArn}:*`],
      }),
    );
  }
}
