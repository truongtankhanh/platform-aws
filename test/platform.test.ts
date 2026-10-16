import type { Stack } from 'aws-cdk-lib';
import { Match } from 'aws-cdk-lib/assertions';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveStage, STAGES } from '../lib/config.js';
import { retention } from '../lib/retention.js';
import {
  containers,
  environmentOf,
  flatten,
  secretNamesOf,
  synth,
  type Synthesised,
} from './helpers.js';

let staging: Synthesised;
let production: Synthesised;

beforeAll(() => {
  staging = synth('staging');
  production = synth('production');
});

describe('security checks (cdk-nag, AWS Solutions pack)', () => {
  it('passes for every stage with only the documented acknowledgements', () => {
    expect(() => staging.app.synth()).not.toThrow();
    expect(() => production.app.synth()).not.toThrow();
  });

  it('fails the build for a new finding', () => {
    const { app, platform } = synth('staging');
    // An unencrypted, unlogged bucket with no TLS policy: several AwsSolutions-S* rules.
    new s3.Bucket(platform.network as Stack, 'CarelessBucket', {
      encryption: s3.BucketEncryption.UNENCRYPTED,
    });
    expect(() => app.synth()).toThrow(/AwsSolutions-S/);
  });
});

describe('configuration', () => {
  it('refuses a stage that needs site values without them', () => {
    expect(() => resolveStage({ stage: 'production' })).toThrow(/needs site values/);
    expect(() => resolveStage({ stage: 'nope' })).toThrow(/Unknown stage/);
  });

  it('keeps every stage in one region and on a supported log retention', () => {
    for (const config of Object.values(STAGES)) {
      expect(config.env.region).toBe('ap-southeast-1');
      expect(() => retention(config.observability.logRetentionDays)).not.toThrow();
    }
    expect(() => retention(10)).toThrow(/not one CloudWatch supports/);
  });
});

describe('network', () => {
  it('has public, private and isolated tiers, and isolated subnets have no route out', () => {
    const t = staging.template('network');
    t.resourceCountIs('AWS::EC2::Subnet', 6);
    const routes = Object.values(t.findResources('AWS::EC2::Route')).map((r) => flatten(r));
    const toInternet = routes.filter((r) => r.includes('0.0.0.0/0'));
    // 2 public routes (internet gateway) + 2 app routes (NAT); none from the data tier.
    expect(toInternet).toHaveLength(4);
    expect(toInternet.some((r) => /dataSubnet/.test(r))).toBe(false);
  });

  it('logs rejected traffic and sizes NAT per stage', () => {
    staging
      .template('network')
      .hasResourceProperties('AWS::EC2::FlowLog', { TrafficType: 'REJECT' });
    staging.template('network').resourceCountIs('AWS::EC2::NatGateway', 1);
    production.template('network').resourceCountIs('AWS::EC2::NatGateway', 2);
  });
});

describe('database', () => {
  it('is private, encrypted, TLS-only and sized per stage', () => {
    staging.template('data').hasResourceProperties('AWS::RDS::DBInstance', {
      PubliclyAccessible: false,
      StorageEncrypted: true,
      MultiAZ: false,
      DeletionProtection: false,
      Engine: 'postgres',
    });
    production.template('data').hasResourceProperties('AWS::RDS::DBInstance', {
      MultiAZ: true,
      DeletionProtection: true,
      DBInstanceClass: 'db.m7g.large',
    });
    staging.template('data').hasResourceProperties('AWS::RDS::DBParameterGroup', {
      Parameters: Match.objectLike({ 'rds.force_ssl': '1' }),
    });
  });

  it('creates one database and login per system through the bootstrap', () => {
    const t = staging.template('data');
    t.hasResourceProperties('Custom::DatabaseBootstrap', {
      databases: { ops: Match.anyValue(), keycloak: Match.anyValue(), telemetry: Match.anyValue() },
    });
    for (const name of ['ops', 'keycloak', 'telemetry']) {
      t.hasResourceProperties('AWS::SecretsManager::Secret', {
        GenerateSecretString: Match.objectLike({
          SecretStringTemplate: JSON.stringify({ username: name }),
        }),
      });
    }
  });

  it('is reachable only from named security groups, never from an address range', () => {
    for (const stack of ['data', 'commandCenter', 'telemetry'] as const) {
      const ingress = staging.template(stack).findResources('AWS::EC2::SecurityGroupIngress');
      for (const rule of Object.values(ingress)) {
        if (rule.Properties.FromPort !== 5432) continue;
        expect(rule.Properties.CidrIp).toBeUndefined();
        expect(rule.Properties.SourceSecurityGroupId).toBeDefined();
      }
    }
  });
});

describe('command center', () => {
  it('lets only CloudFront reach the load balancer', () => {
    const t = staging.template('commandCenter');
    const albIngress = Object.values(t.findResources('AWS::EC2::SecurityGroupIngress')).filter(
      (r) => flatten(r.Properties.GroupId).includes('LoadBalancerSecurityGroup'),
    );
    expect(albIngress).toHaveLength(1);
    expect(albIngress[0]!.Properties).toMatchObject({ FromPort: 80, ToPort: 80 });
    expect(flatten(albIngress[0]!.Properties.SourcePrefixListId)).toContain('CloudFrontPrefixList');
    // No ingress from any address range anywhere in the stack (outbound rules may be open).
    const inline = Object.values(t.findResources('AWS::EC2::SecurityGroup')).flatMap(
      (g) => (g.Properties.SecurityGroupIngress ?? []) as object[],
    );
    const standalone = Object.values(t.findResources('AWS::EC2::SecurityGroupIngress')).map(
      (r) => r.Properties,
    );
    for (const rule of [...inline, ...standalone]) expect(rule).not.toHaveProperty('CidrIp');
  });

  it('routes /api, /socket.io and /auth to the load balancer uncached, the rest to S3', () => {
    const t = staging.template('commandCenter');
    const distribution = Object.values(t.findResources('AWS::CloudFront::Distribution'))[0]!;
    const config = distribution.Properties.DistributionConfig;
    const patterns = config.CacheBehaviors.map((b: { PathPattern: string }) => b.PathPattern);
    expect(patterns).toEqual(['/api/*', '/socket.io/*', '/auth/*']);
    for (const behavior of config.CacheBehaviors) {
      // Managed policy CachingDisabled.
      expect(behavior.CachePolicyId).toBe('4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
      expect(behavior.ViewerProtocolPolicy).toBe('https-only');
    }
    expect(flatten(config.Origins)).toContain('OriginAccessControlId');
  });

  it('never serves the Keycloak admin console publicly', () => {
    const t = staging.template('commandCenter');
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Priority: 5,
      Conditions: [
        Match.objectLike({ PathPatternConfig: { Values: ['/auth/admin', '/auth/admin/*'] } }),
      ],
      Actions: [
        Match.objectLike({
          Type: 'fixed-response',
          FixedResponseConfig: Match.objectLike({ StatusCode: '403' }),
        }),
      ],
    });
    // The block comes before the rule that forwards /auth to Keycloak.
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Priority: 30,
      Conditions: [Match.objectLike({ PathPatternConfig: { Values: ['/auth', '/auth/*'] } })],
    });
  });

  it('rate-limits per client like the Compose stack, keyed on the forwarded address', () => {
    const t = staging.template('commandCenter');
    const acl = Object.values(t.findResources('AWS::WAFv2::WebACL'))[0]!;
    const limits = Object.fromEntries(
      acl.Properties.Rules.filter(
        (r: { Statement: object }) => 'RateBasedStatement' in r.Statement,
      ).map(
        (r: {
          Name: string;
          Statement: { RateBasedStatement: { Limit: number; AggregateKeyType: string } };
        }) => [
          r.Name,
          [r.Statement.RateBasedStatement.Limit, r.Statement.RateBasedStatement.AggregateKeyType],
        ],
      ),
    );
    expect(limits).toEqual({
      'api-per-client': [1200, 'FORWARDED_IP'],
      'socket-handshakes-per-client': [120, 'FORWARDED_IP'],
    });
    t.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
  });

  it('configures the API for this deployment, with every secret from Secrets Manager', () => {
    const [api] = containers(staging.template('commandCenter'), 'ApiTask');
    const env = environmentOf(api!);
    expect(env).toMatchObject({
      DEPLOYMENT_ENV: 'staging',
      DB_NAME: 'ops',
      DB_USER: 'ops',
      DB_SSL: 'true',
      OIDC_AUDIENCE: 'occ-api',
      OIDC_JWKS_URL: 'http://keycloak:8080/auth/realms/occ/protocol/openid-connect/certs',
      TRUST_PROXY_HOPS: '2',
      API_DOCS_ENABLED: 'false',
      DEMO_MODE: 'true',
      CAMERA_SOURCE: 'mock',
    });
    expect(flatten(env.OIDC_ISSUER)).toContain('/auth/realms/occ');
    expect(secretNamesOf(api!)).toEqual(['DB_PASSWORD']);
    for (const name of Object.keys(env)) expect(name).not.toMatch(/PASSWORD|SECRET|PRIVATE|TOKEN/);
  });

  it('checks API readiness at the load balancer and scales on CPU', () => {
    const t = production.template('commandCenter');
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      HealthCheckPath: '/api/health/ready',
      Port: 3000,
    });
    t.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
      MinCapacity: 2,
      MaxCapacity: 6,
    });
  });

  it('serves a stage with a domain over HTTPS end to end, with real cameras and no demo', () => {
    const t = production.template('commandCenter');
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443,
      Protocol: 'HTTPS',
    });
    const distribution = Object.values(t.findResources('AWS::CloudFront::Distribution'))[0]!;
    const config = distribution.Properties.DistributionConfig;
    expect(config.Aliases).toEqual(['ops.langbiang-campus.example']);
    expect(config.ViewerCertificate.MinimumProtocolVersion).toBe('TLSv1.2_2021');
    expect(flatten(config.Origins)).toContain('"OriginProtocolPolicy":"https-only"');

    const [api] = containers(t, 'ApiTask');
    expect(environmentOf(api!)).toMatchObject({
      OIDC_ISSUER: 'https://ops.langbiang-campus.example/auth/realms/occ',
      DEMO_MODE: 'false',
      SEED_ON_BOOT: 'false',
      CAMERA_SOURCE: 'mediamtx',
      TELEMETRY_SOURCE: 'off',
    });
  });

  it('runs Keycloak with the public issuer and its own database login', () => {
    const [keycloak] = containers(production.template('commandCenter'), 'KeycloakTask');
    const env = environmentOf(keycloak!);
    expect(env.KC_HOSTNAME).toBe('https://ops.langbiang-campus.example/auth');
    expect(env.KC_DB_USERNAME).toBe('keycloak');
    expect(flatten(env.KC_DB_URL)).toContain('sslmode=verify-full');
    expect(secretNamesOf(keycloak!).sort()).toEqual([
      'KC_BOOTSTRAP_ADMIN_PASSWORD',
      'KC_DB_PASSWORD',
    ]);
  });

  it('turns metrics into CloudWatch metrics inside the task, with no open metrics port', () => {
    const [api, collector] = containers(staging.template('commandCenter'), 'ApiTask');
    expect(api!.Name).toBe('api');
    expect(collector!.Name).toBe('metrics-collector');
    expect(collector!.Essential).toBe(false);
    // The config embeds the log group's name, so it is a CloudFormation join; check its text.
    const config = flatten(environmentOf(collector!).AOT_CONFIG_CONTENT);
    expect(config).toContain('localhost:9464');
    expect(config).toContain('Platform/CommandCenter');
    const ingress = staging
      .template('commandCenter')
      .findResources('AWS::EC2::SecurityGroupIngress');
    expect(Object.values(ingress).some((r) => r.Properties.FromPort === 9464)).toBe(false);
  });
});

describe('telemetry', () => {
  it('lets the ingest service join exactly one shared subscription and nothing else', () => {
    const t = staging.template('telemetry');
    const policies = Object.values(t.findResources('AWS::IoT::Policy'));
    const ingest = policies.find((p) => flatten(p).includes('$share'))!;
    const statements = ingest.Properties.PolicyDocument.Statement as Array<{
      Action: string;
      Resource: unknown;
    }>;
    expect(statements.map((s) => s.Action)).toEqual([
      'iot:Connect',
      'iot:Subscribe',
      'iot:Receive',
    ]);
    expect(flatten(statements[0]!.Resource)).toContain(':client/ingest-*');
    expect(flatten(statements[1]!.Resource)).toContain(
      ':topicfilter/$share/ingest/campus/+/+/telemetry',
    );
    expect(flatten(statements[2]!.Resource)).toContain(':topic/campus/*/*/telemetry');
  });

  it('lets a device publish only to its own topic, as itself', () => {
    const t = staging.template('telemetry');
    const device = Object.values(t.findResources('AWS::IoT::Policy')).find((p) =>
      flatten(p).includes('Thing.ThingName'),
    )!;
    const text = flatten(device);
    expect(text).toContain(
      'topic/campus/${iot:Connection.Thing.Attributes[zone]}/${iot:Connection.Thing.ThingName}/telemetry',
    );
    expect(text).toContain('iot:Connection.Thing.IsAttached');
    expect(text).not.toContain('iot:Subscribe');
  });

  it('connects the ingest service to IoT Core with its certificate from Secrets Manager', () => {
    const [ingest] = containers(production.template('telemetry'), 'IngestTask');
    const env = environmentOf(ingest!);
    expect(flatten(env.MQTT_URL)).toMatch(/mqtts:\/\/.*:8883/);
    expect(env).toMatchObject({
      MQTT_SHARE_GROUP: 'ingest',
      MQTT_CLIENT_ID_PREFIX: 'ingest',
      MQTT_CONNECTIONS: '4',
      OCC_API_URL: '',
    });
    expect(flatten(env.DATABASE_URL)).toMatch(/^.*postgres:\/\/telemetry@.*sslmode=verify-full/);
    expect(flatten(env.DATABASE_URL)).not.toMatch(/telemetry:[^@]*@/);
    expect(secretNamesOf(ingest!).sort()).toEqual(['MQTT_CERT_PEM', 'MQTT_KEY_PEM', 'PGPASSWORD']);
  });

  it('keeps the subscription group populated during deploys and accepts no inbound traffic', () => {
    const t = staging.template('telemetry');
    t.hasResourceProperties('AWS::ECS::Service', {
      DeploymentConfiguration: Match.objectLike({ MinimumHealthyPercent: 100 }),
    });
    t.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Telemetry ingest tasks: outbound only',
      SecurityGroupIngress: Match.absent(),
    });
  });

  it('alarms on any lost message', () => {
    staging.template('telemetry').hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'telemetry_sequence_gaps_total',
      Namespace: 'Platform/Telemetry',
      Threshold: 0,
      ComparisonOperator: 'GreaterThanThreshold',
    });
  });
});
