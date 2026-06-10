/**
 * Static genesis-federation identity for the regtest full topology.
 *
 * rskj's `--regtest` profile bakes a fixed 3-of-3 PowPeg federation into
 * its genesis state. The federation's BTC address, redeem script, and the
 * three member public keys are consensus constants — a federate JVM only
 * participates in that federation if it signs with one of the three
 * matching private keys. So unlike the rest of the topology (ports, data
 * dirs), this material is NOT free to choose: it is copied verbatim from
 * rskj's regtest genesis and rootstock-integration-tests'
 * `config/regtest-all-keyfiles.js` + `config/node-keys/genesis-federation/`.
 *
 * Each member's `nodeId` is its devp2p enode id — the uncompressed
 * secp256k1 public key minus the `04` prefix (128 hex chars). Peers dial
 * each other by `<ip>:<port>` + this id; it is derived from the same key
 * as `publicKey`, hardcoded here because it must match what the peer
 * advertises.
 *
 * The same private key acts as the BTC, RSK, and MST signer for a member
 * AND as that node's devp2p `peer.privateKey` — this mirrors RIT, where
 * one `fedN.key` file is referenced by all three signer slots and is the
 * node key in `fedN.conf`.
 *
 * Do NOT edit these values to "rotate keys" — they are pinned to rskj's
 * regtest genesis. Changing the membership requires a federation-change
 * flow (out of scope; that is what RIT's second/third/fourth federations
 * exercise).
 */

/** The Bridge precompiled-contract address (same on every RSK network). */
export const BRIDGE_ADDRESS = "0x0000000000000000000000000000000001000006";

/**
 * The genesis federation's BTC address on regtest. `getFederationAddress()`
 * on a correctly-formed federate returns exactly this — the topology smoke
 * uses it to prove the three federators agree on the genesis federation.
 */
export const GENESIS_FEDERATION_BTC_ADDRESS = "2N5muMepJizJE1gR7FbHJU6CD18V3BpNF9p";

/**
 * The single key authorized to change fee-per-kb on regtest (MAJORITY of
 * one authorizer ⇒ a single vote succeeds). NOT a federator key — it is a
 * dedicated governance key from rskj's `FeePerKbRegTestConstants`. The
 * topology smoke imports it on the miner node to prove the federation can
 * be voted on.
 */
export const FEE_PER_KB_AUTHORIZER = {
  privateKey: "0x6a4b49312b91e203ddfb9bc2d900ebbd46fbede46a7462e770bedcb11ad405e9",
  address: "0x53f8f6dabd612b6137215ddd7758bb5cdd638922",
} as const;

/** Regtest fee-per-kb bounds (rskj `FeePerKbRegTestConstants`). */
export const GENESIS_FEE_PER_KB_SATS = 100_000; // Coin.MILLICOIN
export const MAX_FEE_PER_KB_SATS = 5_000_000;

/** 4-byte Bridge selectors used by the topology smoke (verified against the ABI). */
export const BRIDGE_SELECTORS = {
  getFederationAddress: "0x6923fa85",
  getFeePerKb: "0x724ec886",
  voteFeePerKbChange: "0x0461313e", // voteFeePerKbChange(int256)
} as const;

/** A single genesis-federation member's pinned identity. */
export interface GenesisFederationMember {
  /** Stable label, e.g. `"genesis-fed-1"`. */
  id: string;
  /** 32-byte hex private key (no `0x`): BTC/RSK/MST signer AND devp2p key. */
  privateKey: string;
  /** Compressed secp256k1 public key (`0x02`/`0x03` prefixed). */
  publicKey: string;
  /** devp2p enode id (uncompressed pubkey minus `04`, 128 hex chars). */
  nodeId: string;
  /** devp2p (`peer.port`) port — fixed so peer wiring is deterministic. */
  p2pPort: number;
  /** JSON-RPC HTTP port. */
  rpcPort: number;
}

/**
 * The three genesis federators, copied from RIT's
 * `config/regtest-all-keyfiles.js` (ports, nodeIds, pubkeys) and
 * `config/node-keys/genesis-federation/fedN.key` (private keys).
 *
 * Ports 30000–30005 are reserved for this federation; the rest of the
 * topology (bitcoind, the vanilla miner) must allocate outside that band.
 */
export const GENESIS_FEDERATION: readonly GenesisFederationMember[] = [
  {
    id: "genesis-fed-1",
    privateKey: "45c5b07fc1a6f58892615b7c31dca6c96db58c4bbc538a6b8a22999aaa860c32",
    publicKey: "0x0362634ab57dae9cb373a5d536e66a8c4f67468bbcfb063809bab643072d78a124",
    nodeId:
      "62634ab57dae9cb373a5d536e66a8c4f67468bbcfb063809bab643072d78a1243bd206c2c7a218d6ff4c9a185e71f066bd354e5267875b7683fbc70a1d455e87",
    p2pPort: 30000,
    rpcPort: 30001,
  },
  {
    id: "genesis-fed-2",
    privateKey: "505334c7745df2fc61486dffb900784505776a898377172ffa77384892749179",
    publicKey: "0x03c5946b3fbae03a654237da863c9ed534e0878657175b132b8ca630f245df04db",
    nodeId:
      "c5946b3fbae03a654237da863c9ed534e0878657175b132b8ca630f245df04dbb0bde4f3854613b16032fb214f9cc00f75363976ee078cc4409cdc543036ccfd",
    p2pPort: 30002,
    rpcPort: 30003,
  },
  {
    id: "genesis-fed-3",
    privateKey: "bed0af2ce8aa8cb2bc3f9416c9d518fdee15d1ff15b8ded28376fcb23db6db69",
    publicKey: "0x02cd53fc53a07f211641a677d250f6de99caf620e8e77071e811a28b3bcddf0be1",
    nodeId:
      "cd53fc53a07f211641a677d250f6de99caf620e8e77071e811a28b3bcddf0be19e9da12b897b83765fbaebe717fab74fcb1b57c82f7978b8be3296239909e626",
    p2pPort: 30004,
    rpcPort: 30005,
  },
] as const;

/** Lowest/highest TCP ports reserved by the genesis federation. */
export const FEDERATION_PORT_RANGE = { start: 30000, end: 30005 } as const;

/**
 * The 13 named hard forks rskj/powpeg recognise on regtest. RIT activates
 * every one at height 1 so the chain behaves as fully-upgraded from block
 * 1; the federates and any peer must agree, so the vanilla miner gets the
 * identical override. Emitted as
 * `-Dblockchain.config.hardforkActivationHeights.<name>=1`.
 */
export const ALL_FORKS = [
  "orchid",
  "wasabi100",
  "papyrus200",
  "iris300",
  "hop400",
  "hop401",
  "fingerroot500",
  "arrowhead600",
  "arrowhead631",
  "lovell700",
  "reed800",
  "reed810",
  "vetiver900",
] as const;

/**
 * Build the `peer.active.N.*` HOCON keys wiring `member` to every other
 * genesis federator (mesh). Returns a flat dotted-key map ready to merge
 * into the federate's config.
 */
export function peerActiveWiring(
  member: GenesisFederationMember,
  all: readonly GenesisFederationMember[] = GENESIS_FEDERATION,
): Record<string, string | number> {
  const wiring: Record<string, string | number> = {};
  let index = 0;
  for (const peer of all) {
    if (peer.id === member.id) continue;
    wiring[`peer.active.${index}.ip`] = "127.0.0.1";
    wiring[`peer.active.${index}.port`] = peer.p2pPort;
    wiring[`peer.active.${index}.nodeId`] = peer.nodeId;
    index++;
  }
  return wiring;
}

/** The fork-activation `-D` override map (all forks at height 1). */
export function forkActivationOverrides(): Record<string, number> {
  const overrides: Record<string, number> = {};
  for (const fork of ALL_FORKS) {
    overrides[`blockchain.config.hardforkActivationHeights.${fork}`] = 1;
  }
  return overrides;
}
