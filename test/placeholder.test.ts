import { expect } from "chai";
import { describe as describeRegression, VERSION } from "../src/index.js";

describe("rskj-regression scaffolding", () => {
  it("exposes a version string", () => {
    expect(VERSION).to.be.a("string");
    expect(VERSION.length).to.be.greaterThan(0);
  });

  it("returns a self-describing banner", () => {
    expect(describeRegression()).to.contain("rskj-regression");
  });
});
