/**
 * Deploys initial on-chain state for a scenario:
 *   - LUNA mint (via token_mint program PDA mint authority)
 *   - Mock UST mint (plain SPL, deployer is mint authority)
 *   - Tokenomics config + allocation buckets
 *   - AMM pool (LUNA/UST) seeded with initial liquidity at the scenario's initialPrice
 *   - Writes sim-engine/deployment.json manifest
 *
 * Prereqs:
 *   - solana-test-validator running (or ANCHOR_PROVIDER_URL set)
 *   - Programs deployed via `anchor deploy`
 *   - IDLs present at target/idl/{token_mint,amm_dex}.json
 *     (build with: RUSTFLAGS='--cfg procmacro2_semver_exempt' anchor build)
 *
 * Run from repo root:
 *   cd sim-engine && bun run ../scripts/deploy-programs.ts
 */
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { BN } from "@anchor-lang/core";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { writeFileSync } from "node:fs";
import {
  getProvider,
  TOKEN_MINT_PROGRAM_ID,
  AMM_DEX_PROGRAM_ID,
} from "../src/chain/connection";
import {
  getTokenMintProgram,
  getAmmDexProgram,
  deriveMintAuthority,
  deriveTokenomicsConfig,
  deriveAllocation,
  derivePool,
  derivePoolAuthority,
  deriveVaultA,
  deriveVaultB,
  nameToBytes,
  deploymentPath,
  type Deployment,
} from "../src/chain/sdk";
import scenario from "../scenarios/luna-ust";

const DECIMALS = 6;
const SCALE = 10 ** DECIMALS;

function toAtoms(amount: number): BN {
  return new BN(Math.floor(amount * SCALE));
}

async function main() {
  const provider = getProvider();
  const payer = (provider.wallet as any).payer as Keypair;
  console.log(`Deployer: ${payer.publicKey.toBase58()}`);
  console.log(`RPC: ${provider.connection.rpcEndpoint}`);

  const balance = await provider.connection.getBalance(payer.publicKey);
  console.log(`Deployer SOL: ${balance / 1e9}\n`);
  if (balance < 0.5 * 1e9) {
    throw new Error("Deployer needs at least 0.5 SOL. Run: solana airdrop 100");
  }

  const tokenMint = getTokenMintProgram(provider);
  const ammDex = getAmmDexProgram(provider);
  const cfg = scenario.config;

  // --- 1. Create LUNA mint (init via token_mint program) ---
  console.log("→ Initializing LUNA mint...");
  const lunaMintKeypair = Keypair.generate();
  const lunaMint = lunaMintKeypair.publicKey;
  const [mintAuthority] = deriveMintAuthority(lunaMint);
  const [tokenomicsConfig] = deriveTokenomicsConfig(lunaMint);

  await tokenMint.methods
    .initializeMint(DECIMALS)
    .accounts({
      authority: payer.publicKey,
      mint: lunaMint,
      mintAuthority,
      config: tokenomicsConfig,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .signers([lunaMintKeypair])
    .rpc();
  console.log(`  LUNA mint: ${lunaMint.toBase58()}`);
  console.log(`  Config: ${tokenomicsConfig.toBase58()}`);

  // --- 2. Configure tokenomics + allocations ---
  console.log("→ Configuring tokenomics...");
  const totalSupplyAtoms = toAtoms(cfg.token.totalSupply);
  const allocInputs = cfg.token.allocations.map((a) => ({
    name: nameToBytes(a.name),
    percentBps: Math.round(a.percent * 100),
    vestingTicks: a.vestingMonths === 0 ? 0 : a.vestingMonths * 30, // ~1 tick = 1 day
    cliffTicks: 0,
  }));
  const totalBps = allocInputs.reduce((s, a) => s + a.percentBps, 0);
  if (totalBps !== 10_000) {
    throw new Error(`Allocations sum to ${totalBps} bps, must be 10000`);
  }

  await tokenMint.methods
    .configureTokenomics(totalSupplyAtoms, allocInputs as any)
    .accounts({
      authority: payer.publicKey,
      config: tokenomicsConfig,
    })
    .rpc();

  for (const alloc of allocInputs) {
    const [allocPda] = deriveAllocation(tokenomicsConfig, alloc.name);
    await tokenMint.methods
      .createAllocation(
        Array.from(alloc.name),
        alloc.percentBps,
        alloc.vestingTicks,
        alloc.cliffTicks,
      )
      .accounts({
        authority: payer.publicKey,
        config: tokenomicsConfig,
        allocation: allocPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(
      `  Allocation: ${alloc.name.toString("utf8").replace(/\0+$/, "")} (${alloc.percentBps} bps)`,
    );
  }

  // --- 3. Mint deployer's LUNA bag from "Ecosystem" allocation for liquidity seeding ---
  console.log("→ Distributing LUNA to deployer for pool seeding...");
  const ecosystem = allocInputs.find((a) =>
    a.name.toString("utf8").startsWith("Ecosystem"),
  );
  if (!ecosystem) throw new Error("Ecosystem allocation not found");
  const [ecosystemPda] = deriveAllocation(tokenomicsConfig, ecosystem.name);

  const deployerLunaAta = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    payer,
    lunaMint,
    payer.publicKey,
  );

  // Seed deployer with enough LUNA for: pool liquidity + agent funding (rough estimate)
  // Pool needs initialLiquidity LUNA; agents need sum of initialCapital.token across personas.
  const agentTokenSum = scenario.agents.reduce(
    (s, a) => s + a.initialCapital.token,
    0,
  );
  const lunaToMint = toAtoms(cfg.amm.initialLiquidity + agentTokenSum);
  await tokenMint.methods
    .distributeAllocation(lunaToMint)
    .accounts({
      authority: payer.publicKey,
      config: tokenomicsConfig,
      mint: lunaMint,
      mintAuthority,
      allocation: ecosystemPda,
      recipientAta: deployerLunaAta.address,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  console.log(`  Minted ${(cfg.amm.initialLiquidity + agentTokenSum).toLocaleString()} LUNA to deployer`);

  // --- 4. Create mock UST mint (plain SPL, deployer = mint authority) ---
  console.log("→ Creating mock UST mint...");
  const ustMint = await createMint(
    provider.connection,
    payer,
    payer.publicKey,
    null,
    DECIMALS,
  );
  console.log(`  UST mint: ${ustMint.toBase58()}`);

  const deployerUstAta = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    payer,
    ustMint,
    payer.publicKey,
  );

  const agentUsdcSum = scenario.agents.reduce(
    (s, a) => s + a.initialCapital.usdc,
    0,
  );
  const ustToMint = cfg.amm.initialLiquidity * cfg.amm.initialPrice + agentUsdcSum;
  await mintTo(
    provider.connection,
    payer,
    ustMint,
    deployerUstAta.address,
    payer,
    BigInt(Math.floor(ustToMint * SCALE)),
  );
  console.log(`  Minted ${ustToMint.toLocaleString()} UST to deployer`);

  // --- 5. Initialize AMM pool ---
  console.log("→ Initializing AMM pool...");
  // Pool seeds require canonical mint ordering by program — match programs/amm-dex/src/lib.rs
  // which uses [b"pool", token_a_mint, token_b_mint] in that order.
  // We pick: tokenA = LUNA, tokenB = UST (matches scenario semantics).
  const tokenAMint = lunaMint;
  const tokenBMint = ustMint;
  const aIsLuna = true;

  const [pool] = derivePool(tokenAMint, tokenBMint);
  const [poolAuthority] = derivePoolAuthority(pool);
  const [vaultA] = deriveVaultA(pool);
  const [vaultB] = deriveVaultB(pool);
  const lpMintKeypair = Keypair.generate();

  const feeBps = Math.round(cfg.amm.feeTier * 100); // 0.3% → 30 bps
  await ammDex.methods
    .initializePool(feeBps, 0)
    .accounts({
      authority: payer.publicKey,
      tokenAMint,
      tokenBMint,
      pool,
      poolAuthority,
      tokenAVault: vaultA,
      tokenBVault: vaultB,
      lpMint: lpMintKeypair.publicKey,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .signers([lpMintKeypair])
    .rpc();
  console.log(`  Pool: ${pool.toBase58()}`);

  // --- 6. Add initial liquidity ---
  console.log("→ Adding initial liquidity...");
  const deployerLpAta = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    payer,
    lpMintKeypair.publicKey,
    payer.publicKey,
  );
  const liquidityA = toAtoms(cfg.amm.initialLiquidity);
  const liquidityB = toAtoms(cfg.amm.initialLiquidity * cfg.amm.initialPrice);
  await ammDex.methods
    .addLiquidity(liquidityA, liquidityB, new BN(0))
    .accounts({
      provider: payer.publicKey,
      pool,
      poolAuthority,
      tokenAVault: vaultA,
      tokenBVault: vaultB,
      lpMint: lpMintKeypair.publicKey,
      providerTokenA: deployerLunaAta.address,
      providerTokenB: deployerUstAta.address,
      providerLp: deployerLpAta.address,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  console.log(
    `  Seeded ${cfg.amm.initialLiquidity.toLocaleString()} LUNA + ${(cfg.amm.initialLiquidity * cfg.amm.initialPrice).toLocaleString()} UST`,
  );

  // --- 7. Write deployment manifest ---
  const deployment: Deployment = {
    cluster: provider.connection.rpcEndpoint,
    programs: {
      tokenMint: TOKEN_MINT_PROGRAM_ID.toBase58(),
      ammDex: AMM_DEX_PROGRAM_ID.toBase58(),
    },
    mints: {
      luna: lunaMint.toBase58(),
      ust: ustMint.toBase58(),
    },
    pool: {
      address: pool.toBase58(),
      authority: poolAuthority.toBase58(),
      vaultA: vaultA.toBase58(),
      vaultB: vaultB.toBase58(),
      lpMint: lpMintKeypair.publicKey.toBase58(),
      aIsLuna,
    },
    config: {
      address: tokenomicsConfig.toBase58(),
    },
    agents: [], // populated by fund-agents.ts
    decimals: DECIMALS,
  };
  writeFileSync(deploymentPath(), JSON.stringify(deployment, null, 2));
  console.log(`\n✓ Wrote ${deploymentPath()}`);
  console.log("Next: bun run ../scripts/fund-agents.ts");
}

main().catch((err) => {
  console.error("Deploy failed:", err);
  process.exit(1);
});
