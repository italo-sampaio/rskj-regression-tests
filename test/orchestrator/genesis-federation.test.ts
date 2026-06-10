/**
 * Unit tests for the static genesis-federation identity + wiring helpers.
 *
 * These values are consensus constants copied from rskj's regtest genesis
 * and RIT's config; the tests guard against accidental edits (a wrong
 * nodeId or pubkey silently breaks peering / federation membership) and
 * assert the derived `peer.active` mesh + fork-override maps.
 */

import { expect } from "chai";
import {
  ALL_FORKS,
  forkActivationOverrides,
  GENESIS_FEDERATION,
  peerActiveWiring,
} from "../../src/orchestrator/federation/genesis-federation.js";

describe("orchestrator: genesis federation", () => {
  it("has three members with the pinned ports and unique identities", () => {
    expect(GENESIS_FEDERATION).to.have.length(3);
    const p2pPorts = GENESIS_FEDERATION.map((m) => m.p2pPort);
    const rpcPorts = GENESIS_FEDERATION.map((m) => m.rpcPort);
    expect(p2pPorts).to.deep.equal([30000, 30002, 30004]);
    expect(rpcPorts).to.deep.equal([30001, 30003, 30005]);
    expect(new Set(GENESIS_FEDERATION.map((m) => m.nodeId)).size).to.equal(3);
    expect(new Set(GENESIS_FEDERATION.map((m) => m.privateKey)).size).to.equal(3);
  });

  it("each member's nodeId is 128 hex chars and pubkey is compressed", () => {
    for (const member of GENESIS_FEDERATION) {
      expect(member.nodeId, member.id).to.match(/^[0-9a-f]{128}$/);
      expect(member.privateKey, member.id).to.match(/^[0-9a-f]{64}$/);
      expect(member.publicKey, member.id).to.match(/^0x0[23][0-9a-f]{64}$/);
    }
  });

  it("wires each member to the other two (mesh, self excluded)", () => {
    const member = GENESIS_FEDERATION[0]!;
    const wiring = peerActiveWiring(member);
    // Two peers → indices 0 and 1, three keys each.
    expect(wiring["peer.active.0.port"]).to.equal(30002);
    expect(wiring["peer.active.0.nodeId"]).to.equal(GENESIS_FEDERATION[1]!.nodeId);
    expect(wiring["peer.active.1.port"]).to.equal(30004);
    expect(wiring["peer.active.1.nodeId"]).to.equal(GENESIS_FEDERATION[2]!.nodeId);
    expect(wiring["peer.active.2.port"]).to.equal(undefined);
    // Self never appears.
    const ports = Object.entries(wiring)
      .filter(([k]) => k.endsWith(".port"))
      .map(([, v]) => v);
    expect(ports).to.not.include(member.p2pPort);
  });

  it("emits every fork at activation height 1", () => {
    const overrides = forkActivationOverrides();
    expect(Object.keys(overrides)).to.have.length(ALL_FORKS.length);
    for (const fork of ALL_FORKS) {
      expect(overrides[`blockchain.config.hardforkActivationHeights.${fork}`]).to.equal(1);
    }
  });
});
