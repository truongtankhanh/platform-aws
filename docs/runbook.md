# Runbook

Everything below needs an AWS account. This repository has none attached; the steps are what a
first deployment and day-to-day operation take.

## One-time setup per account

1. **Bootstrap CDK** in the stage's region:

   ```bash
   npx cdk bootstrap aws://<account>/ap-southeast-1
   ```

2. **Create the deploy role** that GitHub Actions assumes through OIDC — no access keys anywhere.
   Trust policy (replace the account id; restrict `sub` to the repository and environment):

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Principal": {
           "Federated": "arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com"
         },
         "Action": "sts:AssumeRoleWithWebIdentity",
         "Condition": {
           "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
           "StringLike": {
             "token.actions.githubusercontent.com:sub": "repo:truongtankhanh/platform-aws:environment:*"
           }
         }
       }
     ]
   }
   ```

   Its permissions: assume the CDK bootstrap roles (`cdk-*-deploy-role`, `cdk-*-file-publishing-role`,
   `cdk-*-image-publishing-role`, `cdk-*-lookup-role`), push to and describe images in the stage's
   ECR repositories, write to the console bucket, create CloudFront invalidations, and read stack outputs.

3. **GitHub environments** `staging` and `production`, each with:
   - `AWS_DEPLOY_ROLE_ARN` — the role above;
   - `SITE_JSON` — the stage's site values, in the shape of `config/site.example.json` (required
     for production);
   - required reviewers on `production`.

## Deploying

Run the **Deploy** workflow with the stage and the refs of the two systems (a commit SHA or release
tag for each; there is no default, and a branch name builds whatever it points to at that moment).
The workflow has two jobs:

1. **build** builds the three images (tagged `<occ sha>-<itp sha>-<run>-<attempt>`) and the console
   from the two systems' code. It has no AWS access and no OIDC token: their install scripts and
   Dockerfile steps run without credentials. Its output is kept for one day.
2. **deploy** (the `production` reviewers approve here, after the build) deploys the registry,
   pushes the images, deploys every stack with that tag, publishes the console and invalidates
   `index.html`, then checks the release through the public URL: `/api/health/ready`, Keycloak's
   OIDC discovery document and the console page, retrying for about five minutes.

The repositories are immutable, so each tag exists once. Re-running the **whole** workflow gets a new
attempt number and therefore a new tag. Re-running only the failed **deploy** job keeps the build's
tag; images already in ECR under it are the same content and are not pushed again (this needs
`ecr:DescribeImages` on the stage's repositories in the deploy role). A manual `cdk deploy` must pass
`-c imageTag=<tag>`; without it the tasks ask for the tag `unset-pass-imageTag`, which does not
exist, and roll back.

ECS deployments roll with a circuit breaker: a release whose tasks never become healthy rolls back
on its own. A failed CloudFormation update rolls back the stack. A red final check is different: the
stacks are deployed and nothing is rolled back. Look at the service logs and the alarms, then
either fix forward or deploy the previous refs again.

## After the first deployment

1. **Keycloak administrators.** Read the bootstrap administrator from the secret in the
   `KeycloakAdminSecretArn` output, then open the admin console through ECS Exec — the public URL does
   not forward it:

   ```bash
   # ECS Exec port-forward to the Keycloak task (the service has execute-command enabled)
   aws ssm start-session --target ecs:<cluster>_<task-id>_<container-runtime-id> \
     --document-name AWS-StartPortForwardingSession \
     --parameters '{"portNumber":["8080"],"localPortNumber":["8080"]}'
   # http://localhost:8080/auth/admin
   ```

   Create named administrators, delete the bootstrap one, and add the site's directory as an
   identity provider (OIDC or SAML) in the `occ` realm. Map directory groups to the realm roles
   only if the site asks for it (platform ADR-0005).

2. **The pipeline's client secret.** Keycloak generated a secret for the `telemetry-pipeline`
   client when it imported the realm. In the admin console (same port-forward), open **Clients →
   telemetry-pipeline → Credentials**, copy the secret into the `PipelineClientSecret` secret
   (Telemetry stack), then force a new deployment of the ingest service. Alerts raised before
   this were kept in the outbox and are delivered then.

3. **Custom domain.** Point the domain at the `DistributionDomainName` output (alias or CNAME).

4. **Alarm subscription.** Confirm the e-mail AWS sends to the alarm address.

## Registering a device

Until fleet provisioning exists (iot-telemetry-pipeline ITP-17):

```bash
aws iot create-thing --thing-name dc-env-01 --attribute-payload '{"attributes":{"zone":"BLD-DC"}}'
aws iot create-keys-and-certificate --set-as-active \
  --certificate-pem-outfile dc-env-01.crt --private-key-outfile dc-env-01.key
aws iot attach-policy --policy-name <DevicePolicy> --target <certificateArn>
aws iot attach-thing-principal --thing-name dc-env-01 --principal <certificateArn>
```

The device connects with client id `dc-env-01` and publishes to `campus/BLD-DC/dc-env-01/telemetry`.
It must also be in the pipeline's device registry (`apps/ingest/config/devices.json`), or its
messages are rejected as `unknown_device`.

## Rotating credentials

| Credential                | How                                                                                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Database admin login      | Automatic, every 30 days.                                                                                                                                                                                          |
| A system's database login | Put a new password in its secret, increment `database.loginGeneration` in `lib/config.ts` and redeploy the Data stack (the bootstrap sets it in PostgreSQL), then force a new deployment of that system's service. |
| Ingest IoT certificate    | Change the certificate construct's id and redeploy: a new certificate is written to a new secret, the service restarts on it, the old one is deleted.                                                              |
| CloudFront origin header  | Change the `OriginVerify` construct's id and redeploy the CommandCenter stack: CloudFront and the listener switch together.                                                                                        |
| Pipeline client secret    | Regenerate it in Keycloak (Clients → telemetry-pipeline → Credentials), copy it to `PipelineClientSecret`, force a new ingest deployment. Deliveries in between are retried.                                       |
| Keycloak bootstrap admin  | Not rotated: deleted after named administrators exist.                                                                                                                                                             |

## Refresh the RDS CA bundle

The three images (`images/*/Dockerfile`) download AWS's RDS certificate bundle and check it against
a SHA-256, so a changed or tampered file stops the build. AWS republishes the bundle when it adds
authorities, so a failing `ADD --checksum` (in CI's `image-layers` job or in a deploy) is expected
from time to time and is not by itself an incident. To refresh:

1. Download `https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem` and read what
   changed against the previous bundle (new authorities are normal; removed ones need a reason).
2. Compute `sha256sum global-bundle.pem` and put the same `sha256:<hash>` in all three Dockerfiles.
3. Let CI run, then deploy so new tasks carry the new bundle. Running tasks keep the bundle they
   started with, so do this before RDS moves the instance to a certificate the old bundle lacks.

## Where to look

| Symptom                                 | First check                                                                                          |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Console loads, sign-in fails            | Keycloak service health and logs; `KC_HOSTNAME` matches the URL in the browser                       |
| Sign-in works, every API call is 401    | API logs: issuer or audience mismatch — `OIDC_ISSUER` must equal the public URL + `/auth/realms/occ` |
| API 503 "Identity provider unavailable" | API cannot reach `keycloak:8080` over Service Connect; Keycloak task running?                        |
| `SequenceGaps` alarm                    | Ingest tasks running? Connection count high enough for the load (tasks × connections × 100/s)?       |
| Alerts not becoming incidents           | Ingest logs: `invalid_client` means the client secret in Secrets Manager differs from Keycloak's     |
| `NoReadings` alarm                      | Devices connected (IoT Core metrics); ingest logs for subscribe or policy errors                     |
