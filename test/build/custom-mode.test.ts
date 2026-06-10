/**
 * Unit tests for custom mode — path validation + fingerprinting. All
 * filesystem access goes through injected seams; nothing touches disk.
 */

import { expect } from "chai";
import { resolveCustom } from "../../src/build/custom-mode.js";
import type { BuildSeams, FileStat } from "../../src/build/seams.js";

/** Seams over a static path → {size, mode, sha256} table. */
function tableSeams(
  table: Record<string, { size: number; mode?: number; sha256: string }>,
): BuildSeams {
  return {
    existsFn: (p: string) => p in table,
    statFn: (p: string): FileStat => ({
      isFile: () => true,
      size: table[p]!.size,
      mode: table[p]!.mode ?? 0o755,
    }),
    sha256FileFn: async (p: string) => table[p]!.sha256,
    log: () => undefined,
  };
}

const RSKJ_SHA = "0929678bc5fedb4e49a43b5207e6d053d38900f320cada2fc198a0c7ed7982d7";
const POWPEG_SHA = "d4b12e58e7985b5818e7f75272564a6e4ae83e258ec57d73485ab1a7daecdf68";
const SIGNER_SHA = "1111111111111111111111111111111111111111111111111111111111111111";

describe("build/custom-mode: resolveCustom", () => {
  it("throws when the rskj jar does not exist", async () => {
    let err: Error | null = null;
    try {
      await resolveCustom({ mode: "custom", rskjJar: "/missing.jar" }, tableSeams({}));
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.not.equal(null);
    expect(err!.message).to.match(/--rskj-jar path does not exist: \/missing\.jar/);
  });

  it("throws when a supplied path is not a regular file", async () => {
    const seams = tableSeams({ "/a/dir": { size: 0, sha256: RSKJ_SHA } });
    seams.statFn = (): FileStat => ({ isFile: () => false, size: 0, mode: 0o755 });
    let err: Error | null = null;
    try {
      await resolveCustom({ mode: "custom", rskjJar: "/a/dir" }, seams);
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.not.equal(null);
    expect(err!.message).to.match(/not a regular file/);
  });

  it("fingerprints the rskj jar (path, size, sha256) into provenance", async () => {
    const result = await resolveCustom(
      { mode: "custom", rskjJar: "/abs/rskj-core-9.0.2-VETIVER-all.jar" },
      tableSeams({ "/abs/rskj-core-9.0.2-VETIVER-all.jar": { size: 94535882, sha256: RSKJ_SHA } }),
    );
    expect(result.rskjJarPath).to.equal("/abs/rskj-core-9.0.2-VETIVER-all.jar");
    expect(result.provenance.rskj).to.deep.equal({
      component: "rskj",
      mode: "custom",
      path: "/abs/rskj-core-9.0.2-VETIVER-all.jar",
      sha256: RSKJ_SHA,
      sizeBytes: 94535882,
    });
    expect(result.powpegJarPath).to.equal(undefined);
    expect(result.tcpsignerPath).to.equal(undefined);
    expect(result.warnings).to.deep.equal([]);
  });

  it("accepts a release-named powpeg jar without warnings", async () => {
    const result = await resolveCustom(
      {
        mode: "custom",
        rskjJar: "/abs/rskj-all.jar",
        powpegJar: "/abs/federate-node-VETIVER-9.0.0.0-all.jar",
      },
      tableSeams({
        "/abs/rskj-all.jar": { size: 1, sha256: RSKJ_SHA },
        "/abs/federate-node-VETIVER-9.0.0.0-all.jar": { size: 2, sha256: POWPEG_SHA },
      }),
    );
    expect(result.powpegJarPath).to.equal("/abs/federate-node-VETIVER-9.0.0.0-all.jar");
    expect(result.provenance.powpeg!.sha256).to.equal(POWPEG_SHA);
    expect(result.warnings).to.deep.equal([]);
  });

  it("warns (but does not fail) when the powpeg jar name is unconventional", async () => {
    const result = await resolveCustom(
      { mode: "custom", rskjJar: "/abs/rskj-all.jar", powpegJar: "/abs/my-local-build.jar" },
      tableSeams({
        "/abs/rskj-all.jar": { size: 1, sha256: RSKJ_SHA },
        "/abs/my-local-build.jar": { size: 2, sha256: POWPEG_SHA },
      }),
    );
    expect(result.powpegJarPath).to.equal("/abs/my-local-build.jar");
    expect(result.warnings).to.have.length(1);
    expect(result.warnings[0]).to.match(/does not match the release naming/);
  });

  it("throws when the powpeg jar path does not exist", async () => {
    let err: Error | null = null;
    try {
      await resolveCustom(
        { mode: "custom", rskjJar: "/abs/rskj-all.jar", powpegJar: "/missing-powpeg.jar" },
        tableSeams({ "/abs/rskj-all.jar": { size: 1, sha256: RSKJ_SHA } }),
      );
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.not.equal(null);
    expect(err!.message).to.match(/--powpeg-jar path does not exist/);
  });

  it("fingerprints the tcpsigner and warns when it is not executable", async () => {
    const result = await resolveCustom(
      { mode: "custom", rskjJar: "/abs/rskj-all.jar", tcpsigner: "/abs/tcpsigner" },
      tableSeams({
        "/abs/rskj-all.jar": { size: 1, sha256: RSKJ_SHA },
        "/abs/tcpsigner": { size: 3, sha256: SIGNER_SHA, mode: 0o644 },
      }),
    );
    expect(result.tcpsignerPath).to.equal("/abs/tcpsigner");
    expect(result.provenance.tcpsigner!.sha256).to.equal(SIGNER_SHA);
    expect(result.warnings).to.have.length(1);
    expect(result.warnings[0]).to.match(/not executable/);
  });

  it("does not warn for an executable tcpsigner", async () => {
    const result = await resolveCustom(
      { mode: "custom", rskjJar: "/abs/rskj-all.jar", tcpsigner: "/abs/tcpsigner" },
      tableSeams({
        "/abs/rskj-all.jar": { size: 1, sha256: RSKJ_SHA },
        "/abs/tcpsigner": { size: 3, sha256: SIGNER_SHA, mode: 0o755 },
      }),
    );
    expect(result.warnings).to.deep.equal([]);
  });
});
