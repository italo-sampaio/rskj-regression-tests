/**
 * Mode 3 — build from a git ref.
 *
 * Clone strategy: one cached BARE repo per component under
 * `<cacheDir>/src/<component>.git` (cloned once from the canonical
 * rsksmart remotes, `git fetch`ed on later runs), and a throwaway
 * `git worktree` per build. We deliberately NEVER build inside the
 * developer's working checkouts (`~/workspace/rskj`,
 * `~/workspace/powpeg-node`): besides trampling uncommitted state, the
 * powpeg checkout carries a live `DONT-COMMIT-settings.gradle` that
 * silently substitutes the local rskj tree for SNAPSHOT/RC rskj-core
 * versions — a clean clone is the only hermetic option.
 *
 * Ref normalization: every ref (branch, tag, short SHA, full SHA) is
 * collapsed via `git rev-parse <ref>^{commit}` to the 40-char commit
 * SHA, which is the ONLY cache key. Branch names never key the cache —
 * they move. Non-SHA refs trigger a fetch first so a moved branch tip
 * resolves to today's commit, not whenever the bare repo last fetched;
 * a full 40-char SHA with a valid cache entry short-circuits before
 * any git call at all.
 *
 * Build recipe (verified on both repos — JDK 17, Gradle 8.6 wrapper):
 *
 *     ./configure.sh                 # fetches the gradle wrapper jar
 *                                    # from deps.rsklabs.io (fresh clones
 *                                    # don't carry it)
 *     ./gradlew --no-daemon fatJar
 *
 * Outputs land in `rskj-core/build/libs/rskj-core-<version>-all.jar`
 * (rskj) / `build/libs/federate-node-<modifier>-<version>-all.jar`
 * (powpeg). The filename is SHA-independent (it comes from
 * `version.properties`), so the cache is keyed by SHA and the jar name
 * is just recorded in `build.json`.
 *
 * Concurrency + atomicity: builders serialize on a `<sha>.lock`
 * pidfile next to the entry (O_EXCL create; a lock whose pid is dead
 * is treated as stale and removed — Node has no flock(2) without
 * native deps, so this is the portable equivalent). The entry itself
 * is staged in `<sha>.tmp.<pid>/` and atomically renamed, with
 * `.complete` written last — identical to release mode.
 */

import { join } from "node:path";
import { defaultCacheDir, finalizeCacheEntry, validateCacheEntry } from "./cache.js";
import { materializeSeams, type BuildSeams, type MaterializedSeams } from "./seams.js";
import type { BinaryProvenance, ResolvedBinaries, ShaBuildSpec } from "./types.js";

/** Canonical clone URLs per buildable component. */
const REPO_URLS = {
  rskj: "https://github.com/rsksmart/rskj.git",
  powpeg: "https://github.com/rsksmart/powpeg-node.git",
} as const;

/** Where the fat jar lands, relative to the build tree. */
const LIBS_DIR = {
  rskj: join("rskj-core", "build", "libs"),
  powpeg: join("build", "libs"),
} as const;

const FULL_SHA = /^[0-9a-f]{40}$/;

/** Give up on a held lock after this long (a cold gradle build runs 10–25 min). */
const LOCK_TIMEOUT_MS = 90 * 60 * 1000;
const LOCK_POLL_MS = 2_000;

type ShaComponent = keyof typeof REPO_URLS;

/** Resolve a {@link ShaBuildSpec}: build (or reuse) jars for the given refs. */
export async function resolveSha(
  spec: ShaBuildSpec,
  seams: BuildSeams = {},
): Promise<ResolvedBinaries> {
  const s = materializeSeams(seams);
  const cacheDir = defaultCacheDir(spec.cacheDir, s.env);
  const result: ResolvedBinaries = { provenance: {}, warnings: [] };

  if (spec.rskjRef) {
    const rskj = await resolveOneSha("rskj", spec.rskjRef, cacheDir, s);
    result.rskjJarPath = rskj.path;
    result.provenance.rskj = rskj;
  }
  if (spec.powpegRef) {
    const powpeg = await resolveOneSha("powpeg", spec.powpegRef, cacheDir, s);
    result.powpegJarPath = powpeg.path;
    result.provenance.powpeg = powpeg;
  }
  return result;
}

/* -------------------------------------------------------------------------- *
 * Per-component resolution
 * -------------------------------------------------------------------------- */

async function resolveOneSha(
  component: ShaComponent,
  ref: string,
  cacheDir: string,
  s: MaterializedSeams,
): Promise<BinaryProvenance> {
  const buildsDir = join(cacheDir, "builds", component);

  // Fast path: a full SHA with a valid cache entry never touches git
  // (or the network) at all.
  if (FULL_SHA.test(ref)) {
    const hit = await validateCacheEntry(join(buildsDir, ref), null, s);
    if (hit.valid) {
      s.log(`[build:sha] ${component} ${ref}: cache hit (no git needed) at ${hit.jarPath}`);
      return provenanceFor(component, ref, ref, hit.jarPath!, hit.sha256!, hit.jarName!, true);
    }
  }

  const srcDir = join(cacheDir, "src", `${component}.git`);
  await ensureBareRepo(component, srcDir, cacheDir, s);
  const sha = await resolveCommit(srcDir, ref, s);
  const entryDir = join(buildsDir, sha);

  const cached = await validateCacheEntry(entryDir, null, s);
  if (cached.valid) {
    s.log(`[build:sha] ${component} ${ref} → ${sha}: cache hit at ${cached.jarPath}`);
    return provenanceFor(
      component,
      ref,
      sha,
      cached.jarPath!,
      cached.sha256!,
      cached.jarName!,
      true,
    );
  }

  // Cache miss — serialize concurrent builders on a per-SHA lock, and
  // re-check after acquiring it (another builder may have just finished).
  s.mkdirFn(buildsDir);
  const lockPath = join(buildsDir, `${sha}.lock`);
  await acquireLock(lockPath, s);
  try {
    const lateHit = await validateCacheEntry(entryDir, null, s);
    if (lateHit.valid) {
      s.log(`[build:sha] ${component} ${sha}: built concurrently elsewhere; using it`);
      return provenanceFor(
        component,
        ref,
        sha,
        lateHit.jarPath!,
        lateHit.sha256!,
        lateHit.jarName!,
        true,
      );
    }
    return await buildAndCache(component, ref, sha, srcDir, buildsDir, entryDir, s);
  } finally {
    try {
      s.rmFn(lockPath);
    } catch {
      /* ignore */
    }
  }
}

async function buildAndCache(
  component: ShaComponent,
  ref: string,
  sha: string,
  srcDir: string,
  buildsDir: string,
  entryDir: string,
  s: MaterializedSeams,
): Promise<BinaryProvenance> {
  const treeDir = join(buildsDir, `${sha}.tree.${s.pid}`);
  const startedAt = new Date().toISOString();
  s.log(`[build:sha] ${component} ${sha}: building in throwaway worktree ${treeDir}`);
  await git(srcDir, ["worktree", "add", "--detach", treeDir, sha], s);
  try {
    await run("./configure.sh", [], treeDir, s, `${component} configure.sh`);
    await run("./gradlew", ["--no-daemon", "fatJar"], treeDir, s, `${component} gradlew fatJar`);

    const libsDir = join(treeDir, LIBS_DIR[component]);
    const jars = s.readdirFn(libsDir).filter((f) => f.endsWith("-all.jar"));
    if (jars.length !== 1) {
      throw new Error(
        `Expected exactly one *-all.jar in ${libsDir} after the ${component} build, ` +
          `found ${jars.length === 0 ? "none" : jars.join(", ")}.`,
      );
    }
    const jarName = jars[0]!;

    const tmpDir = `${entryDir}.tmp.${s.pid}`;
    try {
      s.mkdirFn(tmpDir);
      s.copyFileFn(join(libsDir, jarName), join(tmpDir, jarName));
      const sha256 = await s.sha256FileFn(join(tmpDir, jarName));
      s.writeFileFn(
        join(tmpDir, "build.json"),
        JSON.stringify(
          {
            component,
            repo: REPO_URLS[component],
            ref,
            sha,
            version: versionFromJarName(jarName),
            jarName,
            sha256,
            task: "fatJar",
            jdk: await detectJdk(s),
            startedAt,
            finishedAt: new Date().toISOString(),
          },
          null,
          2,
        ) + "\n",
      );
      finalizeCacheEntry(tmpDir, entryDir, jarName, sha256, s);
      const jarPath = join(entryDir, jarName);
      s.log(`[build:sha] ${component} ${sha}: built → ${jarPath} (sha256 ${sha256})`);
      return provenanceFor(component, ref, sha, jarPath, sha256, jarName, false);
    } catch (err) {
      try {
        s.rmFn(tmpDir);
      } catch {
        /* ignore */
      }
      throw err;
    }
  } finally {
    await removeWorktree(srcDir, treeDir, s);
  }
}

function provenanceFor(
  component: ShaComponent,
  ref: string,
  sha: string,
  jarPath: string,
  sha256: string,
  jarName: string,
  cacheHit: boolean,
): BinaryProvenance {
  return {
    component,
    mode: "sha",
    path: jarPath,
    sha256,
    version: versionFromJarName(jarName),
    ref,
    commitSha: sha,
    cacheHit,
  };
}

/** `rskj-core-9.0.2-VETIVER-all.jar` → `9.0.2-VETIVER`, etc. */
function versionFromJarName(jarName: string): string {
  return jarName.replace(/^(rskj-core|federate-node)-/, "").replace(/-all\.jar$/, "");
}

/* -------------------------------------------------------------------------- *
 * Git plumbing
 * -------------------------------------------------------------------------- */

async function ensureBareRepo(
  component: ShaComponent,
  srcDir: string,
  cacheDir: string,
  s: MaterializedSeams,
): Promise<void> {
  if (s.existsFn(join(srcDir, "HEAD"))) {
    return;
  }
  const parent = join(cacheDir, "src");
  s.mkdirFn(parent);
  s.log(`[build:sha] cloning ${REPO_URLS[component]} (bare) → ${srcDir}`);
  const result = await runChild(
    "git",
    ["clone", "--bare", REPO_URLS[component], srcDir],
    parent,
    s,
  );
  expectSuccess(result, `git clone --bare ${REPO_URLS[component]}`);
}

/**
 * Normalize `ref` to a 40-char commit SHA. Non-SHA refs fetch first
 * (branch tips move); full SHAs try the local object store first and
 * only fetch when the commit is genuinely unknown.
 */
async function resolveCommit(srcDir: string, ref: string, s: MaterializedSeams): Promise<string> {
  if (FULL_SHA.test(ref)) {
    const local = await tryRevParse(srcDir, ref, s);
    if (local) return local;
  }
  await fetchAll(srcDir, s);
  const resolved = await tryRevParse(srcDir, ref, s);
  if (!resolved) {
    throw new Error(
      `Cannot resolve ref "${ref}" in ${srcDir} even after fetching — ` +
        `check the spelling (branch / tag / SHA) against the upstream repo.`,
    );
  }
  return resolved;
}

async function fetchAll(srcDir: string, s: MaterializedSeams): Promise<void> {
  s.log(`[build:sha] fetching ${srcDir}`);
  // Bare repos have no default fetch refspec — mirror branches + tags explicitly.
  const result = await runChild(
    "git",
    [
      `--git-dir=${srcDir}`,
      "fetch",
      "origin",
      "+refs/heads/*:refs/heads/*",
      "+refs/tags/*:refs/tags/*",
      "--prune",
    ],
    srcDir,
    s,
  );
  expectSuccess(result, "git fetch");
}

async function tryRevParse(
  srcDir: string,
  ref: string,
  s: MaterializedSeams,
): Promise<string | null> {
  const result = await runChild(
    "git",
    [`--git-dir=${srcDir}`, "rev-parse", "--verify", `${ref}^{commit}`],
    srcDir,
    s,
  );
  if (result.exitCode !== 0) return null;
  const sha = result.stdout.trim();
  return FULL_SHA.test(sha) ? sha : null;
}

async function git(srcDir: string, args: string[], s: MaterializedSeams): Promise<void> {
  const result = await runChild("git", [`--git-dir=${srcDir}`, ...args], srcDir, s);
  expectSuccess(result, `git ${args[0]}`);
}

async function removeWorktree(
  srcDir: string,
  treeDir: string,
  s: MaterializedSeams,
): Promise<void> {
  const result = await runChild(
    "git",
    [`--git-dir=${srcDir}`, "worktree", "remove", "--force", treeDir],
    srcDir,
    s,
  );
  if (result.exitCode !== 0) {
    // Fall back to a plain rm + prune so a failed build can't leave a
    // tree that blocks the next `worktree add`.
    try {
      s.rmFn(treeDir);
    } catch {
      /* ignore */
    }
    await runChild("git", [`--git-dir=${srcDir}`, "worktree", "prune"], srcDir, s);
  }
}

/** Record which JDK built the jar. Best-effort — `"unknown"` on failure. */
async function detectJdk(s: MaterializedSeams): Promise<string> {
  try {
    const result = await runChild("java", ["-version"], ".", s);
    // `java -version` prints to stderr.
    const firstLine = (result.stderr || result.stdout).split("\n")[0]?.trim();
    return firstLine && result.exitCode === 0 ? firstLine : "unknown";
  } catch {
    return "unknown";
  }
}

/* -------------------------------------------------------------------------- *
 * Locking
 * -------------------------------------------------------------------------- */

async function acquireLock(lockPath: string, s: MaterializedSeams): Promise<void> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    if (s.openExclusiveFn(lockPath, `${s.pid}\n`)) {
      return;
    }
    // Held — but by a live process?
    let holderPid: number | null = null;
    try {
      holderPid = Number.parseInt(s.readFileFn(lockPath).trim(), 10) || null;
    } catch {
      // Racing the holder's release; just retry.
    }
    if (holderPid !== null && !s.processAliveFn(holderPid)) {
      s.log(`[build:sha] removing stale lock ${lockPath} (pid ${holderPid} is gone)`);
      try {
        s.rmFn(lockPath);
      } catch {
        /* ignore */
      }
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${LOCK_TIMEOUT_MS}ms waiting for build lock ${lockPath} ` +
          `(held by pid ${holderPid ?? "unknown"}). Remove it manually if the holder is wedged.`,
      );
    }
    s.log(`[build:sha] waiting for build lock ${lockPath} (held by pid ${holderPid ?? "?"})`);
    await s.sleepFn(LOCK_POLL_MS);
  }
}

/* -------------------------------------------------------------------------- *
 * Child processes — same collect-and-resolve shape as the suite
 * runners, but lines stream through the seam logger so a 20-minute
 * gradle build shows progress.
 * -------------------------------------------------------------------------- */

interface ChildResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function run(
  command: string,
  args: string[],
  cwd: string,
  s: MaterializedSeams,
  label: string,
): Promise<void> {
  s.log(`[build:sha] ${label}: ${command} ${args.join(" ")} (cwd ${cwd})`);
  const result = await runChild(command, args, cwd, s);
  expectSuccess(result, label);
}

function runChild(
  command: string,
  args: string[],
  cwd: string,
  s: MaterializedSeams,
): Promise<ChildResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = s.spawnFn(command, args, {
      cwd,
      env: s.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      for (const line of text.split("\n")) {
        if (line.trim() !== "") s.log(line);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      for (const line of text.split("\n")) {
        if (line.trim() !== "") s.log(line);
      }
    });
    child.on("error", (err) => rejectPromise(err));
    child.on("close", (code, signal) => {
      if (signal) {
        rejectPromise(new Error(`${command} terminated by signal ${signal}`));
        return;
      }
      resolvePromise({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

function expectSuccess(result: ChildResult, label: string): void {
  if (result.exitCode !== 0) {
    const tail = (result.stderr || result.stdout).slice(-2000);
    throw new Error(`${label} failed with exit code ${result.exitCode}.\n${tail}`);
  }
}
