import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { AnchorProvider, Wallet } from "@anchor-lang/core";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_RPC = "http://127.0.0.1:8899";
const DEFAULT_WALLET = join(homedir(), ".config/solana/id.json");
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Expand a leading `~/` to the user's home directory. Solana CLI configs
 * often store wallet paths with literal tildes; `fs.readFileSync` does not
 * expand them and silently ENOENTs.
 */
function expandTilde(p: string): string {
  if (p.startsWith("~/") || p === "~") return join(homedir(), p.slice(1));
  return p;
}

export function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(expandTilde(path), "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

/**
 * Resolve the RPC endpoint. Order of precedence:
 *   1. ANCHOR_PROVIDER_URL (explicit override; Anchor convention)
 *   2. HELIUS_API_KEY      (auto-builds Helius mainnet URL when set without #1)
 *   3. localhost           (solana-test-validator default)
 *
 * Helius support is the parallel-deploy enabler: localnet caps you at
 * single-validator throughput, devnet throttles, but Helius takes the
 * `Promise.all` parallelism we just added and actually serves it.
 */
export function resolveRpcUrl(): string {
  const explicit = process.env.ANCHOR_PROVIDER_URL;
  if (explicit && explicit.length > 0) return explicit;
  const helius = process.env.HELIUS_API_KEY;
  if (helius && helius.length > 0) {
    const cluster = process.env.HELIUS_CLUSTER ?? "mainnet";
    return `https://${cluster}.helius-rpc.com/?api-key=${helius}`;
  }
  return DEFAULT_RPC;
}

export function getConnection(): Connection {
  return new Connection(resolveRpcUrl(), "confirmed");
}

export function getProvider(): AnchorProvider {
  const connection = getConnection();
  const walletPath = process.env.ANCHOR_WALLET ?? DEFAULT_WALLET;
  const wallet = new Wallet(loadKeypair(walletPath));
  return new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Program IDs — cluster-aware
//
// Localnet IDs are baked-in (they match `declare_id!()` in programs/*/src/lib.rs
// and `[programs.localnet]` in Anchor.toml). Devnet IDs come from a JSON config
// file produced by `infra/onchain/deploy-devnet.sh` after running
// `anchor deploy --provider.cluster devnet` for each program. The container
// ships that file at /app/infra/onchain/devnet-programs.json (overrideable via
// `DEVNET_PROGRAMS_PATH`).
//
// Resolution happens at module load. Tests don't set SOLANA_NETWORK, so they
// keep getting localnet IDs and existing assertions pass unchanged.
// ────────────────────────────────────────────────────────────────────────────

interface ProgramIds {
  tokenMint: string;
  ammDex: string;
  staking: string;
  governance: string;
}

const LOCALNET_PROGRAM_IDS: ProgramIds = {
  tokenMint: "8hFR2Zw5tmX9ysKBPwGkhF9VxaV7pj24TDu6im7jPBXj",
  ammDex: "Dz3ZGCtmpqrxLs3GaKxc12wJGT7qNZNebdd6pzU5JnFx",
  staking: "2ecsTtNNuZUDSs19BfUx2yZ4n3WHTKKR2XfDWz6PAmdY",
  governance: "Hk4eHkcr5njyntu4WEQuafVKkaK4LQJ8dTH5fqAArHFD",
};

const PLACEHOLDER_TOKEN = "REPLACE_ME";

function defaultDevnetProgramsPath(): string {
  // Repo layout: sim-engine/src/chain/connection.ts → ../../../infra/onchain/...
  // Container: file is copied to /app/infra/onchain/devnet-programs.json and
  // the env var `DEVNET_PROGRAMS_PATH` overrides this.
  return resolve(__dirname, "../../../infra/onchain/devnet-programs.json");
}

export function resolveProgramIds(env: NodeJS.ProcessEnv = process.env): ProgramIds {
  const network = (env.SOLANA_NETWORK ?? "localnet").toLowerCase();
  if (network === "localnet") return LOCALNET_PROGRAM_IDS;
  if (network !== "devnet") {
    throw new Error(
      `SOLANA_NETWORK="${network}" is not supported. Use "localnet" (default) or "devnet".`,
    );
  }
  const cfgPath = env.DEVNET_PROGRAMS_PATH ?? defaultDevnetProgramsPath();
  if (!existsSync(cfgPath)) {
    throw new Error(
      `SOLANA_NETWORK=devnet but no program-ID config found at ${cfgPath}. ` +
        `Run infra/onchain/deploy-devnet.sh once to deploy programs and populate this file.`,
    );
  }
  const raw = readFileSync(cfgPath, "utf8");
  const cfg = JSON.parse(raw) as { cluster?: string; programs?: Partial<ProgramIds> };
  const p = cfg.programs ?? {};
  const ids: ProgramIds = {
    tokenMint: p.tokenMint ?? "",
    ammDex: p.ammDex ?? "",
    staking: p.staking ?? "",
    governance: p.governance ?? "",
  };
  for (const [name, value] of Object.entries(ids)) {
    if (!value || value === PLACEHOLDER_TOKEN) {
      throw new Error(
        `${cfgPath}: programs.${name} is missing or still set to "${PLACEHOLDER_TOKEN}". ` +
          `Run infra/onchain/deploy-devnet.sh to populate it.`,
      );
    }
  }
  return ids;
}

const RESOLVED_PROGRAM_IDS = resolveProgramIds();

export const TOKEN_MINT_PROGRAM_ID = new PublicKey(RESOLVED_PROGRAM_IDS.tokenMint);
export const AMM_DEX_PROGRAM_ID = new PublicKey(RESOLVED_PROGRAM_IDS.ammDex);
export const STAKING_PROGRAM_ID = new PublicKey(RESOLVED_PROGRAM_IDS.staking);
export const GOVERNANCE_PROGRAM_ID = new PublicKey(RESOLVED_PROGRAM_IDS.governance);
