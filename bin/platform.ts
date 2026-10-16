#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { readFileSync } from 'node:fs';
import { resolveStage, type SiteValues } from '../lib/config.js';
import { buildPlatform } from '../lib/platform.js';

const app = new App();
const siteFile = app.node.tryGetContext('siteFile') as string | undefined;

buildPlatform(
  app,
  resolveStage({
    stage: app.node.tryGetContext('stage') as string | undefined,
    imageTag: app.node.tryGetContext('imageTag') as string | undefined,
    site: siteFile ? (JSON.parse(readFileSync(siteFile, 'utf8')) as SiteValues) : undefined,
  }),
);
