/**
 * Allocation replies as OpenCost's swagger file and Kubecost's API page document them
 * (UNVERIFIED against a running instance): `{ code, status?, data: [ { "<key>": allocation } ] }`,
 * one set per day step. Shared by the `opencost` and `kubecost` tests.
 */

export const OPENCOST_BASE = "http://opencost.opencost.svc:9003";
export const KUBECOST_BASE = "http://kubecost-cost-analyzer.kubecost.svc:9090";

function allocation(name: string, day: string, costs: Record<string, number>) {
  const start = `${day}T00:00:00Z`;
  const end = new Date(Date.parse(start) + 86_400_000).toISOString().replace(".000Z", "Z");
  return {
    name,
    properties: { cluster: "default-cluster", namespace: name, labels: { app: "x" } },
    window: { start, end },
    start,
    end,
    minutes: 1440,
    cpuCoreHours: 12.5,
    cpuCost: 0,
    gpuCost: 0,
    ramCost: 0,
    pvCost: 0,
    networkCost: 0,
    loadBalancerCost: 0,
    sharedCost: 0,
    externalCost: 0,
    totalCost: 0,
    totalEfficiency: 0.4,
    ...costs,
  };
}

export const TWO_DAYS = {
  code: 200,
  status: "success",
  data: [
    {
      default: allocation("default", "2026-11-20", { cpuCost: 1.5, ramCost: 0.5, totalCost: 2 }),
      "kube-system": allocation("kube-system", "2026-11-20", {
        cpuCost: 3,
        totalCost: 3.25,
        pvCost: 0.25,
      }),
    },
    {
      default: allocation("default", "2026-11-21", { cpuCost: 2, ramCost: 1, totalCost: 3 }),
    },
  ],
};

export const ODD_REPLY = {
  code: 200,
  data: [
    null,
    "x",
    {
      odd: {
        name: "odd",
        window: { start: "2026-11-20T00:00:00Z" },
        totalCost: "NaN",
        cpuCost: null,
      },
      undated: { name: "undated", totalCost: 5 },
      nope: 7,
    },
  ],
};
