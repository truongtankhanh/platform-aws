import type { CloudFormationCustomResourceEvent } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { handle, type Clients } from './index.js';

const CERT_ID = 'a'.repeat(64);
const TOKEN = 'arn:aws:lambda:ap-southeast-1:111111111111:function:provider';

function fakeClients(options: { missing?: boolean } = {}) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const record = (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    calls.push([command.constructor.name, command.input]);
    if (options.missing && command.constructor.name !== 'CreateKeysAndCertificateCommand') {
      throw Object.assign(new Error('gone'), { name: 'ResourceNotFoundException' });
    }
    if (command.constructor.name === 'CreateKeysAndCertificateCommand') {
      return {
        certificateId: CERT_ID,
        certificateArn: `arn:aws:iot:ap-southeast-1:111111111111:cert/${CERT_ID}`,
        certificatePem: '-----BEGIN CERTIFICATE-----',
        keyPair: { PrivateKey: '-----BEGIN RSA PRIVATE KEY-----', PublicKey: 'pub' },
      };
    }
    return {};
  };
  const clients = {
    iot: { send: async (c: never) => record(c) },
    secrets: { send: async (c: never) => record(c) },
  } as unknown as Clients;
  return { clients, calls };
}

const base = {
  ServiceToken: TOKEN,
  ResponseURL: 'https://example.invalid',
  StackId: 'stack',
  RequestId: 'req',
  LogicalResourceId: 'Cert',
  ResourceType: 'Custom::IotClientCertificate',
  ResourceProperties: { ServiceToken: TOKEN, policyName: 'ingest-policy', secretArn: 'arn:secret' },
};

describe('IoT client certificate custom resource', () => {
  it('creates a key pair, stores it only in the secret, attaches the policy, returns no key', async () => {
    const { clients, calls } = fakeClients();
    const result = await handle(
      { ...base, RequestType: 'Create' } as CloudFormationCustomResourceEvent,
      clients,
    );

    expect(calls.map(([name]) => name)).toEqual([
      'CreateKeysAndCertificateCommand',
      'PutSecretValueCommand',
      'AttachPolicyCommand',
    ]);
    const stored = JSON.parse(calls[1]![1].SecretString as string);
    expect(stored).toEqual({
      certificatePem: '-----BEGIN CERTIFICATE-----',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----',
    });
    expect(result?.PhysicalResourceId).toBe(CERT_ID);
    expect(JSON.stringify(result)).not.toContain('PRIVATE KEY');
  });

  it('deactivates and deletes the certificate on delete, tolerating one already gone', async () => {
    const event = {
      ...base,
      RequestType: 'Delete',
      PhysicalResourceId: CERT_ID,
    } as CloudFormationCustomResourceEvent;
    const { clients, calls } = fakeClients();
    await handle(event, clients);
    expect(calls.map(([name]) => name)).toEqual([
      'DetachPolicyCommand',
      'UpdateCertificateCommand',
      'DeleteCertificateCommand',
    ]);
    expect(calls[0]![1].target).toBe(`arn:aws:iot:ap-southeast-1:111111111111:cert/${CERT_ID}`);

    const gone = fakeClients({ missing: true });
    await expect(handle(event, gone.clients)).resolves.toBeDefined();
  });

  it('ignores a delete for a resource whose create never produced a certificate', async () => {
    const { clients, calls } = fakeClients();
    await handle(
      {
        ...base,
        RequestType: 'Delete',
        PhysicalResourceId: 'failed-create',
      } as CloudFormationCustomResourceEvent,
      clients,
    );
    expect(calls).toEqual([]);
  });

  it('moves the policy when it changes, and replaces the certificate when the secret changes', async () => {
    const update = (old: object) =>
      ({
        ...base,
        RequestType: 'Update',
        PhysicalResourceId: CERT_ID,
        OldResourceProperties: { ...base.ResourceProperties, ...old },
      }) as CloudFormationCustomResourceEvent;

    const moved = fakeClients();
    await handle(update({ policyName: 'old-policy' }), moved.clients);
    expect(moved.calls.map(([name, input]) => `${name}:${input.policyName}`)).toEqual([
      'DetachPolicyCommand:old-policy',
      'AttachPolicyCommand:ingest-policy',
    ]);

    const replaced = fakeClients();
    await handle(update({ secretArn: 'arn:old-secret' }), replaced.clients);
    expect(replaced.calls[0]![0]).toBe('CreateKeysAndCertificateCommand');
  });
});
