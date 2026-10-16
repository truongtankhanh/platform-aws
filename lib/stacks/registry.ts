import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import type { Construct } from 'constructs';
import type { StageConfig } from '../config.js';

export const IMAGES = ['occ-api', 'keycloak', 'ingest'] as const;
export type ImageName = (typeof IMAGES)[number];

export interface RegistryStackProps extends StackProps {
  config: StageConfig;
}

/**
 * Image repositories, in their own stack: the deploy workflow pushes images here before the
 * stacks that run them are deployed, so this stack must exist first and change rarely.
 */
export class RegistryStack extends Stack {
  readonly repositories: Record<ImageName, ecr.Repository>;

  constructor(scope: Construct, id: string, props: RegistryStackProps) {
    super(scope, id, props);
    const repositories = {} as Record<ImageName, ecr.Repository>;
    for (const name of IMAGES) {
      repositories[name] = new ecr.Repository(this, name, {
        repositoryName: `platform-${props.config.name}/${name}`,
        imageScanOnPush: true,
        encryption: ecr.RepositoryEncryption.AES_256,
        removalPolicy: RemovalPolicy.RETAIN,
        lifecycleRules: [
          {
            description: 'Drop untagged layers',
            tagStatus: ecr.TagStatus.UNTAGGED,
            maxImageAge: Duration.days(7),
          },
          { description: 'Keep the last 30 releases', maxImageCount: 30 },
        ],
      });
    }
    this.repositories = repositories;
  }
}
