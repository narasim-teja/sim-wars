/**
 * Config-driven on-chain bootstrap. Loads .env from repo root before any
 * Anchor / Solana code reads process.env so Helius keys + ANCHOR_PROVIDER_URL
 * are picked up regardless of which directory `bun run` was invoked from.
 *
 * Takes a scenario JSON file (the same shape we POST to /api/sim:
 *   { config: SimulationConfig, agents: AgentPersona[], tickConfig, onChain? })
 * and deploys everything that scenario needs to run live on Solana:
 *
 *   - Token mint (parameterized totalSupply, allocations) via the token_mint program
 *   - Mock quote-token mint
 *   - AMM pool (base/quote) seeded with the configured initialLiquidity at initialPrice
 *   - Optional staking pool (when --with-staking is passed AND staking config is non-trivial)
 *   - Optional governance (when --with-governance is passed AND a staking pool was deployed)
 *   - Per-agent keypair + ATA + funding (base + quote per persona's initialCapital)
 *
 * Output: writes the deployment manifest to either:
 *   - sim-engine/.local/runs/<simId>/deployment.json   (when --sim-id is passed)
 *   - sim-engine/.local/deployment.json                (default; backward-compat)
 *
 * Usage:
 *   bun run scripts/deploy-from-config.ts --scenario .local/runs/<simId>/scenario.json --sim-id <simId> [--with-staking] [--with-governance]
 *
 * Environment:
 *   ANCHOR_PROVIDER_URL — Solana RPC endpoint (default: localnet)
 *   ANCHOR_WALLET       — Deployer keypair file (default: ~/.config/solana/id.json)
 *
 * Designed to be invoked both from the CLI and from the API server's child-spawn
 * path (server.ts spawns this as a subprocess when POST /api/sim has onChain=true).
 */
import "../src/bootstrap";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  LAMPORTS_PER_SOL,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { BN } from "@anchor-lang/core";
import {
  createMint,
  createMintToInstruction,
  createTransferInstruction,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  transfer,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getProvider,
  loadKeypair,
  TOKEN_MINT_PROGRAM_ID,
  AMM_DEX_PROGRAM_ID,
  STAKING_PROGRAM_ID,
  GOVERNANCE_PROGRAM_ID,
} from "../src/chain/connection";
import { buildDeploymentPlan } from "../src/chain/deployment-plan";
import {
  getTokenMintProgram,
  getAmmDexProgram,
  getStakingProgram,
  getGovernanceProgram,
  deriveMintAuthority,
  deriveTokenomicsConfig,
  deriveAllocation,
  deriveVesting,
  derivePool,
  derivePoolAuthority,
  deriveVaultA,
  deriveVaultB,
  deriveStakingPool,
  deriveStakingPoolAuthority,
  deriveStakeVault,
  deriveRewardVault,
  deriveGovernance,
  nameToBytes,
  type Deployment,
  type AgentWalletEntry,
  type VestingEntry,
  KEYS_DIR,
  LOCAL_DIR,
} from "../src/chain/sdk";
import type { SimulationConfig, AgentPersona } from "../src/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");

interface Args {
  scenarioPath: string;
  simId: string | null;
  withStaking: boolean;
  withGovernance: boolean;
  /**
   * Funding SOL per agent. Default is cluster-aware: 5 on localnet (cheap,
   * the test validator mints SOL freely) and 0.05 on devnet (rate-limited
   * faucet — a 100-agent run on the localnet default would need 500 SOL,
   * which no devnet wallet ever has). Override with `--sol-per-agent`.
   */
  solPerAgent: number;
  /** Where to write the deployment manifest. */
  outputPath: string;
}

/**
 * Pick a sensible per-agent funding default by inspecting ANCHOR_PROVIDER_URL
 * and SOLANA_NETWORK. We can't read the provider here yet (parseArgs runs
 * before the SDK), so fall back to a string sniff.
 */
function defaultSolPerAgent(env: NodeJS.ProcessEnv = process.env): number {
  const network = (env.SOLANA_NETWORK ?? "").toLowerCase();
  const url = env.ANCHOR_PROVIDER_URL ?? "";
  const looksLikeLocalnet =
    network === "localnet" ||
    url.includes("127.0.0.1") ||
    url.includes("localhost");
  return looksLikeLocalnet ? 5 : 0.05;
}

function parseArgs(argv: string[]): Args {
  let scenarioPath = "";
  let simId: string | null = null;
  let withStaking = false;
  let withGovernance = false;
  let solPerAgent = defaultSolPerAgent();
  let outputPath = "";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--scenario" && argv[i + 1]) { scenarioPath = argv[++i]!; continue; }
    if (a === "--sim-id" && argv[i + 1]) { simId = argv[++i]!; continue; }
    if (a === "--out" && argv[i + 1]) { outputPath = argv[++i]!; continue; }
    if (a === "--with-staking") { withStaking = true; continue; }
    if (a === "--with-governance") { withGovernance = true; withStaking = true; continue; }
    if (a === "--sol-per-agent" && argv[i + 1]) { solPerAgent = Number(argv[++i]); continue; }
  }

  if (!scenarioPath) {
    console.error("usage: bun run scripts/deploy-from-config.ts --scenario <path> [--sim-id <id>] [--with-staking] [--with-governance]");
    process.exit(2);
  }

  const absScenario = isAbsolute(scenarioPath) ? scenarioPath : join(process.cwd(), scenarioPath);
  if (!outputPath) {
    if (simId) {
      outputPath = join(LOCAL_DIR, "runs", simId, "deployment.json");
    } else {
      outputPath = join(LOCAL_DIR, "deployment.json");
    }
  }

  return { scenarioPath: absScenario, simId, withStaking, withGovernance, solPerAgent, outputPath };
}

interface ScenarioPayload {
  config: SimulationConfig;
  agents: AgentPersona[];
}

function loadScenario(path: string): ScenarioPayload {
  if (!existsSync(path)) throw new Error(`scenario file not found: ${path}`);
  const text = readFileSync(path, "utf-8");
  const parsed = JSON.parse(text);
  // The /api/sim payload nests under root keys; tolerate both shapes.
  const config = parsed.config ?? parsed.default?.config;
  const agents = parsed.agents ?? parsed.default?.agents;
  if (!config || !agents) throw new Error("scenario must export { config, agents }");
  return { config, agents };
}

function loadOrCreateKeypair(path: string): { keypair: Keypair; created: boolean } {
  if (existsSync(path)) return { keypair: loadKeypair(path), created: false };
  const kp = Keypair.generate();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
  return { keypair: kp, created: true };
}

/**
 * Bounded-concurrency map. Solana RPC + the local validator can take ~30
 * concurrent in-flight calls before throughput tanks (TPS ceilings, leader
 * scheduling). Caller picks the limit based on the backend (Helius can
 * take more; localnet wants fewer).
 */
async function pmapBounded<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers: Promise<void>[] = [];
  const workerCount = Math.min(limit, items.length);
  for (let w = 0; w < workerCount; w++) {
    workers.push((async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!, i);
      }
    })());
  }
  await Promise.all(workers);
  return out;
}

/**
 * Pack N TransactionInstructions into transactions of at most `instrPerTx`
 * each and send them sequentially. Used for fan-out SPL ops (transfers
 * from one source ATA, mintTos from one mint authority) where the parallel
 * version races on the writable account lock and intermittently fails
 * with `Custom: 1` (InsufficientFunds) on the validator side.
 *
 * Sequential at the tx level; instructions WITHIN a tx execute atomically.
 * For 100 ops at instrPerTx=6 this is ~17 round-trips — much faster than
 * truly serial individual transfers (~100 round-trips) while staying
 * race-free.
 */
async function sendBatchedSplOps(args: {
  connection: ReturnType<typeof getProvider>["connection"];
  payer: Keypair;
  instrPerTx: number;
  ops: import("@solana/web3.js").TransactionInstruction[];
}): Promise<void> {
  const { connection, payer, instrPerTx, ops } = args;
  if (ops.length === 0) return;
  for (let i = 0; i < ops.length; i += instrPerTx) {
    const slice = ops.slice(i, i + instrPerTx);
    const tx = new Transaction();
    for (const ix of slice) tx.add(ix);
    await sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { config, agents } = loadScenario(args.scenarioPath);

  // Clamp decimals to a Solana SPL practical max (9). Whitepapers from EVM
  // ecosystems (Curve, Aave, etc.) often specify 18 decimals; on Solana that
  // overflows u64 (max ~1.8e19) for any non-trivial supply × scale product
  // and overflows JS Number safe-int range (2^53) before BN even sees it.
  // 9 decimals is sufficient resolution for fees + per-tick rewards in a sim.
  const rawDecimals = config.token.decimals ?? 6;
  const decimals = Math.min(9, Math.max(0, rawDecimals));
  if (decimals !== rawDecimals) {
    console.warn(`[deploy] clamped token decimals ${rawDecimals} → ${decimals} (Solana SPL practical max)`);
  }
  const SCALE_BI = 10n ** BigInt(decimals);
  // BigInt-safe UI-units → atoms. Uses Number.toFixed to convert the float
  // into a fixed-point string with `decimals` fractional digits, then turns
  // the resulting digit string into a BN. Avoids JS Number overflow for very
  // large totalSupply × 10^decimals products.
  const toAtoms = (a: number): BN => {
    if (!isFinite(a)) throw new Error(`toAtoms: non-finite input ${a}`);
    if (a === 0) return new BN(0);
    const negative = a < 0;
    const fixed = Math.abs(a).toFixed(decimals);
    const [whole, frac = ""] = fixed.split(".");
    const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
    const digits = (whole + fracPadded).replace(/^0+/, "") || "0";
    return new BN(negative ? "-" + digits : digits);
  };
  // BigInt sister of toAtoms — used by SPL Token mintTo/transfer which take
  // a bigint amount. Same fixed-point string conversion to avoid Number
  // precision loss on large supplies.
  const toAtomsBI = (a: number): bigint => {
    if (!isFinite(a)) throw new Error(`toAtomsBI: non-finite input ${a}`);
    if (a === 0) return 0n;
    const negative = a < 0;
    const fixed = Math.abs(a).toFixed(decimals);
    const [whole, frac = ""] = fixed.split(".");
    const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
    const digits = (whole + fracPadded).replace(/^0+/, "") || "0";
    return negative ? -BigInt(digits) : BigInt(digits);
  };
  void SCALE_BI; // reserved for future BigInt-native arithmetic

  // Defensive coalescing — when extraction returns `amm: {}` / `governance: {}`
  // (Zod inner defaults sometimes don't apply through the API round-trip),
  // fall back to the same values as the schema's defaults so the deploy still
  // produces a valid market. Renamed to govCfg to avoid shadowing the
  // governance Program client created later.
  const amm = {
    initialLiquidity: config.amm?.initialLiquidity ?? 100_000_000,
    initialPrice: config.amm?.initialPrice ?? 1,
    feeTier: config.amm?.feeTier ?? 0.3,
  };
  const govCfg = {
    proposalThresholdPercent: config.governance?.proposalThresholdPercent ?? 0.1,
    quorumPercent: config.governance?.quorumPercent ?? 10,
    votingPeriodTicks: config.governance?.votingPeriodTicks ?? 5,
    timelockTicks: config.governance?.timelockTicks ?? 0,
  };
  const deploymentPlan = buildDeploymentPlan({
    config,
    agents,
    onChain: true,
    withStaking: args.withStaking,
    withGovernance: args.withGovernance,
  });
  if (deploymentPlan.blockers.length > 0) {
    throw new Error(`[deploy] preflight failed: ${deploymentPlan.blockers.join("; ")}`);
  }
  for (const warning of deploymentPlan.warnings) {
    console.warn(`[deploy] warning: ${warning}`);
  }

  const provider = getProvider();
  const payer = (provider.wallet as any).payer as Keypair;
  console.log(`[deploy] deployer: ${payer.publicKey.toBase58()}`);
  console.log(`[deploy] rpc: ${provider.connection.rpcEndpoint}`);
  console.log(`[deploy] scenario: ${args.scenarioPath}`);
  console.log(`[deploy] simId: ${args.simId ?? "(default location)"}`);
  console.log(`[deploy] staking: ${args.withStaking}, governance: ${args.withGovernance}`);

  const balance = await provider.connection.getBalance(payer.publicKey);
  console.log(`[deploy] deployer SOL: ${balance / LAMPORTS_PER_SOL}`);
  const minSol = 0.5 + agents.length * args.solPerAgent;
  if (balance < minSol * LAMPORTS_PER_SOL) {
    throw new Error(
      `deployer needs at least ${minSol} SOL (have ${balance / LAMPORTS_PER_SOL}). Run: solana airdrop ${Math.ceil(minSol)}`,
    );
  }

  // ─── 1. Base token mint via token_mint program ─────────────────────────
  const tokenMint = getTokenMintProgram(provider);
  console.log(`[deploy] init ${deploymentPlan.symbols.base} mint…`);
  const baseMintKp = Keypair.generate();
  const baseMint = baseMintKp.publicKey;
  const [mintAuthority] = deriveMintAuthority(baseMint);
  const [tokenomicsConfig] = deriveTokenomicsConfig(baseMint);

  await tokenMint.methods
    .initializeMint(decimals)
    .accounts({
      authority: payer.publicKey,
      mint: baseMint,
      mintAuthority,
      config: tokenomicsConfig,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .signers([baseMintKp])
    .rpc();

  // ─── 2. Configure tokenomics + create allocations ──────────────────────
  // 1 month ≈ 30 ticks. The schema's `vestingMonths` is TOTAL time-from-TGE
  // until fully unlocked. The on-chain program treats `vesting_ticks` as the
  // POST-CLIFF linear duration only, so we translate:
  //   vesting_ticks (program) = (vestingMonths - cliffMonths) * 30
  //   cliff_ticks   (program) = cliffMonths * 30
  // Full unlock then occurs at start_tick + cliff_ticks + vesting_ticks
  //                         = start_tick + vestingMonths * 30, matching intent.
  // Lump-sum cliffs (vestingMonths == cliffMonths) get vesting_ticks=1 so the
  // program's "ticks_after_cliff >= vesting_duration" branch returns total.
  const totalSupplyAtoms = toAtoms(config.token.totalSupply);
  const allocInputs = config.token.allocations.map((a) => {
    const vestingMonths = Math.max(0, a.vestingMonths);
    const cliffMonths = Math.min(Math.max(0, a.cliffMonths ?? 0), vestingMonths);
    const cliffTicks = cliffMonths === 0 ? 0 : cliffMonths * 30;
    const linearMonths = Math.max(0, vestingMonths - cliffMonths);
    // Lump-sum cliff edge case: linear=0 would divide-by-zero in the program.
    // Use linearTicks=1 so the very next tick after the cliff fully unlocks.
    const linearTicks = vestingMonths === 0
      ? 0
      : linearMonths === 0
        ? 1
        : linearMonths * 30;
    return {
      name: nameToBytes(a.name),
      displayName: a.name,
      percentBps: Math.round(a.percent * 100),
      vestingTicks: linearTicks,
      cliffTicks,
    };
  });
  const totalBps = allocInputs.reduce((s, a) => s + a.percentBps, 0);
  if (totalBps !== 10_000) {
    // The on-chain program enforces == 10000. Auto-rebalance the largest
    // allocation so user-edited configs don't bounce off the rails here.
    const diff = 10_000 - totalBps;
    let largest = 0;
    for (let i = 1; i < allocInputs.length; i++) {
      if (allocInputs[i]!.percentBps > allocInputs[largest]!.percentBps) largest = i;
    }
    allocInputs[largest]!.percentBps += diff;
    console.warn(`[deploy] allocations summed to ${totalBps} bps; rebalanced largest by ${diff} bps`);
  }

  await tokenMint.methods
    .configureTokenomics(totalSupplyAtoms, allocInputs.map((a) => ({
      name: a.name,
      percentBps: a.percentBps,
      vestingTicks: a.vestingTicks,
      cliffTicks: a.cliffTicks,
    })) as any)
    .accounts({ authority: payer.publicKey, config: tokenomicsConfig })
    .rpc();

  for (const alloc of allocInputs) {
    const [allocPda] = deriveAllocation(tokenomicsConfig, alloc.name);
    await tokenMint.methods
      .createAllocation(Array.from(alloc.name), alloc.percentBps, alloc.vestingTicks, alloc.cliffTicks)
      .accounts({
        authority: payer.publicKey,
        config: tokenomicsConfig,
        allocation: allocPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  // ─── 3. Mint deployer's base-token pool seed ───────────────────────────
  // Pool seed + agent funding must come from a LIQUID (unvested) allocation.
  // Picking a vested bucket here would either silently bypass the lockup or
  // (correctly) exceed `allocated` once we also create a vesting account.
  const liquidAllocs = allocInputs.filter((a) => a.vestingTicks === 0);
  if (liquidAllocs.length === 0) {
    throw new Error(
      "[deploy] every allocation is vested — there is no liquid bucket to seed pool liquidity from. " +
        "At least one allocation must have vestingMonths=0 (e.g. an 'Ecosystem' or 'Liquidity' bucket).",
    );
  }
  const seedAlloc = liquidAllocs.reduce(
    (largest, a) => (a.percentBps > largest.percentBps ? a : largest),
    liquidAllocs[0]!,
  );
  const [seedAllocPda] = deriveAllocation(tokenomicsConfig, seedAlloc.name);
  const deployerBaseAta = await getOrCreateAssociatedTokenAccount(
    provider.connection, payer, baseMint, payer.publicKey,
  );

  const agentTokenSum = agents.reduce((s, a) => s + a.initialCapital.token, 0);
  const totalStakedExpected = agents.reduce(
    (s, a) => s + a.initialCapital.token * (a.initialCapital.stakedFraction ?? 0),
    0,
  );
  // Reward-vault seed: gets transferred into reward_vault at deploy time as
  // initial yield buffer. Sized to ~10% of total agent tokens.
  const rewardSeedTarget = args.withStaking
    ? Math.max(1_000_000, agentTokenSum * 0.10)
    : 0;
  // Inflation budget: stays in the deployer's base-token ATA so per-tick
  // `fundRewardVault` calls have source funds to pull from. Without this the
  // deployer ATA drains during deploy (AMM seed + reward seed + agent
  // funding consume everything minted) and every per-tick emission fails
  // with "insufficient funds". Sized to cover 200 ticks of max-rate emissions
  // at the expected initial stake — a generous overhead because the actual
  // total_staked grows during the sim as agents stake more.
  const emissionRate = config.staking.rewardEmissionRate ?? 0;
  const inflationBudget = args.withStaking && emissionRate > 0
    ? Math.max(0, totalStakedExpected * emissionRate * 200)
    : 0;
  const baseToMintUi = amm.initialLiquidity + agentTokenSum + rewardSeedTarget + inflationBudget;
  // Defensive: don't mint more than the seed allocation has room for.
  const seedAllocCapUi = (config.token.totalSupply * seedAlloc.percentBps) / 10_000;
  if (baseToMintUi > seedAllocCapUi) {
    throw new Error(
      `[deploy] liquid seed allocation '${seedAlloc.displayName}' (${seedAlloc.percentBps} bps = ${seedAllocCapUi} tokens) ` +
        `cannot fund pool ${amm.initialLiquidity} + agents ${agentTokenSum} + reward ${rewardSeedTarget} + inflation ${inflationBudget} = ${baseToMintUi}. ` +
        `Increase the liquid bucket or reduce agent initialCapital totals.`,
    );
  }
  // Compute the mint amount in atom-space, summing the per-agent atom amounts
  // directly (matching what we'll later transfer per agent) plus the AMM seed
  // and reward/inflation buffers. Float-summing UI units and converting once
  // at the end can lose ~N atoms for N agents (each `toFixed(decimals)` may
  // round; summing rounded values diverges from sum-then-round). Doing the
  // sum in atom space is exact, so the deployer ATA balance after mint
  // matches the sum of subsequent per-agent transfer atoms exactly.
  const agentBaseAtomsSum = agents.reduce<bigint>(
    (s, a) => s + toAtomsBI(a.initialCapital.token),
    0n,
  );
  const baseMintAtoms = new BN(
    (
      toAtomsBI(amm.initialLiquidity) +
      agentBaseAtomsSum +
      toAtomsBI(rewardSeedTarget) +
      toAtomsBI(inflationBudget)
    ).toString(),
  );
  await tokenMint.methods
    .distributeAllocation(baseMintAtoms)
    .accounts({
      authority: payer.publicKey,
      config: tokenomicsConfig,
      mint: baseMint,
      mintAuthority,
      allocation: seedAllocPda,
      recipientAta: deployerBaseAta.address,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  // ─── 3b. Create vesting accounts for vested allocations ─────────────────
  // Each vested allocation gets a unique beneficiary keypair (deployer-owned)
  // because the on-chain VestingAccount PDA seeds = ["vesting", config, beneficiary],
  // so re-using the deployer pubkey across allocations would collide.
  // Cliff + linear unlock is enforced by `claim_vested` against `current_tick`.
  const vestingDir = args.simId
    ? join(LOCAL_DIR, "runs", args.simId, "keys")
    : KEYS_DIR;
  if (!existsSync(vestingDir)) mkdirSync(vestingDir, { recursive: true });

  const vestedAllocs = allocInputs.filter((a) => a.vestingTicks > 0 && (config.token.totalSupply * a.percentBps) / 10_000 > 0);
  // Vesting accounts can be created in parallel — each one writes to a
  // distinct PDA (seeds = ["vesting", config, beneficiary]) and pays from
  // the deployer's lamport balance, which is shared but non-conflicting.
  const vestingEntries: VestingEntry[] = await pmapBounded(vestedAllocs, 10, async (alloc) => {
    const allocCapUi = (config.token.totalSupply * alloc.percentBps) / 10_000;
    const beneficiaryPath = join(vestingDir, `_vesting_${alloc.displayName.replace(/\s+/g, "_")}.json`);
    const { keypair: beneficiaryKp } = loadOrCreateKeypair(beneficiaryPath);
    const beneficiaryAta = await getOrCreateAssociatedTokenAccount(
      provider.connection, payer, baseMint, beneficiaryKp.publicKey,
    );
    const [allocPda] = deriveAllocation(tokenomicsConfig, alloc.name);
    const [vestingPda] = deriveVesting(tokenomicsConfig, beneficiaryKp.publicKey);

    await tokenMint.methods
      .createVesting(toAtoms(allocCapUi), new BN(0))
      .accounts({
        authority: payer.publicKey,
        config: tokenomicsConfig,
        mint: baseMint,
        allocation: allocPda,
        beneficiary: beneficiaryKp.publicKey,
        vesting: vestingPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log(
      `[deploy] vesting created for ${alloc.displayName}: ${allocCapUi} tokens, ` +
        `cliff ${alloc.cliffTicks}t, total ${alloc.vestingTicks}t`,
    );
    return {
      allocationName: alloc.displayName,
      vesting: vestingPda.toBase58(),
      beneficiary: beneficiaryKp.publicKey.toBase58(),
      beneficiaryKeypairPath: beneficiaryPath,
      beneficiaryAta: beneficiaryAta.address.toBase58(),
      totalAmount: allocCapUi,
      startTick: 0,
      cliffTicks: alloc.cliffTicks,
      vestingTicks: alloc.vestingTicks,
    };
  });

  // ─── 4. Mock quote-token mint ──────────────────────────────────────────
  console.log(`[deploy] create ${deploymentPlan.symbols.quote} mint…`);
  const quoteMint = await createMint(provider.connection, payer, payer.publicKey, null, decimals);
  const deployerQuoteAta = await getOrCreateAssociatedTokenAccount(
    provider.connection, payer, quoteMint, payer.publicKey,
  );
  const agentUsdcSum = agents.reduce((s, a) => s + a.initialCapital.usdc, 0);
  const quoteToMintUi = amm.initialLiquidity * amm.initialPrice + agentUsdcSum;
  await mintTo(
    provider.connection, payer, quoteMint, deployerQuoteAta.address, payer,
    toAtomsBI(quoteToMintUi),
  );

  // ─── 5. AMM pool ──────────────────────────────────────────────────────
  console.log("[deploy] init AMM pool…");
  const ammDex = getAmmDexProgram(provider);
  const [pool] = derivePool(baseMint, quoteMint);
  const [poolAuthority] = derivePoolAuthority(pool);
  const [vaultA] = deriveVaultA(pool);
  const [vaultB] = deriveVaultB(pool);
  const lpMintKp = Keypair.generate();
  const feeBps = Math.round(amm.feeTier * 100);

  await ammDex.methods
    .initializePool(feeBps, 0)
    .accounts({
      authority: payer.publicKey,
      tokenAMint: baseMint,
      tokenBMint: quoteMint,
      pool,
      poolAuthority,
      tokenAVault: vaultA,
      tokenBVault: vaultB,
      lpMint: lpMintKp.publicKey,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .signers([lpMintKp])
    .rpc();

  const deployerLpAta = await getOrCreateAssociatedTokenAccount(
    provider.connection, payer, lpMintKp.publicKey, payer.publicKey,
  );
  await ammDex.methods
    .addLiquidity(toAtoms(amm.initialLiquidity), toAtoms(amm.initialLiquidity * amm.initialPrice), new BN(0))
    .accounts({
      provider: payer.publicKey,
      pool,
      poolAuthority,
      tokenAVault: vaultA,
      tokenBVault: vaultB,
      lpMint: lpMintKp.publicKey,
      providerTokenA: deployerBaseAta.address,
      providerTokenB: deployerQuoteAta.address,
      providerLp: deployerLpAta.address,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  // ─── 6. Optional staking pool ──────────────────────────────────────────
  let stakingDeployment: Deployment["staking"] = undefined;
  if (args.withStaking) {
    console.log("[deploy] init staking pool…");
    const staking = getStakingProgram(provider);
    const [stakingPool] = deriveStakingPool(baseMint);
    const [stakingPoolAuthority] = deriveStakingPoolAuthority(stakingPool);
    const [stakeVault] = deriveStakeVault(stakingPool);
    const [rewardVault] = deriveRewardVault(stakingPool);
    const baseApyBps = Math.round(config.staking.baseAPY * 100);
    // max_apy_bps must be >= base_apy_bps (program enforces). Default to base
    // when extraction didn't pull a separate maxAPY.
    const maxApyBps = Math.max(
      baseApyBps,
      Math.round((config.staking.maxAPY ?? config.staking.baseAPY) * 100),
    );
    const penaltyBps = Math.min(
      10_000,
      Math.round(Math.max(0, config.staking.unstakePenaltyPercent ?? 0) * 100),
    );
    const ticksPerYear = 365;
    const lockTicks = Math.max(0, Math.floor(config.staking.lockPeriodTicks));
    const cooldownTicks = Math.max(0, Math.floor(config.staking.unstakeCooldownTicks ?? 1));
    await staking.methods
      .initializePool(baseApyBps, ticksPerYear, lockTicks, cooldownTicks, maxApyBps, penaltyBps)
      .accounts({
        authority: payer.publicKey,
        stakeMint: baseMint,
        pool: stakingPool,
        poolAuthority: stakingPoolAuthority,
        stakeVault,
        rewardVault,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    // Seed the reward vault from the deployer's base-token ATA so claim_rewards has
    // something to pay out. The amount is `rewardSeedTarget` (computed up
    // front and already added to baseToMintUi), so the transfer cannot starve
    // the per-agent funding loop that runs after this.
    const rewardSeedUi = rewardSeedTarget;
    await transfer(
      provider.connection, payer, deployerBaseAta.address, rewardVault, payer,
      toAtomsBI(rewardSeedUi),
    );
    stakingDeployment = {
      program: STAKING_PROGRAM_ID.toBase58(),
      pool: stakingPool.toBase58(),
      poolAuthority: stakingPoolAuthority.toBase58(),
      stakeVault: stakeVault.toBase58(),
      rewardVault: rewardVault.toBase58(),
      stakeMint: baseMint.toBase58(),
      unstakeCooldownTicks: cooldownTicks,
      lockPeriodTicks: lockTicks,
      maxApyBps,
      unstakePenaltyBps: penaltyBps,
      rewardEmissionRate: Math.max(0, config.staking.rewardEmissionRate ?? 0),
    };

    // ─── 7. Optional governance ─────────────────────────────────────────
    if (args.withGovernance) {
      console.log("[deploy] init governance…");
      const gov = getGovernanceProgram(provider);
      const [governance] = deriveGovernance(stakingPool);
      const proposalThresholdAtoms = toAtoms(
        config.token.totalSupply * (govCfg.proposalThresholdPercent / 100),
      );
      const quorumAtoms = toAtoms(
        config.token.totalSupply * (govCfg.quorumPercent / 100),
      );
      await gov.methods
        .initializeGovernance(
          proposalThresholdAtoms,
          quorumAtoms,
          govCfg.votingPeriodTicks,
          govCfg.timelockTicks,
        )
        .accounts({
          authority: payer.publicKey,
          stakingPool,
          governance,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
  }

  // ─── 8. Per-agent keypairs + ATAs + funding ────────────────────────────
  // Three-phase pipeline:
  //   (a) Parallel — keypair load + SOL airdrop + ATA creation (no contention)
  //   (b) Serial-batched — base-token transfers from deployer's ATA (avoids
  //       same-source-ATA simulation/execution races that intermittently
  //       failed with `Custom: 1` (InsufficientFunds))
  //   (c) Serial-batched — quote mintTo (mint authority is shared, so
  //       parallel mintTos contend on the mint account write lock)
  // Both (b) and (c) pack ~6 SPL instructions per transaction, so a 100-agent
  // run is ~17 round-trips instead of 100 — fast and correct.
  const keysDir = args.simId ? join(LOCAL_DIR, "runs", args.simId, "keys") : KEYS_DIR;
  if (!existsSync(keysDir)) mkdirSync(keysDir, { recursive: true });

  const fundT0 = Date.now();
  const SETUP_CONCURRENCY = Number(process.env.DEPLOY_AGENT_CONCURRENCY) || 25;
  const FUND_INSTR_PER_TX = Math.max(1, Number(process.env.DEPLOY_FUND_BATCH) || 6);

  console.log(`[deploy] phase 1/3: keypair + airdrop + ATA for ${agents.length} agents (parallel, concurrency=${SETUP_CONCURRENCY})…`);
  type AgentSetup = {
    persona: typeof agents[number];
    keypair: Keypair;
    keypairPath: string;
    baseAta: PublicKey;
    quoteAta: PublicKey;
    baseAtoms: bigint;
    quoteAtoms: bigint;
  };
  const setups: AgentSetup[] = await pmapBounded(agents, SETUP_CONCURRENCY, async (persona) => {
    const keypairPath = join(keysDir, `${persona.id}.json`);
    const { keypair } = loadOrCreateKeypair(keypairPath);
    const balance = await provider.connection.getBalance(keypair.publicKey);
    if (balance < args.solPerAgent * LAMPORTS_PER_SOL * 0.5) {
      try {
        const sig = await provider.connection.requestAirdrop(keypair.publicKey, args.solPerAgent * LAMPORTS_PER_SOL);
        await provider.connection.confirmTransaction(sig, "confirmed");
      } catch (e) {
        // Devnet airdrop is rate-limited; tolerate failure if pre-funded.
        console.warn(`[deploy] airdrop failed for ${persona.id}: ${(e as Error).message}`);
      }
    }
    const [baseAta, quoteAta] = await Promise.all([
      getOrCreateAssociatedTokenAccount(provider.connection, payer, baseMint, keypair.publicKey),
      getOrCreateAssociatedTokenAccount(provider.connection, payer, quoteMint, keypair.publicKey),
    ]);
    return {
      persona,
      keypair,
      keypairPath,
      baseAta: baseAta.address,
      quoteAta: quoteAta.address,
      baseAtoms: toAtomsBI(persona.initialCapital.token),
      quoteAtoms: toAtomsBI(persona.initialCapital.usdc),
    };
  });

  // Pre-flight: confirm the deployer's base ATA actually has enough atoms
  // for the upcoming transfers. The earlier mint+pool seed should have
  // landed by now, but if anything is delayed we want a clean error here
  // rather than a cryptic `Custom: 1` mid-batch.
  const totalBaseTransfer = setups.reduce((sum, s) => sum + s.baseAtoms, 0n);
  const deployerBaseAcc = await getAccount(provider.connection, deployerBaseAta.address);
  if (deployerBaseAcc.amount < totalBaseTransfer) {
    throw new Error(
      `[deploy] deployer ${deploymentPlan.symbols.base} ATA has ${deployerBaseAcc.amount} atoms, ` +
        `but agent funding needs ${totalBaseTransfer}. Mint capacity exceeded — increase liquid bucket or reduce agent capital.`,
    );
  }

  console.log(`[deploy] phase 2/3: ${deploymentPlan.symbols.base} transfers (batched, ${FUND_INSTR_PER_TX} instructions/tx)…`);
  await sendBatchedSplOps({
    connection: provider.connection,
    payer,
    instrPerTx: FUND_INSTR_PER_TX,
    ops: setups
      .filter((s) => s.baseAtoms > 0n)
      .map((s) =>
        createTransferInstruction(deployerBaseAta.address, s.baseAta, payer.publicKey, s.baseAtoms),
      ),
  });

  console.log(`[deploy] phase 3/3: ${deploymentPlan.symbols.quote} mintTo (batched, ${FUND_INSTR_PER_TX} instructions/tx)…`);
  await sendBatchedSplOps({
    connection: provider.connection,
    payer,
    instrPerTx: FUND_INSTR_PER_TX,
    ops: setups
      .filter((s) => s.quoteAtoms > 0n)
      .map((s) =>
        createMintToInstruction(quoteMint, s.quoteAta, payer.publicKey, s.quoteAtoms),
      ),
  });

  const entries: AgentWalletEntry[] = setups.map((s) => ({
    agentId: s.persona.id,
    pubkey: s.keypair.publicKey.toBase58(),
    keypairPath: s.keypairPath,
    baseAta: s.baseAta.toBase58(),
    quoteAta: s.quoteAta.toBase58(),
    // Legacy field aliases for older readers; new code should use baseAta/quoteAta.
    lunaAta: s.baseAta.toBase58(),
    ustAta: s.quoteAta.toBase58(),
  }));
  console.log(`[deploy]   funded ${agents.length} agents in ${Date.now() - fundT0}ms`);

  // ─── 9. Write deployment manifest ──────────────────────────────────────
  const deployment: Deployment = {
    cluster: provider.connection.rpcEndpoint,
    programs: {
      tokenMint: TOKEN_MINT_PROGRAM_ID.toBase58(),
      ammDex: AMM_DEX_PROGRAM_ID.toBase58(),
      ...(args.withStaking ? { staking: STAKING_PROGRAM_ID.toBase58() } : {}),
      ...(args.withGovernance ? { governance: GOVERNANCE_PROGRAM_ID.toBase58() } : {}),
    },
    mints: {
      base: baseMint.toBase58(),
      quote: quoteMint.toBase58(),
      luna: baseMint.toBase58(),
      ust: quoteMint.toBase58(),
    },
    symbols: deploymentPlan.symbols,
    pool: {
      address: pool.toBase58(),
      authority: poolAuthority.toBase58(),
      vaultA: vaultA.toBase58(),
      vaultB: vaultB.toBase58(),
      lpMint: lpMintKp.publicKey.toBase58(),
      aIsBase: true,
      // Legacy alias kept so older readers (chain/sdk.ts pre-poolBaseInSlotA)
      // still parse this manifest. New code reads via poolBaseInSlotA().
      aIsLuna: true,
    },
    config: { address: tokenomicsConfig.toBase58() },
    vesting: vestingEntries.length > 0 ? vestingEntries : undefined,
    staking: stakingDeployment,
    ...(args.withGovernance ? {
      governance: {
        program: GOVERNANCE_PROGRAM_ID.toBase58(),
        governance: deriveGovernance(deriveStakingPool(baseMint)[0])[0].toBase58(),
        initialProposalCount: 0,
      },
    } : {}),
    agents: entries,
    decimals,
  };
  mkdirSync(dirname(args.outputPath), { recursive: true });
  writeFileSync(args.outputPath, JSON.stringify(deployment, null, 2));
  console.log(`[deploy] ✓ wrote manifest to ${args.outputPath}`);

  // Suppress unused-var warning when --sim-id wasn't passed.
  void REPO_ROOT;
}

main().catch((err) => {
  console.error("[deploy] failed:", err);
  process.exit(1);
});
