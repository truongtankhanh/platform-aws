import * as logs from 'aws-cdk-lib/aws-logs';

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
