import { describe, expect, it } from "bun:test";
import {
  ABSENT_LIVE,
  diffSha256,
  normaliseForDiff,
  planDiff,
  unpackKubeJson,
} from "../src/manifest-diff.ts";

const cm = (name: string, data: Record<string, string> = {}, extra: object = {}) => ({
  apiVersion: "v1",
  kind: "ConfigMap",
  metadata: { name, namespace: "shop" },
  data,
  ...extra,
});

describe("unpackKubeJson", () => {
  it("reads nothing as no objects", () => {
    expect(unpackKubeJson(null).size).toBe(0);
    expect(unpackKubeJson(undefined).size).toBe(0);
    expect(unpackKubeJson("").size).toBe(0);
  });

  it("reads a bare object as one, keyed by resource prefix and name", () => {
    const o = { kind: "Deployment", metadata: { name: "api" } };
    expect([...unpackKubeJson(o).keys()]).toEqual(["deployment.apps/api"]);
  });

  it("reads a List as its items, in order; an empty List is none", () => {
    const list = {
      kind: "List",
      items: [
        { kind: "Service", metadata: { name: "b" } },
        { kind: "Ingress", metadata: { name: "a" } },
      ],
    };
    expect([...unpackKubeJson(list).keys()]).toEqual(["service/b", "ingress.networking.k8s.io/a"]);
    expect(unpackKubeJson({ kind: "List", items: [] }).size).toBe(0);
  });

  it("fails closed on anything it cannot key", () => {
    const bad: unknown[] = [
      "text",
      [],
      { kind: "List" },
      { kind: "List", items: ["x"] },
      { metadata: { name: "a" } },
      { kind: "ConfigMap" },
      { kind: "ConfigMap", metadata: { name: 3 } },
      { kind: "ConfigMap", metadata: { name: "" } },
      { kind: "Namespace", metadata: { name: "a" } },
      { kind: "constructor", metadata: { name: "a" } },
      { kind: "List", items: [cm("a"), cm("a")] },
    ];
    for (const b of bad) expect(() => unpackKubeJson(b)).toThrow();
  });
});

describe("normaliseForDiff", () => {
  it("drops exactly the server-owned fields and sorts keys by code unit", () => {
    const live = {
      status: { ready: true },
      spec: { z: 1, a: [{ y: 1, b: 2 }] },
      kind: "Deployment",
      metadata: {
        name: "api",
        uid: "u",
        resourceVersion: "9",
        generation: 4,
        creationTimestamp: "t",
        selfLink: "s",
        managedFields: [{ x: 1 }],
        labels: { app: "api" },
        annotations: {
          "kubectl.kubernetes.io/last-applied-configuration": "{}",
          keep: "me",
        },
      },
    };
    expect(normaliseForDiff(live)).toEqual([
      "{",
      '  "kind": "Deployment",',
      '  "metadata": {',
      '    "annotations": {',
      '      "keep": "me"',
      "    },",
      '    "labels": {',
      '      "app": "api"',
      "    },",
      '    "name": "api"',
      "  },",
      '  "spec": {',
      '    "a": [',
      "      {",
      '        "b": 2,',
      '        "y": 1',
      "      }",
      "    ],",
      '    "z": 1',
      "  }",
      "}",
    ]);
    // The input is left alone.
    expect(live.metadata.uid).toBe("u");
  });

  it("drops an annotations map the last-applied annotation alone filled", () => {
    const o = cm("a", {}, {});
    (o.metadata as Record<string, unknown>)["annotations"] = {
      "kubectl.kubernetes.io/last-applied-configuration": "{}",
    };
    expect(normaliseForDiff(o).join("\n")).not.toContain("annotations");
  });

  it("orders keys by UTF-16 code unit, upper case before lower", () => {
    expect(normaliseForDiff({ b: 1, B: 2, a: 3 })).toEqual([
      "{",
      '  "B": 2,',
      '  "a": 3,',
      '  "b": 1',
      "}",
    ]);
  });
});

describe("planDiff", () => {
  const map = (...o: Record<string, unknown>[]) => unpackKubeJson({ kind: "List", items: o });

  it("a create shows the absent marker against the whole planned object", () => {
    const out = planDiff(map(cm("a", { k: "v" })), map());
    expect(out.startsWith("--- live configmap/a\n+++ planned configmap/a\n@@ -1,1 +1,")).toBe(true);
    expect(out).toContain(`-${ABSENT_LIVE}\n+{\n`);
  });

  it("an update shows only the changed value with its context", () => {
    const out = planDiff(map(cm("a", { k: "new" })), map(cm("a", { k: "old" })));
    expect(out).toBe(
      [
        "--- live configmap/a",
        "+++ planned configmap/a",
        "@@ -1,7 +1,7 @@",
        " {",
        '   "apiVersion": "v1",',
        '   "data": {',
        '-    "k": "old"',
        '+    "k": "new"',
        "   },",
        '   "kind": "ConfigMap",',
        '   "metadata": {',
        "",
      ].join("\n"),
    );
  });

  it("is empty when only fields the server owns, or defaulted on both sides, differ", () => {
    const live = cm("a", { k: "v" }, { status: { x: 1 } });
    (live.metadata as Record<string, unknown>)["resourceVersion"] = "77";
    (live.metadata as Record<string, unknown>)["managedFields"] = [{ manager: "kubectl" }];
    const planned = cm("a", { k: "v" });
    expect(planDiff(map(planned), map(live))).toBe("");
  });

  it("diffs several objects in code-unit order of their keys, skipping the unchanged", () => {
    const planned = map(cm("zz", { k: "2" }), cm("b", { k: "same" }), cm("Ab", { k: "2" }));
    const live = map(cm("zz", { k: "1" }), cm("b", { k: "same" }), cm("Ab", { k: "1" }));
    const heads = planDiff(planned, live)
      .split("\n")
      .filter((l) => l.startsWith("--- "));
    expect(heads).toEqual(["--- live configmap/Ab", "--- live configmap/zz"]);
  });

  it("ignores a live object the plan does not name", () => {
    expect(planDiff(map(), map(cm("other")))).toBe("");
  });
});

describe("diffSha256", () => {
  it("is sha256 of the v1 domain, a newline and the text (pinned vectors)", () => {
    expect(diffSha256("")).toBe("e790f2ddcf17b661799c2c9adf93f6e8c4c0f24ed2ffdf501d5813c7c115b588");
    expect(diffSha256("--- live a\n+++ planned a\n")).toBe(
      "ab285d0cfbf36c3e2567dc8a8e9b54ab356e8da6e73df89118e43932116f6472",
    );
  });
});
