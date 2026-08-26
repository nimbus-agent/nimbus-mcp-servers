# The standalone launcher

`nimbus-connector` is the package `bin`: it resolves a connector id to its entry point and runs that
connector as a standalone MCP server over stdio.

```bash
npx @nimbus-dev/connectors github
```

The id is validated against a strict allow-list — lowercase letters, digits and hyphens — **before**
it is joined into a path, so a separator or `..` cannot escape the connectors directory and import
an arbitrary module.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The server ran and exited normally. |
| `2` | No id given, an id that is not a valid shape, or an id with no matching connector. |
| `3` | The connector exists but is **not eligible** to run standalone. |

## Eligibility

The launcher refuses a connector that declares write or delete tools which have not been routed
through the consent kit, exiting `3` rather than starting it ungated.

Today **all 94 are eligible** — 58 declare no mutating tools, and the other 36 have had their writes
routed through the consent kit.

That verdict is derived from each connector's own manifest and sources, never hand-maintained. A
test recomputes the three numbers from the code and asserts this page states them, so the count
cannot drift from reality even if this sentence is left untouched.

## What eligibility does and does not buy

Eligible means the connector's mutating tools go through `createWriteToolRegistrar`, so consent, the
write-scope allow-list and the mutation budget apply. It does **not** mean the connector is
sandboxed, that its credentials are protected, or that egress is recorded — those are gateway
properties. [`NOTICE`](../NOTICE) states the tiering in full.

Eligibility is also not the same as your client being able to *use* the write tools. A connector can
be eligible and still expose reads only, because the client never advertised `elicitation`. See
[Client support](./client-support.md).
