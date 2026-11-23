# Kubecost Connector

## What this is

First-party Nimbus MCP connector for [Kubecost](https://www.kubecost.com), the Kubernetes cost-allocation service. It
exposes one **read-only** tool, `kubecost_allocation_list`, over Kubecost's Allocation API
(`GET /model/allocation`): the CPU, RAM, GPU, persistent-volume, network, load-balancer, shared and external
cost of each namespace (or controller, pod, label) for each UTC day.

It never writes. Every request is a `GET`, the manifest declares no HITL action (`hitlRequired`
is `[]`), and no host is named in the manifest: Kubecost runs in the owner's own cluster, so the
gateway adds the one host of `KUBECOST_URL` to the sandbox when it starts the connector.

This connector and `opencost` share one reader (`shared/k8s-allocation.ts`), because OpenCost is the
open-source core of Kubecost and both serve the same Allocation reply.

## Install

Bundled with Nimbus. No separate install is required.

## Quickstart

```bash
nimbus connector auth kubecost --url http://kubecost.example.svc:9090
# Optional, for an ingress that wants a bearer token
nimbus connector auth kubecost --url <url> --token <token>
```

(The `nimbus connector auth` flags are registered on the gateway side by the Nimbus release that
adds the Kubecost syncable; this README lists the variables the connector reads.)

Reach the service from where the gateway runs, for example `kubectl -n <ns> port-forward svc/<name> 9090`
and `http://127.0.0.1:9090`, or an ingress. Nimbus never starts a port-forward.

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `KUBECOST_URL` | yes | Base URL of the service, `http` or `https`, with no credentials, query or fragment. A path prefix is kept. |
| `KUBECOST_TOKEN` | no | Sent as `Authorization: Bearer <token>` when set. A cluster-local Kubecost is usually unauthenticated; send a token over `https` only. |

## Tools

| Tool | Purpose |
| --- | --- |
| `kubecost_allocation_list` | `GET /model/allocation` with `accumulate=false`. Inputs: `sinceMs`, `untilMs` (epoch ms; the start is moved back to UTC midnight; `untilMs` defaults to now, `sinceMs` to 7 days before it; at most 62 days), `aggregate` (`namespace` by default; `cluster`, `node`, `controllerKind`, `controller`, `service`, `pod`, `container`, `label:<name>`, `annotation:<name>`), `includeIdle` (sent as `idle`, default false), `limit` (default 5000, at most 20000). Returns `{ items, skipped, truncated }`. |

Each item is one allocation for one UTC day: `date`, `key`, `name`, `start`, `end`, `minutes`,
`properties` (cluster, namespace, controller, controllerKind, node, pod, container, when present),
and `cpuCost`, `ramCost`, `gpuCost`, `pvCost`, `networkCost`, `loadBalancerCost`, `sharedCost`,
`externalCost`, `totalCost`. A number the reply does not carry as a finite number reads as 0;
`skipped` counts allocations whose day could not be read.

## Verified against

Documentation only. The reply shape and parameters were written from the project's published API
documentation; no live instance was available, so they are UNVERIFIED against a running Kubecost.
Stated bounds: the first and last day are partial when the window does not begin or end at UTC
midnight; the currency is whatever the cluster's pricing is configured for and is not reported;
whether the service returns exactly one set per day for a window given as Unix seconds is taken
from the documentation.
