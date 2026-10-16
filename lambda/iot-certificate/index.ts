import {
  AttachPolicyCommand,
  CreateKeysAndCertificateCommand,
  DeleteCertificateCommand,
  DetachPolicyCommand,
  IoTClient,
  UpdateCertificateCommand,
} from '@aws-sdk/client-iot';
import { PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';

/**
 * Custom resource: an AWS IoT client certificate whose private key never appears in CloudFormation.
 *
 * CloudFormation can register a certificate only from a CSR, and keeps every custom-resource
 * response readable in the stack. So the key pair is created here, written straight to a Secrets
 * Manager secret the service reads at start, and only the certificate's id and ARN are returned.
 */

interface Properties {
  policyName: string;
  secretArn: string;
}

export interface Clients {
  iot: Pick<IoTClient, 'send'>;
  secrets: Pick<SecretsManagerClient, 'send'>;
}

const defaultClients: Clients = { iot: new IoTClient({}), secrets: new SecretsManagerClient({}) };

export const handler = (event: CloudFormationCustomResourceEvent) => handle(event, defaultClients);

export async function handle(event: CloudFormationCustomResourceEvent, clients: Clients) {
  const props = event.ResourceProperties as unknown as Properties;

  switch (event.RequestType) {
    case 'Create':
      return create(props, clients);

    case 'Update': {
      const old = event.OldResourceProperties as unknown as Properties;
      // A new secret needs a new key pair written to it: replace the certificate. CloudFormation
      // deletes the old one once the new physical id is in place.
      if (old.secretArn !== props.secretArn) return create(props, clients);
      const certificateArn = arnOf(event.PhysicalResourceId, event.ServiceToken);
      if (old.policyName !== props.policyName) {
        await clients.iot.send(
          new DetachPolicyCommand({ policyName: old.policyName, target: certificateArn }),
        );
        await clients.iot.send(
          new AttachPolicyCommand({ policyName: props.policyName, target: certificateArn }),
        );
      }
      return response(event.PhysicalResourceId, certificateArn);
    }

    case 'Delete': {
      const certificateId = event.PhysicalResourceId;
      if (!/^[0-9a-f]{64}$/.test(certificateId)) return { PhysicalResourceId: certificateId };
      const certificateArn = arnOf(certificateId, event.ServiceToken);
      await ignoreMissing(
        clients.iot.send(
          new DetachPolicyCommand({ policyName: props.policyName, target: certificateArn }),
        ),
      );
      await ignoreMissing(
        clients.iot.send(new UpdateCertificateCommand({ certificateId, newStatus: 'INACTIVE' })),
      );
      await ignoreMissing(
        clients.iot.send(new DeleteCertificateCommand({ certificateId, forceDelete: true })),
      );
      return { PhysicalResourceId: certificateId };
    }
  }
}

async function create(props: Properties, clients: Clients) {
  const created = await clients.iot.send(
    new CreateKeysAndCertificateCommand({ setAsActive: true }),
  );
  const { certificateId, certificateArn, certificatePem, keyPair } = created;
  if (!certificateId || !certificateArn || !certificatePem || !keyPair?.PrivateKey) {
    throw new Error('CreateKeysAndCertificate returned an incomplete result');
  }
  await clients.secrets.send(
    new PutSecretValueCommand({
      SecretId: props.secretArn,
      SecretString: JSON.stringify({ certificatePem, privateKey: keyPair.PrivateKey }),
    }),
  );
  await clients.iot.send(
    new AttachPolicyCommand({ policyName: props.policyName, target: certificateArn }),
  );
  return response(certificateId, certificateArn);
}

const response = (certificateId: string, certificateArn: string) => ({
  PhysicalResourceId: certificateId,
  Data: { CertificateId: certificateId, CertificateArn: certificateArn },
});

/** arn:aws:iot:<region>:<account>:cert/<id>, from the Lambda's own ARN (the service token). */
function arnOf(certificateId: string, serviceToken: string): string {
  const [, partition, , region, account] = serviceToken.split(':');
  return `arn:${partition}:iot:${region}:${account}:cert/${certificateId}`;
}

async function ignoreMissing(call: Promise<unknown>): Promise<void> {
  try {
    await call;
  } catch (error) {
    if ((error as { name?: string }).name !== 'ResourceNotFoundException') throw error;
  }
}
