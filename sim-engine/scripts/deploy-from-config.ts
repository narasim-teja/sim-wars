/**
 * Config-driven on-chain bootstrap.
 *
 * Takes a scenario JSON file (the same shape we POST to /api/sim:
 *   { config: SimulationConfig, agents: AgentPersona[], tickConfig, onChain? })
 * and deploys everything that scenario needs to run live on Solana:
 *
 *   - Token mint (parameterized totalSupply, allocations) via the token_mint program
 *   - Mock UST mint
 *   - AMM pool (LUNA/UST) seeded with the configured initialLiquidity at initialPrice
 *   - Optional staking pool (when --with-staking is passed AND staking config is non-trivial)
 *   - Optional governance (when --with-governance is passed AND a staking pool was deployed)
 *   - Per-agent keypair + ATA + funding (LUNA + UST per persona's initialCapital)
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
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { BN } from "@anchor-lang/core";
import {
  createMint,
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
  /** Funding SOL per agent. Default 5; for devnet you may want less. */
  solPerAgent: number;
  /** Where to write the deployment manifest. */
  outputPath: string;
}

function parseArgs(argv: string[]): Args {
  let scenarioPath = "";
  let simId: string | null = null;
  let withStaking = false;
  let withGovernance = false;
  let solPerAgent = 5;
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { config, agents } = loadScenario(args.scenarioPath);
  const decimals = config.token.decimals ?? 6;
  const SCALE = 10 ** decimals;
  const toAtoms = (a: number) => new BN(Math.floor(a * SCALE));

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

  // ─── 1. LUNA mint via token_mint program ───────────────────────────────
  const tokenMint = getTokenMintProgram(provider);
  console.log("[deploy] init LUNA mint…");
  const lunaMintKp = Keypair.generate();
  const lunaMint = lunaMintKp.publicKey;
  const [mintAuthority] = deriveMintAuthority(lunaMint);
  const [tokenomicsConfig] = deriveTokenomicsConfig(lunaMint);

  await tokenMint.methods
    .initializeMint(decimals)
    .accounts({
      authority: payer.publicKey,
      mint: lunaMint,
      mintAuthority,
      config: tokenomicsConfig,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .signers([lunaMintKp])
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

  // ─── 3. Mint deployer's LUNA pool seed ─────────────────────────────────
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
  const deployerLunaAta = await getOrCreateAssociatedTokenAccount(
    provider.connection, payer, lunaMint, payer.publicKey,
  );

  const agentTokenSum = agents.reduce((s, a) => s + a.initialCapital.token, 0);
  const lunaToMintUi = config.amm.initialLiquidity + agentTokenSum;
  // Defensive: don't mint more than the seed allocation has room for.
  const seedAllocCapUi = (config.token.totalSupply * seedAlloc.percentBps) / 10_000;
  if (lunaToMintUi > seedAllocCapUi) {
    throw new Error(
      `[deploy] liquid seed allocation '${seedAlloc.displayName}' (${seedAlloc.percentBps} bps = ${seedAllocCapUi} tokens) ` +
        `cannot fund pool ${config.amm.initialLiquidity} + agents ${agentTokenSum} = ${lunaToMintUi}. ` +
        `Increase the liquid bucket or reduce agent initialCapital totals.`,
    );
  }
  await tokenMint.methods
    .distributeAllocation(toAtoms(lunaToMintUi))
    .accounts({
      authority: payer.publicKey,
      config: tokenomicsConfig,
      mint: lunaMint,
      mintAuthority,
      allocation: seedAllocPda,
      recipientAta: deployerLunaAta.address,
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

  const vestingEntries: VestingEntry[] = [];
  for (const alloc of allocInputs) {
    if (alloc.vestingTicks === 0) continue;
    const allocCapUi = (config.token.totalSupply * alloc.percentBps) / 10_000;
    if (allocCapUi <= 0) continue;

    const beneficiaryPath = join(vestingDir, `_vesting_${alloc.displayName.replace(/\s+/g, "_")}.json`);
    const { keypair: beneficiaryKp } = loadOrCreateKeypair(beneficiaryPath);
    const beneficiaryAta = await getOrCreateAssociatedTokenAccount(
      provider.connection, payer, lunaMint, beneficiaryKp.publicKey,
    );
    const [allocPda] = deriveAllocation(tokenomicsConfig, alloc.name);
    const [vestingPda] = deriveVesting(tokenomicsConfig, beneficiaryKp.publicKey);

    await tokenMint.methods
      .createVesting(toAtoms(allocCapUi), new BN(0))
      .accounts({
        authority: payer.publicKey,
        config: tokenomicsConfig,
        mint: lunaMint,
        allocation: allocPda,
        beneficiary: beneficiaryKp.publicKey,
        vesting: vestingPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    vestingEntries.push({
      allocationName: alloc.displayName,
      vesting: vestingPda.toBase58(),
      beneficiary: beneficiaryKp.publicKey.toBase58(),
      beneficiaryKeypairPath: beneficiaryPath,
      beneficiaryAta: beneficiaryAta.address.toBase58(),
      totalAmount: allocCapUi,
      startTick: 0,
      cliffTicks: alloc.cliffTicks,
      vestingTicks: alloc.vestingTicks,
    });
    console.log(
      `[deploy] vesting created for ${alloc.displayName}: ${allocCapUi} tokens, ` +
        `cliff ${alloc.cliffTicks}t, total ${alloc.vestingTicks}t`,
    );
  }

  // ─── 4. Mock UST mint ─────────────────────────────────────────────────
  console.log("[deploy] create UST mint…");
  const ustMint = await createMint(provider.connection, payer, payer.publicKey, null, decimals);
  const deployerUstAta = await getOrCreateAssociatedTokenAccount(
    provider.connection, payer, ustMint, payer.publicKey,
  );
  const agentUsdcSum = agents.reduce((s, a) => s + a.initialCapital.usdc, 0);
  const ustToMintUi = config.amm.initialLiquidity * config.amm.initialPrice + agentUsdcSum;
  await mintTo(
    provider.connection, payer, ustMint, deployerUstAta.address, payer,
    BigInt(Math.floor(ustToMintUi * SCALE)),
  );

  // ─── 5. AMM pool ──────────────────────────────────────────────────────
  console.log("[deploy] init AMM pool…");
  const ammDex = getAmmDexProgram(provider);
  const [pool] = derivePool(lunaMint, ustMint);
  const [poolAuthority] = derivePoolAuthority(pool);
  const [vaultA] = deriveVaultA(pool);
  const [vaultB] = deriveVaultB(pool);
  const lpMintKp = Keypair.generate();
  const feeBps = Math.round(config.amm.feeTier * 100);

  await ammDex.methods
    .initializePool(feeBps, 0)
    .accounts({
      authority: payer.publicKey,
      tokenAMint: lunaMint,
      tokenBMint: ustMint,
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
    .addLiquidity(toAtoms(config.amm.initialLiquidity), toAtoms(config.amm.initialLiquidity * config.amm.initialPrice), new BN(0))
    .accounts({
      provider: payer.publicKey,
      pool,
      poolAuthority,
      tokenAVault: vaultA,
      tokenBVault: vaultB,
      lpMint: lpMintKp.publicKey,
      providerTokenA: deployerLunaAta.address,
      providerTokenB: deployerUstAta.address,
      providerLp: deployerLpAta.address,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  // ─── 6. Optional staking pool ──────────────────────────────────────────
  let stakingDeployment: Deployment["staking"] = undefined;
  if (args.withStaking) {
    console.log("[deploy] init staking pool…");
    const staking = getStakingProgram(provider);
    const [stakingPool] = deriveStakingPool(lunaMint);
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
        stakeMint: lunaMint,
        pool: stakingPool,
        poolAuthority: stakingPoolAuthority,
        stakeVault,
        rewardVault,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    // Seed the reward vault from the deployer's LUNA ATA so claim_rewards has
    // something to pay out.
    const rewardSeedUi = Math.min(
      lunaToMintUi * 0.05,                  // ≤ 5% of pool seed
      Math.max(1_000_000, agentTokenSum * 0.10), // or ≥ 10% of agents' bag
    );
    await transfer(
      provider.connection, payer, deployerLunaAta.address, rewardVault, payer,
      BigInt(Math.floor(rewardSeedUi * SCALE)),
    );
    stakingDeployment = {
      program: STAKING_PROGRAM_ID.toBase58(),
      pool: stakingPool.toBase58(),
      poolAuthority: stakingPoolAuthority.toBase58(),
      stakeVault: stakeVault.toBase58(),
      rewardVault: rewardVault.toBase58(),
      stakeMint: lunaMint.toBase58(),
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
        config.token.totalSupply * (config.governance.proposalThresholdPercent / 100),
      );
      const quorumAtoms = toAtoms(
        config.token.totalSupply * (config.governance.quorumPercent / 100),
      );
      await gov.methods
        .initializeGovernance(
          proposalThresholdAtoms,
          quorumAtoms,
          config.governance.votingPeriodTicks,
          config.governance.timelockTicks,
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
  const keysDir = args.simId ? join(LOCAL_DIR, "runs", args.simId, "keys") : KEYS_DIR;
  if (!existsSync(keysDir)) mkdirSync(keysDir, { recursive: true });

  console.log(`[deploy] funding ${agents.length} agents…`);
  const entries: AgentWalletEntry[] = [];
  for (const persona of agents) {
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
    const lunaAta = await getOrCreateAssociatedTokenAccount(provider.connection, payer, lunaMint, keypair.publicKey);
    const ustAta = await getOrCreateAssociatedTokenAccount(provider.connection, payer, ustMint, keypair.publicKey);
    const lunaAtoms = BigInt(Math.floor(persona.initialCapital.token * SCALE));
    if (lunaAtoms > 0n) {
      await transfer(provider.connection, payer, deployerLunaAta.address, lunaAta.address, payer, lunaAtoms);
    }
    const ustAtoms = BigInt(Math.floor(persona.initialCapital.usdc * SCALE));
    if (ustAtoms > 0n) {
      await mintTo(provider.connection, payer, ustMint, ustAta.address, payer, ustAtoms);
    }
    entries.push({
      agentId: persona.id,
      pubkey: keypair.publicKey.toBase58(),
      keypairPath,
      lunaAta: lunaAta.address.toBase58(),
      ustAta: ustAta.address.toBase58(),
    });
  }

  // ─── 9. Write deployment manifest ──────────────────────────────────────
  const deployment: Deployment = {
    cluster: provider.connection.rpcEndpoint,
    programs: {
      tokenMint: TOKEN_MINT_PROGRAM_ID.toBase58(),
      ammDex: AMM_DEX_PROGRAM_ID.toBase58(),
      ...(args.withStaking ? { staking: STAKING_PROGRAM_ID.toBase58() } : {}),
      ...(args.withGovernance ? { governance: GOVERNANCE_PROGRAM_ID.toBase58() } : {}),
    },
    mints: { luna: lunaMint.toBase58(), ust: ustMint.toBase58() },
    pool: {
      address: pool.toBase58(),
      authority: poolAuthority.toBase58(),
      vaultA: vaultA.toBase58(),
      vaultB: vaultB.toBase58(),
      lpMint: lpMintKp.publicKey.toBase58(),
      aIsLuna: true,
    },
    config: { address: tokenomicsConfig.toBase58() },
    vesting: vestingEntries.length > 0 ? vestingEntries : undefined,
    staking: stakingDeployment,
    ...(args.withGovernance ? {
      governance: {
        program: GOVERNANCE_PROGRAM_ID.toBase58(),
        governance: deriveGovernance(deriveStakingPool(lunaMint)[0])[0].toBase58(),
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
