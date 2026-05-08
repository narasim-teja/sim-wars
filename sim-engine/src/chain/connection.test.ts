import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProgramIds } from "./connection";

const LOCALNET_TOKEN_MINT = "8hFR2Zw5tmX9ysKBPwGkhF9VxaV7pj24TDu6im7jPBXj";

describe("resolveProgramIds", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "simwars-conn-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns localnet ids when SOLANA_NETWORK is unset (default)", () => {
    const ids = resolveProgramIds({});
    expect(ids.tokenMint).toBe(LOCALNET_TOKEN_MINT);
  });

  it('returns localnet ids when SOLANA_NETWORK="localnet"', () => {
    const ids = resolveProgramIds({ SOLANA_NETWORK: "localnet" });
    expect(ids.tokenMint).toBe(LOCALNET_TOKEN_MINT);
  });

  it("rejects unknown networks", () => {
    expect(() => resolveProgramIds({ SOLANA_NETWORK: "mainnet" })).toThrow(
      /not supported/i,
    );
  });

  it("throws a helpful error when devnet config is missing", () => {
    expect(() =>
      resolveProgramIds({
        SOLANA_NETWORK: "devnet",
        DEVNET_PROGRAMS_PATH: join(tmpDir, "missing.json"),
      }),
    ).toThrow(/no program-ID config found/i);
  });

  it("throws when devnet config still has REPLACE_ME placeholders", () => {
    const cfgPath = join(tmpDir, "programs.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        cluster: "devnet",
        programs: {
          tokenMint: "REPLACE_ME",
          ammDex: "REPLACE_ME",
          staking: "REPLACE_ME",
          governance: "REPLACE_ME",
        },
      }),
    );
    expect(() =>
      resolveProgramIds({
        SOLANA_NETWORK: "devnet",
        DEVNET_PROGRAMS_PATH: cfgPath,
      }),
    ).toThrow(/REPLACE_ME/);
  });

  it("loads valid devnet program ids from the config file", () => {
    const cfgPath = join(tmpDir, "programs.json");
    // Use the canonical localnet ids — they're real base58 pubkeys, so any
    // downstream `new PublicKey(…)` cast (not exercised here) would also
    // succeed. The point of the test is the resolver path, not the validity
    // of arbitrary devnet ids.
    const ids = {
      tokenMint: LOCALNET_TOKEN_MINT,
      ammDex: "Dz3ZGCtmpqrxLs3GaKxc12wJGT7qNZNebdd6pzU5JnFx",
      staking: "2ecsTtNNuZUDSs19BfUx2yZ4n3WHTKKR2XfDWz6PAmdY",
      governance: "Hk4eHkcr5njyntu4WEQuafVKkaK4LQJ8dTH5fqAArHFD",
    };
    writeFileSync(cfgPath, JSON.stringify({ cluster: "devnet", programs: ids }));
    const resolved = resolveProgramIds({
      SOLANA_NETWORK: "devnet",
      DEVNET_PROGRAMS_PATH: cfgPath,
    });
    expect(resolved).toEqual(ids);
  });
});
