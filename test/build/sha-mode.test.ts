/**
 * Unit tests for sha mode — ref normalization, cache-hit
 * short-circuiting, partial-build detection, build/cache file layout,
 * lock behaviour, and rskj/powpeg independence. The git / gradle /
 * java child processes are scripted FakeChild EventEmitters (same
 * style as the orchestrator runner tests); the filesystem is an
 * in-memory fake. Nothing forks, nothing touches disk or network.
 */

import { expect } from "chai";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { resolveSha } from "../../src/build/sha-mode.js";
import type { BuildSeams, FileStat } from "../../src/build/seams.js";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** In-memory filesystem — same shape as in release-mode.test.ts. */
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

/* -------------------------------------------------------------------------- *
 * Scripted child processes
 * -------------------------------------------------------------------------- */

interface Outcome {
  code: number;
  stdout?: string;
  stderr?: string;
}

class FakeChild extends EventEmitter {
  stdout = new Readable({ read() {} });
  stderr = new Readable({ read() {} });
  pid = 777;
  constructor(outcome: Outcome) {
    super();
    setImmediate(() => {
      if (outcome.stdout) this.stdout.emit("data", Buffer.from(outcome.stdout));
      if (outcome.stderr) this.stderr.emit("data", Buffer.from(outcome.stderr));
      this.emit("close", outcome.code, null);
    });
  }
}

interface ExecCall {
  cmd: string;
  args: string[];
  cwd: string;
}

type ExecScript = (call: ExecCall) => Outcome;

function scriptedSpawn(script: ExecScript): { spawnFn: BuildSeams["spawnFn"]; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const spawnFn = ((cmd: unknown, args: unknown, options: unknown) => {
    const call: ExecCall = {
      cmd: cmd as string,
      args: args as string[],
      cwd: (options as { cwd?: string }).cwd ?? "",
    };
    calls.push(call);
    return new FakeChild(script(call));
  }) as unknown as BuildSeams["spawnFn"];
  return { spawnFn, calls };
}

/** Friendly token for assertions on call sequences. */
function tokenFor(call: ExecCall): string {
  if (call.cmd === "git") {
    const sub = call.args.find((a) => !a.startsWith("--git-dir="))!;
    if (sub === "worktree") return `git-worktree-${call.args[call.args.indexOf("worktree") + 1]}`;
    return `git-${sub}`;
  }
  return call.cmd;
}

/* -------------------------------------------------------------------------- *
 * Fixtures
 * -------------------------------------------------------------------------- */

const CACHE = "/cache";
const RSKJ_SHA = "0123456789abcdef0123456789abcdef01234567";
const POWPEG_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const RSKJ_JAR = "rskj-core-9.9.9-TEST-all.jar";
const POWPEG_JAR = "federate-node-TEST-9.9.9.9-all.jar";
const RSKJ_ENTRY = `${CACHE}/builds/rskj/${RSKJ_SHA}`;

/**
 * Default happy-path script: rev-parse answers per component, gradle
 * "produces" the fat jar (plus a sources jar that must be filtered out)
 * in the right libs dir, java -version reports a JDK.
 */
function happyScript(fs: FakeFs): ExecScript {
  return (call: ExecCall): Outcome => {
    const gitDir = call.args.find((a) => a.startsWith("--git-dir="))?.slice("--git-dir=".length);
    const component = (gitDir ?? call.cwd).includes("powpeg") ? "powpeg" : "rskj";
    const sha = component === "rskj" ? RSKJ_SHA : POWPEG_SHA;
    if (call.cmd === "git" && call.args.includes("clone")) {
      fs.files.set(`${call.args[call.args.length - 1]}/HEAD`, "ref: refs/heads/master");
      return { code: 0 };
    }
    if (call.cmd === "git" && call.args.includes("rev-parse")) {
      return { code: 0, stdout: `${sha}\n` };
    }
    if (call.cmd === "./gradlew") {
      const libs =
        component === "rskj" ? `${call.cwd}/rskj-core/build/libs` : `${call.cwd}/build/libs`;
      const jarName = component === "rskj" ? RSKJ_JAR : POWPEG_JAR;
      fs.files.set(`${libs}/${jarName}`, `built-${component}-${sha}`);
      fs.files.set(`${libs}/${jarName.replace("-all.jar", "-sources.jar")}`, "sources");
      return { code: 0 };
    }
    if (call.cmd === "java") {
      return { code: 0, stderr: 'openjdk version "17.0.19" 2026-04-21\n' };
    }
    return { code: 0 }; // fetch, worktree add/remove, configure.sh, ...
  };
}

function seedValidRskjEntry(fs: FakeFs): void {
  const content = `built-rskj-${RSKJ_SHA}`;
  fs.files.set(`${RSKJ_ENTRY}/${RSKJ_JAR}`, content);
  fs.files.set(`${RSKJ_ENTRY}/jar.sha256`, `${sha256(content)}  ${RSKJ_JAR}\n`);
  fs.files.set(`${RSKJ_ENTRY}/build.json`, "{}");
  fs.files.set(`${RSKJ_ENTRY}/.complete`, "");
}

describe("build/sha-mode: resolveSha", () => {
  it("clones, fetches, normalizes the ref, builds, and caches on a cold miss", async () => {
    const fs = new FakeFs();
    const { spawnFn, calls } = scriptedSpawn(happyScript(fs));

    const result = await resolveSha(
      { mode: "sha", rskjRef: "master", cacheDir: CACHE },
      fs.seams({ spawnFn }),
    );

    // Command sequence: bare clone (no repo yet) → fetch (branch refs
    // always fetch) → rev-parse → worktree add → configure.sh →
    // gradlew fatJar → java -version (for build.json) → worktree remove.
    expect(calls.map(tokenFor)).to.deep.equal([
      "git-clone",
      "git-fetch",
      "git-rev-parse",
      "git-worktree-add",
      "./configure.sh",
      "./gradlew",
      "java",
      "git-worktree-remove",
    ]);

    // The worktree was created at the SHA, not the branch name.
    const worktreeAdd = calls.find((c) => tokenFor(c) === "git-worktree-add")!;
    expect(worktreeAdd.args[worktreeAdd.args.length - 1]).to.equal(RSKJ_SHA);

    // configure.sh + gradlew ran inside the throwaway tree.
    const treeDir = `${CACHE}/builds/rskj/${RSKJ_SHA}.tree.4242`;
    expect(calls.find((c) => c.cmd === "./configure.sh")!.cwd).to.equal(treeDir);
    const gradlew = calls.find((c) => c.cmd === "./gradlew")!;
    expect(gradlew.cwd).to.equal(treeDir);
    expect(gradlew.args).to.deep.equal(["--no-daemon", "fatJar"]);

    // Cache entry: jar + jar.sha256 + build.json + .complete (last).
    const jarContent = `built-rskj-${RSKJ_SHA}`;
    expect(fs.files.get(`${RSKJ_ENTRY}/${RSKJ_JAR}`)).to.equal(jarContent);
    expect(fs.files.get(`${RSKJ_ENTRY}/jar.sha256`)).to.equal(
      `${sha256(jarContent)}  ${RSKJ_JAR}\n`,
    );
    const buildInfo = JSON.parse(fs.files.get(`${RSKJ_ENTRY}/build.json`)!) as Record<
      string,
      unknown
    >;
    expect(buildInfo.ref).to.equal("master");
    expect(buildInfo.sha).to.equal(RSKJ_SHA);
    expect(buildInfo.task).to.equal("fatJar");
    expect(buildInfo.jdk).to.match(/openjdk version "17/);
    expect(fs.files.has(`${RSKJ_ENTRY}/.complete`)).to.equal(true);
    const tmpWrites = fs.writeOrder.filter((p) => p.includes(".tmp.4242"));
    expect(tmpWrites[tmpWrites.length - 1]).to.equal(`${RSKJ_ENTRY}.tmp.4242/.complete`);

    // Lock released, worktree cleaned up.
    expect(fs.removed).to.include(`${CACHE}/builds/rskj/${RSKJ_SHA}.lock`);

    // Provenance.
    expect(result.rskjJarPath).to.equal(`${RSKJ_ENTRY}/${RSKJ_JAR}`);
    expect(result.provenance.rskj).to.deep.include({
      component: "rskj",
      mode: "sha",
      ref: "master",
      commitSha: RSKJ_SHA,
      version: "9.9.9-TEST",
      sha256: sha256(jarContent),
      cacheHit: false,
    });
  });

  it("re-resolving the same full SHA is a pure cache hit — zero child processes", async () => {
    const fs = new FakeFs();
    seedValidRskjEntry(fs);
    const { spawnFn, calls } = scriptedSpawn(happyScript(fs));

    const result = await resolveSha(
      { mode: "sha", rskjRef: RSKJ_SHA, cacheDir: CACHE },
      fs.seams({ spawnFn }),
    );

    expect(calls).to.deep.equal([]);
    expect(result.provenance.rskj!.cacheHit).to.equal(true);
    expect(result.provenance.rskj!.commitSha).to.equal(RSKJ_SHA);
    expect(result.rskjJarPath).to.equal(`${RSKJ_ENTRY}/${RSKJ_JAR}`);
  });

  it("a partial build (missing .complete) is invalidated and rebuilt", async () => {
    const fs = new FakeFs();
    seedValidRskjEntry(fs);
    fs.files.delete(`${RSKJ_ENTRY}/.complete`);
    fs.files.set(`${CACHE}/src/rskj.git/HEAD`, "ref"); // bare repo already cached
    const { spawnFn, calls } = scriptedSpawn(happyScript(fs));

    const result = await resolveSha(
      { mode: "sha", rskjRef: RSKJ_SHA, cacheDir: CACHE },
      fs.seams({ spawnFn }),
    );

    expect(fs.removed).to.include(RSKJ_ENTRY);
    expect(calls.map(tokenFor)).to.include("./gradlew");
    // Full SHA already known locally — no clone, no fetch.
    expect(calls.map(tokenFor)).to.not.include("git-clone");
    expect(calls.map(tokenFor)).to.not.include("git-fetch");
    expect(result.provenance.rskj!.cacheHit).to.equal(false);
    expect(fs.files.has(`${RSKJ_ENTRY}/.complete`)).to.equal(true);
  });

  it("a corrupted entry (jar hash mismatch) is invalidated and rebuilt", async () => {
    const fs = new FakeFs();
    seedValidRskjEntry(fs);
    fs.files.set(`${RSKJ_ENTRY}/${RSKJ_JAR}`, "bit-rotted-bytes");
    fs.files.set(`${CACHE}/src/rskj.git/HEAD`, "ref");
    const { spawnFn, calls } = scriptedSpawn(happyScript(fs));

    const result = await resolveSha(
      { mode: "sha", rskjRef: RSKJ_SHA, cacheDir: CACHE },
      fs.seams({ spawnFn }),
    );

    expect(fs.removed).to.include(RSKJ_ENTRY);
    expect(calls.map(tokenFor)).to.include("./gradlew");
    expect(result.provenance.rskj!.sha256).to.equal(sha256(`built-rskj-${RSKJ_SHA}`));
  });

  it("branch and SHA spellings of the same commit share one cache entry", async () => {
    const fs = new FakeFs();
    const { spawnFn } = scriptedSpawn(happyScript(fs));
    await resolveSha({ mode: "sha", rskjRef: "master", cacheDir: CACHE }, fs.seams({ spawnFn }));

    // Second run, same commit via its full SHA: pure hit, no rebuild.
    const second = scriptedSpawn(happyScript(fs));
    const result = await resolveSha(
      { mode: "sha", rskjRef: RSKJ_SHA, cacheDir: CACHE },
      fs.seams({ spawnFn: second.spawnFn }),
    );
    expect(second.calls).to.deep.equal([]);
    expect(result.provenance.rskj!.cacheHit).to.equal(true);
  });

  it("resolves rskj and powpeg independently, from their own repos and layouts", async () => {
    const fs = new FakeFs();
    const { spawnFn, calls } = scriptedSpawn(happyScript(fs));

    const result = await resolveSha(
      { mode: "sha", rskjRef: RSKJ_SHA, powpegRef: POWPEG_SHA, cacheDir: CACHE },
      fs.seams({ spawnFn }),
    );

    const cloneUrls = calls
      .filter((c) => tokenFor(c) === "git-clone")
      .map((c) => c.args[c.args.length - 2]);
    expect(cloneUrls).to.deep.equal([
      "https://github.com/rsksmart/rskj.git",
      "https://github.com/rsksmart/powpeg-node.git",
    ]);
    expect(result.rskjJarPath).to.equal(`${RSKJ_ENTRY}/${RSKJ_JAR}`);
    // The powpeg jar embeds rskj-core from the rskj SHA, so its cache entry is
    // keyed by both SHAs.
    expect(result.powpegJarPath).to.equal(
      `${CACHE}/builds/powpeg/${POWPEG_SHA}__rskj-${RSKJ_SHA}/${POWPEG_JAR}`,
    );
    expect(result.provenance.powpeg).to.deep.include({
      component: "powpeg",
      mode: "sha",
      commitSha: POWPEG_SHA,
      version: "TEST-9.9.9.9",
      cacheHit: false,
    });
  });

  it("wires powpeg to composite-build rskj-core from the requested rskj source", async () => {
    const fs = new FakeFs();
    const { spawnFn, calls } = scriptedSpawn(happyScript(fs));

    await resolveSha(
      { mode: "sha", rskjRef: RSKJ_SHA, powpegRef: POWPEG_SHA, cacheDir: CACHE },
      fs.seams({ spawnFn }),
    );

    // A DONT-COMMIT-settings.gradle is written into the powpeg build tree (its
    // settings.gradle applies it) pointing includeBuild at a throwaway rskj
    // source worktree, with the SNAPSHOT/RC rskj-core substitution.
    const powpegTree = `${CACHE}/builds/powpeg/${POWPEG_SHA}.tree.4242`;
    const rskjCompositeSrc = `${CACHE}/builds/rskj/${RSKJ_SHA}.composite.4242`;
    const settings = fs.files.get(`${powpegTree}/DONT-COMMIT-settings.gradle`);
    expect(settings, "DONT-COMMIT-settings.gradle should be written").to.be.a("string");
    expect(settings).to.include(`includeBuild('${rskjCompositeSrc}')`);
    expect(settings).to.include("dependency.requested.module == 'rskj-core'");
    expect(settings).to.include("dependency.useTarget targetProject");

    // The composite source is a worktree of the rskj bare repo (no second
    // clone), configured, then removed.
    const compositeAdd = calls.find(
      (c) => c.cmd === "git" && c.args.includes("worktree") && c.args.includes(rskjCompositeSrc),
    );
    expect(compositeAdd, "rskj composite worktree add").to.not.equal(undefined);
    expect(compositeAdd!.args).to.include("--detach");
    expect(compositeAdd!.args[compositeAdd!.args.length - 1]).to.equal(RSKJ_SHA);
    expect(
      calls.some((c) => c.cmd === "./configure.sh" && c.cwd === rskjCompositeSrc),
      "configure.sh runs in the composite source",
    ).to.equal(true);
    expect(
      calls.some(
        (c) => c.cmd === "git" && c.args.includes("worktree") && c.args.includes("remove"),
      ),
      "composite worktree is cleaned up",
    ).to.equal(true);
  });

  it("removes a stale lock left by a dead pid and proceeds to build", async () => {
    const fs = new FakeFs();
    fs.files.set(`${CACHE}/src/rskj.git/HEAD`, "ref");
    const lockPath = `${CACHE}/builds/rskj/${RSKJ_SHA}.lock`;
    fs.files.set(lockPath, "999999\n");
    const { spawnFn, calls } = scriptedSpawn(happyScript(fs));

    const result = await resolveSha(
      { mode: "sha", rskjRef: RSKJ_SHA, cacheDir: CACHE },
      fs.seams({ spawnFn, processAliveFn: () => false }),
    );

    expect(fs.removed.filter((p) => p === lockPath).length).to.be.greaterThan(1); // stale + release
    expect(calls.map(tokenFor)).to.include("./gradlew");
    expect(result.provenance.rskj!.cacheHit).to.equal(false);
  });

  it("waits on a live lock and serves the entry the other builder produced", async () => {
    const fs = new FakeFs();
    fs.files.set(`${CACHE}/src/rskj.git/HEAD`, "ref");
    const lockPath = `${CACHE}/builds/rskj/${RSKJ_SHA}.lock`;
    fs.files.set(lockPath, "1\n");
    const { spawnFn, calls } = scriptedSpawn(happyScript(fs));
    let sleeps = 0;

    const result = await resolveSha(
      { mode: "sha", rskjRef: RSKJ_SHA, cacheDir: CACHE },
      fs.seams({
        spawnFn,
        processAliveFn: () => true,
        sleepFn: async () => {
          // Simulate the concurrent builder finishing while we wait.
          sleeps++;
          fs.files.delete(lockPath);
          seedValidRskjEntry(fs);
        },
      }),
    );

    expect(sleeps).to.equal(1);
    expect(result.provenance.rskj!.cacheHit).to.equal(true);
    // We never built anything ourselves.
    expect(calls.map(tokenFor)).to.not.include("./configure.sh");
    expect(calls.map(tokenFor)).to.not.include("./gradlew");
  });

  it("fails clearly when the ref cannot be resolved even after fetching", async () => {
    const fs = new FakeFs();
    fs.files.set(`${CACHE}/src/rskj.git/HEAD`, "ref");
    const { spawnFn } = scriptedSpawn((call) => {
      if (call.cmd === "git" && call.args.includes("rev-parse")) return { code: 128 };
      return { code: 0 };
    });

    let err: Error | null = null;
    try {
      await resolveSha(
        { mode: "sha", rskjRef: "no-such-branch", cacheDir: CACHE },
        fs.seams({ spawnFn }),
      );
    } catch (e) {
      err = e as Error;
    }
    expect(err, "should have thrown").to.not.equal(null);
    expect(err!.message).to.match(/Cannot resolve ref "no-such-branch"/);
  });

  it("fails the build when gradle exits non-zero, and leaves no cache entry", async () => {
    const fs = new FakeFs();
    fs.files.set(`${CACHE}/src/rskj.git/HEAD`, "ref");
    const { spawnFn } = scriptedSpawn((call) => {
      if (call.cmd === "git" && call.args.includes("rev-parse")) {
        return { code: 0, stdout: `${RSKJ_SHA}\n` };
      }
      if (call.cmd === "./gradlew") return { code: 1, stderr: "BUILD FAILED\n" };
      return { code: 0 };
    });

    let err: Error | null = null;
    try {
      await resolveSha({ mode: "sha", rskjRef: RSKJ_SHA, cacheDir: CACHE }, fs.seams({ spawnFn }));
    } catch (e) {
      err = e as Error;
    }
    expect(err, "should have thrown").to.not.equal(null);
    expect(err!.message).to.match(/gradlew fatJar failed with exit code 1/);
    expect(fs.exists(RSKJ_ENTRY)).to.equal(false);
    // Lock must be released even on failure.
    expect(fs.files.has(`${CACHE}/builds/rskj/${RSKJ_SHA}.lock`)).to.equal(false);
  });
});
