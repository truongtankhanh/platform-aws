import { Aws, CustomResource, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as iot from 'aws-cdk-lib/aws-iot';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { fileURLToPath } from 'node:url';
import { logGroup, type LogPolicy } from '../retention.js';

export interface IotClientCertificateProps {
  policy: iot.CfnPolicy;
  /** Retention and removal of the two log groups this construct creates. */
  logs: LogPolicy;
}

/**
 * An AWS IoT client certificate for a service, with its private key only in Secrets Manager
 * (lambda/iot-certificate). The secret holds `{ certificatePem, privateKey }`.
 */
export class IotClientCertificate extends Construct {
  readonly secret: secretsmanager.Secret;
  readonly certificateArn: string;

  constructor(scope: Construct, id: string, props: IotClientCertificateProps) {
    super(scope, id);

    // Created with a placeholder; the custom resource writes the real key pair before anything
    // that depends on this construct starts.
    this.secret = new secretsmanager.Secret(this, 'Secret', {
      description: 'AWS IoT client certificate and private key (written by a custom resource)',
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const fn = new NodejsFunction(this, 'Function', {
      entry: fileURLToPath(new URL('../../lambda/iot-certificate/index.ts', import.meta.url)),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: Duration.minutes(1),
      logGroup: logGroup(this, 'Logs', props.logs),
      bundling: { format: OutputFormat.ESM, externalModules: ['@aws-sdk/*'] },
    });
    this.secret.grantWrite(fn);
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        // CreateKeysAndCertificate has no resource-level permissions.
        actions: ['iot:CreateKeysAndCertificate'],
        resources: ['*'],
      }),
    );
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        // Attaching a policy is authorised on its target, the certificate, whose id is not known
        // before creation; scoped to this account and region.
        actions: [
          'iot:AttachPolicy',
          'iot:DetachPolicy',
          'iot:UpdateCertificate',
          'iot:DeleteCertificate',
        ],
        resources: [`arn:${Aws.PARTITION}:iot:${Aws.REGION}:${Aws.ACCOUNT_ID}:cert/*`],
      }),
    );

    const provider = new cr.Provider(this, 'Provider', {
      onEventHandler: fn,
      logGroup: logGroup(this, 'ProviderLogs', props.logs),
    });

    const resource = new CustomResource(this, 'Resource', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::IotClientCertificate',
      properties: { policyName: props.policy.ref, secretArn: this.secret.secretArn },
    });
    this.certificateArn = resource.getAttString('CertificateArn');
  }
}
