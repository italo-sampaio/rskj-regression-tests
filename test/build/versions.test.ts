/**
 * Unit tests for release-version → tag / asset / reproducible-dir
 * mapping. Pure logic — the expected values mirror what `gh release
 * list` / `gh release view` showed for the real repos.
 */

import { expect } from "chai";
import { powpegReleaseCoordinates, rskjReleaseCoordinates } from "../../src/build/versions.js";

describe("build/versions: rskjReleaseCoordinates", () => {
  it("maps a plain version to tag, asset, and reproducible dir", () => {
    const coords = rskjReleaseCoordinates("9.0.1");
    expect(coords.version).to.equal("9.0.1");
    expect(coords.codename).to.equal("VETIVER");
    expect(coords.tag).to.equal("VETIVER-9.0.1");
    expect(coords.assetName).to.equal("rskj-core-9.0.1-VETIVER-all.jar");
    expect(coords.reproducibleDir).to.equal("rskj/9.0.1-vetiver");
    expect(coords.repo).to.equal("rsksmart/rskj");
  });

  it("accepts the tag form (CODENAME-x.y.z)", () => {
    const coords = rskjReleaseCoordinates("VETIVER-9.0.1");
    expect(coords.tag).to.equal("VETIVER-9.0.1");
    expect(coords.version).to.equal("9.0.1");
  });

  it("accepts the reproducible-dir form (x.y.z-codename)", () => {
    const coords = rskjReleaseCoordinates("8.1.0-reed");
    expect(coords.tag).to.equal("REED-8.1.0");
    expect(coords.assetName).to.equal("rskj-core-8.1.0-REED-all.jar");
    expect(coords.reproducibleDir).to.equal("rskj/8.1.0-reed");
  });

  it("infers older codenames from the major version", () => {
    expect(rskjReleaseCoordinates("7.2.0").tag).to.equal("LOVELL-7.2.0");
    expect(rskjReleaseCoordinates("6.5.1").tag).to.equal("ARROWHEAD-6.5.1");
  });

  it("rejects a plain version with an unknown major", () => {
    expect(() => rskjReleaseCoordinates("42.0.0")).to.throw(/Unknown rskj major version 42/);
  });

  it("rejects garbage and wrong component counts", () => {
    expect(() => rskjReleaseCoordinates("not-a-version")).to.throw(/Unrecognized rskj/);
    expect(() => rskjReleaseCoordinates("9.0.0.0")).to.throw(/Unrecognized rskj/);
  });
});

describe("build/versions: powpegReleaseCoordinates", () => {
  it("maps a plain 4-component version to tag, asset, and reproducible dir", () => {
    const coords = powpegReleaseCoordinates("9.0.0.0");
    expect(coords.version).to.equal("9.0.0.0");
    expect(coords.tag).to.equal("VETIVER-9.0.0.0");
    expect(coords.assetName).to.equal("federate-node-VETIVER-9.0.0.0-all.jar");
    // powpeg reproducible dirs are uppercase, named like the tag.
    expect(coords.reproducibleDir).to.equal("powpeg-node/VETIVER-9.0.0.0");
    expect(coords.repo).to.equal("rsksmart/powpeg-node");
  });

  it("accepts the tag form", () => {
    const coords = powpegReleaseCoordinates("REED-8.1.0.0");
    expect(coords.tag).to.equal("REED-8.1.0.0");
    expect(coords.assetName).to.equal("federate-node-REED-8.1.0.0-all.jar");
  });

  it("rejects 3-component versions (those are rskj's)", () => {
    expect(() => powpegReleaseCoordinates("9.0.0")).to.throw(/Unrecognized powpeg-node/);
  });
});
