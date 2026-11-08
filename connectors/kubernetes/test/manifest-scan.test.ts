import { describe, expect, it } from "bun:test";
import { scanNamespacedManifest } from "../src/manifest-scan.ts";

const NS = "shop";
const DEPLOY = ["apiVersion: apps/v1", "kind: Deployment", "metadata:", "  name: api", ""].join(
  "\n",
);

function scan(text: string, ns = NS) {
  return scanNamespacedManifest(text, ns);
}

/** Lines joined with LF. */
function doc(...lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

function refused(text: string, why: RegExp | string, ns = NS): void {
  expect(() => scan(text, ns)).toThrow(why);
}

describe("scanNamespacedManifest: what it accepts", () => {
  it("reads one object", () => {
    expect(scan(DEPLOY)).toEqual([{ apiVersion: "apps/v1", kind: "Deployment", name: "api" }]);
  });

  it("reads a multi-document manifest, comments, blank lines and a namespace that matches", () => {
    const text = doc(
      "# leading comment",
      "---  # first",
      "apiVersion: v1",
      "kind: ConfigMap # trailing comment",
      "metadata:",
      "  # a comment under metadata",
      "  name: cfg",
      "  namespace: shop",
      "  labels:",
      "    app: web",
      "data:",
      "  a: b",
      "---",
      "",
      "---",
      "apiVersion: autoscaling/v2",
      "kind: HorizontalPodAutoscaler",
      "metadata:",
      "    name: hpa",
    );
    expect(scan(text)).toEqual([
      { apiVersion: "v1", kind: "ConfigMap", name: "cfg", namespace: "shop" },
      { apiVersion: "autoscaling/v2", kind: "HorizontalPodAutoscaler", name: "hpa" },
    ]);
  });

  it("accepts CRLF line endings", () => {
    expect(scan(DEPLOY.replaceAll("\n", "\r\n"))).toHaveLength(1);
  });

  it("accepts simply quoted values and a quoted all-digit name", () => {
    const text = doc(
      'apiVersion: "v1"',
      "kind: 'Service'",
      "metadata:",
      '  name: "123"',
      "  namespace: 'shop'",
    );
    expect(scan(text)).toEqual([
      { apiVersion: "v1", kind: "Service", name: "123", namespace: "shop" },
    ]);
  });

  it("accepts every allowlisted kind with its group", () => {
    const pairs: [string, string][] = [
      ["Deployment", "apps/v1"],
      ["StatefulSet", "apps/v1"],
      ["DaemonSet", "apps/v1"],
      ["ReplicaSet", "apps/v1"],
      ["Job", "batch/v1"],
      ["CronJob", "batch/v1"],
      ["Pod", "v1"],
      ["Service", "v1"],
      ["ConfigMap", "v1"],
      ["Secret", "v1"],
      ["PersistentVolumeClaim", "v1"],
      ["ServiceAccount", "v1"],
      ["Ingress", "networking.k8s.io/v1"],
      ["NetworkPolicy", "networking.k8s.io/v1"],
      ["Role", "rbac.authorization.k8s.io/v1"],
      ["RoleBinding", "rbac.authorization.k8s.io/v1"],
      ["HorizontalPodAutoscaler", "autoscaling/v1"],
      ["PodDisruptionBudget", "policy/v1"],
    ];
    for (const [kind, apiVersion] of pairs) {
      expect(
        scan(doc(`apiVersion: ${apiVersion}`, `kind: ${kind}`, "metadata:", "  name: x")),
      ).toEqual([{ apiVersion, kind, name: "x" }]);
    }
  });

  it("does not read a kind or namespace that sits in a deeper mapping or a block scalar", () => {
    const text = doc(
      "apiVersion: v1",
      "kind: ConfigMap",
      "metadata:",
      "  name: cfg",
      "  annotations:",
      "    namespace: elsewhere",
      "    note: |",
      "      namespace: elsewhere",
      "      kind: ClusterRole",
      "data:",
      "  script: |",
      "    kind: ClusterRole",
      "    metadata:",
      "      namespace: other",
      "  list:",
      "    - kind: ClusterRole",
      "    - |",
      "      kind: Namespace",
    );
    expect(scan(text)).toEqual([{ apiVersion: "v1", kind: "ConfigMap", name: "cfg" }]);
  });

  it("a block scalar opened at column 0 is skipped, and ends at the next column-0 key", () => {
    const text = doc(
      "description: |-",
      "  kind: ClusterRole",
      "",
      "  more",
      ...DEPLOY.trim().split("\n"),
    );
    expect(scan(text)).toEqual([{ apiVersion: "apps/v1", kind: "Deployment", name: "api" }]);
  });

  it("a --- line splits the document even inside a block scalar (go-yaml ends the scalar there too)", () => {
    const text = doc(
      "apiVersion: v1",
      "kind: ConfigMap",
      "metadata:",
      "  name: a",
      "data:",
      "  x: |",
      "    one",
      "---",
      "apiVersion: rbac.authorization.k8s.io/v1",
      "kind: ClusterRole",
      "metadata:",
      "  name: evil",
    );
    refused(text, /not on the namespaced allowlist/);
  });
});

describe("scanNamespacedManifest: characters", () => {
  const BASE = DEPLOY;
  const cases: [string, string][] = [
    ["NUL", "\u0000"],
    ["a C0 control", "\u0001"],
    ["ESC", "\u001b"],
    ["TAB", "\t"],
    ["DEL", "\u007f"],
    ["NEL", "\u0085"],
    ["a C1 control", "\u0090"],
    ["LS", " "],
    ["PS", " "],
    ["a BOM", "﻿"],
    ["U+FFFE", "￾"],
  ];
  for (const [label, ch] of cases) {
    it(`refuses ${label} in a comment`, () => {
      refused(`# a${ch}b\n${BASE}`, /character U\+[0-9A-F]{4} is not allowed/);
    });
    it(`refuses ${label} at the start`, () => {
      refused(`${ch}${BASE}`, /is not allowed/);
    });
  }

  it("refuses a lone CR but accepts CRLF", () => {
    refused(BASE.replace("\n", "\r"), /U\+000D/);
    expect(scan(BASE.replaceAll("\n", "\r\n"))).toHaveLength(1);
  });

  it("refuses a lone surrogate", () => {
    refused(`# \ud800\n${BASE}`, /is not allowed/);
  });

  it("a kind that only looks top-level because of a Unicode line break is refused, not read", () => {
    // go-yaml breaks the line at NEL/LS/PS, so `kind: ClusterRole` would be a top-level key to it.
    for (const ch of ["\u0085", " ", " "]) {
      refused(doc(`${DEPLOY.trim()}`, `note: x${ch}kind: ClusterRole`), /is not allowed/);
    }
  });

  it("allows ordinary non-ASCII text in values it does not interpret", () => {
    expect(
      scan(
        doc(
          "apiVersion: v1",
          "kind: ConfigMap",
          "metadata:",
          "  name: c",
          "data:",
          "  greeting: héllo ✓",
        ),
      ),
    ).toHaveLength(1);
  });

  it("does not echo the manifest in the error", () => {
    try {
      scan("secret: hunter2\u0000\n");
      throw new Error("should have thrown");
    } catch (e) {
      expect(String(e)).not.toContain("hunter2");
    }
  });
});

describe("scanNamespacedManifest: document markers", () => {
  it("refuses a ... line, a % directive and --- followed by other content", () => {
    refused(`${DEPLOY}...\n`, /document end marker/);
    refused(`%YAML 1.1\n${DEPLOY}`, /directive/);
    refused(`--- !!map\n${DEPLOY}`, /exactly ---/);
    refused(`--- kind: ClusterRole\n${DEPLOY}`, /exactly ---/);
    refused(`---#comment\n${DEPLOY}`, /exactly ---/);
    refused(`----\n${DEPLOY}`, /exactly ---/);
    refused(`---\t\n${DEPLOY}`, /not allowed/);
  });

  it("refuses a manifest with no objects", () => {
    refused("", /no objects/);
    refused("---\n---\n# nothing\n", /no objects/);
    refused("   \n\n", /no objects/);
  });
});

describe("scanNamespacedManifest: column 0", () => {
  const BAD: [string, string, RegExp][] = [
    ["a quoted key", `"kind": Deployment`, /plain key/],
    ["a single-quoted key", `'kind': Deployment`, /plain key/],
    ["a complex key", "? kind", /anchors, aliases, tags/],
    ["a sequence", "- kind: Deployment", /list at column 0/],
    ["a bare dash", "-", /list at column 0/],
    ["a merge key", "<<: {a: b}", /merge key/],
    ["a flow mapping", "{kind: Deployment}", /anchors, aliases, tags/],
    ["a flow sequence", "[a, b]", /anchors, aliases, tags/],
    ["an anchor", "&a kind: Deployment", /anchors, aliases, tags/],
    ["an alias", "*a", /anchors, aliases, tags/],
    ["a tag", "!!str kind: x", /anchors, aliases, tags/],
    ["a bare scalar", "Deployment", /must be `key:`/],
    ["a key with no space after the colon", "kind:Deployment", /must be `key:`/],
    ["a key with a space before the colon", "kind : Deployment", /plain key/],
    ["a key with an escape-looking name", "ki\\u006ed: Deployment", /plain key|must be/],
    ["a key starting with a digit", "1kind: x", /plain key/],
    ["a block scalar header", "|", /block scalar needs/],
  ];
  for (const [label, line, why] of BAD) {
    it(`refuses ${label}`, () => {
      refused(doc(line, ...DEPLOY.trim().split("\n")), why);
    });
  }

  it("refuses a first content line that is indented", () => {
    refused(
      `  apiVersion: apps/v1\n  kind: Deployment\n`,
      /first line of a document must start at column 0/,
    );
  });

  it("refuses a JSON manifest", () => {
    refused(
      '{"apiVersion":"v1","kind":"ClusterRole","metadata":{"name":"x"}}',
      /anchors, aliases, tags/,
    );
    refused('{\n  "kind": "Pod"\n}\n', /anchors, aliases, tags/);
    refused('["a"]\n', /anchors, aliases, tags/);
  });

  it("refuses a value that starts an anchor, alias, tag, flow collection or reserved indicator, at any depth", () => {
    for (const v of [
      "&a x",
      "*a",
      "!!str x",
      "{a: b}",
      "[a]",
      "?x",
      "@x",
      "`x",
      "%x",
      "]",
      "}",
      ",",
    ]) {
      refused(
        doc("apiVersion: v1", "kind: ConfigMap", "metadata:", "  name: c", "data:", `  k: ${v}`),
        /anchors, aliases, tags/,
      );
      refused(
        doc(
          "apiVersion: v1",
          "kind: ConfigMap",
          "metadata:",
          "  name: c",
          "data:",
          "  list:",
          `    - ${v}`,
        ),
        /anchors, aliases, tags/,
      );
    }
  });

  it("refuses a merge key, a ? line and a flow value at depth", () => {
    const head = ["apiVersion: v1", "kind: ConfigMap", "metadata:", "  name: c", "data:"];
    refused(doc(...head, "  <<: *base"), /merge key/);
    refused(doc(...head, "  - <<: x"), /merge key/);
    refused(doc(...head, "  ? complex"), /anchors, aliases, tags/);
    refused(doc(...head, "  args: []"), /anchors, aliases, tags/);
    refused(doc(...head, "  emptyDir: {}"), /anchors, aliases, tags/);
  });

  it("refuses an unterminated quote, and text after a closing quote", () => {
    const head = ["apiVersion: v1", "kind: ConfigMap", "metadata:", "  name: c", "data:"];
    refused(doc(...head, '  k: "open'), /must close on the line/);
    refused(doc(...head, "  k: 'open"), /must close on the line/);
    refused(doc(...head, '  k: "a" b'), /unexpected text after a quoted string/);
    refused(doc(...head, '  k: "a"#c'), /unexpected text after a quoted string/);
    expect(scan(doc(...head, '  k: "a" # c'))).toHaveLength(1);
  });

  it("refuses a nested mapping indicator in a plain value and an empty key", () => {
    const head = ["apiVersion: v1", "kind: ConfigMap", "metadata:", "  name: c", "data:"];
    refused(doc(...head, "  k: a: b"), /mapping indicator/);
    refused(doc(...head, "  k: a:"), /mapping indicator/);
    refused(doc(...head, "  k: - a"), /nested sequence/);
    refused(doc(...head, "  : a"), /empty key/);
    expect(scan(doc(...head, "  url: http://x:80/y"))).toHaveLength(1);
  });

  it("refuses a malformed block scalar header", () => {
    const head = ["apiVersion: v1", "kind: ConfigMap", "metadata:", "  name: c", "data:"];
    refused(doc(...head, "  k: |x"), /block scalar header/);
    refused(doc(...head, "  k: >>"), /block scalar header/);
    for (const ok of ["|", ">", "|-", ">+", "|2", ">+2", "|-2", "| # c"]) {
      expect(scan(doc(...head, `  k: ${ok}`, "    kind: ClusterRole"))).toHaveLength(1);
    }
  });
});

describe("scanNamespacedManifest: duplicates", () => {
  it("refuses a duplicate kind, apiVersion or metadata", () => {
    refused(doc("kind: Pod", ...DEPLOY.trim().split("\n")), /duplicate top-level kind/);
    refused(doc(...DEPLOY.trim().split("\n"), "kind: ClusterRole"), /duplicate top-level kind/);
    refused(doc("apiVersion: v1", ...DEPLOY.trim().split("\n")), /duplicate top-level apiVersion/);
    refused(
      doc(...DEPLOY.trim().split("\n"), "metadata:", "  name: b"),
      /duplicate top-level metadata/,
    );
  });

  it("refuses a duplicate metadata.name or metadata.namespace", () => {
    const head = ["apiVersion: v1", "kind: Pod", "metadata:"];
    refused(doc(...head, "  name: a", "  name: b"), /duplicate metadata.name/);
    refused(
      doc(...head, "  namespace: shop", "  name: a", "  namespace: other"),
      /duplicate metadata.namespace/,
    );
  });

  it("a second document that is a ClusterRole is refused", () => {
    refused(
      `${DEPLOY}---\napiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRole\nmetadata:\n  name: x\n`,
      /ClusterRole/,
    );
  });

  it("refuses a document missing apiVersion, kind or metadata", () => {
    refused(doc("kind: Pod", "metadata:", "  name: a"), /apiVersion and kind/);
    refused(doc("apiVersion: v1", "metadata:", "  name: a"), /apiVersion and kind/);
    refused(doc("apiVersion: v1", "kind: Pod"), /metadata block/);
  });
});

describe("scanNamespacedManifest: metadata", () => {
  const head = ["apiVersion: v1", "kind: Pod"];

  it("refuses flow, scalar and block-scalar metadata", () => {
    refused(doc(...head, "metadata: {name: a, namespace: other}"), /anchors, aliases, tags/);
    refused(doc(...head, "metadata: x"), /must be a block mapping/);
    refused(doc(...head, "metadata: |", "  name: a"), /must be a block mapping/);
    refused(doc(...head, "metadata: null"), /must be a block mapping/);
  });

  it("refuses metadata that opens with a list or a bare scalar", () => {
    refused(doc(...head, "metadata:", "  - name: a"), /must be a block mapping/);
    refused(doc(...head, "metadata:", "  justtext"), /must be a block mapping/);
  });

  it("refuses a quoted key directly under metadata, including a quoted namespace", () => {
    refused(doc(...head, "metadata:", "  name: a", '  "namespace": other'), /plain key/);
    refused(doc(...head, "metadata:", '  "name": a'), /plain key/);
    refused(doc(...head, "metadata:", "  name: a", "  'namespace': other"), /plain key/);
  });

  it("refuses an indentation that falls between metadata's children and column 0", () => {
    refused(
      doc(...head, "metadata:", "    name: a", "  namespace: other"),
      /inconsistent indentation/,
    );
  });

  it("reads children at the first child's indentation only", () => {
    const text = doc(
      ...head,
      "metadata:",
      "    name: a",
      "    labels:",
      "      namespace: ignored",
      "    namespace: shop",
    );
    expect(scan(text)).toEqual([{ apiVersion: "v1", kind: "Pod", name: "a", namespace: "shop" }]);
  });

  it("a namespace that differs from the argument is refused, as is a case difference", () => {
    refused(
      doc(...head, "metadata:", "  name: a", "  namespace: other"),
      /differs from the namespace argument/,
    );
    refused(doc(...head, "metadata:", "  namespace: Shop"), /differs/);
    expect(scan(doc(...head, "metadata:", "  namespace: Shop"), "Shop")).toHaveLength(1);
  });

  it("a dash line at the child level belongs to the previous key, not to metadata", () => {
    const text = doc(
      ...head,
      "metadata:",
      "  name: a",
      "  finalizers:",
      "  - namespace: other",
      "  namespace: shop",
    );
    expect(scan(text)).toEqual([{ apiVersion: "v1", kind: "Pod", name: "a", namespace: "shop" }]);
  });

  it("a block scalar under metadata hides a namespace-looking line", () => {
    const text = doc(
      ...head,
      "metadata:",
      "  name: a",
      "  annotations: |",
      "    namespace: other",
      "  namespace: shop",
    );
    expect(scan(text)).toEqual([{ apiVersion: "v1", kind: "Pod", name: "a", namespace: "shop" }]);
  });

  it("an interpreted value may not continue on a more-indented line", () => {
    refused(
      doc(...head, "metadata:", "  name: a", "  namespace: shop", "    -evil"),
      /must fit on one line/,
    );
    refused(
      doc("apiVersion: v1", "kind: Pod", "  Deployment", "metadata:", "  name: a"),
      /must fit on one line/,
    );
    refused(
      doc("apiVersion: apps/v1", "", "  v2", "kind: Deployment", "metadata:", "  name: a"),
      /must fit on one line/,
    );
  });
});

describe("scanNamespacedManifest: interpreted values", () => {
  const meta = (value: string) =>
    doc("apiVersion: v1", "kind: Pod", "metadata:", `  name: ${value}`);

  it("refuses an escape in a double-quoted kind, apiVersion, name or namespace", () => {
    refused(
      doc("apiVersion: v1", 'kind: "Cluster\\u0052ole"', "metadata:", "  name: a"),
      /cannot read with certainty/,
    );
    refused(
      doc('apiVersion: "v\\x31"', "kind: Pod", "metadata:", "  name: a"),
      /cannot read with certainty/,
    );
    refused(meta('"a\\nb"'), /cannot read with certainty/);
    refused(
      doc("apiVersion: v1", "kind: Pod", "metadata:", '  namespace: "sh\\x6fp"'),
      /cannot read with certainty/,
    );
  });

  it("refuses a plain value YAML 1.1 reads as a boolean, null or number", () => {
    for (const v of [
      "yes",
      "No",
      "true",
      "OFF",
      "null",
      "y",
      "n",
      "123",
      "1e3",
      "0x1f",
      "010",
      "1:30",
      "2001-12-14",
    ]) {
      refused(meta(v), /must be quoted|cannot read with certainty/);
    }
    expect(scan(meta('"123"'))).toHaveLength(1);
    expect(scan(meta("web-1"))).toHaveLength(1);
  });

  it("refuses a missing, empty, block or oddly spelled value", () => {
    refused(
      doc("apiVersion: v1", "kind:", "metadata:", "  name: a"),
      /plain or simply quoted scalar/,
    );
    refused(
      doc("apiVersion: v1", "kind: |", "  Pod", "metadata:", "  name: a"),
      /plain or simply quoted scalar/,
    );
    refused(
      doc("apiVersion: v1", "kind: Pod # c", "metadata:", "  name: a b"),
      /cannot read with certainty/,
    );
    refused(
      doc("apiVersion: v1", "kind: Pod#x", "metadata:", "  name: a"),
      /cannot read with certainty/,
    );
    refused(
      doc("apiVersion: v1", "kind: ' Pod'", "metadata:", "  name: a"),
      /cannot read with certainty/,
    );
  });

  it("strips a trailing comment from an interpreted value", () => {
    expect(
      scan(doc("apiVersion: v1 # core", "kind: Pod   # pod", "metadata:", "  name: a # n")),
    ).toEqual([{ apiVersion: "v1", kind: "Pod", name: "a" }]);
  });
});

describe("scanNamespacedManifest: the allowlist", () => {
  const meta = ["metadata:", "  name: x"];

  it("refuses cluster-scoped kinds and kinds off the list, naming the kind", () => {
    const kinds: [string, string][] = [
      ["ClusterRole", "rbac.authorization.k8s.io/v1"],
      ["ClusterRoleBinding", "rbac.authorization.k8s.io/v1"],
      ["Namespace", "v1"],
      ["Node", "v1"],
      ["PersistentVolume", "v1"],
      ["StorageClass", "storage.k8s.io/v1"],
      ["CustomResourceDefinition", "apiextensions.k8s.io/v1"],
      ["MutatingWebhookConfiguration", "admissionregistration.k8s.io/v1"],
      ["List", "v1"],
      ["Widget", "example.com/v1"],

      ["constructor", "v1"],
    ];
    for (const [kind, apiVersion] of kinds) {
      refused(
        doc(`apiVersion: ${apiVersion}`, `kind: ${kind}`, ...meta),
        /not on the namespaced allowlist/,
      );
    }
  });

  it("pairs the group with the kind: a CRD named like a core kind is refused", () => {
    refused(
      doc("apiVersion: example.com/v1", "kind: Service", ...meta),
      /does not match kind Service/,
    );
    refused(doc("apiVersion: apps/v1", "kind: Service", ...meta), /does not match kind Service/);
    refused(doc("apiVersion: v1", "kind: Deployment", ...meta), /does not match kind Deployment/);
    refused(
      doc("apiVersion: extensions/v1beta1", "kind: Ingress", ...meta),
      /does not match kind Ingress/,
    );
    refused(
      doc("apiVersion: autoscaling/v3", "kind: HorizontalPodAutoscaler", ...meta),
      /does not match/,
    );
  });

  it("is case-sensitive", () => {
    refused(doc("apiVersion: v1", "kind: pod", ...meta), /not on the namespaced allowlist/);
    refused(doc("apiVersion: V1", "kind: Pod", ...meta), /does not match/);
  });
});

describe("scanNamespacedManifest: odd names", () => {
  it("refuses __proto__ as a kind and an underscore number as a name", () => {
    refused(
      doc("apiVersion: v1", "kind: __proto__", "metadata:", "  name: a"),
      /cannot read with certainty/,
    );
    refused(
      doc("apiVersion: v1", "kind: Pod", "metadata:", "  name: 1_000"),
      /cannot read with certainty/,
    );
  });
});
