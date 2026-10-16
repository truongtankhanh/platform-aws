# ADR-0003: AWS IoT Core as the MQTT broker

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

On-premises, the telemetry pipeline uses Mosquitto: MQTT 5, a shared subscription spreading
messages across ingest replicas, username and password authentication
([iot-telemetry-pipeline ADR-0001](https://github.com/truongtankhanh/iot-telemetry-pipeline/blob/main/docs/adr/0001-mqtt-shared-subscriptions.md)).
On AWS, the broker has to accept devices from the internet, authenticate each one, and survive
the loss of a host or an Availability Zone.

Facts that shape the choice, from the AWS IoT Core documentation and quotas:

- IoT Core supports MQTT 5 and shared subscriptions (`$share/{group}/{filter}`), delivering each
  message to one member of the group.
- It delivers at most **100 publishes per second per connection** by default.
- Devices authenticate with **X.509 client certificates** on port 8883. Username and password are
  accepted only through a custom authorizer, on **port 443 with the ALPN extension `mqtt`**.
- QoS 1 messages are queued for a shared-subscription group only while a member holds a
  persistent session; with clean sessions, a group with no member online drops them.

## Options

1. **Mosquitto on ECS behind a Network Load Balancer** — no application changes, but a single
   broker task is a single point of failure (Mosquitto does not cluster), and the platform
   operates TLS, accounts and ACLs itself.
2. **Amazon MQ** — managed, but the ActiveMQ engine offers MQTT 3.1.1 without shared
   subscriptions, which the pipeline's scaling depends on.
3. **AWS IoT Core** — managed, multi-AZ, per-device certificates and policies, shared
   subscriptions; requires client certificates and a way past the per-connection limit.

## Decision

Option 3.

- **Ingest** connects with a client certificate whose private key exists only in Secrets Manager
  (`lambda/iot-certificate`), and opens several connections per task into the shared group, so
  capacity is tasks × connections × 100 messages/s (staging 1–2 × 2, production 2–6 × 4). Both
  capabilities were added to the pipeline for this (its ITP-19).
- **The ingest policy** allows connecting as `ingest-*`, subscribing to exactly
  `$share/ingest/campus/+/+/telemetry`, and receiving `campus/*/*/telemetry`. MQTT wildcards are
  literal characters in IoT policies, so the subscribe grant is that one filter and nothing wider.
- **The device policy** uses thing variables: a device connects only under its own thing name and
  publishes only to `campus/<its zone attribute>/<its name>/telemetry`. A stolen certificate cannot
  speak for another device or zone.
- Deployments keep at least the current number of ingest tasks running (minimum healthy 100 %), so
  the group never empties during a rollout; clean sessions are kept, as on-premises.

## Consequences

- Device provisioning becomes certificate-based: each device needs a thing, a certificate and the
  device policy. Fleet provisioning is not built yet; the runbook describes registering a device
  by hand.
- Message volume is billed per message. The sizing notes show the levers.
- **Not yet connected: the command center's own asset telemetry.** Its MQTT client
  authenticates with a password and cannot set ALPN, so it cannot reach IoT Core. On AWS it runs
  with `TELEMETRY_SOURCE=mock` in staging and `off` in production until it supports client
  certificates (the change the pipeline needed in ITP-19).
- **Alert delivery to the command center** is connected: the pipeline authenticates with client
  credentials against the platform's Keycloak (its ADR-0006, ITP-20; the realm client is
  ops-command-center OCC-29) and calls the API over Service Connect. Keycloak generates the
  client's secret on import; an administrator copies it to Secrets Manager once (runbook), and
  until then deliveries are kept in the outbox and retried.

## Verification

- **Observed:** the ingest service over mutual TLS with several connections in one shared group,
  against a TLS-only Mosquitto that requires client certificates (and refuses a connection without
  one); its end-to-end suite runs with two connections.
- **Designed, not yet observed on a live account:** the IoT policies' evaluation of the shared
  filter and thing variables, and the certificate custom resource's API calls (unit-tested against
  fakes).

## Revisit when

A site requires the broker on its own premises (then option 1 returns, as in the Compose stack),
or the per-connection limit makes the connection count unwieldy — then an IoT rule into a queue
gives the pipeline a pull-based input with acknowledgement after commit.
