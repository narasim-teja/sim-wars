import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { AnchorProvider, Wallet } from "@anchor-lang/core";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_RPC = "http://127.0.0.1:8899";
const DEFAULT_WALLET = join(homedir(), ".config/solana/id.json");

export function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export function getConnection(): Connection {
  const url = process.env.ANCHOR_PROVIDER_URL ?? DEFAULT_RPC;
  return new Connection(url, "confirmed");
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
