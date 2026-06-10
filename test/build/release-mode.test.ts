/**
 * Unit tests for release mode — README sha parsing, cache hit / miss /
 * corruption, and the stale-reproducible-builds fallback. Everything
 * runs against an in-memory fake filesystem + a scripted download stub;
 * no network, no disk. (Hashing in-memory strings with node:crypto is
 * the only "real" work — that's the verification logic under test.)
 */

import { expect } from "chai";
import { createHash } from "node:crypto";
import { resolveRelease } from "../../src/build/release-mode.js";
import type { BuildSeams, FileStat } from "../../src/build/seams.js";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Minimal in-memory filesystem honouring the prefix semantics the
 * cache code relies on (recursive rm, atomic dir rename, readdir).
 * Kept local to this file — same self-contained-fakes convention as
 * the suite-runner tests.
 */
class FakeFs {
  files = new Map<string, string>();
  dirs = new Set<string>();
  writeOrder: string[] = [];
  removed: string[] = [];

  seams(extra: Partial<BuildSeams> = {}): BuildSeams {
    return {
      existsFn: (p: string) => this.exists(p),
      statFn: (p: string): FileStat => ({
        isFile: () => this.files.has(p),
        size: this.files.get(p)?.length ?? 0,
        mode: 0o755,
      }),
      readFileFn: (p: string) => {
        const contents = this.files.get(p);
        if (contents === undefined) throw new Error(`ENOENT: ${p}`);
        return contents;
      },
      writeFileFn: (p: string, c: string) => {
        this.files.set(p, c);
        this.writeOrder.push(p);
      },
      mkdirFn: (p: string) => {
        this.dirs.add(p);
      },
      rmFn: (p: string) => this.rm(p),
      renameFn: (from: string, to: string) => this.rename(from, to),
      readdirFn: (p: string) => this.readdir(p),
      copyFileFn: (from: string, to: string) => {
        this.files.set(to, this.files.get(from) ?? "");
        this.writeOrder.push(to);
      },
      openExclusiveFn: (p: string, c: string) => {
        if (this.files.has(p)) return false;
        this.files.set(p, c);
        return true;
      },
      sha256FileFn: async (p: string) => {
        const contents = this.files.get(p);
        if (contents === undefined) throw new Error(`ENOENT: ${p}`);
        return sha256(contents);
      },
      env: {},
      pid: 4242,
      sleepFn: async () => undefined,
      log: () => undefined,
      ...extra,
    };
  }

  exists(p: string): boolean {
    if (this.files.has(p) || this.dirs.has(p)) return true;
    const prefix = p.endsWith("/") ? p : `${p}/`;
    for (const key of this.files.keys()) if (key.startsWith(prefix)) return true;
    for (const dir of this.dirs) if (dir.startsWith(prefix)) return true;
    return false;
  }

  rm(p: string): void {
    this.removed.push(p);
    const prefix = `${p}/`;
    this.files.delete(p);
    this.dirs.delete(p);
    for (const key of [...this.files.keys()]) if (key.startsWith(prefix)) this.files.delete(key);
    for (const dir of [...this.dirs]) if (dir.startsWith(prefix)) this.dirs.delete(dir);
  }

  rename(from: string, to: string): void {
    const prefix = `${from}/`;
    for (const [key, value] of [...this.files]) {
      if (key === from) {
        this.files.delete(key);
        this.files.set(to, value);
      } else if (key.startsWith(prefix)) {
        this.files.delete(key);
        this.files.set(to + key.slice(from.length), value);
      }
    }
    for (const dir of [...this.dirs]) {
      if (dir === from || dir.startsWith(prefix)) {
        this.dirs.delete(dir);
        this.dirs.add(to + dir.slice(from.length));
      }
    }
  }

  readdir(p: string): string[] {
    const prefix = p.endsWith("/") ? p : `${p}/`;
    const names = new Set<string>();
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split("/")[0]!);
    }
    for (const dir of this.dirs) {
      if (dir.startsWith(prefix)) names.add(dir.slice(prefix.length).split("/")[0]!);
    }
    return [...names];
  }
}

function downloadStub(
  fs: FakeFs,
  responses: Record<string, string>,
): { downloadFn: (url: string, dest: string) => Promise<void>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    downloadFn: async (url: string, dest: string): Promise<void> => {
      calls.push(url);
      const body = responses[url];
      if (body === undefined) throw new Error(`unexpected download: ${url}`);
      fs.files.set(dest, body);
      fs.writeOrder.push(dest);
    },
  };
}

const CACHE = "/cache";
const REPRO = "/repro";
const ASSET = "rskj-core-9.0.1-VETIVER-all.jar";
const JAR_CONTENT = "fake-rskj-9.0.1-jar-bytes";
const JAR_SHA = sha256(JAR_CONTENT);
const ENTRY = `${CACHE}/releases/rskj/VETIVER-9.0.1`;
const JAR_URL = `https://github.com/rsksmart/rskj/releases/download/VETIVER-9.0.1/${ASSET}`;
const SUMS_URL = `https://github.com/rsksmart/rskj/releases/download/VETIVER-9.0.1/SHA256SUMS.asc`;

function readmeFor(asset: string, sha: string): string {
  return `## Verify\n\n\`\`\`\n${sha}  ${asset}\n\`\`\`\n`;
}

function spec(): {
  mode: "release";
  rskjVersion: string;
  reproducibleBuildsPath: string;
  cacheDir: string;
} {
  return { mode: "release", rskjVersion: "9.0.1", reproducibleBuildsPath: REPRO, cacheDir: CACHE };
}

function seedValidEntry(fs: FakeFs, verification = "reproducible-builds"): void {
  fs.files.set(`${ENTRY}/${ASSET}`, JAR_CONTENT);
  fs.files.set(`${ENTRY}/jar.sha256`, `${JAR_SHA}  ${ASSET}\n`);
  fs.files.set(`${ENTRY}/source.json`, JSON.stringify({ verification }));
  fs.files.set(`${ENTRY}/.complete`, "");
}

describe("build/release-mode: resolveRelease", () => {
  it("downloads, verifies against the reproducible-builds README, and caches", async () => {
    const fs = new FakeFs();
    fs.files.set(`${REPRO}/rskj/9.0.1-vetiver/README.md`, readmeFor(ASSET, JAR_SHA));
    const { downloadFn, calls } = downloadStub(fs, { [JAR_URL]: JAR_CONTENT });

    const result = await resolveRelease(spec(), fs.seams({ downloadFn }));

    expect(calls).to.deep.equal([JAR_URL]);
    expect(result.rskjJarPath).to.equal(`${ENTRY}/${ASSET}`);
    expect(result.warnings).to.deep.equal([]);
    expect(result.provenance.rskj).to.deep.include({
      component: "rskj",
      mode: "release",
      path: `${ENTRY}/${ASSET}`,
      sha256: JAR_SHA,
      version: "9.0.1",
      releaseTag: "VETIVER-9.0.1",
      verification: "reproducible-builds",
      cacheHit: false,
    });

    // Cache entry shape: jar + jar.sha256 + source.json + .complete.
    expect(fs.files.get(`${ENTRY}/${ASSET}`)).to.equal(JAR_CONTENT);
    expect(fs.files.get(`${ENTRY}/jar.sha256`)).to.equal(`${JAR_SHA}  ${ASSET}\n`);
    const source = JSON.parse(fs.files.get(`${ENTRY}/source.json`)!) as Record<string, unknown>;
    expect(source.verification).to.equal("reproducible-builds");
    expect(source.url).to.equal(JAR_URL);
    expect(fs.files.has(`${ENTRY}/.complete`)).to.equal(true);

    // The sentinel was the LAST write into the staging dir.
    const tmpWrites = fs.writeOrder.filter((p) => p.includes(".tmp.4242"));
    expect(tmpWrites[tmpWrites.length - 1]).to.equal(`${ENTRY}.tmp.4242/.complete`);
  });

  it("serves a valid cache entry without downloading", async () => {
    const fs = new FakeFs();
    fs.files.set(`${REPRO}/rskj/9.0.1-vetiver/README.md`, readmeFor(ASSET, JAR_SHA));
    seedValidEntry(fs);
    const { downloadFn, calls } = downloadStub(fs, {});

    const result = await resolveRelease(spec(), fs.seams({ downloadFn }));

    expect(calls).to.deep.equal([]);
    expect(result.provenance.rskj!.cacheHit).to.equal(true);
    expect(result.provenance.rskj!.sha256).to.equal(JAR_SHA);
  });

  it("invalidates and re-fetches a corrupted entry (recorded sha mismatch)", async () => {
    const fs = new FakeFs();
    fs.files.set(`${REPRO}/rskj/9.0.1-vetiver/README.md`, readmeFor(ASSET, JAR_SHA));
    seedValidEntry(fs);
    fs.files.set(`${ENTRY}/${ASSET}`, "corrupted-bytes");
    const { downloadFn, calls } = downloadStub(fs, { [JAR_URL]: JAR_CONTENT });

    const result = await resolveRelease(spec(), fs.seams({ downloadFn }));

    expect(fs.removed).to.include(ENTRY);
    expect(calls).to.deep.equal([JAR_URL]);
    expect(result.provenance.rskj!.cacheHit).to.equal(false);
    expect(fs.files.get(`${ENTRY}/${ASSET}`)).to.equal(JAR_CONTENT);
  });

  it("invalidates and re-fetches when the .complete sentinel is missing", async () => {
    const fs = new FakeFs();
    fs.files.set(`${REPRO}/rskj/9.0.1-vetiver/README.md`, readmeFor(ASSET, JAR_SHA));
    seedValidEntry(fs);
    fs.files.delete(`${ENTRY}/.complete`);
    const { downloadFn, calls } = downloadStub(fs, { [JAR_URL]: JAR_CONTENT });

    const result = await resolveRelease(spec(), fs.seams({ downloadFn }));

    expect(calls).to.deep.equal([JAR_URL]);
    expect(result.provenance.rskj!.cacheHit).to.equal(false);
  });

  it("refuses to cache a download whose sha256 does not match", async () => {
    const fs = new FakeFs();
    fs.files.set(`${REPRO}/rskj/9.0.1-vetiver/README.md`, readmeFor(ASSET, JAR_SHA));
    const { downloadFn } = downloadStub(fs, { [JAR_URL]: "tampered-bytes" });

    let err: Error | null = null;
    try {
      await resolveRelease(spec(), fs.seams({ downloadFn }));
    } catch (e) {
      err = e as Error;
    }
    expect(err, "should have thrown").to.not.equal(null);
    expect(err!.message).to.match(/sha256 mismatch/);
    // No half-written staging dir and no (invalid) final entry left behind.
    expect([...fs.files.keys()].filter((p) => p.startsWith(`${ENTRY}.tmp`))).to.deep.equal([]);
    expect(fs.exists(ENTRY)).to.equal(false);
  });

  it("falls back to the release SHA256SUMS.asc when reproducible-builds is stale", async () => {
    const fs = new FakeFs(); // No README anywhere.
    const { downloadFn, calls } = downloadStub(fs, {
      [SUMS_URL]: `-----BEGIN PGP SIGNED MESSAGE-----\n\n${JAR_SHA}  ${ASSET}\n`,
      [JAR_URL]: JAR_CONTENT,
    });

    const result = await resolveRelease(spec(), fs.seams({ downloadFn }));

    expect(calls).to.deep.equal([SUMS_URL, JAR_URL]);
    expect(result.warnings).to.have.length(1);
    expect(result.warnings[0]).to.match(/falling back to the GitHub release's SHA256SUMS\.asc/);
    expect(result.provenance.rskj!.verification).to.equal("release-sha256sums");
    // The checksum file is kept in the entry for audit.
    expect(fs.files.has(`${ENTRY}/SHA256SUMS.asc`)).to.equal(true);
  });

  it("treats a README without the asset's line as unusable and warns twice", async () => {
    const fs = new FakeFs();
    fs.files.set(
      `${REPRO}/rskj/9.0.1-vetiver/README.md`,
      readmeFor("some-other-file.jar", JAR_SHA),
    );
    const { downloadFn } = downloadStub(fs, {
      [SUMS_URL]: `${JAR_SHA}  ${ASSET}\n`,
      [JAR_URL]: JAR_CONTENT,
    });

    const result = await resolveRelease(spec(), fs.seams({ downloadFn }));

    expect(result.warnings).to.have.length(2);
    expect(result.warnings[0]).to.match(/no sha256 line/);
    expect(result.provenance.rskj!.verification).to.equal("release-sha256sums");
  });

  it("keeps working offline on a warm cache even when reproducible-builds is stale", async () => {
    const fs = new FakeFs(); // No README.
    seedValidEntry(fs, "release-sha256sums");
    const { downloadFn, calls } = downloadStub(fs, {});

    const result = await resolveRelease(spec(), fs.seams({ downloadFn }));

    expect(calls).to.deep.equal([]);
    expect(result.provenance.rskj!.cacheHit).to.equal(true);
    // Verification source recorded at download time is surfaced, not guessed.
    expect(result.provenance.rskj!.verification).to.equal("release-sha256sums");
  });

  it("resolves rskj and powpeg releases independently", async () => {
    const fs = new FakeFs();
    const powpegAsset = "federate-node-VETIVER-9.0.0.0-all.jar";
    const powpegContent = "fake-powpeg-jar-bytes";
    const powpegUrl = `https://github.com/rsksmart/powpeg-node/releases/download/VETIVER-9.0.0.0/${powpegAsset}`;
    fs.files.set(`${REPRO}/rskj/9.0.1-vetiver/README.md`, readmeFor(ASSET, JAR_SHA));
    fs.files.set(
      `${REPRO}/powpeg-node/VETIVER-9.0.0.0/README.md`,
      readmeFor(powpegAsset, sha256(powpegContent)),
    );
    const { downloadFn, calls } = downloadStub(fs, {
      [JAR_URL]: JAR_CONTENT,
      [powpegUrl]: powpegContent,
    });

    const result = await resolveRelease(
      { ...spec(), powpegVersion: "9.0.0.0" },
      fs.seams({ downloadFn }),
    );

    expect(calls).to.have.members([JAR_URL, powpegUrl]);
    expect(result.powpegJarPath).to.equal(
      `${CACHE}/releases/powpeg/VETIVER-9.0.0.0/${powpegAsset}`,
    );
    expect(result.provenance.powpeg).to.deep.include({
      component: "powpeg",
      mode: "release",
      releaseTag: "VETIVER-9.0.0.0",
      version: "9.0.0.0",
      verification: "reproducible-builds",
      cacheHit: false,
    });
  });
});
