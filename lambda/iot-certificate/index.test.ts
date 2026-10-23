import type { CloudFormationCustomResourceEvent } from 'aws-lambda';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handle, type Clients } from './index.js';

const CERT_ID = 'a'.repeat(64);
const TOKEN = 'arn:aws:lambda:ap-southeast-1:111111111111:function:provider';

function fakeClients(
  options: {
    missing?: boolean;
    /** Names of the commands that throw (the call is still recorded). */
    failOn?: string[];
    /** CreateKeysAndCertificate answers without a private key. */
    incomplete?: boolean;
  } = {},
) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const record = (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    calls.push([command.constructor.name, command.input]);
    if (options.failOn?.includes(command.constructor.name)) {
      throw new Error(`boom ${command.constructor.name}`);
    }
    if (options.missing && command.constructor.name !== 'CreateKeysAndCertificateCommand') {
      throw Object.assign(new Error('gone'), { name: 'ResourceNotFoundException' });
    }
    if (command.constructor.name === 'CreateKeysAndCertificateCommand') {
      return {
        certificateId: CERT_ID,
        certificateArn: `arn:aws:iot:ap-southeast-1:111111111111:cert/${CERT_ID}`,
        certificatePem: '-----BEGIN CERTIFICATE-----',
        keyPair: options.incomplete
          ? undefined
          : { PrivateKey: '-----BEGIN RSA PRIVATE KEY-----', PublicKey: 'pub' },
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

afterEach(() => vi.restoreAllMocks());

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

  it('ignores a delete for a resource whose create never produced a certificate, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toContain('delete skipped');
    expect(String(warn.mock.calls[0]![0])).toContain('failed-create');
  });

  describe('when a create fails after the certificate exists', () => {
    const create = { ...base, RequestType: 'Create' } as CloudFormationCustomResourceEvent;

    it.each(['PutSecretValueCommand', 'AttachPolicyCommand'])(
      'deactivates and deletes the new certificate when %s fails, and rethrows that error',
      async (failing) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { clients, calls } = fakeClients({ failOn: [failing] });

        await expect(handle(create, clients)).rejects.toThrow(`boom ${failing}`);

        const [deactivate, remove] = calls.slice(-2);
        expect(deactivate).toEqual([
          'UpdateCertificateCommand',
          { certificateId: CERT_ID, newStatus: 'INACTIVE' },
        ]);
        expect(remove).toEqual([
          'DeleteCertificateCommand',
          { certificateId: CERT_ID, forceDelete: true },
        ]);
        expect(warn).toHaveBeenCalledOnce();
        expect(String(warn.mock.calls[0]![0])).toContain(CERT_ID);
      },
    );

    it('does not attach the policy to a certificate whose key could not be stored', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { clients, calls } = fakeClients({ failOn: ['PutSecretValueCommand'] });
      await expect(handle(create, clients)).rejects.toThrow();
      expect(calls.map(([name]) => name)).not.toContain('AttachPolicyCommand');
    });

    it('discards the certificate when the answer has no private key', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { clients, calls } = fakeClients({ incomplete: true });
      await expect(handle(create, clients)).rejects.toThrow(/incomplete result/);
      expect(calls.map(([name]) => name)).toEqual([
        'CreateKeysAndCertificateCommand',
        'UpdateCertificateCommand',
        'DeleteCertificateCommand',
      ]);
    });

    it('reports the original error, and logs the id, when the cleanup fails too', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { clients } = fakeClients({
        failOn: ['AttachPolicyCommand', 'UpdateCertificateCommand'],
      });

      await expect(handle(create, clients)).rejects.toThrow('boom AttachPolicyCommand');

      expect(error).toHaveBeenCalledOnce();
      expect(String(error.mock.calls[0]![0])).toContain(CERT_ID);
      expect(String(error.mock.calls[0]![0])).not.toContain('PRIVATE KEY');
    });
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
