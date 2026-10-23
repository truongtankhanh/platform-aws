import { Duration } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import type * as ecs from 'aws-cdk-lib/aws-ecs';

/**
 * Tasks the service is running, from Container Insights (enabled on the cluster, network.ts). One
 * minute resolution, and the minimum so that a dip inside a period is not averaged away. When a
 * service has no task the metric can stop being reported, so alarms on it must treat missing data
 * as breaching.
 */
export function runningTaskCount(
  cluster: ecs.ICluster,
  service: ecs.BaseService,
): cloudwatch.Metric {
  return new cloudwatch.Metric({
    namespace: 'ECS/ContainerInsights',
    metricName: 'RunningTaskCount',
    dimensionsMap: { ClusterName: cluster.clusterName, ServiceName: service.serviceName },
    statistic: 'Minimum',
    period: Duration.minutes(1),
  });
}
