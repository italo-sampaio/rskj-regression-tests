/**
 * Unit tests for the orchestrator's HOCON-rendering helpers.
 *
 * The tests pin the shape of the generated config so a future refactor
 * doesn't accidentally drop a required key (e.g. forgetting to set
 * `database.dir`, which would leak state into `~/.rsk/`).
 */

import { expect } from "chai";
import {
  defaultRskjConfig,
  mergeConfig,
  renderHocon,
} from "../../src/orchestrator/regtest-config.js";

describe("orchestrator/regtest-config: defaultRskjConfig", () => {
  const config = defaultRskjConfig({
    dataDir: "/tmp/rskj-x",
    rpcPort: 30001,
    p2pPort: 30002,
  });

  it("points database.dir inside the per-run dataDir", () => {
    expect(config["database.dir"]).to.equal("/tmp/rskj-x/db");
    expect(config["database.reset"]).to.equal(true);
  });

  it("wires the RPC + P2P ports through to the right keys", () => {
    expect(config["peer.port"]).to.equal(30002);
    expect(config["rpc.providers.web.http.port"]).to.equal(30001);
    expect(config["rpc.providers.web.http.enabled"]).to.equal(true);
  });

  it("disables peer discovery (single-node)", () => {
    expect(config["peer.discovery.enabled"]).to.equal(false);
  });

  it("keeps the autominer on so blocks advance without RPC poking", () => {
    expect(config["miner.server.enabled"]).to.equal(true);
    expect(config["miner.client.enabled"]).to.equal(true);
  });

  it("derives a deterministic peer.privateKey from the p2p port", () => {
    const a = defaultRskjConfig({ dataDir: "/x", rpcPort: 1, p2pPort: 50001 });
    const b = defaultRskjConfig({ dataDir: "/x", rpcPort: 1, p2pPort: 50001 });
    const c = defaultRskjConfig({ dataDir: "/x", rpcPort: 1, p2pPort: 50002 });
    expect(a["peer.privateKey"]).to.equal(b["peer.privateKey"]);
    expect(a["peer.privateKey"]).to.not.equal(c["peer.privateKey"]);
    expect(a["peer.privateKey"]).to.match(/^[0-9a-f]{64}$/);
  });
});

describe("orchestrator/regtest-config: mergeConfig", () => {
  it("overlays overrides onto base keys", () => {
    const merged = mergeConfig({ a: 1, b: 2 }, { b: 99, c: 3 });
    expect(merged).to.deep.equal({ a: 1, b: 99, c: 3 });
  });

  it("does not mutate the base", () => {
    const base = { a: 1 };
    mergeConfig(base, { a: 2 });
    expect(base).to.deep.equal({ a: 1 });
  });
});

describe("orchestrator/regtest-config: renderHocon", () => {
  it("emits dotted-key lines sorted alphabetically", () => {
    const text = renderHocon({ "z.a": 1, "a.b": 2, "m.c": 3 });
    const keyLines = text.split("\n").filter((line) => /^[a-z]/.test(line));
    expect(keyLines).to.deep.equal(["a.b = 2", "m.c = 3", "z.a = 1"]);
  });

  it("quotes strings and leaves booleans / numbers bare", () => {
    const text = renderHocon({
      n: 7,
      b: true,
      s: "hello world",
      a: ["one", 2, true],
    });
    expect(text).to.include("n = 7");
    expect(text).to.include("b = true");
    expect(text).to.include('s = "hello world"');
    expect(text).to.include('a = ["one", 2, true]');
  });

  it("opens with a 'do not edit' header", () => {
    const text = renderHocon({ a: 1 });
    expect(text.split("\n")[0]).to.match(/Auto-generated/);
  });
});
