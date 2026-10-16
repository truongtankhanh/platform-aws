import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { readFileSync } from 'node:fs';
import { resolveStage, type SiteValues } from '../lib/config.js';
import { buildPlatform, type Platform } from '../lib/platform.js';

const cdkJson = JSON.parse(readFileSync(new URL('../cdk.json', import.meta.url), 'utf8')) as {
  context: Record<string, unknown>;
};
export const exampleSite = JSON.parse(
  readFileSync(new URL('../config/site.example.json', import.meta.url), 'utf8'),
) as SiteValues;

export interface Synthesised {
  app: App;
  platform: Platform;
  template: (stack: keyof Platform) => Template;
}

/** Synthesises one stage the way `cdk synth` does, with the project's feature flags. */
export function synth(stage: 'staging' | 'production', imageTag = 'test'): Synthesised {
  const app = new App({ context: { ...cdkJson.context, stage } });
  const platform = buildPlatform(
    app,
    resolveStage({ stage, imageTag, site: stage === 'production' ? exampleSite : undefined }),
  );
  const cache = new Map<keyof Platform, Template>();
  return {
    app,
    platform,
    template: (stack) => {
      if (!cache.has(stack)) cache.set(stack, Template.fromStack(platform[stack]));
      return cache.get(stack)!;
    },
  };
}

/** Container definitions of the task definition whose logical id starts with `prefix`. */
export function containers(template: Template, prefix: string): Array<Record<string, unknown>> {
  const tasks = template.findResources('AWS::ECS::TaskDefinition');
  const [, task] = Object.entries(tasks).find(([id]) => id.startsWith(prefix)) ?? [];
  if (!task) throw new Error(`No task definition ${prefix}*`);
  return task.Properties.ContainerDefinitions as Array<Record<string, unknown>>;
}

export function environmentOf(container: Record<string, unknown>): Record<string, unknown> {
  const entries = (container.Environment ?? []) as Array<{ Name: string; Value: unknown }>;
  return Object.fromEntries(entries.map((e) => [e.Name, e.Value]));
}

export function secretNamesOf(container: Record<string, unknown>): string[] {
  return ((container.Secrets ?? []) as Array<{ Name: string }>).map((s) => s.Name);
}

/** Resolves CloudFormation intrinsics in a value to a readable string for assertions. */
export function flatten(value: unknown): string {
  return JSON.stringify(value);
}
