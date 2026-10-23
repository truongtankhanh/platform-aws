/**
 * Everything that differs between stages lives here, typed. Stacks read a `StageConfig` and never
 * branch on the stage name, so a new stage is a new object, not a code change.
 */

export interface ServiceSize {
  /** Fargate CPU units (256 = 0.25 vCPU). */
  cpu: number;
  memoryMiB: number;
}

export interface ScaledServiceSize extends ServiceSize {
  minTasks: number;
  maxTasks: number;
  /** Target average CPU utilisation for scaling, in percent. */
  targetCpuPercent: number;
}

export interface StageConfig {
  /** Short name, used in resource names and as DEPLOYMENT_ENV for the services. */
  name: string;
  /**
   * Region is fixed per stage (several resources, such as load-balancer access logging, need it at
   * synth time). The account comes from the deploying credentials.
   */
  env: { account?: string; region: string };

  network: {
    /** Two AZs are the minimum for RDS Multi-AZ and for the ALB. */
    maxAzs: number;
    /** NAT gateways: 1 saves money, one per AZ survives an AZ outage. */
    natGateways: number;
  };

  database: {
    /** e.g. `t4g.small`; burstable classes are for non-production. */
    instanceType: string;
    multiAz: boolean;
    allocatedStorageGiB: number;
    maxAllocatedStorageGiB: number;
    backupRetentionDays: number;
    deletionProtection: boolean;
    /** Each system gets its own database and login on the instance (platform ADR-0003). */
    databases: readonly DatabaseName[];
    /**
     * Bump to re-run the database bootstrap, e.g. after putting a new password in a system's
     * secret (docs/runbook.md). The bootstrap otherwise runs only when the set of databases changes.
     */
    loginGeneration: number;
  };

  commandCenter: {
    api: ScaledServiceSize;
    keycloak: ServiceSize;
    /**
     * Demo behaviour (mock cameras, mock telemetry, seeding). The API refuses these in production
     * unless DEMO_MODE is set (OCC ADR-0006), so this is an explicit, per-stage opt-in.
     */
    demoMode: boolean;
    /**
     * Where the API's asset telemetry comes from. `mqtt` is not offered here yet: the API
     * authenticates to its broker with a password, and AWS IoT Core accepts passwords only on port
     * 443 with ALPN, which the API cannot set (docs/adr/0003).
     */
    telemetrySource: 'mock' | 'off';
  };

  telemetry: {
    ingest: ScaledServiceSize & {
      /**
       * MQTT connections per task into the shared subscription. AWS IoT Core delivers at most
       * 100 messages/s per connection by default, so capacity is tasks × connections × 100/s.
       */
      mqttConnections: number;
    };
  };

  observability: {
    logRetentionDays: number;
    /**
     * Keep the log groups and the access-log bucket when their stack is deleted (docs/adr/0007).
     * They are the evidence of what happened, so a stage that matters must not lose them with the
     * stack; a demo stage that is torn down and rebuilt should not leave them behind.
     */
    retainLogs: boolean;
  };

  /** Values only a site can provide. Required by stages that are not demos. */
  site?: SiteValues;

  /** Tag of the images in this stage's ECR repositories, set by the deploy workflow. */
  imageTag: string;
}

export type DatabaseName = 'ops' | 'keycloak' | 'telemetry';

/**
 * Site-specific values, kept out of the repository: `-c siteFile=<path>` points at a JSON file in
 * this shape. `config/site.example.json` is a complete, fictional example that CI synthesises.
 */
export interface SiteValues {
  /** Custom domain served by CloudFront. */
  domain: {
    name: string;
    /** ACM certificate in us-east-1, for CloudFront. */
    cloudFrontCertificateArn: string;
    /** ACM certificate in the stage's region, for the load balancer's HTTPS listener. */
    loadBalancerCertificateArn: string;
  };
  /**
   * The site's media relay (MediaMTX). The API hands these URLs to operators' browsers, so they
   * must be reachable from wherever operators work, not only from the VPC.
   */
  camera: {
    hlsBaseUrl: string;
    webRtcBaseUrl: string;
    protocol: 'hls' | 'webrtc';
  };
  /** Where alarm notifications go. */
  alarmEmail: string;
}

const REGION = 'ap-southeast-1';
const account = process.env.CDK_DEFAULT_ACCOUNT;

const staging: StageConfig = {
  name: 'staging',
  env: { account, region: REGION },
  network: { maxAzs: 2, natGateways: 1 },
  database: {
    instanceType: 't4g.small',
    multiAz: false,
    allocatedStorageGiB: 20,
    maxAllocatedStorageGiB: 50,
    backupRetentionDays: 3,
    deletionProtection: false,
    databases: ['ops', 'keycloak', 'telemetry'],
    loginGeneration: 1,
  },
  commandCenter: {
    api: { cpu: 512, memoryMiB: 1024, minTasks: 2, maxTasks: 3, targetCpuPercent: 60 },
    keycloak: { cpu: 1024, memoryMiB: 2048 },
    demoMode: true,
    telemetrySource: 'mock',
  },
  telemetry: {
    ingest: {
      cpu: 512,
      memoryMiB: 1024,
      minTasks: 1,
      maxTasks: 2,
      targetCpuPercent: 60,
      mqttConnections: 2,
    },
  },
  observability: { logRetentionDays: 14, retainLogs: false },
  imageTag: 'latest',
};

const production: StageConfig = {
  name: 'production',
  env: { account, region: REGION },
  network: { maxAzs: 2, natGateways: 2 },
  database: {
    instanceType: 'm7g.large',
    multiAz: true,
    allocatedStorageGiB: 100,
    maxAllocatedStorageGiB: 500,
    backupRetentionDays: 14,
    deletionProtection: true,
    databases: ['ops', 'keycloak', 'telemetry'],
    loginGeneration: 1,
  },
  commandCenter: {
    api: { cpu: 1024, memoryMiB: 2048, minTasks: 2, maxTasks: 6, targetCpuPercent: 60 },
    keycloak: { cpu: 1024, memoryMiB: 2048 },
    demoMode: false,
    telemetrySource: 'off',
  },
  telemetry: {
    ingest: {
      cpu: 1024,
      memoryMiB: 2048,
      minTasks: 2,
      maxTasks: 6,
      targetCpuPercent: 60,
      mqttConnections: 4,
    },
  },
  observability: { logRetentionDays: 90, retainLogs: true },
  imageTag: 'latest',
};

export const STAGES: Record<string, StageConfig> = { staging, production };

/** Stages that are not demos cannot be synthesised without their site values. */
const NEEDS_SITE = new Set(['production']);

/** Resolves `-c stage=…`, `-c imageTag=…` and `-c siteFile=…` into a stage configuration. */
export function resolveStage(options: {
  stage?: string;
  imageTag?: string;
  site?: SiteValues;
}): StageConfig {
  const config = STAGES[options.stage ?? 'staging'];
  if (!config) {
    throw new Error(
      `Unknown stage "${options.stage}". Known stages: ${Object.keys(STAGES).join(', ')}`,
    );
  }
  if (NEEDS_SITE.has(config.name) && !options.site) {
    throw new Error(
      `Stage "${config.name}" needs site values: -c siteFile=<path> (see config/site.example.json)`,
    );
  }
  return {
    ...config,
    ...(options.imageTag ? { imageTag: options.imageTag } : {}),
    ...(options.site ? { site: options.site } : {}),
  };
}
