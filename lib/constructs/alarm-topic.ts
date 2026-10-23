import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

/**
 * `AlarmProps` with the choice that differs most between alarms made mandatory: what a gap in the
 * data means. For a counter that only exists while something happens it is "fine", for a heartbeat
 * it is "breaching", and CloudWatch's own default ("missing") is rarely what either wants.
 */
export type TopicAlarmProps = cloudwatch.AlarmProps & {
  treatMissingData: cloudwatch.TreatMissingData;
};

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

  /**
   * Creates an alarm in `scope` that notifies the topic when it fires and when it recovers. It is
   * created in the caller's scope, not in this construct, so each alarm keeps the id and path it
   * has in its own stack.
   */
  alarm(scope: Construct, id: string, props: TopicAlarmProps): cloudwatch.Alarm {
    const alarm = new cloudwatch.Alarm(scope, id, props);
    alarm.addAlarmAction(new actions.SnsAction(this.topic));
    alarm.addOkAction(new actions.SnsAction(this.topic));
    return alarm;
  }
}
