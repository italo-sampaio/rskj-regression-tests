/**
 * Unit tests for the JSON-RPC readiness probe. We inject a fake
 * `fetchFn` so the tests don't need a real RPC endpoint and run fast.
 */

import { expect } from "chai";
import { waitForRpcReady } from "../../src/orchestrator/rpc-readiness.js";

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as unknown as Response;
}

describe("orchestrator/rpc-readiness: waitForRpcReady", () => {
  it("resolves once the node returns a 0x-prefixed result", async () => {
    let calls = 0;
    await waitForRpcReady("http://node:4444", {
      timeoutMs: 5_000,
      pollIntervalMs: 1,
      fetchFn: (async () => {
        calls++;
        if (calls < 3) {
          // Connection refused for the first two attempts.
          throw new Error("ECONNREFUSED");
        }
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x42" });
      }) as unknown as typeof fetch,
    });
    expect(calls).to.equal(3);
  });

  it("treats jsonrpc error envelopes as not-ready and keeps retrying", async () => {
    let calls = 0;
    await waitForRpcReady("http://node:4444", {
      timeoutMs: 5_000,
      pollIntervalMs: 1,
      fetchFn: (async () => {
        calls++;
        if (calls < 2) {
          return jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "x" } });
        }
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x0" });
      }) as unknown as typeof fetch,
    });
    expect(calls).to.equal(2);
  });

  it("rejects when the timeout is exhausted", async () => {
    let err: Error | null = null;
    try {
      await waitForRpcReady("http://node:4444", {
        timeoutMs: 30,
        pollIntervalMs: 5,
        fetchFn: (async () => {
          throw new Error("ECONNREFUSED");
        }) as unknown as typeof fetch,
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err, "should have thrown").to.not.equal(null);
    expect(err!.message).to.match(/did not answer eth_blockNumber/);
    expect(err!.message).to.include("ECONNREFUSED");
  });
});
