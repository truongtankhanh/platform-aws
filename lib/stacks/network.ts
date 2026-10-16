import { RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import type { StageConfig } from '../config.js';
import { AlarmTopic } from '../constructs/alarm-topic.js';
import { retention } from '../retention.js';

export interface NetworkStackProps extends StackProps {
  config: StageConfig;
}

/**
 * The VPC, the ECS cluster every service runs in, and the stage's alarm topic.
 *
 * Three tiers: public subnets hold only the load balancer and NAT gateways; services run in
 * private subnets with outbound access; the database sits in isolated subnets with no route out.
 */
export class NetworkStack extends Stack {
  readonly vpc: ec2.Vpc;
  readonly cluster: ecs.Cluster;
  readonly alarms: AlarmTopic;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);
    const { config } = props;

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.40.0.0/16'),
      maxAzs: config.network.maxAzs,
      natGateways: config.network.natGateways,
      restrictDefaultSecurityGroup: true,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'app', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
        { name: 'data', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
      flowLogs: {
        rejected: {
          trafficType: ec2.FlowLogTrafficType.REJECT,
          destination: ec2.FlowLogDestination.toCloudWatchLogs(
            new logs.LogGroup(this, 'FlowLogs', {
              retention: retention(config.observability.logRetentionDays),
              removalPolicy: RemovalPolicy.DESTROY,
            }),
          ),
        },
      },
    });
    // Image layers and S3 traffic stay off the NAT gateways.
    this.vpc.addGatewayEndpoint('S3', { service: ec2.GatewayVpcEndpointAwsService.S3 });

    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: this.vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });
    // Service Connect: services call each other by short name (`keycloak`, `occ-api`).
    this.cluster.addDefaultCloudMapNamespace({
      name: `${config.name}.platform.internal`,
      useForServiceConnect: true,
    });

    this.alarms = new AlarmTopic(this, 'Alarms', { email: config.site?.alarmEmail });
  }
}
