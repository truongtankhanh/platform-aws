import { RemovalPolicy } from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import type { StageConfig } from './config.js';

/** CloudWatch accepts only certain retention periods; the config states days. */
export function retention(days: number): logs.RetentionDays {
  const allowed = Object.values(logs.RetentionDays).filter(
    (value): value is logs.RetentionDays => typeof value === 'number' && value > 0,
  );
  if (!allowed.includes(days as logs.RetentionDays)) {
    throw new Error(`Log retention of ${days} days is not one CloudWatch supports`);
  }
  return days as logs.RetentionDays;
}

/** How a stage keeps its log groups: for how long, and whether they outlive their stack. */
export interface LogPolicy {
  retention: logs.RetentionDays;
  removalPolicy: RemovalPolicy;
}

/** The stage's log policy, from `observability` (docs/adr/0007). */
export function logPolicy(observability: StageConfig['observability']): LogPolicy {
  return {
    retention: retention(observability.logRetentionDays),
    removalPolicy: observability.retainLogs ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
  };
}

/** A log group that follows the stage's policy. Every log group in this app is made here. */
export function logGroup(scope: Construct, id: string, policy: LogPolicy): logs.LogGroup {
  return new logs.LogGroup(scope, id, {
    retention: policy.retention,
    removalPolicy: policy.removalPolicy,
  });
}
