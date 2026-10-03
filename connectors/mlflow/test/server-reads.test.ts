import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  type StubReply,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import { registerMlflowTools } from "../src/server.ts";

const API = "https://mlflow.example.com/api/2.0/mlflow/registered-models";

const MODELS = {
  registered_models: [
    { name: "churn", description: "Churn classifier", tags: [{ key: "team", value: "growth" }] },
    { name: "fraud", description: "", tags: [] },
  ],
};

let tools: CapturedTools;
let http: FetchStub | undefined;

function serve(reply: StubReply): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

function configured(fn: () => Promise<void>): Promise<void> {
  return withEnv({ MLFLOW_HOST: "https://mlflow.example.com/", MLFLOW_TOKEN: "ml-token" }, fn);
}

// The read surface in gateway mode; the writes are asserted in server-writes.test.ts.
beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
  tools = captureTools(registerMlflowTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
  resetConnectorModeForTests();
});

describe("mlflow read tools", () => {
  it("list asks for 100 models by default and `limit` when given, with a bearer token", async () => {
    const stub = serve(JSON.stringify(MODELS));
    await configured(async () => {
      expect(await tools.callJson("mlflow_list", {})).toEqual(MODELS);
      await tools.call("mlflow_list", { limit: 7 });
    });
    expect(stub.calls.map((c) => c.url)).toEqual([
      `${API}/search?max_results=100`,
      `${API}/search?max_results=7`,
    ]);
    expect(stub.calls[0]?.headers["authorization"]).toBe("Bearer ml-token");
  });

  it("get fetches one registered model by its name as a query parameter", async () => {
    const stub = serve('{"registered_model":{"name":"churn v2"}}');
    await configured(async () => {
      await tools.call("mlflow_get", { name: "churn v2" });
    });
    expect(stub.only.url).toBe(`${API}/get?name=churn+v2`);
  });

  it("search matches name, description and key=value tags", async () => {
    const stub = serve(JSON.stringify(MODELS));
    const names = async (query: string): Promise<unknown[]> => {
      let out: unknown;
      await configured(async () => {
        out = await tools.callJson("mlflow_search", { query });
      });
      return (out as { matches: { name: string }[] }).matches.map((m) => m.name);
    };
    expect(await names("FRAUD")).toEqual(["fraud"]);
    expect(await names("classifier")).toEqual(["churn"]);
    expect(await names("team=growth")).toEqual(["churn"]);
    expect(await names("forecast")).toEqual([]);
    expect(stub.calls[0]?.url).toBe(`${API}/search?max_results=100`);
  });

  it("search finds nothing in an answer that carries no `registered_models`", async () => {
    serve('{"next_page_token":""}');
    await configured(async () => {
      expect(await tools.callJson("mlflow_search", { query: "churn" })).toEqual({ matches: [] });
    });
  });

  it("refuses without MLFLOW_HOST, before any request, and quotes an API failure", async () => {
    const stub = serve("{}");
    await withEnv({ MLFLOW_HOST: undefined, MLFLOW_TOKEN: "t" }, async () => {
      await expect(tools.call("mlflow_list", {})).rejects.toThrow("MLFLOW_HOST is not set");
    });
    expect(stub.calls).toEqual([]);

    serve({ status: 404, body: '{"error_code":"RESOURCE_DOES_NOT_EXIST"}' });
    await configured(async () => {
      await expect(tools.call("mlflow_get", { name: "gone" })).rejects.toThrow(
        'MLflow 404: {"error_code":"RESOURCE_DOES_NOT_EXIST"}',
      );
    });
  });
});
