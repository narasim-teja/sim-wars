//! Negative-path security tests for the amm-dex program.

mod common;

use common::*;
use anchor_lang::system_program;
use solana_program::sysvar::rent;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};

fn amm_pid() -> Pubkey {
    AMM_DEX_PROGRAM_ID.parse().unwrap()
}

fn pool_seeds(token_a: &Pubkey, token_b: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"pool", token_a.as_ref(), token_b.as_ref()], &amm_pid())
}

fn pool_authority_seeds(pool: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"pool_authority", pool.as_ref()], &amm_pid())
}

fn vault_a_seeds(pool: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"vault_a", pool.as_ref()], &amm_pid())
}

fn vault_b_seeds(pool: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"vault_b", pool.as_ref()], &amm_pid())
}

#[allow(dead_code)]
struct PoolFixture {
    authority: Keypair,
    token_a_mint: Pubkey,
    token_b_mint: Pubkey,
    pool: Pubkey,
    pool_authority: Pubkey,
    vault_a: Pubkey,
    vault_b: Pubkey,
    lp_mint: Keypair,
    provider_a: Pubkey,
    provider_b: Pubkey,
    provider_lp: Pubkey,
}

fn setup_pool(svm: &mut litesvm::LiteSVM) -> PoolFixture {
    let authority = new_funded_keypair(svm, 100_000_000_000);

    let m1 = create_mint(svm, &authority, 6);
    let m2 = create_mint(svm, &authority, 6);
    let (token_a_mint, token_b_mint) = if m1 < m2 { (m1, m2) } else { (m2, m1) };

    let (pool, _) = pool_seeds(&token_a_mint, &token_b_mint);
    let (pool_authority, _) = pool_authority_seeds(&pool);
    let (vault_a, _) = vault_a_seeds(&pool);
    let (vault_b, _) = vault_b_seeds(&pool);
    let lp_mint = Keypair::new();

    let init_ix = anchor_ix(
        amm_pid(),
        amm_dex::accounts::InitializePool {
            authority: authority.pubkey(),
            token_a_mint,
            token_b_mint,
            pool,
            pool_authority,
            token_a_vault: vault_a,
            token_b_vault: vault_b,
            lp_mint: lp_mint.pubkey(),
            system_program: system_program::ID,
            token_program: spl_token::ID,
            rent: rent::ID,
        },
        amm_dex::instruction::InitializePool {
            fee_bps: 30,
            protocol_fee_bps: 0,
        },
    );
    send_ix(svm, init_ix, &authority, &[&lp_mint]).expect("initialize_pool");

    let provider_a = create_ata(svm, &authority, &authority.pubkey(), &token_a_mint);
    let provider_b = create_ata(svm, &authority, &authority.pubkey(), &token_b_mint);
    let provider_lp = create_ata(svm, &authority, &authority.pubkey(), &lp_mint.pubkey());
    mint_to(svm, &authority, &token_a_mint, &provider_a, 1_000_000_000);
    mint_to(svm, &authority, &token_b_mint, &provider_b, 1_000_000_000);

    let add_ix = anchor_ix(
        amm_pid(),
        amm_dex::accounts::AddLiquidity {
            provider: authority.pubkey(),
            pool,
            pool_authority,
            token_a_vault: vault_a,
            token_b_vault: vault_b,
            lp_mint: lp_mint.pubkey(),
            provider_token_a: provider_a,
            provider_token_b: provider_b,
            provider_lp,
            token_program: spl_token::ID,
        },
        amm_dex::instruction::AddLiquidity {
            amount_a: 100_000_000,
            amount_b: 100_000_000,
            min_lp_tokens: 0,
        },
    );
    send_ix(svm, add_ix, &authority, &[]).expect("seed add_liquidity");

    PoolFixture {
        authority,
        token_a_mint,
        token_b_mint,
        pool,
        pool_authority,
        vault_a,
        vault_b,
        lp_mint,
        provider_a,
        provider_b,
        provider_lp,
    }
}

#[test]
fn add_liquidity_rejects_wrong_token_a_mint() {
    let mut svm = setup_svm();
    let f = setup_pool(&mut svm);

    let foreign = create_mint(&mut svm, &f.authority, 6);
    let foreign_ata = create_ata(&mut svm, &f.authority, &f.authority.pubkey(), &foreign);
    mint_to(&mut svm, &f.authority, &foreign, &foreign_ata, 10_000);

    let bad = anchor_ix(
        amm_pid(),
        amm_dex::accounts::AddLiquidity {
            provider: f.authority.pubkey(),
            pool: f.pool,
            pool_authority: f.pool_authority,
            token_a_vault: f.vault_a,
            token_b_vault: f.vault_b,
            lp_mint: f.lp_mint.pubkey(),
            provider_token_a: foreign_ata,
            provider_token_b: f.provider_b,
            provider_lp: f.provider_lp,
            token_program: spl_token::ID,
        },
        amm_dex::instruction::AddLiquidity {
            amount_a: 1_000,
            amount_b: 1_000,
            min_lp_tokens: 0,
        },
    );
    let err = send_ix(&mut svm, bad, &f.authority, &[]).expect_err("expect mint mismatch");
    let logs = format!("{:?}", err);
    assert!(
        logs.contains("MintMismatch"),
        "expected MintMismatch, got: {logs}"
    );
}

#[test]
fn swap_rejects_same_in_out_account() {
    let mut svm = setup_svm();
    let f = setup_pool(&mut svm);

    let bad = anchor_ix(
        amm_pid(),
        amm_dex::accounts::Swap {
            swapper: f.authority.pubkey(),
            pool: f.pool,
            pool_authority: f.pool_authority,
            token_a_vault: f.vault_a,
            token_b_vault: f.vault_b,
            swapper_token_in: f.provider_a,
            swapper_token_out: f.provider_a,
            token_program: spl_token::ID,
        },
        amm_dex::instruction::Swap {
            amount_in: 1_000,
            minimum_out: 0,
            a_to_b: true,
        },
    );
    let err = send_ix(&mut svm, bad, &f.authority, &[]).expect_err("expect same account");
    let logs = format!("{:?}", err);
    // Anchor 1.0's built-in ConstraintDuplicateMutableAccount (2040) fires before
    // our SameTokenAccount constraint; either is acceptable proof.
    assert!(
        logs.contains("SameTokenAccount") || logs.contains("ConstraintDuplicateMutableAccount"),
        "expected duplicate-account rejection, got: {logs}"
    );
}

#[test]
fn swap_rejects_mint_direction_mismatch() {
    let mut svm = setup_svm();
    let f = setup_pool(&mut svm);

    let bad = anchor_ix(
        amm_pid(),
        amm_dex::accounts::Swap {
            swapper: f.authority.pubkey(),
            pool: f.pool,
            pool_authority: f.pool_authority,
            token_a_vault: f.vault_a,
            token_b_vault: f.vault_b,
            swapper_token_in: f.provider_b,
            swapper_token_out: f.provider_a,
            token_program: spl_token::ID,
        },
        amm_dex::instruction::Swap {
            amount_in: 1_000,
            minimum_out: 0,
            a_to_b: true,
        },
    );
    let err = send_ix(&mut svm, bad, &f.authority, &[]).expect_err("expect mint mismatch");
    let logs = format!("{:?}", err);
    assert!(
        logs.contains("MintMismatch"),
        "expected MintMismatch, got: {logs}"
    );
}

#[test]
fn swap_happy_path() {
    let mut svm = setup_svm();
    let f = setup_pool(&mut svm);

    let ok = anchor_ix(
        amm_pid(),
        amm_dex::accounts::Swap {
            swapper: f.authority.pubkey(),
            pool: f.pool,
            pool_authority: f.pool_authority,
            token_a_vault: f.vault_a,
            token_b_vault: f.vault_b,
            swapper_token_in: f.provider_a,
            swapper_token_out: f.provider_b,
            token_program: spl_token::ID,
        },
        amm_dex::instruction::Swap {
            amount_in: 1_000_000,
            minimum_out: 1,
            a_to_b: true,
        },
    );
    send_ix(&mut svm, ok, &f.authority, &[]).expect("swap should succeed");
}
