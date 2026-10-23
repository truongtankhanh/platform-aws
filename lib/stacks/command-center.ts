import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import type * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';
import type { StageConfig } from '../config.js';
import type { AlarmTopic } from '../constructs/alarm-topic.js';
import { CloudFrontOriginPrefixList } from '../constructs/cloudfront-prefix-list.js';
import { MetricsSidecar } from '../constructs/metrics-sidecar.js';
import { allowDatabaseAccess } from '../database-access.js';
import { logGroup, logPolicy } from '../retention.js';

export interface CommandCenterStackProps extends StackProps {
  config: StageConfig;
  vpc: ec2.IVpc;
  cluster: ecs.ICluster;
  database: rds.DatabaseInstance;
  opsLogin: secretsmanager.ISecret;
  keycloakLogin: secretsmanager.ISecret;
  apiRepository: ecr.IRepository;
  keycloakRepository: ecr.IRepository;
  alarms: AlarmTopic;
}

const API_PORT = 3000;
const API_METRICS_PORT = 9464;
const KEYCLOAK_PORT = 8080;
const KEYCLOAK_MANAGEMENT_PORT = 9000;
const ORIGIN_VERIFY_HEADER = 'X-Origin-Verify';
const VIEWER_IP_HEADER = 'X-Viewer-Address';
/** Keycloak paths the console's sign-in uses; nothing else under /auth is forwarded. */
export const KEYCLOAK_PUBLIC_PATHS = ['/auth/realms/occ/*', '/auth/resources/*', '/auth/js/*'];
/** Paths under /auth that could normalise to somewhere else (ALB path patterns are case-sensitive). */
const AMBIGUOUS_AUTH_PATHS = [
  '/auth/*..*',
  '/auth/*%2e*',
  '/auth/*%2E*',
  '/auth/*%2f*',
  '/auth/*%2F*',
];

/**
 * ops-command-center: the operator console (static, on S3 behind CloudFront), the API (Fargate,
 * several replicas behind an ALB) and Keycloak (Fargate), all on one public origin.
 *
 * CloudFront routes `/api/*`, `/socket.io/*` and `/auth/*` to the load balancer and everything else
 * to the console bucket — the same single-origin layout as the Compose stack's nginx, so the
 * console, its OIDC client and the API need no changes and no CORS (docs/adr/0004).
 */
export class CommandCenterStack extends Stack {
  readonly distribution: cloudfront.Distribution;
  readonly consoleBucket: s3.Bucket;
  readonly publicUrl: string;
  /** Security groups other stacks may be let into (the telemetry pipeline delivers alerts). */
  readonly apiSecurityGroup: ec2.SecurityGroup;
  readonly keycloakSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: CommandCenterStackProps) {
    super(scope, id, props);
    const { config } = props;
    const cc = config.commandCenter;
    const logging = logPolicy(config.observability);
    const site = config.site;

    // ---------------------------------------------------------------- logs and buckets

    const accessLogs = new s3.Bucket(this, 'AccessLogs', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      // CloudFront standard logging writes with ACLs.
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      lifecycleRules: [{ expiration: Duration.days(config.observability.logRetentionDays) }],
      // Follows the stage's log policy (docs/adr/0007). Emptying a bucket on deletion only makes
      // sense when the bucket is deleted too, so a bucket that is kept keeps its objects.
      removalPolicy: logging.removalPolicy,
      autoDeleteObjects: logging.removalPolicy === RemovalPolicy.DESTROY,
    });

    this.consoleBucket = new s3.Bucket(this, 'Console', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      serverAccessLogsBucket: accessLogs,
      serverAccessLogsPrefix: 'console-bucket/',
      lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(30) }],
      // Not evidence of anything: every deploy rebuilds and republishes the console.
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ---------------------------------------------------------------- load balancer

    const albSecurityGroup = new ec2.SecurityGroup(this, 'LoadBalancerSecurityGroup', {
      vpc: props.vpc,
      description: 'Load balancer: reachable only from CloudFront',
      allowAllOutbound: false,
    });
    const cloudFront = new CloudFrontOriginPrefixList(this, 'CloudFrontPrefixList');
    const listenerPort = site ? 443 : 80;
    albSecurityGroup.addIngressRule(
      ec2.Peer.prefixList(cloudFront.prefixListId),
      ec2.Port.tcp(listenerPort),
      'CloudFront origin-facing addresses',
    );

    const alb = new elbv2.ApplicationLoadBalancer(this, 'LoadBalancer', {
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup,
      dropInvalidHeaderFields: true,
      // Socket.IO pings every 25 s; idle connections must outlive that comfortably.
      idleTimeout: Duration.seconds(120),
    });
    alb.logAccessLogs(accessLogs, 'alb');

    const listener = site
      ? alb.addListener('Https', {
          port: 443,
          protocol: elbv2.ApplicationProtocol.HTTPS,
          sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
          certificates: [elbv2.ListenerCertificate.fromArn(site.domain.loadBalancerCertificateArn)],
          open: false,
          defaultAction: elbv2.ListenerAction.fixedResponse(404),
        })
      : alb.addListener('Http', {
          port: 80,
          protocol: elbv2.ApplicationProtocol.HTTP,
          open: false,
          defaultAction: elbv2.ListenerAction.fixedResponse(404),
        });

    // The prefix list admits every CloudFront distribution, not only this one. CloudFront adds a
    // secret header to each origin request and the listener forwards nothing without it.
    const originVerify = new secretsmanager.Secret(this, 'OriginVerify', {
      description: 'Header value CloudFront sends to the load balancer (X-Origin-Verify)',
      generateSecretString: { excludePunctuation: true, passwordLength: 48 },
    });
    const fromThisDistribution = elbv2.ListenerCondition.httpHeader(ORIGIN_VERIFY_HEADER, [
      originVerify.secretValue.unsafeUnwrap(),
    ]);

    this.addWaf(alb);

    // ---------------------------------------------------------------- CloudFront

    // SPA routing: paths without a file extension are the console's client-side routes.
    const spaRewrite = new cloudfront.Function(this, 'SpaRewrite', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        "function handler(event) { var r = event.request; if (!r.uri.includes('.')) { r.uri = '/index.html'; } return r; }",
      ),
    });

    // X-Forwarded-For starts with whatever the viewer sent, so it cannot key a rate limit. This
    // function overwrites a header with the address CloudFront saw the connection from.
    const viewerAddress = new cloudfront.Function(this, 'ViewerAddress', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        `function handler(event) { event.request.headers['${VIEWER_IP_HEADER}'] = { value: event.viewer.ip }; return event.request; }`,
      ),
    });

    const albOrigin = new origins.LoadBalancerV2Origin(alb, {
      protocolPolicy: site
        ? cloudfront.OriginProtocolPolicy.HTTPS_ONLY
        : cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      readTimeout: Duration.seconds(60),
      customHeaders: { [ORIGIN_VERIFY_HEADER]: originVerify.secretValue.unsafeUnwrap() },
    });
    const toAlb: cloudfront.BehaviorOptions = {
      origin: albOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      // Host is forwarded: with a custom domain CloudFront then validates the load balancer's
      // certificate against that domain instead of the *.elb.amazonaws.com name.
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      functionAssociations: [
        { function: viewerAddress, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
      ],
    };

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `ops-command-center (${config.name})`,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.consoleBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        functionAssociations: [
          { function: spaRewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
      additionalBehaviors: { '/api/*': toAlb, '/socket.io/*': toAlb, '/auth/*': toAlb },
      ...(site
        ? {
            domainNames: [site.domain.name],
            certificate: acm.Certificate.fromCertificateArn(
              this,
              'CloudFrontCertificate',
              site.domain.cloudFrontCertificateArn,
            ),
            minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
          }
        : {}),
      enableLogging: true,
      logBucket: accessLogs,
      logFilePrefix: 'cloudfront/',
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
    });

    this.publicUrl = site
      ? `https://${site.domain.name}`
      : `https://${this.distribution.distributionDomainName}`;

    // ---------------------------------------------------------------- Keycloak

    const keycloakAdmin = new secretsmanager.Secret(this, 'KeycloakAdmin', {
      description: 'Keycloak bootstrap administrator',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'platform-admin' }),
        generateStringKey: 'password',
        passwordLength: 32,
        excludePunctuation: true,
      },
    });

    const keycloakTask = new ecs.FargateTaskDefinition(this, 'KeycloakTask', {
      cpu: cc.keycloak.cpu,
      memoryLimitMiB: cc.keycloak.memoryMiB,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64 },
    });
    const dbHost = props.database.dbInstanceEndpointAddress;
    keycloakTask.addContainer('keycloak', {
      image: ecs.ContainerImage.fromEcrRepository(props.keycloakRepository, config.imageTag),
      // images/keycloak builds an optimised server with the realm and the RDS CA baked in.
      command: ['start', '--optimized', '--import-realm'],
      portMappings: [
        { name: 'keycloak', containerPort: KEYCLOAK_PORT, appProtocol: ecs.AppProtocol.http },
        { containerPort: KEYCLOAK_MANAGEMENT_PORT },
      ],
      environment: {
        KC_DB_URL: `jdbc:postgresql://${dbHost}:5432/keycloak?sslmode=verify-full&sslrootcert=/opt/keycloak/conf/rds-ca.pem`,
        KC_DB_USERNAME: 'keycloak',
        // Tokens carry this issuer; it must be the URL browsers use (OCC ADR-0010).
        KC_HOSTNAME: `${this.publicUrl}/auth`,
        // The admin console is never public; it is opened through an ECS Exec port-forward.
        KC_HOSTNAME_ADMIN: `http://localhost:${KEYCLOAK_PORT}/auth`,
        KC_HTTP_ENABLED: 'true',
        KC_PROXY_HEADERS: 'xforwarded',
        // One node, no cluster: Keycloak 26 would otherwise try to form one over JDBC_PING.
        KC_CACHE: 'local',
        KC_BOOTSTRAP_ADMIN_USERNAME: 'platform-admin',
      },
      secrets: {
        KC_DB_PASSWORD: ecs.Secret.fromSecretsManager(props.keycloakLogin, 'password'),
        KC_BOOTSTRAP_ADMIN_PASSWORD: ecs.Secret.fromSecretsManager(keycloakAdmin, 'password'),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'keycloak',
        logGroup: logGroup(this, 'KeycloakLogs', logging),
      }),
    });

    const keycloakSecurityGroup = (this.keycloakSecurityGroup = new ec2.SecurityGroup(
      this,
      'KeycloakSecurityGroup',
      {
        vpc: props.vpc,
        description: 'Keycloak tasks',
      },
    ));
    const keycloak = new ecs.FargateService(this, 'Keycloak', {
      cluster: props.cluster,
      taskDefinition: keycloakTask,
      // One node with a local cache (docs/adr/0006): a release stops the old task before starting
      // the new one, so two nodes with separate caches never serve side by side.
      desiredCount: 1,
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      securityGroups: [keycloakSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      // Keycloak builds nothing at start (optimised image) but still needs a minute to migrate.
      healthCheckGracePeriod: Duration.minutes(3),
      enableExecuteCommand: true,
      serviceConnectConfiguration: {
        services: [{ portMappingName: 'keycloak', dnsName: 'keycloak', port: KEYCLOAK_PORT }],
      },
    });
    allowDatabaseAccess(
      this,
      'KeycloakToDatabase',
      props.database,
      keycloakSecurityGroup,
      'Keycloak',
    );

    // Keycloak normalises paths it receives; the load balancer matches them raw. A path that could
    // normalise out of the allowed prefixes (dot segments, encoded dots or slashes) is refused
    // before any forwarding rule sees it.
    listener.addAction('RefuseAmbiguousAuthPaths', {
      priority: 10,
      conditions: [elbv2.ListenerCondition.pathPatterns(AMBIGUOUS_AUTH_PATHS)],
      action: elbv2.ListenerAction.fixedResponse(400, {
        contentType: 'text/plain',
        messageBody: 'Bad request',
      }),
    });

    // Only what the console's sign-in needs reaches Keycloak: the occ realm and static resources.
    // Everything else under /auth — the admin console, the master realm — falls through to 404.
    listener.addTargets('KeycloakTargets', {
      priority: 30,
      conditions: [
        elbv2.ListenerCondition.pathPatterns(KEYCLOAK_PUBLIC_PATHS),
        fromThisDistribution,
      ],
      port: KEYCLOAK_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [
        keycloak.loadBalancerTarget({ containerName: 'keycloak', containerPort: KEYCLOAK_PORT }),
      ],
      healthCheck: {
        path: '/auth/health/ready',
        port: String(KEYCLOAK_MANAGEMENT_PORT),
        healthyThresholdCount: 2,
        interval: Duration.seconds(15),
      },
      deregistrationDelay: Duration.seconds(30),
    });
    keycloakSecurityGroup.connections.allowFrom(
      albSecurityGroup,
      ec2.Port.tcp(KEYCLOAK_PORT),
      'ALB',
    );
    keycloakSecurityGroup.connections.allowFrom(
      albSecurityGroup,
      ec2.Port.tcp(KEYCLOAK_MANAGEMENT_PORT),
      'ALB health checks',
    );

    // ---------------------------------------------------------------- API

    const apiTask = new ecs.FargateTaskDefinition(this, 'ApiTask', {
      cpu: cc.api.cpu,
      memoryLimitMiB: cc.api.memoryMiB,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64 },
    });
    const demo = cc.demoMode;
    apiTask.addContainer('api', {
      image: ecs.ContainerImage.fromEcrRepository(props.apiRepository, config.imageTag),
      portMappings: [
        { name: 'occ-api', containerPort: API_PORT, appProtocol: ecs.AppProtocol.http },
        { containerPort: API_METRICS_PORT },
      ],
      environment: {
        DEPLOYMENT_ENV: config.name,
        DB_HOST: dbHost,
        DB_PORT: '5432',
        DB_NAME: 'ops',
        DB_USER: 'ops',
        DB_SSL: 'true',
        OIDC_ISSUER: `${this.publicUrl}/auth/realms/occ`,
        // Signing keys come straight from Keycloak over Service Connect.
        OIDC_JWKS_URL: `http://keycloak:${KEYCLOAK_PORT}/auth/realms/occ/protocol/openid-connect/certs`,
        OIDC_AUDIENCE: 'occ-api',
        // Client → CloudFront → ALB → API: two proxies append to X-Forwarded-For.
        TRUST_PROXY_HOPS: '2',
        API_DOCS_ENABLED: 'false',
        DEMO_MODE: String(demo),
        SEED_ON_BOOT: String(demo),
        SIMULATOR_ENABLED: String(demo),
        CAMERA_SOURCE: site ? 'mediamtx' : 'mock',
        ...(site
          ? {
              MEDIAMTX_HLS_URL: site.camera.hlsBaseUrl,
              MEDIAMTX_WEBRTC_URL: site.camera.webRtcBaseUrl,
              MEDIAMTX_PROTOCOL: site.camera.protocol,
            }
          : {}),
        TELEMETRY_SOURCE: cc.telemetrySource,
        TELEMETRY_MOCK_SCENARIO: String(demo && cc.telemetrySource === 'mock'),
      },
      secrets: {
        DB_PASSWORD: ecs.Secret.fromSecretsManager(props.opsLogin, 'password'),
      },
      healthCheck: {
        command: [
          'CMD-SHELL',
          `wget -qO- http://127.0.0.1:${API_PORT}/api/health/live > /dev/null || exit 1`,
        ],
        interval: Duration.seconds(10),
        timeout: Duration.seconds(3),
        startPeriod: Duration.seconds(90),
        retries: 3,
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'api',
        logGroup: logGroup(this, 'ApiLogs', logging),
      }),
    });

    new MetricsSidecar(this, 'ApiMetrics', {
      taskDefinition: apiTask,
      target: `localhost:${API_METRICS_PORT}`,
      namespace: 'Platform/CommandCenter',
      declarations: [
        {
          dimensions: [['env'], ['env', 'route', 'status_code']],
          metricNameSelectors: ['^http_requests_total$'],
        },
        { dimensions: [['env']], metricNameSelectors: ['^realtime_connected_consoles$'] },
      ],
      logs: logging,
    });

    const apiSecurityGroup = (this.apiSecurityGroup = new ec2.SecurityGroup(
      this,
      'ApiSecurityGroup',
      {
        vpc: props.vpc,
        description: 'ops-command-center API tasks',
      },
    ));
    const api = new ecs.FargateService(this, 'Api', {
      cluster: props.cluster,
      taskDefinition: apiTask,
      desiredCount: cc.api.minTasks,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      securityGroups: [apiSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      healthCheckGracePeriod: Duration.seconds(120),
      serviceConnectConfiguration: {
        services: [{ portMappingName: 'occ-api', dnsName: 'occ-api', port: API_PORT }],
      },
    });
    api.node.addDependency(keycloak);
    allowDatabaseAccess(
      this,
      'ApiToDatabase',
      props.database,
      apiSecurityGroup,
      'ops-command-center API',
    );
    keycloakSecurityGroup.connections.allowFrom(
      apiSecurityGroup,
      ec2.Port.tcp(KEYCLOAK_PORT),
      'API → JWKS',
    );

    const apiTargets = listener.addTargets('ApiTargets', {
      priority: 20,
      conditions: [
        elbv2.ListenerCondition.pathPatterns(['/api/*', '/socket.io/*']),
        fromThisDistribution,
      ],
      port: API_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [api.loadBalancerTarget({ containerName: 'api', containerPort: API_PORT })],
      healthCheck: {
        // Readiness, not liveness: a replica that cannot reach the database gets no traffic.
        path: '/api/health/ready',
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        interval: Duration.seconds(10),
        timeout: Duration.seconds(3),
      },
      deregistrationDelay: Duration.seconds(30),
    });
    apiSecurityGroup.connections.allowFrom(albSecurityGroup, ec2.Port.tcp(API_PORT), 'ALB');

    const scaling = api.autoScaleTaskCount({
      minCapacity: cc.api.minTasks,
      maxCapacity: cc.api.maxTasks,
    });
    scaling.scaleOnCpuUtilization('Cpu', { targetUtilizationPercent: cc.api.targetCpuPercent });

    // ---------------------------------------------------------------- alarms

    const watch = (
      id: string,
      metric: cloudwatch.IMetric,
      threshold: number,
      description: string,
    ) =>
      props.alarms.watch(
        new cloudwatch.Alarm(this, id, {
          metric,
          threshold,
          evaluationPeriods: 3,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
          alarmDescription: description,
        }),
      );
    watch(
      'Api5xx',
      apiTargets.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, {
        period: Duration.minutes(1),
      }),
      10,
      'The API answered 10 or more 5xx a minute for 3 minutes',
    );
    watch(
      'ApiUnhealthy',
      apiTargets.metrics.unhealthyHostCount({ period: Duration.minutes(1) }),
      1,
      'An API replica has been failing readiness for 3 minutes',
    );
    watch(
      'ApiLatency',
      apiTargets.metrics.targetResponseTime({ period: Duration.minutes(1), statistic: 'p95' }),
      1,
      'API p95 response time above 1 s for 3 minutes',
    );

    new CfnOutput(this, 'PublicUrl', { value: this.publicUrl });
    new CfnOutput(this, 'DistributionDomainName', {
      value: this.distribution.distributionDomainName,
      description: 'Point the custom domain here (CNAME or alias)',
    });
    new CfnOutput(this, 'ConsoleBucketName', { value: this.consoleBucket.bucketName });
    new CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
    new CfnOutput(this, 'KeycloakAdminSecretArn', { value: keycloakAdmin.secretArn });
  }

  /**
   * Edge protection on the load balancer: AWS managed rule groups, plus per-client rate limits that
   * mirror the Compose stack's nginx limits (OCC ADR-0012: 20 r/s on /api, 2 r/s on handshakes).
   * The key is the viewer address CloudFront writes into its own header, not X-Forwarded-For,
   * whose first entry the client controls.
   */
  private addWaf(alb: elbv2.ApplicationLoadBalancer): void {
    const rateRule = (name: string, priority: number, path: string, perMinute: number) => ({
      name,
      priority,
      action: { block: {} },
      statement: {
        rateBasedStatement: {
          limit: perMinute,
          evaluationWindowSec: 60,
          aggregateKeyType: 'FORWARDED_IP',
          forwardedIpConfig: { headerName: VIEWER_IP_HEADER, fallbackBehavior: 'MATCH' },
          scopeDownStatement: {
            byteMatchStatement: {
              fieldToMatch: { uriPath: {} },
              positionalConstraint: 'STARTS_WITH',
              searchString: path,
              textTransformations: [{ priority: 0, type: 'NONE' }],
            },
          },
        },
      },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: name,
        sampledRequestsEnabled: true,
      },
    });
    const managed = (name: string, priority: number) => ({
      name,
      priority,
      overrideAction: { none: {} },
      statement: { managedRuleGroupStatement: { vendorName: 'AWS', name } },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: name,
        sampledRequestsEnabled: true,
      },
    });

    const acl = new wafv2.CfnWebACL(this, 'WebAcl', {
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'occ',
        sampledRequestsEnabled: true,
      },
      rules: [
        rateRule('api-per-client', 10, '/api/', 20 * 60),
        rateRule('socket-handshakes-per-client', 20, '/socket.io/', 2 * 60),
        managed('AWSManagedRulesKnownBadInputsRuleSet', 30),
        managed('AWSManagedRulesCommonRuleSet', 40),
      ],
    });
    new wafv2.CfnWebACLAssociation(this, 'WebAclAssociation', {
      resourceArn: alb.loadBalancerArn,
      webAclArn: acl.attrArn,
    });
  }
}
