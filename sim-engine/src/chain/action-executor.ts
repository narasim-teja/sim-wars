import { Keypair, PublicKey } from "@solana/web3.js";
import { BN, AnchorProvider } from "@anchor-lang/core";
import { getAccount } from "@solana/spl-token";
import {
  getAmmDexProgram,
  loadDeployment,
  type Deployment,
  type AgentWalletEntry,
} from "./sdk";
import { loadKeypair, getProvider } from "./connection";

export interface ChainSwapResult {
  txSignature: string;
  amountInAtoms: bigint;
  amountOutAtoms: bigint;
  newPrice: number;
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
}
