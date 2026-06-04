/**
 * Unit tests for the orchestrator's port-allocation helpers.
 *
 * We inject a stubbed availability probe so the tests don't depend on
 * what's actually listening on the host's TCP ports — they exercise the
 * loop's selection logic and the timeout / waiting behaviour.
 */

import { expect } from "chai";
import { findFreePorts, waitForPort } from "../../src/orchestrator/port-utils.js";

describe("orchestrator/port-utils: findFreePorts", () => {
  it("returns the first N available ports from the range in ascending order", async () => {
    const occupied = new Set([20000, 20002, 20004]);
    const ports = await findFreePorts(3, {
      rangeStart: 20000,
      rangeEnd: 20100,
      isAvailable: async (port) => !occupied.has(port),
    });
    expect(ports).to.deep.equal([20001, 20003, 20005]);
  });

  it("returns an empty list when 0 ports are requested", async () => {
    const ports = await findFreePorts(0, { isAvailable: async () => true });
    expect(ports).to.deep.equal([]);
  });

  it("throws when the range can't supply enough free ports", async () => {
    let err: Error | null = null;
    try {
      await findFreePorts(5, {
        rangeStart: 30000,
        rangeEnd: 30002,
        isAvailable: async () => true,
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err, "should have thrown").to.not.equal(null);
    expect(err!.message).to.match(/Could not find 5 free ports/);
  });

  it("rejects an inverted range", async () => {
    let err: Error | null = null;
    try {
      await findFreePorts(1, { rangeStart: 30100, rangeEnd: 30000 });
    } catch (e) {
      err = e as Error;
    }
    expect(err, "should have thrown").to.not.equal(null);
    expect(err!.message).to.match(/Invalid port range/);
  });
});

describe("orchestrator/port-utils: waitForPort", () => {
  it("resolves once the port stops being available", async () => {
    let calls = 0;
    await waitForPort(
      { host: "127.0.0.1", port: 12345 },
      {
        attempts: 5,
        intervalMs: 1,
        // First two probes say "still free"; third probe reports "in use",
        // mimicking a JVM that just bound the port.
        isAvailable: async () => {
          calls++;
          return calls < 3;
        },
      },
    );
    expect(calls).to.equal(3);
  });

  it("rejects after exhausting attempts", async () => {
    let err: Error | null = null;
    try {
      await waitForPort(
        { host: "127.0.0.1", port: 12345 },
        {
          attempts: 3,
          intervalMs: 1,
          isAvailable: async () => true,
        },
      );
    } catch (e) {
      err = e as Error;
    }
    expect(err, "should have thrown").to.not.equal(null);
    expect(err!.message).to.match(/Timed out waiting for/);
  });
});
