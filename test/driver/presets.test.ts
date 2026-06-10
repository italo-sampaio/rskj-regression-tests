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

  it("registers the full preset with a rit run on top of smoke", () => {
    expect(listPresets()).to.include("full");
    const full = getPreset("full");
    const kinds = full.runs.map((r) => r.kind);
    expect(kinds).to.include("hardhat");
    expect(kinds).to.include("k6");
    expect(kinds).to.include("rit");
  });

  it("the full preset's rit run includes the sync bootstrap case first", () => {
    const full = getPreset("full");
    const rit = full.runs.find((r) => r.kind === "rit");
    expect(rit, "full should contain a rit run").to.exist;
    if (rit && rit.kind === "rit") {
      // Bootstrap sync test must lead — RIT tests share blockchain state.
      expect(rit.includeCases?.[0]).to.equal("00_00_01-sync");
      expect(rit.reportRelPath)
        .to.be.a("string")
        .and.to.match(/\.xml$/);
    }
  });

  it("leaves the smoke preset rit-free", () => {
    const smoke = getPreset("smoke");
    expect(smoke.runs.map((r) => r.kind)).to.not.include("rit");
  });
});
