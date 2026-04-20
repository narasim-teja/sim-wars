import { Program, AnchorProvider, Idl } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TOKEN_MINT_PROGRAM_ID,
  AMM_DEX_PROGRAM_ID,
  STAKING_PROGRAM_ID,
  GOVERNANCE_PROGRAM_ID,
} from "./connection";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../../..");
const IDL_DIR = join(REPO_ROOT, "target/idl");
export const LOCAL_DIR = join(REPO_ROOT, "sim-engine/.local");
export const KEYS_DIR = join(LOCAL_DIR, "keys");
const DEPLOYMENT_PATH = join(LOCAL_DIR, "deployment.json");

function loadIdl(name: string): Idl {
  const path = join(IDL_DIR, `${name}.json`);
  if (!existsSync(path)) {
    throw new Error(
      `IDL not found at ${path}. Run: anchor build`,
    );
  }
  const idl = JSON.parse(readFileSync(path, "utf8")) as Idl;
  return idl;
}

export function getTokenMintProgram(provider: AnchorProvider): Program {
  const idl = loadIdl("token_mint");
  return new Program(idl, provider);
}

export function getAmmDexProgram(provider: AnchorProvider): Program {
  const idl = loadIdl("amm_dex");
  return new Program(idl, provider);
}

export function getStakingProgram(provider: AnchorProvider): Program {
  const idl = loadIdl("staking");
  return new Program(idl, provider);
}

export function getGovernanceProgram(provider: AnchorProvider): Program {
  const idl = loadIdl("governance");
  return new Program(idl, provider);
}

// ============================================================
// PDA derivation helpers — mirror seeds in programs/*/src/lib.rs
// ============================================================

export function deriveMintAuthority(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("mint_authority"), mint.toBuffer()],
    TOKEN_MINT_PROGRAM_ID,
  );
}

export function deriveTokenomicsConfig(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("config"), mint.toBuffer()],
    TOKEN_MINT_PROGRAM_ID,
  );
}

export function deriveAllocation(
  config: PublicKey,
  name: Buffer,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("allocation"), config.toBuffer(), name],
    TOKEN_MINT_PROGRAM_ID,
  );
}

export function derivePool(
  tokenAMint: PublicKey,
  tokenBMint: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), tokenAMint.toBuffer(), tokenBMint.toBuffer()],
    AMM_DEX_PROGRAM_ID,
  );
}

export function derivePoolAuthority(pool: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool_authority"), pool.toBuffer()],
    AMM_DEX_PROGRAM_ID,
  );
}

export function deriveVaultA(pool: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault_a"), pool.toBuffer()],
    AMM_DEX_PROGRAM_ID,
  );
}

export function deriveVaultB(pool: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault_b"), pool.toBuffer()],
    AMM_DEX_PROGRAM_ID,
  );
}

// ---- staking PDAs (mirror programs/staking/src/lib.rs seeds) ----

export function deriveStakingPool(stakeMint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("staking_pool"), stakeMint.toBuffer()],
    STAKING_PROGRAM_ID,
  );
}

export function deriveStakingPoolAuthority(pool: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool_authority"), pool.toBuffer()],
    STAKING_PROGRAM_ID,
  );
}

export function deriveStakeVault(pool: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("stake_vault"), pool.toBuffer()],
    STAKING_PROGRAM_ID,
  );
}

export function deriveRewardVault(pool: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("reward_vault"), pool.toBuffer()],
    STAKING_PROGRAM_ID,
  );
}

export function deriveStakeAccount(pool: PublicKey, user: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("stake_account"), pool.toBuffer(), user.toBuffer()],
    STAKING_PROGRAM_ID,
  );
}

// ---- governance PDAs (mirror programs/governance/src/lib.rs seeds) ----

export function deriveGovernance(stakingPool: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("governance"), stakingPool.toBuffer()],
    GOVERNANCE_PROGRAM_ID,
  );
}

export function deriveProposal(
  governance: PublicKey,
  proposalId: number,
): [PublicKey, number] {
  const idBuf = Buffer.alloc(4);
  idBuf.writeUInt32LE(proposalId, 0);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("proposal"), governance.toBuffer(), idBuf],
    GOVERNANCE_PROGRAM_ID,
  );
}

export function deriveVoteReceipt(
  proposal: PublicKey,
  voter: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vote"), proposal.toBuffer(), voter.toBuffer()],
    GOVERNANCE_PROGRAM_ID,
  );
}

/** Pad a string to a 32-byte buffer (allocation name format). */
export function nameToBytes(name: string): Buffer {
  const buf = Buffer.alloc(32);
  buf.write(name, 0, "utf8");
  return buf;
}

// ============================================================
// Deployment manifest
// ============================================================

export interface AgentWalletEntry {
  agentId: string;
  pubkey: string;
  keypairPath: string;
  lunaAta: string;
  ustAta: string;
}

export interface StakingDeployment {
  program: string;
  pool: string;
  poolAuthority: string;
  stakeVault: string;
  rewardVault: string;
  stakeMint: string;
  /** Cooldown in ticks between request_unstake and complete_unstake. */
  unstakeCooldownTicks: number;
  /** Lock period in ticks before a stake can request unstake. */
  lockPeriodTicks: number;
}

export interface GovernanceDeployment {
  program: string;
  governance: string;
  /** Used to mirror the on-chain proposal count for PDA derivation. */
  initialProposalCount?: number;
}

export interface Deployment {
  cluster: string;
  programs: {
    tokenMint: string;
    ammDex: string;
    staking?: string;
    governance?: string;
  };
  mints: {
    luna: string;
    ust: string;
  };
  pool: {
    address: string;
    authority: string;
    vaultA: string;
    vaultB: string;
    lpMint: string;
    aIsLuna: boolean;
  };
  config: {
    address: string;
  };
  /** Optional staking pool deployment — when present, on-chain staking is enabled. */
  staking?: StakingDeployment;
  /** Optional governance deployment — when present, on-chain governance is enabled. */
  governance?: GovernanceDeployment;
  agents: AgentWalletEntry[];
  decimals: number;
}

export function loadDeployment(): Deployment {
  if (!existsSync(DEPLOYMENT_PATH)) {
    throw new Error(
      `Deployment manifest not found at ${DEPLOYMENT_PATH}. Run: bun run scripts/deploy-programs.ts`,
    );
  }
  return JSON.parse(readFileSync(DEPLOYMENT_PATH, "utf8")) as Deployment;
}

export function deploymentPath(): string {
  mkdirSync(LOCAL_DIR, { recursive: true });
  return DEPLOYMENT_PATH;
}
