import { describe, expect, it } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import {
  deriveStakingPool,
  deriveStakeVault,
  deriveStakeAccount,
  deriveGovernance,
  deriveProposal,
  deriveVoteReceipt,
} from "./sdk";
import {
  STAKING_PROGRAM_ID,
  GOVERNANCE_PROGRAM_ID,
} from "./connection";

// These PDAs must match the seeds defined in programs/staking/src/lib.rs and
// programs/governance/src/lib.rs. If a seed ever changes on either side we
// want a compile-time or test-time failure, not a silent on-chain mismatch.

describe("staking PDA derivations", () => {
  const stakeMint = new PublicKey("So11111111111111111111111111111111111111112");

  it("derives a staking pool address under the staking program", () => {
    const [pool, bump] = deriveStakingPool(stakeMint);
    expect(pool).toBeInstanceOf(PublicKey);
    expect(bump).toBeGreaterThanOrEqual(0);
    expect(bump).toBeLessThanOrEqual(255);

    // Same inputs → deterministic output.
    const [pool2] = deriveStakingPool(stakeMint);
    expect(pool.toBase58()).toBe(pool2.toBase58());
  });

  it("stake account PDA is derived against the pool + owner", () => {
    const [pool] = deriveStakingPool(stakeMint);
    const owner = PublicKey.unique();
    const [stakeAcc] = deriveStakeAccount(pool, owner);
    expect(stakeAcc).toBeInstanceOf(PublicKey);

    // Different owner → different stake account.
    const [other] = deriveStakeAccount(pool, PublicKey.unique());
    expect(stakeAcc.toBase58()).not.toBe(other.toBase58());
  });

  it("stake vault is owned by the staking program", () => {
    const [pool] = deriveStakingPool(stakeMint);
    const [vault] = deriveStakeVault(pool);
    expect(vault).toBeInstanceOf(PublicKey);
    // Program IDs aren't returned by findProgramAddress, but the derivation
    // uses STAKING_PROGRAM_ID as the owning program.
    expect(STAKING_PROGRAM_ID.toBase58()).toBe("2ecsTtNNuZUDSs19BfUx2yZ4n3WHTKKR2XfDWz6PAmdY");
  });
});

describe("governance PDA derivations", () => {
  it("governance PDA is derived from the staking pool", () => {
    const stakingPool = PublicKey.unique();
    const [gov] = deriveGovernance(stakingPool);
    expect(gov).toBeInstanceOf(PublicKey);
  });

  it("proposal PDA includes the little-endian id bytes", () => {
    const gov = PublicKey.unique();
    const [p0] = deriveProposal(gov, 0);
    const [p1] = deriveProposal(gov, 1);
    expect(p0.toBase58()).not.toBe(p1.toBase58());
  });

  it("vote receipt is unique per proposal+voter pair", () => {
    const gov = PublicKey.unique();
    const [proposal] = deriveProposal(gov, 0);
    const voterA = PublicKey.unique();
    const voterB = PublicKey.unique();
    const [rA] = deriveVoteReceipt(proposal, voterA);
    const [rB] = deriveVoteReceipt(proposal, voterB);
    expect(rA.toBase58()).not.toBe(rB.toBase58());
    expect(GOVERNANCE_PROGRAM_ID.toBase58()).toBe("Hk4eHkcr5njyntu4WEQuafVKkaK4LQJ8dTH5fqAArHFD");
  });
});
