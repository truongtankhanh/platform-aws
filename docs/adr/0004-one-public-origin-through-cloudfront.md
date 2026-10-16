# ADR-0004: One public origin through CloudFront

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

In the Compose stack, one nginx serves the console's static files and proxies `/api`,
`/socket.io` and `/auth` (Keycloak) on the same origin. The console relies on that: its OIDC
authority is its own origin's `/auth/realms/occ`, and it calls the API without CORS. nginx also
applies per-client rate limits (OCC ADR-0012).

## Options

1. **Separate hostnames** for console, API and identity provider — familiar, but needs CORS, a
   console build per environment, and cookies and redirects across origins.
2. **Everything through the load balancer**, console included — one origin, but static files
   served by containers and no edge caching.
3. **CloudFront in front of both**: the console from S3, and `/api/*`, `/socket.io/*`, `/auth/*`
   forwarded uncached to the load balancer.

## Decision

Option 3.

- The console bucket is private and read through an origin access control. A CloudFront Function
  rewrites extension-less paths to `/index.html` for the console's client-side routes; API paths
  never reach it.
- The load balancer accepts traffic only from CloudFront's origin-facing prefix list, looked up at
  deploy time. Its listener blocks `/auth/admin` with a 403: Keycloak's admin console is reached
  through ECS Exec, never from the internet.
- A regional WAF web ACL on the load balancer applies AWS managed rule groups and the same
  per-client limits as nginx — 20 requests/s on `/api/`, 2 handshakes/s on `/socket.io/` — keyed
  on the first address in `X-Forwarded-For`, which behind CloudFront is the client's.
- The API trusts two proxy hops (CloudFront, then the load balancer). Socket.IO uses WebSocket
  only (OCC ADR-0008), which CloudFront and the load balancer both carry, so no sticky sessions.
- With a custom domain, viewers get TLS 1.2+ and CloudFront reaches the load balancer over HTTPS.
  Without one (the demo stage), CloudFront's default certificate is used and the origin hop is
  HTTP inside AWS, restricted to CloudFront's addresses.

## Consequences

- No change to the console or the API to run on AWS; the issuer is simply the public URL.
- Two places define routing (CloudFront behaviours and listener rules); tests assert both.
- The managed common rule set can reject unusually large request bodies; any false positive shows
  in the web ACL's sampled requests and is excluded per rule, not by switching the group off.

## Revisit when

The console and API need different release or caching domains, or the edge needs a WAF on
CloudFront itself (which must live in us-east-1, as a separate stack).
