# Anchor 0.30.1 → 1.0.0 Migration Plan

## Why

Anchor 0.30.1 ships against Solana 1.18.x and old proc-macro2/zeroize. This machine has Solana CLI 3.1.13 + Rust 1.94, and we want LiteSVM tests (which need modern deps). Every workaround so far (`--no-idl`, proc-macro2 patch) is a band-aid; the patches now collide with newer cargo. Migrating to Anchor 1.0 (released 2026-04-02, matches our installed AVM) removes all of them at once and unlocks the real Rust test harness we deferred.

This work is a **prerequisite to the security-hardening verification step**. The constraint/arithmetic fixes in `programs/{token-mint,amm-dex}/src/lib.rs` already use Anchor syntax that's unchanged in 1.0 — they survive the migration. CPI call sites do not.

## Verified breaking changes (from anchor v1.0.0 source + release notes)

1. **`CpiContext::new` / `new_with_signer`** — first arg changed from `AccountInfo` to `Pubkey`. Every call site needs rewriting. **12 call sites total** (4 in token-mint, 8 in amm-dex). Pattern:
   ```rust
   // before
   CpiContext::new(ctx.accounts.token_program.to_account_info(), Transfer { … })
   // after
   CpiContext::new(ctx.accounts.token_program.key(), Transfer { … })
   ```
2. **TS package rename** — `@coral-xyz/anchor` → `@anchor-lang/core@1.0.0`. Affects [sim-engine/package.json](sim-engine/package.json), [sim-engine/src/chain/connection.ts](sim-engine/src/chain/connection.ts), [sim-engine/src/chain/sdk.ts](sim-engine/src/chain/sdk.ts), [sim-engine/src/chain/action-executor.ts](sim-engine/src/chain/action-executor.ts), [sim-engine/scripts/deploy-programs.ts](sim-engine/scripts/deploy-programs.ts), [sim-engine/scripts/fund-agents.ts](sim-engine/scripts/fund-agents.ts).
3. **Single `#[error_code]` per program** — already true for both programs, no work.
4. **Duplicate-mut-account ban** — needs `dup` constraint. We don't intentionally alias mut accounts; the swap same-account guard we just added makes this explicit. No work expected.
5. **`anchor build` works on stable Rust** — drop `--no-idl` flag and remove proc-macro2 references in the memory note.
6. **`Anchor.toml`** — `[registry]` section removed, `anchor_version = "1.0.0"`.

## Verified non-changes (no rewrite needed)

- `#[derive(Accounts)]`, all `#[account(...)]` constraints (`mut`, `seeds`, `bump`, `has_one`, `mint = …`, `constraint = … @ Err`, `init`, `payer`, `space`, `address = …`, `token::mint`, `token::authority`, `mint::decimals`, `mint::authority`) — syntax unchanged. **All my new mint/auth constraints carry over.**
- `ctx.bumps.field_name` — unchanged.
- `require!`, `require_keys_eq!`, `Result<()>`, `#[error_code]` enum syntax — unchanged.
- `anchor_spl::token::{Transfer, MintTo, Burn}` — still present; `token_interface` migration remains optional.

## Migration steps (execution order)

### 1. Toolchain
```
avm install 1.0.0 && avm use 1.0.0
```
Update [Anchor.toml](Anchor.toml):
- `anchor_version = "1.0.0"`
- delete `[registry]` section

### 2. Workspace Cargo.toml
- Remove the `[patch.crates-io]` block (already removed; confirm).
- No other workspace-level changes needed.

### 3. Per-program Cargo.toml
Both [programs/token-mint/Cargo.toml](programs/token-mint/Cargo.toml) and [programs/amm-dex/Cargo.toml](programs/amm-dex/Cargo.toml):
```toml
anchor-lang = "1.0.0"
anchor-spl  = "1.0.0"
```
Keep the `idl-build` feature line as-is.

### 4. Rewrite all CpiContext call sites
12 total. Mechanical replacement:
- `ctx.accounts.token_program.to_account_info()` → `ctx.accounts.token_program.key()` *only* when used as the first arg to `CpiContext::new` / `new_with_signer`. Other uses of `to_account_info()` (inside `Transfer { from, to, authority }`) stay the same.

Files: [programs/token-mint/src/lib.rs](programs/token-mint/src/lib.rs#L107), [programs/amm-dex/src/lib.rs](programs/amm-dex/src/lib.rs#L77).

### 5. TypeScript client
- [sim-engine/package.json](sim-engine/package.json): replace `"@coral-xyz/anchor": "^0.30.1"` with `"@anchor-lang/core": "^1.0.0"`. Run `bun install`.
- Bulk-rename imports in [sim-engine/src/chain/](sim-engine/src/chain/) and [sim-engine/scripts/](sim-engine/scripts/): `from "@coral-xyz/anchor"` → `from "@anchor-lang/core"`.
- `Program` constructor: `new Program(idl, provider)` still works; consider explicit `Program<MyIdl>(IDL, provider)` once IDLs regenerate (optional).
- `.accounts({…})` calls: keep as-is; if anchor 1.0 strict typing fails on any call, switch the failing one to `.accountsPartial({…})`.

### 6. IDL build
After step 4, run `anchor build` (no `--no-idl`, no `RUSTFLAGS`). Verify `target/idl/{token_mint,amm_dex}.json` appear. The TS chain stack will now load.

### 7. Re-verify the security hardening compiled correctly
The mint/auth constraints in `MintFromBurn`, `AddLiquidity`, `RemoveLiquidity`, `Swap` plus the `checked_*` arithmetic must still compile and behave the same. A clean `anchor build` is the proof.

### 8. Now write the LiteSVM tests
With Anchor 1.0 + solana-program 3.0, `litesvm 0.11` + `anchor-litesvm 0.4` (which needs Anchor 1.0) work without dep conflicts. Re-create [program-tests/](program-tests/) and the suite per [.claude/plans/fuzzy-napping-cloud.md §5](.claude/plans/fuzzy-napping-cloud.md).

### 9. Update memory
Edit `~/.claude/projects/-Users-narasim-Code-work-sim-wars/memory/anchor_build_workaround.md` — the workaround is no longer needed; either delete the memory or rewrite it as "historical, fixed by 1.0 migration on 2026-04-14."

## Verification

1. `anchor build` — no `--no-idl`, no `RUSTFLAGS`, no warnings beyond the unrelated `cfg(anchor-debug)` ones. IDLs land in `target/idl/`.
2. `cd sim-engine && bun install && bun run scripts/deploy-programs.ts` against a running `solana-test-validator` — exits without TypeScript or anchor-client errors.
3. `cargo test -p program-tests` — all negative-path + happy-path tests green.
4. End-to-end: run the existing agent script; price reads + swaps return successfully.

## Risk register

- **TS API surface beyond `Program.methods`**: If we use any `BN`, `web3`, or `Provider` re-exports from `@coral-xyz/anchor` that the new `@anchor-lang/core` doesn't re-export, those imports need their own resolution (likely `bn.js` and `@solana/web3.js` direct).
- **`.accountsPartial` not yet needed but might surface**: 1.0 strictness around resolution may reject some `.accounts({…})` calls that 0.30 accepted. Failing calls are easy to spot at runtime — switch them.
- **Solana CLI 3.1.13 vs target 3.1.10**: minor version mismatch, almost certainly fine.

## Deliverable scope

End state: code compiles + runs on Anchor 1.0, all security hardening intact and verified by the LiteSVM suite, ready for the localnet smoke test you originally asked about.
