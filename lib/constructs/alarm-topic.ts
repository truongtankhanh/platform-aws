import type * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

/** One notification topic per stage; every alarm in every stack reports to it. */
export class AlarmTopic extends Construct {
  readonly topic: sns.Topic;

  constructor(scope: Construct, id: string, props: { email?: string }) {
    super(scope, id);
    // Not encrypted with the AWS-managed SNS key: CloudWatch alarms cannot publish to a topic
    // that uses it. A customer-managed key would work; not worth one for alarm text.
    this.topic = new sns.Topic(this, 'Topic', { enforceSSL: true });
    if (props.email) this.topic.addSubscription(new subscriptions.EmailSubscription(props.email));
  }

  /** Alarm and recover notifications both go to the topic. */
  watch(alarm: cloudwatch.Alarm): cloudwatch.Alarm {
    alarm.addAlarmAction(new actions.SnsAction(this.topic));
    alarm.addOkAction(new actions.SnsAction(this.topic));
    return alarm;
  }
}
