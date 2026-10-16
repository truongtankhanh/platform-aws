# ADR-0005: Prometheus metrics into CloudWatch through an in-task collector

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

Both services expose Prometheus metrics, and both treat the endpoint as internal: the command
center serves it on a separate port that must never be public (OCC ADR-0015); the pipeline's
completeness depends on watching its sequence-gap counter
([platform ADR-0010](https://github.com/truongtankhanh/architecture-decisions/blob/main/decisions/0010-an-observability-baseline-every-service-meets.md)).
On AWS, alarms and dashboards live in CloudWatch, and the stages should not need a metrics
server of their own.

## Options

1. **Amazon Managed Service for Prometheus + Grafana** — the native Prometheus experience, priced
   per sample ingested and per user, plus a scraper with network access to every task.
2. **A Prometheus server on ECS** — one more stateful service to run and back up.
3. **An OpenTelemetry collector (ADOT) as a sidecar** scraping `localhost` and writing CloudWatch
   Embedded Metric Format — no server, no network path to the metrics port.

## Decision

Option 3, as one construct (`MetricsSidecar`) used by both services.

- The collector scrapes `localhost` every 30 s. The metrics port has no security-group rule; tests
  assert that.
- Only declared metrics become CloudWatch metrics, with bounded dimensions (`env`, `route`,
  `status_code`, `result`, `reason`); every sample remains queryable in the collector's log group.
- Alarms: API 5xx, unhealthy replicas and p95 latency from the load balancer; database CPU and
  storage; any telemetry sequence gap; no readings stored for 15 minutes. All notify one topic per
  stage.

## Consequences

- Each task carries a small extra container (64 CPU units, 128 MiB reserved). It is not
  essential: if it stops, the service keeps serving. Alarms built on its metrics then see no data:
  the gap alarm stays quiet, and the "no readings for 15 minutes" alarm (production only, where
  devices are expected) fires, which is the signal that metrics or ingest have stopped.
- Prometheus-style queries (rates across replicas, histograms) are less natural in CloudWatch;
  the load balancer's own metrics cover latency.
- The collector image is pinned, because its configuration format changes between releases.

## Verification

Designed, not yet observed on a live account: the collector's conversion of Prometheus counters
into the declared CloudWatch metrics. The first deployment checks that `telemetry_sequence_gaps_total`
arrives as a per-period sum before the gap alarm is relied on.

## Revisit when

Teams want the services' Grafana dashboards on AWS as they are — then the managed Prometheus
workspace replaces the EMF exporter, and the sidecar stays.
