import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { BN, AnchorProvider } from "@anchor-lang/core";
import { getAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  getAmmDexProgram,
  getStakingProgram,
  getGovernanceProgram,
  getTokenMintProgram,
  loadDeployment,
  deriveStakeAccount,
  deriveProposal,
  deriveVoteReceipt,
  deriveMintAuthority,
  deriveTokenomicsConfig,
  type Deployment,
  type AgentWalletEntry,
  type VestingEntry,
} from "./sdk";
import { loadKeypair, getProvider } from "./connection";

export interface ChainSwapResult {
  txSignature: string;
  amountInAtoms: bigint;
  amountOutAtoms: bigint;
  newPrice: number;
}

export interface ChainStakeResult {
  txSignature: string;
  amountAtoms: bigint;
}

export interface ChainProposalResult {
  txSignature: string;
  proposalId: number;
  proposalPubkey: string;
}

export interface ChainVoteResult {
  txSignature: string;
  proposalId: number;
  support: boolean;
}

export interface ChainClaimVestedResult {
  /** Per-allocation results. Failures are swallowed and reported via `error`. */
  claims: {
    allocationName: string;
    txSignature: string | null;
    /** Empty when nothing newly unlocked (program returned NothingToClaim). */
    error: string | null;
  }[];
}

/**
 * Executes real on-chain swaps against the deployed AMM.
 * Stake/unstake remain in-memory in StateManager (no on-chain staking program in Phase 1).
 */
export class ChainExecutor {
  private deployment: Deployment;
  private provider: AnchorProvider;
  private agentWallets: Map<string, { keypair: Keypair; entry: AgentWalletEntry }> = new Map();
  private decimals: number;

  constructor() {
    this.deployment = loadDeployment();
    this.provider = getProvider();
    this.decimals = this.deployment.decimals;

    for (const entry of this.deployment.agents) {
      this.agentWallets.set(entry.agentId, {
        keypair: loadKeypair(entry.keypairPath),
        entry,
      });
    }
  }

  getDeployment(): Deployment {
    return this.deployment;
  }

  getProvider(): AnchorProvider {
    return this.provider;
  }

  /** Convert a UI-amount float into atomic u64 (BN). */
  private toAtoms(amount: number): BN {
    const scale = 10 ** this.decimals;
    return new BN(Math.floor(amount * scale));
  }

  private fromAtoms(atoms: bigint | BN): number {
    const scale = 10 ** this.decimals;
    const v = typeof atoms === "bigint" ? Number(atoms) : atoms.toNumber();
    return v / scale;
  }

  /** Read pool reserves and derive current price (UST per LUNA). */
  async getPrice(): Promise<{ price: number; reserveLuna: number; reserveUst: number }> {
    const vaultLuna = this.deployment.pool.aIsLuna
      ? new PublicKey(this.deployment.pool.vaultA)
      : new PublicKey(this.deployment.pool.vaultB);
    const vaultUst = this.deployment.pool.aIsLuna
      ? new PublicKey(this.deployment.pool.vaultB)
      : new PublicKey(this.deployment.pool.vaultA);

    const [lunaAcc, ustAcc] = await Promise.all([
      getAccount(this.provider.connection, vaultLuna),
      getAccount(this.provider.connection, vaultUst),
    ]);
    const reserveLuna = this.fromAtoms(lunaAcc.amount);
    const reserveUst = this.fromAtoms(ustAcc.amount);
    const price = reserveLuna === 0 ? 0 : reserveUst / reserveLuna;
    return { price, reserveLuna, reserveUst };
  }

  /**
   * Execute a swap as the given agent.
   * direction: 'sell' = LUNA → UST, 'buy' = UST → LUNA.
   * amount is in UI units of the input token (LUNA for sell, UST for buy).
   */
  async swap(
    agentId: string,
    direction: "buy" | "sell",
    amount: number,
  ): Promise<ChainSwapResult> {
    const wallet = this.agentWallets.get(agentId);
    if (!wallet) throw new Error(`No on-chain wallet for agent ${agentId}`);
    if (amount <= 0) throw new Error("amount must be > 0");

    const program = getAmmDexProgram(this.provider);
    const dep = this.deployment;
    const pool = new PublicKey(dep.pool.address);
    const poolAuthority = new PublicKey(dep.pool.authority);
    const vaultA = new PublicKey(dep.pool.vaultA);
    const vaultB = new PublicKey(dep.pool.vaultB);

    const lunaAta = new PublicKey(wallet.entry.lunaAta);
    const ustAta = new PublicKey(wallet.entry.ustAta);

    // direction → a_to_b mapping
    // sell: LUNA → UST. a_to_b = aIsLuna ? true : false
    // buy:  UST → LUNA. a_to_b = aIsLuna ? false : true
    const aToB = direction === "sell" ? dep.pool.aIsLuna : !dep.pool.aIsLuna;
    const swapperTokenIn = direction === "sell" ? lunaAta : ustAta;
    const swapperTokenOut = direction === "sell" ? ustAta : lunaAta;

    const amountIn = this.toAtoms(amount);

    const builder = program.methods
      .swap(amountIn, new BN(0), aToB)
      .accounts({
        swapper: wallet.keypair.publicKey,
        pool,
        poolAuthority,
        tokenAVault: vaultA,
        tokenBVault: vaultB,
        swapperTokenIn,
        swapperTokenOut,
      })
      .signers([wallet.keypair]);

    // Dry-run before broadcast — surfaces constraint failures (mint mismatch,
    // same-account, math overflow) before paying tx fees. Anchor 1.0's
    // .simulate() doesn't auto-include builder-level .signers(), so we sign
    // the transaction explicitly and use the connection's simulate.
    const tx = await builder.transaction();
    tx.feePayer = this.provider.wallet.publicKey;
    tx.recentBlockhash = (await this.provider.connection.getLatestBlockhash()).blockhash;
    tx.partialSign(wallet.keypair);
    const signedTx = await this.provider.wallet.signTransaction(tx);
    const sim = await this.provider.connection.simulateTransaction(signedTx);
    if (sim.value.err) {
      throw new Error(`swap simulate failed: ${JSON.stringify(sim.value.err)}\nlogs:\n${(sim.value.logs ?? []).join("\n")}`);
    }

    const txSignature = await builder.rpc();

    // Read post-trade balances to compute realized output and new price
    const { price } = await this.getPrice();
    return {
      txSignature,
      amountInAtoms: BigInt(amountIn.toString()),
      amountOutAtoms: 0n, // not parsed from tx; price suffices for state sync
      newPrice: price,
    };
  }

  /** Read an agent's LUNA + UST balances from chain. */
  async getAgentBalances(agentId: string): Promise<{ luna: number; ust: number }> {
    const wallet = this.agentWallets.get(agentId);
    if (!wallet) throw new Error(`No on-chain wallet for agent ${agentId}`);
    const [lunaAcc, ustAcc] = await Promise.all([
      getAccount(this.provider.connection, new PublicKey(wallet.entry.lunaAta)),
      getAccount(this.provider.connection, new PublicKey(wallet.entry.ustAta)),
    ]);
    return {
      luna: this.fromAtoms(lunaAcc.amount),
      ust: this.fromAtoms(ustAcc.amount),
    };
  }

  hasAgent(agentId: string): boolean {
    return this.agentWallets.has(agentId);
  }

  // ==========================================================================
  // Staking (optional — requires deployment.staking)
  // ==========================================================================

  /** True if an on-chain staking pool is configured. */
  hasStaking(): boolean {
    return !!this.deployment.staking;
  }

  /** True if governance is configured (implies staking is too). */
  hasGovernance(): boolean {
    return !!this.deployment.governance && !!this.deployment.staking;
  }

  private requireStaking() {
    if (!this.deployment.staking) {
      throw new Error("staking deployment not configured");
    }
    return this.deployment.staking;
  }

  private requireGovernance() {
    if (!this.deployment.governance) {
      throw new Error("governance deployment not configured");
    }
    return this.deployment.governance;
  }

  /**
   * Initialize a per-agent stake account PDA. Idempotent — returns null if the
   * account already exists so callers can call this lazily before the first stake.
   */
  async ensureStakeAccount(agentId: string): Promise<string | null> {
    const st = this.requireStaking();
    const wallet = this.agentWallets.get(agentId);
    if (!wallet) throw new Error(`no on-chain wallet for agent ${agentId}`);

    const pool = new PublicKey(st.pool);
    const [stakeAccount] = deriveStakeAccount(pool, wallet.keypair.publicKey);

    const info = await this.provider.connection.getAccountInfo(stakeAccount);
    if (info) return null;

    const program = getStakingProgram(this.provider);
    const tx = await program.methods
      .initializeStakeAccount()
      .accounts({
        user: wallet.keypair.publicKey,
        pool,
        stakeAccount,
        systemProgram: SystemProgram.programId,
      })
      .signers([wallet.keypair])
      .rpc();
    return tx;
  }

  /** Stake `amount` tokens for the given agent. Auto-creates stake_account if needed. */
  async stake(agentId: string, amount: number): Promise<ChainStakeResult> {
    const st = this.requireStaking();
    const wallet = this.agentWallets.get(agentId);
    if (!wallet) throw new Error(`no on-chain wallet for agent ${agentId}`);
    if (amount <= 0) throw new Error("amount must be > 0");

    await this.ensureStakeAccount(agentId);

    const pool = new PublicKey(st.pool);
    const stakeVault = new PublicKey(st.stakeVault);
    const [stakeAccount] = deriveStakeAccount(pool, wallet.keypair.publicKey);
    const userAta = new PublicKey(wallet.entry.lunaAta);

    const amountAtoms = this.toAtoms(amount);
    const program = getStakingProgram(this.provider);
    const txSignature = await program.methods
      .stake(amountAtoms)
      .accounts({
        user: wallet.keypair.publicKey,
        pool,
        stakeAccount,
        owner: wallet.keypair.publicKey,
        stakeVault,
        userAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([wallet.keypair])
      .rpc();

    return { txSignature, amountAtoms: BigInt(amountAtoms.toString()) };
  }

  /** Request unstake → moves `amount` into the pending bucket and starts cooldown. */
  async requestUnstake(agentId: string, amount: number): Promise<ChainStakeResult> {
    const st = this.requireStaking();
    const wallet = this.agentWallets.get(agentId);
    if (!wallet) throw new Error(`no on-chain wallet for agent ${agentId}`);
    if (amount <= 0) throw new Error("amount must be > 0");

    const pool = new PublicKey(st.pool);
    const [stakeAccount] = deriveStakeAccount(pool, wallet.keypair.publicKey);

    const amountAtoms = this.toAtoms(amount);
    const program = getStakingProgram(this.provider);
    const txSignature = await program.methods
      .requestUnstake(amountAtoms)
      .accounts({
        user: wallet.keypair.publicKey,
        pool,
        stakeAccount,
        owner: wallet.keypair.publicKey,
      })
      .signers([wallet.keypair])
      .rpc();

    return { txSignature, amountAtoms: BigInt(amountAtoms.toString()) };
  }

  /** Complete a previously requested unstake after the cooldown expires. */
  async completeUnstake(agentId: string): Promise<{ txSignature: string }> {
    const st = this.requireStaking();
    const wallet = this.agentWallets.get(agentId);
    if (!wallet) throw new Error(`no on-chain wallet for agent ${agentId}`);

    const pool = new PublicKey(st.pool);
    const poolAuthority = new PublicKey(st.poolAuthority);
    const stakeVault = new PublicKey(st.stakeVault);
    const [stakeAccount] = deriveStakeAccount(pool, wallet.keypair.publicKey);
    const userAta = new PublicKey(wallet.entry.lunaAta);

    const program = getStakingProgram(this.provider);
    const txSignature = await program.methods
      .completeUnstake()
      .accounts({
        user: wallet.keypair.publicKey,
        pool,
        poolAuthority,
        stakeAccount,
        owner: wallet.keypair.publicKey,
        stakeVault,
        userAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([wallet.keypair])
      .rpc();

    return { txSignature };
  }

  /** Claim accrued rewards from the reward vault. */
  async claimRewards(agentId: string): Promise<{ txSignature: string }> {
    const st = this.requireStaking();
    const wallet = this.agentWallets.get(agentId);
    if (!wallet) throw new Error(`no on-chain wallet for agent ${agentId}`);

    const pool = new PublicKey(st.pool);
    const poolAuthority = new PublicKey(st.poolAuthority);
    const rewardVault = new PublicKey(st.rewardVault);
    const [stakeAccount] = deriveStakeAccount(pool, wallet.keypair.publicKey);
    const userAta = new PublicKey(wallet.entry.lunaAta);

    const program = getStakingProgram(this.provider);
    const txSignature = await program.methods
      .claimRewards()
      .accounts({
        user: wallet.keypair.publicKey,
        pool,
        poolAuthority,
        stakeAccount,
        owner: wallet.keypair.publicKey,
        rewardVault,
        userAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([wallet.keypair])
      .rpc();

    return { txSignature };
  }

  /**
   * Admin-gated: advance the on-chain tick counter on both staking and
   * governance programs so reward accrual and voting-period checks move
   * forward in lockstep with the simulation.
   */
  async setTick(tick: number): Promise<{ stakingTx?: string; governanceTx?: string }> {
    const out: { stakingTx?: string; governanceTx?: string } = {};
    const st = this.deployment.staking;
    if (st) {
      const program = getStakingProgram(this.provider);
      out.stakingTx = await program.methods
        .setTick(new BN(tick))
        .accounts({
          authority: this.provider.wallet.publicKey,
          pool: new PublicKey(st.pool),
        })
        .rpc();
    }
    const gov = this.deployment.governance;
    if (gov) {
      const program = getGovernanceProgram(this.provider);
      out.governanceTx = await program.methods
        .setTick(new BN(tick))
        .accounts({
          authority: this.provider.wallet.publicKey,
          governance: new PublicKey(gov.governance),
        })
        .rpc();
    }
    return out;
  }

  /**
   * Top up the staking reward vault from the deployer's LUNA ATA. Used by the
   * engine to schedule per-tick emissions: `amount = total_staked × rewardEmissionRate`.
   * No-op when `amount <= 0` (e.g. nothing staked yet, or emission rate = 0).
   * Returns null when staking isn't configured at all.
   */
  async fundRewardVault(amount: number): Promise<{ txSignature: string } | null> {
    if (!this.deployment.staking) return null;
    if (amount <= 0) return null;

    const program = getStakingProgram(this.provider);
    const st = this.deployment.staking;
    const payer = (this.provider.wallet as { payer?: Keypair }).payer;
    if (!payer) throw new Error("provider.wallet.payer is required for fundRewardVault");

    // The deployer's LUNA ATA holds the seed allocation. We don't track its
    // address in the manifest (it's the deployer's pubkey + lunaMint), so
    // derive it via the standard SPL ATA seed.
    const { getAssociatedTokenAddress } = await import("@solana/spl-token");
    const funderAta = await getAssociatedTokenAddress(
      new PublicKey(this.deployment.mints.luna),
      payer.publicKey,
    );

    const txSignature = await program.methods
      .fundRewardVault(this.toAtoms(amount))
      .accounts({
        funder: payer.publicKey,
        pool: new PublicKey(st.pool),
        rewardVault: new PublicKey(st.rewardVault),
        funderAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    return { txSignature };
  }

  // ==========================================================================
  // Vesting (optional — requires deployment.vesting)
  // ==========================================================================

  hasVesting(): boolean {
    return !!this.deployment.vesting && this.deployment.vesting.length > 0;
  }

  getVestingEntries(): VestingEntry[] {
    return this.deployment.vesting ?? [];
  }

  /**
   * For each vested allocation, attempt to mint newly-unlocked tokens to the
   * beneficiary's ATA. The on-chain program enforces cliff + linear unlock
   * against `current_tick`; we simply call it each tick and tolerate
   * `NothingToClaim` errors during pre-cliff or no-progress windows.
   *
   * Returns the per-allocation outcome so callers can surface unlock events
   * to the simulation log.
   */
  async claimAllVested(currentTick: number): Promise<ChainClaimVestedResult> {
    const vesting = this.deployment.vesting ?? [];
    if (vesting.length === 0) return { claims: [] };

    const program = getTokenMintProgram(this.provider);
    const lunaMint = new PublicKey(this.deployment.mints.luna);
    const [mintAuthority] = deriveMintAuthority(lunaMint);
    const [tokenomicsConfig] = deriveTokenomicsConfig(lunaMint);

    const out: ChainClaimVestedResult = { claims: [] };
    for (const entry of vesting) {
      let beneficiaryKp;
      try {
        beneficiaryKp = loadKeypair(entry.beneficiaryKeypairPath);
      } catch (e) {
        out.claims.push({
          allocationName: entry.allocationName,
          txSignature: null,
          error: `keypair load failed: ${(e as Error).message}`,
        });
        continue;
      }

      try {
        const txSignature = await program.methods
          .claimVested(new BN(currentTick))
          .accounts({
            beneficiary: beneficiaryKp.publicKey,
            config: tokenomicsConfig,
            mint: lunaMint,
            mintAuthority,
            vesting: new PublicKey(entry.vesting),
            beneficiaryAta: new PublicKey(entry.beneficiaryAta),
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([beneficiaryKp])
          .rpc();
        out.claims.push({
          allocationName: entry.allocationName,
          txSignature,
          error: null,
        });
      } catch (e) {
        const msg = (e as Error).message;
        // Pre-cliff or no-progress is expected. Flag everything else.
        const isExpected = /CliffNotReached|NothingToClaim/i.test(msg);
        out.claims.push({
          allocationName: entry.allocationName,
          txSignature: null,
          error: isExpected ? null : msg,
        });
      }
    }
    return out;
  }

  // ==========================================================================
  // Governance (optional — requires deployment.governance)
  // ==========================================================================

  /**
   * Create a new proposal. Returns the numeric id the chain assigned.
   * Caller is responsible for supplying the current proposal count from
   * their local tracking — governance.proposal_count PDA seed requires it.
   */
  async createProposal(
    agentId: string,
    proposalId: number,
    description: string,
  ): Promise<ChainProposalResult> {
    const st = this.requireStaking();
    const gov = this.requireGovernance();
    const wallet = this.agentWallets.get(agentId);
    if (!wallet) throw new Error(`no on-chain wallet for agent ${agentId}`);

    const pool = new PublicKey(st.pool);
    const governance = new PublicKey(gov.governance);
    const [proposerStake] = deriveStakeAccount(pool, wallet.keypair.publicKey);
    const [proposal] = deriveProposal(governance, proposalId);

    // description packed to 64 bytes (program's [u8; 64] struct field)
    const descBuf = Buffer.alloc(64);
    descBuf.write(description, 0, "utf8");

    const program = getGovernanceProgram(this.provider);
    const txSignature = await program.methods
      .createProposal(Array.from(descBuf))
      .accounts({
        proposer: wallet.keypair.publicKey,
        governance,
        proposerStake,
        proposal,
        systemProgram: SystemProgram.programId,
      })
      .signers([wallet.keypair])
      .rpc();

    return {
      txSignature,
      proposalId,
      proposalPubkey: proposal.toBase58(),
    };
  }

  async castVote(
    agentId: string,
    proposalId: number,
    support: boolean,
  ): Promise<ChainVoteResult> {
    const st = this.requireStaking();
    const gov = this.requireGovernance();
    const wallet = this.agentWallets.get(agentId);
    if (!wallet) throw new Error(`no on-chain wallet for agent ${agentId}`);

    const pool = new PublicKey(st.pool);
    const governance = new PublicKey(gov.governance);
    const [voterStake] = deriveStakeAccount(pool, wallet.keypair.publicKey);
    const [proposal] = deriveProposal(governance, proposalId);
    const [voteReceipt] = deriveVoteReceipt(proposal, wallet.keypair.publicKey);

    const program = getGovernanceProgram(this.provider);
    const txSignature = await program.methods
      .castVote(support)
      .accounts({
        voter: wallet.keypair.publicKey,
        governance,
        proposal,
        voterStake,
        voteReceipt,
        systemProgram: SystemProgram.programId,
      })
      .signers([wallet.keypair])
      .rpc();

    return { txSignature, proposalId, support };
  }
}
