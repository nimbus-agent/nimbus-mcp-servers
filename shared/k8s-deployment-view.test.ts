import { describe, expect, test } from "bun:test";
import { isKubectlNotFound, projectDeployment } from "./k8s-deployment-view.ts";

const FULL = {
  metadata: { name: "api", namespace: "prod", generation: 7 },
  spec: {
    replicas: 3,
    template: {
      metadata: { annotations: { "kubectl.kubernetes.io/restartedAt": "2026-11-01T10:00:00Z" } },
      spec: { containers: [{ image: "acme/api:2" }, { image: "acme/sidecar:1" }, { name: "x" }] },
    },
  },
  status: { readyReplicas: 2, observedGeneration: 6 },
};

describe("projectDeployment", () => {
  test("projects the documented fields", () => {
    expect(projectDeployment(FULL)).toEqual({
      name: "api",
      namespace: "prod",
      replicas: 3,
      readyReplicas: 2,
      generation: 7,
      observedGeneration: 6,
      restartedAt: "2026-11-01T10:00:00Z",
      images: ["acme/api:2", "acme/sidecar:1"],
    });
  });

  test("an omitted readyReplicas is 0 and absent fields stay absent", () => {
    expect(projectDeployment({ metadata: { name: "d" }, spec: {}, status: {} })).toEqual({
      name: "d",
      namespace: "",
      readyReplicas: 0,
      images: [],
    });
  });

  test("a value that is not a Deployment is reported as not found", () => {
    for (const v of [null, "x", [], {}, { metadata: {} }]) {
      expect(() => projectDeployment(v)).toThrow("deployment not found");
    }
  });
});

describe("isKubectlNotFound", () => {
  test("matches the NotFound reason and the plain phrase, nothing else", () => {
    expect(isKubectlNotFound('Error from server (NotFound): deployments.apps "x" not found')).toBe(
      true,
    );
    expect(isKubectlNotFound("kubectl exited 1: forbidden")).toBe(false);
  });
});
