import { expect } from "chai";
import { getPreset, listPresets } from "../../src/driver/presets.js";

describe("driver/presets", () => {
  it("registers the smoke preset", () => {
    expect(listPresets()).to.include("smoke");
  });

  it("returns hardhat + k6 runs for smoke", () => {
    const preset = getPreset("smoke");
    expect(preset.name).to.equal("smoke");
    expect(preset.runs).to.have.length.greaterThan(0);
    const kinds = preset.runs.map((r) => r.kind);
    expect(kinds).to.include("hardhat");
    expect(kinds).to.include("k6");
  });

  it("k6 entries reference per-method files, not heavy stress scenarios", () => {
    const preset = getPreset("smoke");
    const k6Runs = preset.runs.filter((r) => r.kind === "k6");
    expect(k6Runs).to.have.length.greaterThan(0);
    for (const run of k6Runs) {
      if (run.kind !== "k6") continue;
      // tests/ is the per-RPC-method smoke folder; scenarios/ holds the
      // heavy stress profiles we explicitly avoid here.
      expect(run.scriptRelPath).to.match(/^tests\//);
      expect(run.scriptRelPath).to.not.match(/scenarios\//);
    }
  });

  it("throws a helpful error on an unknown preset", () => {
    expect(() => getPreset("nope")).to.throw(/Unknown preset.*Available presets/);
  });
});
