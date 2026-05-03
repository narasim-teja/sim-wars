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

/**
 * Vesting PDA — one per (config, beneficiary). The token program's seeds bind
 * a single vesting account to a beneficiary, so deploying multiple vested
 * allocations requires distinct per-allocation beneficiary pubkeys. The
 * deployer signs `create_vesting` as authority; per-allocation beneficiary
 * keypairs sign `claim_vested` later.
 */
export function deriveVesting(
  config: PublicKey,
  beneficiary: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vesting"), config.toBuffer(), beneficiary.toBuffer()],
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
  baseAta?: string;
  quoteAta?: string;
  /** Backward-compatible alias for baseAta from pre-neutral manifests. */
  lunaAta: string;
  /** Backward-compatible alias for quoteAta from pre-neutral manifests. */
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
  /** On-chain max APY ceiling (bps). Currently informational. */
  maxApyBps: number;
  /** Bps slashed on early exit and routed to the reward vault. */
  unstakePenaltyBps: number;
  /**
   * Fraction of total_staked emitted into the reward vault each tick.
   * Engine reads this to schedule per-tick `fund_reward_vault` calls.
   * 0 disables emissions.
   */
  rewardEmissionRate: number;
}

export interface GovernanceDeployment {
  program: string;
  governance: string;
  /** Used to mirror the on-chain proposal count for PDA derivation. */
  initialProposalCount?: number;
}

/**
 * One per vested allocation. The deployer signs as authority; the beneficiary
 * keypair (stored at `beneficiaryKeypairPath`) signs `claim_vested` to mint
 * unlocked tokens into `beneficiaryAta`.
 */
export interface VestingEntry {
  /** Allocation name (matches the AllocationBucket PDA name field). */
  allocationName: string;
  /** PDA address of the VestingAccount. */
  vesting: string;
  /** Beneficiary pubkey (used in the vesting PDA seeds). */
  beneficiary: string;
  /** Path to the beneficiary keypair file (deployer owns it for unattended claims). */
  beneficiaryKeypairPath: string;
  /** Beneficiary's token ATA — `claim_vested` mints here. */
  beneficiaryAta: string;
  /** Total tokens locked in this vesting (UI units, not atoms). */
  totalAmount: number;
  /** Tick at which the vesting clock starts (== sim tick 0 for our purposes). */
  startTick: number;
  /** Cliff in ticks before any tokens unlock. */
  cliffTicks: number;
  /** Total ticks until fully unlocked. */
  vestingTicks: number;
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
    base?: string;
    quote?: string;
    /** Backward-compatible alias for base mint from pre-neutral manifests. */
    luna: string;
    /** Backward-compatible alias for quote mint from pre-neutral manifests. */
    ust: string;
  };
  symbols?: {
    base: string;
    quote: string;
  };
  pool: {
    address: string;
    authority: string;
    vaultA: string;
    vaultB: string;
    lpMint: string;
    /** True iff token-A in the pool is the base mint. New manifests write this. */
    aIsBase?: boolean;
    /** Legacy alias from pre-neutral manifests. Read via `poolBaseInSlotA()`. */
    aIsLuna?: boolean;
  };
  config: {
    address: string;
  };
  /** Optional staking pool deployment — when present, on-chain staking is enabled. */
  staking?: StakingDeployment;
  /** Optional governance deployment — when present, on-chain governance is enabled. */
  governance?: GovernanceDeployment;
  /** Vesting accounts created at deploy. Empty when no allocation has vestingMonths > 0. */
  vesting?: VestingEntry[];
  agents: AgentWalletEntry[];
  decimals: number;
}

export function baseMintAddress(dep: Deployment): string {
  return dep.mints.base ?? dep.mints.luna;
}

export function quoteMintAddress(dep: Deployment): string {
  return dep.mints.quote ?? dep.mints.ust;
}

export function baseAtaAddress(entry: AgentWalletEntry): string {
  return entry.baseAta ?? entry.lunaAta;
}

export function quoteAtaAddress(entry: AgentWalletEntry): string {
  return entry.quoteAta ?? entry.ustAta;
}

export function baseSymbol(dep: Deployment): string {
  return dep.symbols?.base ?? "TOKEN";
}

export function quoteSymbol(dep: Deployment): string {
  return dep.symbols?.quote ?? "USDC";
}

/**
 * Resolve the "base mint is in pool slot A" flag from either the new
 * `aIsBase` field or the legacy `aIsLuna` alias. Defaults to `true`
 * (slot A holds the base mint) when neither is present, matching the
 * deploy script's invariant.
 */
export function poolBaseInSlotA(dep: Deployment): boolean {
  if (typeof dep.pool.aIsBase === "boolean") return dep.pool.aIsBase;
  if (typeof dep.pool.aIsLuna === "boolean") return dep.pool.aIsLuna;
  return true;
}

/**
 * Load a deployment manifest. By default looks at the global location, but
 * callers can pass an explicit path or a sim id. Per-run manifests live at
 * `.local/runs/<simId>/deployment.json`; the workflow there is:
 *   1. POST /api/sim with onChain=true
 *   2. server spawns scripts/deploy-from-config.ts → writes per-run manifest
 *   3. server spawns the worker with CHAIN_DEPLOYMENT env var pointing at it
 */
export function loadDeployment(path?: string): Deployment {
  const target = path ?? process.env.CHAIN_DEPLOYMENT ?? DEPLOYMENT_PATH;
  if (!existsSync(target)) {
    throw new Error(
      `Deployment manifest not found at ${target}. Run: bun run scripts/deploy-from-config.ts --scenario <path>`,
    );
  }
  return JSON.parse(readFileSync(target, "utf8")) as Deployment;
}

export function deploymentPath(): string {
  mkdirSync(LOCAL_DIR, { recursive: true });
  return DEPLOYMENT_PATH;
}

export function perRunDeploymentPath(simId: string): string {
  return join(LOCAL_DIR, "runs", simId, "deployment.json");
}
