import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { AnchorProvider, Wallet } from "@anchor-lang/core";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_RPC = "http://127.0.0.1:8899";
const DEFAULT_WALLET = join(homedir(), ".config/solana/id.json");

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

export const TOKEN_MINT_PROGRAM_ID = new PublicKey(
  "8hFR2Zw5tmX9ysKBPwGkhF9VxaV7pj24TDu6im7jPBXj",
);
export const AMM_DEX_PROGRAM_ID = new PublicKey(
  "Dz3ZGCtmpqrxLs3GaKxc12wJGT7qNZNebdd6pzU5JnFx",
);
export const STAKING_PROGRAM_ID = new PublicKey(
  "2ecsTtNNuZUDSs19BfUx2yZ4n3WHTKKR2XfDWz6PAmdY",
);
export const GOVERNANCE_PROGRAM_ID = new PublicKey(
  "Hk4eHkcr5njyntu4WEQuafVKkaK4LQJ8dTH5fqAArHFD",
);
