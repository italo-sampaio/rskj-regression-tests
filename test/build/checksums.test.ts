/**
 * Unit tests for the sha256sum-line parser. The fixtures are excerpts
 * of the real documents (reproducible-builds README for rskj
 * 9.0.0-vetiver, SHA256SUMS.asc for VETIVER-9.0.1) so the parser is
 * locked to the formats actually published.
 */

import { expect } from "chai";
import { extractSha256ForAsset } from "../../src/build/checksums.js";

const README_FIXTURE = `# Build instructions

## Verify

The last step of the build prints the sha256sum of the files, if, for any reason there's a need to recheck the hash the following commands can be used to generate them.

\`\`\`
$ docker run --rm rskj/9.0.0-vetiver sh -c 'sha256sum * | grep -v javadoc.jar'
f120a63d685a4df9344371358ac16bbd65ed54b09db79357d2f1fdc2c94c8a8f  rskj-core-9.0.0-VETIVER-all.jar
035decfbcd1dfcb1cf90290e14d95cc621abe2482375802453f13ee458730526  rskj-core-9.0.0-VETIVER-sources.jar
04bb7ca2016e9e66b2924222c67e6bef0d7f41f24c08d23fe5edf0615bbb430b  rskj-core-9.0.0-VETIVER.jar
\`\`\`

## (Optional) Run RSK Node
`;

const SHA256SUMS_FIXTURE = `-----BEGIN PGP SIGNED MESSAGE-----
Hash: SHA256

ffa9ada4e58ede93b342171ce635392f99315b744efbf251bda2fb2cd18da3bb  rskj-core-9.0.1-VETIVER-all.jar
d21a454cf8b16624db23cc4de210840567f3980685046602f9cb44b79085bb49  rskj-core-9.0.1-VETIVER-sources.jar
cc80674ba45588f56bd67a7661f577842cd55661cef89a05b6baa99180381171  rskj-core-9.0.1-VETIVER.jar
-----BEGIN PGP SIGNATURE-----

iQIzBAEBCAAdFiEENZfDVewEdqBfLTLV47fJQYVhL8kFAmnWr2UACgkQ47fJQYVh
-----END PGP SIGNATURE-----
`;

describe("build/checksums: extractSha256ForAsset", () => {
  it("finds the -all.jar line in a reproducible-builds README", () => {
    expect(extractSha256ForAsset(README_FIXTURE, "rskj-core-9.0.0-VETIVER-all.jar")).to.equal(
      "f120a63d685a4df9344371358ac16bbd65ed54b09db79357d2f1fdc2c94c8a8f",
    );
  });

  it("picks the asset's own line, not its siblings'", () => {
    expect(extractSha256ForAsset(README_FIXTURE, "rskj-core-9.0.0-VETIVER.jar")).to.equal(
      "04bb7ca2016e9e66b2924222c67e6bef0d7f41f24c08d23fe5edf0615bbb430b",
    );
  });

  it("finds the -all.jar line in a clear-signed SHA256SUMS.asc", () => {
    expect(extractSha256ForAsset(SHA256SUMS_FIXTURE, "rskj-core-9.0.1-VETIVER-all.jar")).to.equal(
      "ffa9ada4e58ede93b342171ce635392f99315b744efbf251bda2fb2cd18da3bb",
    );
  });

  it("returns null when no line names the asset", () => {
    expect(extractSha256ForAsset(README_FIXTURE, "rskj-core-1.2.3-NOPE-all.jar")).to.equal(null);
    expect(extractSha256ForAsset("", "x-all.jar")).to.equal(null);
  });

  it("ignores lines whose hash is not 64 hex chars", () => {
    const malformed = "deadbeef  rskj-core-9.0.0-VETIVER-all.jar\n";
    expect(extractSha256ForAsset(malformed, "rskj-core-9.0.0-VETIVER-all.jar")).to.equal(null);
  });
});
