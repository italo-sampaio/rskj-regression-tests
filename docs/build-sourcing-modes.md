# Build sourcing — release / custom / sha

The `src/build/` subtree answers one question for the driver (and, later,
the full-topology orchestrator): **where do the binaries come from?** A
regression run needs up to three artifacts — the rskj fat JAR, the
powpeg-node fat JAR, and a tcpsigner binary — and there are three
legitimate ways to obtain them. This library turns a declarative
`BuildSourceSpec` into resolved, fingerprinted paths.

It's the v1 surface described in §"Target architecture" of the
[regression-testing initiative](https://www.notion.so/rootstock/Leverage-RIT-for-regression-366c132873f9809a9f44c6ae72988f86).
The driver consumes the rskj jar today; powpeg + tcpsigner resolution is
recorded in the report so the full-topology task can launch them.

## Why a resolver at all

Before this task, `--auto-node` took a single `--rskj-jar <path>` and
nothing else. That's fine when you already built a jar, but it can't
express "test the exact bytes we shipped as 9.0.1" or "test whatever
`origin/some-branch` is right now" — the two questions regression runs
ask most. Three modes cover them, and every resolved component carries a
`BinaryProvenance` record (mode, version/tag/commit, sha256) so a report
alone answers "which binaries did this run use?". Reproducibility by
record is the point: two reports with the same `rskjSha256` ran the same
code, whatever mode produced it.

## The three modes

| Mode      | Input                           | What happens                                                                                                   | tcpsigner? |
| --------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------- |
| `custom`  | local jar / tcpsigner paths     | validate paths, record size + sha256                                                                           | yes        |
| `release` | a pinned version (e.g. `9.0.1`) | download the GitHub release asset once, verify sha256, cache it                                                | no         |
| `sha`     | a git ref (branch / tag / SHA)  | clone the repo bare, `git worktree` per build, `./configure.sh && ./gradlew --no-daemon fatJar`, cache per-SHA | no         |

**v1 scope (keyfile-only):** sha mode builds rskj + powpeg-node ONLY.
tcpsigner is never built — it is exclusively a user-supplied path in
custom mode. `rsk-powhsm` builds are out of scope.

## API surface

```ts
import { resolveBinaries } from "rskj-regression";

const resolved = await resolveBinaries({ mode: "release", rskjVersion: "9.0.1" });
//   resolved.rskjJarPath          → absolute path to the fat jar
//   resolved.powpegJarPath?       → set when the spec produced one
//   resolved.tcpsignerPath?       → set when the spec supplied one
//   resolved.provenance.rskj      → { mode, path, sha256, version, releaseTag, ... }
//   resolved.warnings             → non-fatal findings (logged, never fail a run)
```

`resolveBinaries(spec, seams?)` is the single front door. It validates
the spec shape first (so a typo'd spec fails with "what's wrong with the
spec" rather than a git error three layers deep) and then dispatches to
the per-mode resolver. The `seams` bag is the test injection point
(filesystem, child-process, download, hashing) — production callers omit
it or pass only `{ log }`. See `src/build/types.ts` for the authoritative
`BuildSourceSpec` / `ResolvedBinaries` / `BinaryProvenance` definitions.

### Spec shapes

```ts
// custom — the only mode that can supply a tcpsigner
{ mode: "custom", rskjJar: "/abs/rskj-core-9.0.2-VETIVER-all.jar",
  powpegJar?: "...", tcpsigner?: "..." }

// release — pin a published release
{ mode: "release", rskjVersion: "9.0.1", powpegVersion?: "9.0.0.0",
  reproducibleBuildsPath?: "~/workspace/reproducible-builds", cacheDir?: "..." }

// sha — build from a git ref (at least one of the two required)
{ mode: "sha", rskjRef?: "master", powpegRef?: "abc123", cacheDir?: "..." }
```

Release versions are accepted in three spellings and normalized
internally: plain (`"9.0.1"`), tag form (`"VETIVER-9.0.1"`), or
reproducible-dir form (`"9.0.1-vetiver"`). Plain versions infer the
codename from the major number (9 → VETIVER, 8 → REED, …); for a major
the harness doesn't know, pass the tag form so the codename isn't
guessed.

## CLI

All build flags require `--auto-node` (binaries are only ever consumed to
boot the node). `--rpc-url` runs need no build mode at all. The pre-build-modes
invocation is preserved verbatim.

```bash
# custom (backward-compatible sugar — no --build-mode needed)
node bin/rskj-regression.js run smoke --auto-node \
  --rskj-jar /abs/rskj-core-9.0.2-VETIVER-all.jar

# custom (explicit, with optional powpeg + tcpsigner)
node bin/rskj-regression.js run smoke --auto-node --build-mode custom \
  --rskj-jar /abs/rskj-all.jar \
  --powpeg-jar /abs/federate-node-VETIVER-9.0.0.0-all.jar \
  --tcpsigner /abs/tcpsigner

# release
node bin/rskj-regression.js run smoke --auto-node --build-mode release \
  --release-version 9.0.1 \
  --powpeg-release-version 9.0.0.0

# sha
node bin/rskj-regression.js run smoke --auto-node --build-mode sha \
  --rskj-sha origin/master \
  --powpeg-sha REED-8.1.0.0 \
  --cache-dir ~/.cache/rskj-regression
```

| Flag                           | Mode        | Meaning                                                                          |
| ------------------------------ | ----------- | -------------------------------------------------------------------------------- |
| `--build-mode <m>`             | all         | `release` \| `custom` \| `sha`. Defaults to `custom` when `--rskj-jar` is given. |
| `--rskj-jar <path>`            | custom      | Path to a prebuilt rskj fat JAR.                                                 |
| `--powpeg-jar <path>`          | custom      | Path to a prebuilt powpeg fat JAR.                                               |
| `--tcpsigner <path>`           | custom      | Path to a tcpsigner binary.                                                      |
| `--release-version <v>`        | release     | rskj release pin, e.g. `9.0.1` or `VETIVER-9.0.1`.                               |
| `--powpeg-release-version <v>` | release     | Optional powpeg-node release pin, e.g. `9.0.0.0`.                                |
| `--rskj-sha <ref>`             | sha         | Git ref of rsksmart/rskj to build (required in sha mode).                        |
| `--powpeg-sha <ref>`           | sha         | Optional git ref of rsksmart/powpeg-node to build.                               |
| `--cache-dir <path>`           | release/sha | Download / build cache root.                                                     |

**Backward compatibility is a hard requirement.** `--auto-node
--rskj-jar <path>` keeps working unchanged — `resolveConfig` synthesizes
a custom-mode spec from it. Flags belonging to a different mode than the
one selected are _rejected_, not ignored: a silently-dropped `--rskj-sha`
next to `--build-mode release` would test the wrong binary, so the config
layer errors with `--rskj-sha cannot be combined with --build-mode
release`.

The resolved provenance lands in the report metadata labels
(`buildMode`, `rskjSha256`, `rskjReleaseTag` / `rskjCommitSha`,
`powpegSha256`, …), and `metadata.rskjVersion` is backfilled from the
resolved version when the caller didn't pass `--rskj-version`.

## Release mode in detail

The reproducible-builds repo publishes the **expected** sha256 of every
release jar inline in its per-version `README.md` "Verify" section (the
release dirs hold only `Dockerfile` + `README.md` — no jars, no checksum
files). The actual bytes live as assets on the GitHub release; verified
in 2026-06, each rskj release ships exactly the `-all.jar` fat jar plus
`SHA256SUMS.asc`. So the cheap-and-trustworthy recipe is: download the
release asset once, hash it, and demand the hash match what
reproducible-builds says it must be.

**Verification ladder:**

1. `<reproducibleBuildsPath>/<versionDir>/README.md` — primary. An
   independent repo with reviewed hashes; provenance records
   `verification: "reproducible-builds"`. The version dir is lowercase
   for rskj (`rskj/9.0.1-vetiver`) and uppercase-tag-shaped for powpeg
   (`powpeg-node/VETIVER-9.0.0.0`).
2. When the local reproducible-builds clone has no dir for the pinned
   version (stale clone), fall back to the release's own
   `SHA256SUMS.asc` (sha line only; PGP signature checking is out of
   scope for v1). Provenance records `verification: "release-sha256sums"`
   and a **loud warning** lands in the result + log — at that point the
   checksum and the jar share a publisher.

> Note (2026-06): the team's `~/workspace/reproducible-builds` clone only
> carries rskj dirs through `9.0.0-vetiver`, so resolving `9.0.1` already
> exercises the fallback path. Pull the repo to restore independent
> verification.

The default reproducible-builds location is
`~/workspace/reproducible-builds` — a convention (like the peer-directory
rule for the test-suite repos), not auto-cloned: the value of that repo
is that a human pulled and reviewed it.

## Sha mode in detail

- **Clones, never working checkouts.** One cached bare repo per component
  under `<cacheDir>/src/<component>.git`, `git fetch`ed on later runs, and
  a throwaway `git worktree` per build. We deliberately never build inside
  `~/workspace/rskj` / `~/workspace/powpeg-node`: besides trampling
  uncommitted state, the powpeg checkout carries a live
  `DONT-COMMIT-settings.gradle` that silently substitutes the local rskj
  tree for SNAPSHOT/RC `rskj-core` versions — a clean clone is the only
  hermetic option.
- **Ref normalization.** Every ref (branch, tag, short SHA, full SHA) is
  collapsed via `git rev-parse <ref>^{commit}` to the 40-char commit SHA,
  the ONLY cache key. Branch names never key the cache — they move.
  Non-SHA refs fetch first so a moved branch tip resolves to today's
  commit; a full 40-char SHA with a valid cache entry short-circuits
  before any git call at all.
- **Build recipe** (JDK 17, Gradle 8.6 wrapper): `./configure.sh` (fetches
  the gradle wrapper jar from `deps.rsklabs.io`, which fresh clones don't
  carry) then `./gradlew --no-daemon fatJar`. Outputs land in
  `rskj-core/build/libs/*-all.jar` (rskj) / `build/libs/*-all.jar`
  (powpeg). The jar name is SHA-independent (it comes from
  `version.properties`), so the cache is keyed by SHA and the name is just
  recorded in `build.json`.
- **Concurrency + atomicity.** Builders serialize on a `<sha>.lock`
  pidfile (`O_EXCL` create; a lock whose pid is dead is treated as stale
  and removed — Node has no `flock(2)` without native deps, so this is the
  portable equivalent). The entry is staged in `<sha>.tmp.<pid>/` and
  atomically renamed, with `.complete` written last. Re-running the same
  SHA is a pure cache hit.

## Cache layout

Default cache root: `~/.cache/rskj-regression`, overridable (in
precedence order) via the spec `cacheDir` field, the `--cache-dir` flag,
the `RSKJ_REGRESSION_CACHE_DIR` env var, or `$XDG_CACHE_HOME`.

```
<cacheDir>/
  releases/<component>/<tag>/        ← release mode
    <asset>-all.jar
    jar.sha256                       ← "<sha256>  <jarName>"
    source.json                      ← url + how it was verified
    SHA256SUMS.asc                   ← only when the fallback verification ran
    .complete                        ← sentinel, written LAST
  src/<component>.git/               ← sha mode: cached bare clones
  builds/<component>/<sha>/          ← sha mode: one dir per 40-char commit
    <jarName>-all.jar
    jar.sha256
    build.json                       ← repo, ref-as-given, sha, version, jdk, timings
    .complete                        ← sentinel, written LAST
```

**Entry validity is two-factor:** the `.complete` sentinel must exist AND
the jar's recomputed sha256 must match `jar.sha256` (the in-process
equivalent of `sha256sum -c`). Anything less — missing sentinel
(interrupted download/build), hash mismatch (corruption) — deletes the
entry so the caller re-fetches / rebuilds. A crashed writer can never
leave a directory that passes validation, because writers populate
`<entry>.tmp.<pid>/` and atomically rename into place with the sentinel
last.

## Failure modes

| Symptom                                                        | Cause / response                                                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `--rskj-jar path does not exist`                               | custom mode validates paths up front so the error names the flag, not `java: no such file`.                  |
| `sha256 mismatch for <asset>: expected … downloaded …`         | release download failed verification; the jar is refused and not cached.                                     |
| `SHA256SUMS.asc … has no line for <asset>`                     | fallback verification can't find the asset; resolution aborts rather than caching unverified bytes.          |
| `Cannot resolve ref "<ref>" … even after fetching`             | sha mode couldn't `rev-parse` the ref — check the spelling against upstream.                                 |
| `gradlew fatJar failed with exit code N`                       | the build failed; the last 2000 chars of output are attached and no cache entry is left behind.              |
| `Timed out … waiting for build lock`                           | another builder holds the per-SHA lock and is alive; remove it manually if the holder is wedged.             |
| WARNING: `falling back to the GitHub release's SHA256SUMS.asc` | the local reproducible-builds clone is stale for that version — pull it to restore independent verification. |
| WARNING: `powpeg jar … does not match the release naming`      | custom-mode heuristic only; never fails the run.                                                             |

## Test seams

Repo-wide rule: unit tests never fork a JVM, hit the network, or touch
disk. The mode resolvers take every side-effecting primitive through one
optional `BuildSeams` bag (filesystem ops, child-process spawning, HTTP
download, hashing, sleep, env), exactly like the orchestrator's
`RskjRunnerHooks`. The tests in `test/build/` use an in-memory fake
filesystem plus a scripted `spawnFn` (the same FakeChild EventEmitter
style as `test/orchestrator/`) — nothing forks, downloads, or writes.

For end-to-end validation against a real jar / build, use a small driver
script — the unit suite stays fast on purpose.

## See also

- [`docs/orchestrator-single-node.md`](orchestrator-single-node.md) — the
  `startRskjNode` library the driver hands the resolved jar to.
- [`docs/driver-poc.md`](driver-poc.md) — driver CLI surface.
- [`docs/unified-report-format.md`](unified-report-format.md) — where the
  provenance labels land in the report.
