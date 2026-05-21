import { createHash } from "node:crypto";

/**
 * Baseline regtest HOCON template + override merger for the orchestrator.
 *
 * The orchestrator writes a fresh `.conf` file per JVM under the node's
 * data directory and points the JVM at it via `-Drsk.conf.file=<path>`.
 * The file content is the
 *
 *   `defaultRskjConfig(dataDir, rpcPort, p2pPort)` ⨁ `configOverrides`
 *
 * merge below, serialised as a simple HOCON document. We don't pull in
 * a full HOCON library — the file's an emit-only artefact, and the
 * subset of HOCON we use (dotted keys, scalar values, strings) is small
 * enough to render by hand.
 *
 * Why not reuse rskj's own `regtest.conf`:
 *
 *   The bundled `regtest.conf` writes its database under
 *   `${user.home}/.rsk/regtest/database` and listens on `peer.port=50501`.
 *   For the orchestrator we want everything contained in the per-run
 *   data dir (no shared state across runs) and dynamic ports. So we
 *   generate a minimal config from scratch and pass `--regtest` on the
 *   JVM command line — the network preset (genesis, hard-fork heights)
 *   comes from there.
 */

/** Concrete inputs the orchestrator already knows by the time it writes the config. */
export interface DefaultConfigInputs {
  /** Absolute path to the JVM's data directory. */
  dataDir: string;
  /** RPC HTTP port. */
  rpcPort: number;
  /** P2P (`peer.port`) port. */
  p2pPort: number;
}

/**
 * A flat `key.path` → primitive map. Strings are quoted at serialise-
 * time; numbers and booleans go through unquoted; arrays produce HOCON
 * list literals. Nested objects are deliberately *not* supported here —
 * use the dotted-key flattening convention rskj's own configs already
 * follow.
 */
export type FlatConfig = Record<string, ConfigValue>;

export type ConfigValue = string | number | boolean | ConfigValue[];

/**
 * Return the baseline HOCON map for a single isolated regtest node.
 *
 * Choices baked in here:
 *
 *   - `peer.discovery.enabled = false` — single node, no DHT peers to
 *     find. Matches rskj's own `regtest.conf`.
 *   - `miner.client.enabled = true` — keep the autominer on so the
 *     suites can advance state without RPC poking. (The bigger mining
 *     model question, "real merge-mining with bitcoind", is task #6 +
 *     the spike — out of scope for single-node.)
 *   - `database.dir = <dataDir>/db` — every run gets a fresh directory,
 *     no shared `${user.home}/.rsk/regtest/database` collisions.
 *   - `wallet.enabled = true` with `accounts = []` — accounts get
 *     funded by whichever suite is running, same way `regtest.conf`
 *     ships.
 *   - `rpc.providers.web.http.host = 0.0.0.0` — the RIT pattern; lets
 *     hardhat and k6 hit the node from any localhost iface.
 *   - `rpc.providers.web.http.cors = "*"` and `hosts = ["*"]` — matches
 *     rskj's bundled `regtest.conf` so the suites don't have to fiddle
 *     with cors / hostname allowlists.
 *
 * Overrides via {@link mergeConfig} take precedence over every key here.
 */
export function defaultRskjConfig(inputs: DefaultConfigInputs): FlatConfig {
  return {
    // Network identity — `--regtest` on the JVM command line sets the
    // network preset, but keys below override the defaults the preset
    // bakes in.
    "peer.discovery.enabled": false,
    "peer.port": inputs.p2pPort,
    "peer.networkId": 7771,
    "peer.active": [],
    "peer.privateKey": deterministicPeerKey(inputs.p2pPort),

    // RPC — bind on all loopback ifaces, no auth, permissive CORS for
    // local suites. Production configs override these.
    "rpc.providers.web.http.enabled": true,
    "rpc.providers.web.http.host": "0.0.0.0",
    "rpc.providers.web.http.port": inputs.rpcPort,
    "rpc.providers.web.http.cors": "*",
    "rpc.providers.web.http.hosts": ["*"],
    "rpc.providers.web.ws.enabled": false,

    // Miner — keep autominer on so the node makes blocks without
    // external prodding. Real merge-mining lives in task #6.
    "miner.server.enabled": true,
    "miner.client.enabled": true,
    "miner.client.delayBetweenBlocks": "1 second",
    "miner.coinbase.secret": "rskj-regression-orchestrator-coinbase",

    // Wallet — funded by the suites.
    "wallet.enabled": true,

    // Database / data dir — entirely inside the per-run dataDir.
    "database.dir": `${inputs.dataDir}/db`,
    "database.reset": true,

    // Genesis — `--regtest` already selects `rsk-dev.json`; we set the
    // file name explicitly so a future move to `--devnet` or `--testnet`
    // doesn't surprise us.
    genesis: "rsk-dev.json",

    "hello.phrase": "rskj-regression",
  };
}

/**
 * Merge `overrides` onto `base`, with `overrides` winning on every key.
 * Both inputs are flat maps — see {@link FlatConfig}.
 */
export function mergeConfig(base: FlatConfig, overrides: Record<string, unknown> = {}): FlatConfig {
  const out: FlatConfig = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    out[key] = value as ConfigValue;
  }
  return out;
}

/**
 * Render a {@link FlatConfig} as a HOCON document. We use dotted keys
 * (`a.b.c = value`) rather than nested blocks because they round-trip
 * cleanly with rskj's `-D` JVM-arg overrides and don't require us to
 * mini-parse paths.
 */
export function renderHocon(config: FlatConfig): string {
  const lines: string[] = [
    "# Auto-generated by @rsksmart/rskj-regression orchestrator.",
    "# This file is regenerated on every node start; manual edits will be lost.",
    "",
  ];
  for (const key of Object.keys(config).sort()) {
    lines.push(`${key} = ${formatValue(config[key]!)}`);
  }
  lines.push(""); // trailing newline
  return lines.join("\n");
}

function formatValue(value: ConfigValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(formatValue).join(", ")}]`;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  // String — quote unconditionally so we don't have to special-case
  // tokens like `true` / `false` / `null` that HOCON would otherwise
  // parse as native types.
  return JSON.stringify(value);
}

/**
 * Derive a deterministic-per-port `peer.privateKey` value so two
 * orchestrated nodes on the same host don't collide.
 *
 * The key is 32 bytes of `sha256("rskj-regression:" + port)` hex-encoded
 * without the `0x` prefix — rskj accepts both forms.
 */
function deterministicPeerKey(port: number): string {
  return createHash("sha256").update(`rskj-regression:${port}`).digest("hex");
}
