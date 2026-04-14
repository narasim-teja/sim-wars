import { Program, AnchorProvider, Idl } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TOKEN_MINT_PROGRAM_ID, AMM_DEX_PROGRAM_ID } from "./connection";

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
      `IDL not found at ${path}. Run: RUSTFLAGS='--cfg procmacro2_semver_exempt' anchor build`,
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

export interface Deployment {
  cluster: string;
  programs: {
    tokenMint: string;
    ammDex: string;
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
