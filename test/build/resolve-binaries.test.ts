/**
 * Unit tests for the {@link resolveBinaries} front door — spec-shape
 * validation and mode dispatch. Mode internals are covered by their
 * own test files; here we lock in the error surface and that a valid
 * spec reaches the right resolver.
 */

import { expect } from "chai";
import { resolveBinaries } from "../../src/build/resolve-binaries.js";
import type { BuildSourceSpec } from "../../src/build/types.js";
import type { FileStat } from "../../src/build/seams.js";

async function expectRejection(spec: unknown): Promise<Error> {
  let err: Error | null = null;
  try {
    await resolveBinaries(spec as BuildSourceSpec);
  } catch (e) {
    err = e as Error;
  }
  expect(err, "should have thrown").to.not.equal(null);
  return err!;
}

describe("build/resolve-binaries: spec validation", () => {
  it("rejects a non-object spec", async () => {
    const err = await expectRejection(null);
    expect(err.message).to.match(/spec must be an object/);
  });

  it("rejects an unknown mode", async () => {
    const err = await expectRejection({ mode: "docker" });
    expect(err.message).to.match(/unknown mode "docker"/);
  });

  it("rejects release mode without rskjVersion", async () => {
    const err = await expectRejection({ mode: "release" });
    expect(err.message).to.match(/release mode requires "rskjVersion"/);
  });

  it("rejects custom mode without rskjJar", async () => {
    const err = await expectRejection({ mode: "custom" });
    expect(err.message).to.match(/custom mode requires "rskjJar"/);
  });

  it("rejects sha mode without any ref", async () => {
    const err = await expectRejection({ mode: "sha" });
    expect(err.message).to.match(/at least one of "rskjRef" \/ "powpegRef"/);
  });

  it("rejects empty-string required fields", async () => {
    const err = await expectRejection({ mode: "custom", rskjJar: "   " });
    expect(err.message).to.match(/custom mode requires "rskjJar"/);
  });
});

describe("build/resolve-binaries: dispatch", () => {
  it("routes a custom spec to the custom resolver (seams pass through)", async () => {
    const result = await resolveBinaries(
      { mode: "custom", rskjJar: "/abs/rskj-all.jar" },
      {
        existsFn: () => true,
        statFn: (): FileStat => ({ isFile: () => true, size: 7, mode: 0o755 }),
        sha256FileFn: async () => "ab".repeat(32),
      },
    );
    expect(result.rskjJarPath).to.equal("/abs/rskj-all.jar");
    expect(result.provenance.rskj!.mode).to.equal("custom");
    expect(result.provenance.rskj!.sha256).to.equal("ab".repeat(32));
  });
});
