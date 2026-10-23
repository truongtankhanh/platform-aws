# ADR-0009: The origin secret is readable from AWS configuration, and that is accepted

- **Status:** Accepted
- **Date:** 2026-10-23

## Context

ADR-0004 puts the load balancer behind CloudFront. The load balancer's security group admits CloudFront's origin-facing address list, but that list covers **every**
CloudFront distribution in the world, so anyone could create a distribution of their own whose origin is this load balancer's DNS name. To close that, CloudFront sends a
secret header (`X-Origin-Verify`, 48 generated characters in Secrets Manager) on every request to the load balancer, and the listener forwards nothing that lacks it.

The secret is used as a CloudFormation dynamic reference (`secretValue.unsafeUnwrap()` in `lib/stacks/command-center.ts`): the synthesised template, the CI artifact and the
CloudFormation template hold only the reference, and a test asserts it. CloudFormation resolves the value while deploying and hands it to the two services, so it is stored in
plain text in **the CloudFront distribution's origin custom header** and **the load balancer listener rules' header condition**. Whoever may describe those two resources
(`cloudfront:GetDistribution*`, `elasticloadbalancing:DescribeRules`) can read it. Neither an ALB header condition nor a CloudFront custom origin header can read a secret at
request time, so this is inherent to the header pattern, not a flaw in how it is wired here.

## Options

1. **Keep the header and accept that it can be read from configuration.** Nothing new to run; the exposure is limited to people who can already describe these resources.
2. **Take the load balancer off the internet**, with CloudFront VPC origins and an internal load balancer. There is then no public address to point another distribution at, and no
   header. It is a different network design (a private load balancer, the VPC origin's own security group and permissions, WebSocket and the 60-second read timeout behaviour
   through it) and has not been assessed for this stack: its availability in the stage's region, its cost, and the effect on the Socket.IO traffic are unknown.
3. **Rotate the header on a schedule.** A secret that expires limits what a leaked copy is worth, but CloudFront and the listener must change together or requests are refused in between
   (the reason `lib/nag.ts` accepts the missing rotation function), and a safe overlap needs the listener to accept two values at once.
4. **Restrict who may read the two resources** with IAM. It narrows who can read the secret, and is worth doing wherever IAM is managed, but it is outside this repository.

## Decision

Option 1, with option 4 as an operating rule and option 2 as the thing to assess when the opportunity comes.

What the header protects, and what is left if it leaks. A holder of the secret can send requests to the load balancer through a distribution of their own. They reach only what the
listener forwards, which is the allowlist of ADR-0004 (`/api/*`, `/socket.io/*` and the sign-in paths of Keycloak; the admin console and the master realm answer 404, ambiguous paths
400), and the regional web ACL still applies to them: the managed rule groups and the body checks. The API requires a valid token on every request. What they gain is limited to the
rate limits: those key on `X-Viewer-Address`, which our CloudFront Function writes, so a request that arrives through another distribution can send any value there. The rate limits are
protection against abuse, not an access control, and nothing else relies on that header.

So the secret is the second layer, after the address list, against a distribution that is not ours; its disclosure removes that layer and weakens the abuse limits, and does not open any
path that needs an identity.

## Consequences

- Treat `cloudfront:GetDistribution*` and `elasticloadbalancing:DescribeRules` on this stage's resources as sensitive permissions, and grant them only to the people who run the platform.
- Rotating the secret is a deployment: change the `OriginVerify` construct's id, update its entries in `lib/nag.ts`, and redeploy (docs/runbook.md, docs/handover.md section 5). There can be a brief
  window while CloudFront and the listener rule update in which requests are refused. Rotate after any suspicion that it was read by someone who should not have.
- The rate limits cannot be relied on against someone who holds the secret.
- Verified by template assertions only (the reference is dynamic, the listener forwards nothing without the header, only the address list reaches the load balancer). How CloudFront and the
  load balancer behave when a request carries the wrong header has not been observed on a live account.

## Revisit when

CloudFront VPC origins have been assessed for this stack and look workable (then the public load balancer, and this header, can go); a requirement appears that a secret must not be readable from
service configuration; the secret is, or may have been, read by someone who should not; or the rate limits start to carry weight as a control.
