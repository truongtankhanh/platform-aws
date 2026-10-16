import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

/**
 * The id of AWS's managed prefix list of CloudFront's origin-facing addresses, looked up at deploy
 * time. The id differs per region, and a synth-time lookup would need AWS credentials in CI.
 */
export class CloudFrontOriginPrefixList extends Construct {
  readonly prefixListId: string;

  constructor(scope: Construct, id: string) {
    super(scope, id);
    const lookup = new cr.AwsCustomResource(this, 'Lookup', {
      onUpdate: {
        service: 'EC2',
        action: 'describeManagedPrefixLists',
        parameters: {
          Filters: [
            { Name: 'prefix-list-name', Values: ['com.amazonaws.global.cloudfront.origin-facing'] },
          ],
        },
        physicalResourceId: cr.PhysicalResourceId.of('cloudfront-origin-facing'),
        outputPaths: ['PrefixLists.0.PrefixListId'],
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
      installLatestAwsSdk: false,
    });
    this.prefixListId = lookup.getResponseField('PrefixLists.0.PrefixListId');
  }
}
