//! Tests for the new mint_from_burn auth + mint constraints.

mod common;

use common::*;
use anchor_lang::system_program;
use solana_program::sysvar::rent;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};

fn tm_pid() -> Pubkey {
    TOKEN_MINT_PROGRAM_ID.parse().unwrap()
}

fn config_seeds(mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"config", mint.as_ref()], &tm_pid())
}

fn mint_authority_seeds(mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"mint_authority", mint.as_ref()], &tm_pid())
}

#[allow(dead_code)]
struct TmFixture {
    authority: Keypair,
    mint: Keypair,
    config: Pubkey,
    mint_authority: Pubkey,
    stablecoin: Pubkey,
    burner: Keypair,
    burner_token_ata: Pubkey,
    burner_stable_ata: Pubkey,
}

fn setup_tm(svm: &mut litesvm::LiteSVM) -> TmFixture {
    let authority = new_funded_keypair(svm, 100_000_000_000);
    let burner = new_funded_keypair(svm, 100_000_000_000);
    let mint = Keypair::new();
    let (config, _) = config_seeds(&mint.pubkey());
    let (mint_authority, _) = mint_authority_seeds(&mint.pubkey());

    let init_ix = anchor_ix(
        tm_pid(),
        token_mint::accounts::InitializeMint {
            authority: authority.pubkey(),
            mint: mint.pubkey(),
            mint_authority,
            config,
            system_program: system_program::ID,
            token_program: spl_token::ID,
            rent: rent::ID,
        },
        token_mint::instruction::InitializeMint { decimals: 6 },
    );
    send_ix(svm, init_ix, &authority, &[&mint]).expect("initialize_mint");

    let stablecoin = create_mint(svm, &burner, 6);
    let burner_stable_ata = create_ata(svm, &burner, &burner.pubkey(), &stablecoin);
    mint_to(svm, &burner, &stablecoin, &burner_stable_ata, 1_000_000);
    let burner_token_ata = create_ata(svm, &burner, &burner.pubkey(), &mint.pubkey());

    TmFixture {
        authority,
        mint,
        config,
        mint_authority,
        stablecoin,
        burner,
        burner_token_ata,
        burner_stable_ata,
    }
}

#[test]
fn mint_from_burn_rejects_non_authority() {
    let mut svm = setup_svm();
    let f = setup_tm(&mut svm);

    let attacker = new_funded_keypair(&mut svm, 10_000_000_000);

    let bad = anchor_ix(
        tm_pid(),
        token_mint::accounts::MintFromBurn {
            burner: f.burner.pubkey(),
            authority: attacker.pubkey(),
            config: f.config,
            token_mint: f.mint.pubkey(),
            stablecoin_mint: f.stablecoin,
            mint_authority: f.mint_authority,
            burner_stablecoin_ata: f.burner_stable_ata,
            burner_token_ata: f.burner_token_ata,
            token_program: spl_token::ID,
        },
        token_mint::instruction::MintFromBurn {
            burn_amount: 100,
            price_numerator: 1,
            price_denominator: 1,
        },
    );
    let err = send_ix(&mut svm, bad, &f.burner, &[&attacker])
        .expect_err("expect non-authority rejection");
    let logs = format!("{:?}", err);
    assert!(
        logs.contains("ConstraintHasOne") || logs.contains("Unauthorized"),
        "expected has_one/Unauthorized, got: {logs}"
    );
}

#[test]
fn mint_from_burn_rejects_wrong_stablecoin_ata_mint() {
    let mut svm = setup_svm();
    let f = setup_tm(&mut svm);

    let other = create_mint(&mut svm, &f.burner, 6);
    let other_ata = create_ata(&mut svm, &f.burner, &f.burner.pubkey(), &other);
    mint_to(&mut svm, &f.burner, &other, &other_ata, 1_000);

    let bad = anchor_ix(
        tm_pid(),
        token_mint::accounts::MintFromBurn {
            burner: f.burner.pubkey(),
            authority: f.authority.pubkey(),
            config: f.config,
            token_mint: f.mint.pubkey(),
            stablecoin_mint: f.stablecoin,
            mint_authority: f.mint_authority,
            burner_stablecoin_ata: other_ata,
            burner_token_ata: f.burner_token_ata,
            token_program: spl_token::ID,
        },
        token_mint::instruction::MintFromBurn {
            burn_amount: 100,
            price_numerator: 1,
            price_denominator: 1,
        },
    );
    let err = send_ix(&mut svm, bad, &f.burner, &[&f.authority])
        .expect_err("expect mint mismatch");
    let logs = format!("{:?}", err);
    assert!(
        logs.contains("MintMismatch"),
        "expected MintMismatch, got: {logs}"
    );
}

#[test]
fn mint_from_burn_happy_path() {
    let mut svm = setup_svm();
    let f = setup_tm(&mut svm);

    let ok = anchor_ix(
        tm_pid(),
        token_mint::accounts::MintFromBurn {
            burner: f.burner.pubkey(),
            authority: f.authority.pubkey(),
            config: f.config,
            token_mint: f.mint.pubkey(),
            stablecoin_mint: f.stablecoin,
            mint_authority: f.mint_authority,
            burner_stablecoin_ata: f.burner_stable_ata,
            burner_token_ata: f.burner_token_ata,
            token_program: spl_token::ID,
        },
        token_mint::instruction::MintFromBurn {
            burn_amount: 1_000,
            price_numerator: 85,
            price_denominator: 1,
        },
    );
    send_ix(&mut svm, ok, &f.burner, &[&f.authority]).expect("mint_from_burn happy path");
}
