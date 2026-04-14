/**
 * Generates agent keypairs, funds them with SOL, creates ATAs, and seeds
 * each agent's starting LUNA + UST holdings per their persona config.
 *
 * Idempotent: if sim-engine/keys/<id>.json exists, the keypair is reused.
 *
 * Run after deploy-programs.ts:
 *   cd sim-engine && bun run ../scripts/fund-agents.ts
 */
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  transfer,
  mintTo,
} from "@solana/spl-token";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getProvider, loadKeypair } from "../src/chain/connection";
import { loadDeployment, deploymentPath, KEYS_DIR, type AgentWalletEntry } from "../src/chain/sdk";
import { LUNA_PERSONAS } from "../src/agents/personas";
const SOL_PER_AGENT = 5;

function loadOrCreateKeypair(path: string): { keypair: Keypair; created: boolean } {
  if (existsSync(path)) {
    return { keypair: loadKeypair(path), created: false };
  }
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
  return { keypair: kp, created: true };
}

async function main() {
  if (!existsSync(KEYS_DIR)) mkdirSync(KEYS_DIR, { recursive: true });

  const provider = getProvider();
  const payer = (provider.wallet as any).payer as Keypair;
  const deployment = loadDeployment();
  const lunaMint = new PublicKey(deployment.mints.luna);
  const ustMint = new PublicKey(deployment.mints.ust);
  const decimals = deployment.decimals;
  const scale = 10 ** decimals;

  console.log(`Deployer: ${payer.publicKey.toBase58()}`);
  console.log(`Funding ${LUNA_PERSONAS.length} agents...\n`);

  const entries: AgentWalletEntry[] = [];

  for (const persona of LUNA_PERSONAS) {
    const keypairPath = join(KEYS_DIR, `${persona.id}.json`);
    const { keypair, created } = loadOrCreateKeypair(keypairPath);
    console.log(`→ ${persona.id} (${created ? "new" : "reused"}): ${keypair.publicKey.toBase58()}`);

    // Fund SOL via airdrop (works on localnet/devnet)
    const balance = await provider.connection.getBalance(keypair.publicKey);
    if (balance < SOL_PER_AGENT * LAMPORTS_PER_SOL * 0.5) {
      const sig = await provider.connection.requestAirdrop(
        keypair.publicKey,
        SOL_PER_AGENT * LAMPORTS_PER_SOL,
      );
      await provider.connection.confirmTransaction(sig, "confirmed");
      console.log(`   airdropped ${SOL_PER_AGENT} SOL`);
    }

    // Create ATAs
    const lunaAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      lunaMint,
      keypair.publicKey,
    );
    const ustAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      ustMint,
      keypair.publicKey,
    );

    // Transfer LUNA from deployer ATA
    const deployerLunaAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      lunaMint,
      payer.publicKey,
    );
    const lunaAtoms = BigInt(Math.floor(persona.initialCapital.token * scale));
    if (lunaAtoms > 0n) {
      await transfer(
        provider.connection,
        payer,
        deployerLunaAta.address,
        lunaAta.address,
        payer,
        lunaAtoms,
      );
    }

    // Mint UST directly (deployer is mint authority)
    const ustAtoms = BigInt(Math.floor(persona.initialCapital.usdc * scale));
    if (ustAtoms > 0n) {
      await mintTo(
        provider.connection,
        payer,
        ustMint,
        ustAta.address,
        payer,
        ustAtoms,
      );
    }

    console.log(
      `   LUNA: ${persona.initialCapital.token.toLocaleString()} | UST: ${persona.initialCapital.usdc.toLocaleString()}`,
    );

    entries.push({
      agentId: persona.id,
      pubkey: keypair.publicKey.toBase58(),
      keypairPath,
      lunaAta: lunaAta.address.toBase58(),
      ustAta: ustAta.address.toBase58(),
    });
  }

  // Update manifest with agent entries
  const updated = { ...deployment, agents: entries };
  writeFileSync(deploymentPath(), JSON.stringify(updated, null, 2));
  console.log(`\n✓ Updated ${deploymentPath()} with ${entries.length} agents`);
}

main().catch((err) => {
  console.error("Fund failed:", err);
  process.exit(1);
});
