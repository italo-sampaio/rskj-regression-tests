/**
 * Injection seams for the build-sourcing resolvers.
 *
 * Repo-wide rule: unit tests never fork a JVM, hit the network, or
 * touch disk. The three mode resolvers therefore take every
 * side-effecting primitive — filesystem ops, child-process spawning,
 * HTTP downloads, hashing, sleeping — through one optional
 * {@link BuildSeams} bag, exactly like the orchestrator's
 * `RskjRunnerHooks`. Production callers pass nothing and get the real
 * implementations; tests pass an in-memory fake filesystem plus a
 * scripted `spawnFn`.
 *
 * {@link materializeSeams} fills the defaults in one place so the mode
 * modules don't repeat fifteen `?? realThing` lines each.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";

/** The slice of `fs.Stats` the resolvers actually consult. */
export interface FileStat {
  isFile(): boolean;
  /** Size in bytes. */
  size: number;
  /** POSIX mode bits (used for the tcpsigner executable-bit warning). */
  mode: number;
}

/** Optional injection points. Production callers omit all of them. */
export interface BuildSeams {
  existsFn?: (p: string) => boolean;
  statFn?: (p: string) => FileStat;
  readFileFn?: (p: string) => string;
  writeFileFn?: (p: string, contents: string) => void;
  /** Recursive mkdir. */
  mkdirFn?: (p: string) => void;
  /** Recursive, force remove. */
  rmFn?: (p: string) => void;
  renameFn?: (from: string, to: string) => void;
  readdirFn?: (p: string) => string[];
  copyFileFn?: (from: string, to: string) => void;
  /**
   * Exclusive-create a file (O_EXCL semantics). Returns true when the
   * file was created, false when it already existed. Used for the
   * per-SHA build lock.
   */
  openExclusiveFn?: (p: string, contents: string) => boolean;
  /** Liveness probe for the pid recorded in a stale lock file. */
  processAliveFn?: (pid: number) => boolean;
  /** Streaming sha256 of a file on disk, hex-encoded. */
  sha256FileFn?: (p: string) => Promise<string>;
  /** Download `url` to `destPath`. Default streams via global fetch. */
  downloadFn?: (url: string, destPath: string) => Promise<void>;
  /** Child-process spawner for git / gradle / java. */
  spawnFn?: typeof spawn;
  /** Environment consulted for cache-dir defaults. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Pid used in temp-dir / lock-file names. Default `process.pid`. */
  pid?: number;
  /** Sleep between lock-acquisition polls. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Progress logger. Default: silent. */
  log?: (line: string) => void;
}

/** {@link BuildSeams} with every member filled in. Internal to src/build. */
export type MaterializedSeams = Required<BuildSeams>;

/** Apply real-implementation defaults to a (possibly empty) seam bag. */
export function materializeSeams(seams: BuildSeams = {}): MaterializedSeams {
  return {
    existsFn: seams.existsFn ?? existsSync,
    statFn: seams.statFn ?? ((p: string): FileStat => statSync(p)),
    readFileFn: seams.readFileFn ?? ((p: string): string => readFileSync(p, "utf8")),
    writeFileFn: seams.writeFileFn ?? ((p: string, c: string): void => writeFileSync(p, c, "utf8")),
    mkdirFn:
      seams.mkdirFn ??
      ((p: string): void => {
        mkdirSync(p, { recursive: true });
      }),
    rmFn: seams.rmFn ?? ((p: string): void => rmSync(p, { recursive: true, force: true })),
    renameFn: seams.renameFn ?? renameSync,
    readdirFn: seams.readdirFn ?? ((p: string): string[] => readdirSync(p)),
    copyFileFn: seams.copyFileFn ?? copyFileSync,
    openExclusiveFn: seams.openExclusiveFn ?? openExclusive,
    processAliveFn: seams.processAliveFn ?? processAlive,
    sha256FileFn: seams.sha256FileFn ?? sha256File,
    downloadFn: seams.downloadFn ?? downloadToFile,
    spawnFn: seams.spawnFn ?? spawn,
    env: seams.env ?? process.env,
    pid: seams.pid ?? process.pid,
    sleepFn: seams.sleepFn ?? delay,
    log: seams.log ?? ((): void => undefined),
  };
}

/* -------------------------------------------------------------------------- *
 * Real implementations
 * -------------------------------------------------------------------------- */

/**
 * Streaming sha256 so a ~95 MB fat jar never has to fit in one Buffer.
 * Equivalent to `sha256sum <p>` — we hash in-process instead of
 * shelling out so the seam stays a plain function.
 */
async function sha256File(p: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(p), hash);
  return hash.digest("hex");
}

/**
 * Stream an HTTP(S) response straight to disk. GitHub release assets
 * redirect to a CDN; global fetch follows redirects by default.
 */
async function downloadToFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  await pipeline(Readable.fromWeb(res.body as ReadableStream), createWriteStream(destPath));
}

function openExclusive(p: string, contents: string): boolean {
  try {
    writeFileSync(p, contents, { flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means "exists but not ours" — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
