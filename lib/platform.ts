import { Tags, Validations, type App } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { stackName, type StageConfig } from './config.js';
import { applyAcknowledgements } from './nag.js';
import { CommandCenterStack } from './stacks/command-center.js';
import { DataStack } from './stacks/data.js';
import { NetworkStack } from './stacks/network.js';
import { RegistryStack } from './stacks/registry.js';
import { TelemetryStack } from './stacks/telemetry.js';

export interface Platform {
  registry: RegistryStack;
  network: NetworkStack;
  data: DataStack;
  commandCenter: CommandCenterStack;
  telemetry: TelemetryStack;
}

/**
 * One stage of the platform. Stack names carry the stage, so stages live side by side in one
 * account or, better, in separate accounts.
 */
export function buildPlatform(app: App, config: StageConfig): Platform {
  const env = config.env;
  const name = (stack: string) => stackName(config, stack);

  const registry = new RegistryStack(app, name('Registry'), { env, config });
  const network = new NetworkStack(app, name('Network'), { env, config });
  const data = new DataStack(app, name('Data'), {
    env,
    config,
    vpc: network.vpc,
    alarms: network.alarms,
  });
  const commandCenter = new CommandCenterStack(app, name('CommandCenter'), {
    env,
    config,
    vpc: network.vpc,
    cluster: network.cluster,
    database: data.instance,
    opsLogin: data.secrets.ops,
    keycloakLogin: data.secrets.keycloak,
    apiRepository: registry.repositories['occ-api'],
    keycloakRepository: registry.repositories.keycloak,
    alarms: network.alarms,
  });
  const telemetry = new TelemetryStack(app, name('Telemetry'), {
    env,
    config,
    vpc: network.vpc,
    cluster: network.cluster,
    database: data.instance,
    telemetryLogin: data.secrets.telemetry,
    commandCenter: {
      api: commandCenter.apiSecurityGroup,
      keycloak: commandCenter.keycloakSecurityGroup,
    },
    ingestRepository: registry.repositories.ingest,
    alarms: network.alarms,
  });

  const platform = { registry, network, data, commandCenter, telemetry };
  for (const stack of Object.values(platform)) {
    Tags.of(stack).add('platform:stage', config.name);
    Tags.of(stack).add('platform:repository', 'truongtankhanh/platform-aws');
    applyAcknowledgements(stack, config);
  }
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
  return platform;
}
