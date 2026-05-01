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

// =====================================================================
// Vesting tests — exercise create_allocation → create_vesting → claim_vested
// to lock the cliff + linear-unlock semantics the deploy script depends on.
// =====================================================================

fn alloc_seeds(config: &Pubkey, name: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"allocation", config.as_ref(), name], &tm_pid())
}

fn vesting_seeds(config: &Pubkey, beneficiary: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"vesting", config.as_ref(), beneficiary.as_ref()],
        &tm_pid(),
    )
}

fn name32(s: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    let bytes = s.as_bytes();
    let n = bytes.len().min(32);
    out[..n].copy_from_slice(&bytes[..n]);
    out
}

fn read_token_amount(svm: &litesvm::LiteSVM, ata: &Pubkey) -> u64 {
    let acct = svm.get_account(ata).expect("ata exists");
    // SPL token accounts: amount is at bytes 64..72 (little-endian).
    u64::from_le_bytes(acct.data[64..72].try_into().unwrap())
}

#[test]
fn vesting_cliff_blocks_early_claim_then_unlocks_linearly() {
    let mut svm = setup_svm();
    let f = setup_tm(&mut svm);

    let total_supply: u64 = 1_000_000_000_000; // 1M tokens at 6 decimals
    let percent_bps: u16 = 10_000; // 100% in this allocation
    let cliff_ticks: u32 = 360; // 12 months × 30
    let linear_ticks: u32 = 1_080; // 36 months × 30 (post-cliff)

    // 1. Configure tokenomics with one 100% allocation.
    let alloc_name = name32("Team");
    let configure_ix = anchor_ix(
        tm_pid(),
        token_mint::accounts::ConfigureTokenomics {
            authority: f.authority.pubkey(),
            config: f.config,
        },
        token_mint::instruction::ConfigureTokenomics {
            total_supply,
            allocations: vec![token_mint::AllocationInput {
                name: alloc_name,
                percent_bps,
                vesting_ticks: linear_ticks,
                cliff_ticks,
            }],
        },
    );
    send_ix(&mut svm, configure_ix, &f.authority, &[]).expect("configure_tokenomics");

    let (alloc_pda, _) = alloc_seeds(&f.config, &alloc_name);
    let create_alloc_ix = anchor_ix(
        tm_pid(),
        token_mint::accounts::CreateAllocation {
            authority: f.authority.pubkey(),
            config: f.config,
            allocation: alloc_pda,
            system_program: system_program::ID,
        },
        token_mint::instruction::CreateAllocation {
            name: alloc_name,
            percent_bps,
            vesting_ticks: linear_ticks,
            cliff_ticks,
        },
    );
    send_ix(&mut svm, create_alloc_ix, &f.authority, &[]).expect("create_allocation");

    // 2. Create vesting for a fresh beneficiary keypair (deployer-owned).
    let beneficiary = new_funded_keypair(&mut svm, 10_000_000_000);
    let beneficiary_ata = create_ata(&mut svm, &f.authority, &beneficiary.pubkey(), &f.mint.pubkey());
    let (vesting_pda, _) = vesting_seeds(&f.config, &beneficiary.pubkey());

    let create_vesting_ix = anchor_ix(
        tm_pid(),
        token_mint::accounts::CreateVesting {
            authority: f.authority.pubkey(),
            config: f.config,
            mint: f.mint.pubkey(),
            allocation: alloc_pda,
            beneficiary: beneficiary.pubkey(),
            vesting: vesting_pda,
            system_program: system_program::ID,
        },
        token_mint::instruction::CreateVesting {
            total_amount: total_supply,
            start_tick: 0,
        },
    );
    send_ix(&mut svm, create_vesting_ix, &f.authority, &[]).expect("create_vesting");

    // 3. Pre-cliff claim → CliffNotReached.
    let pre_cliff = anchor_ix(
        tm_pid(),
        token_mint::accounts::ClaimVested {
            beneficiary: beneficiary.pubkey(),
            config: f.config,
            mint: f.mint.pubkey(),
            mint_authority: f.mint_authority,
            vesting: vesting_pda,
            beneficiary_ata,
            token_program: spl_token::ID,
        },
        token_mint::instruction::ClaimVested { current_tick: 100 },
    );
    let err = send_ix(&mut svm, pre_cliff, &beneficiary, &[])
        .expect_err("expect CliffNotReached");
    let logs = format!("{:?}", err);
    assert!(logs.contains("CliffNotReached"), "want CliffNotReached, got: {logs}");
    assert_eq!(read_token_amount(&svm, &beneficiary_ata), 0, "no tokens before cliff");

    // 4. At the cliff exactly: ticks_after_cliff = 0 → unlocked = 0 → NothingToClaim.
    let at_cliff = anchor_ix(
        tm_pid(),
        token_mint::accounts::ClaimVested {
            beneficiary: beneficiary.pubkey(),
            config: f.config,
            mint: f.mint.pubkey(),
            mint_authority: f.mint_authority,
            vesting: vesting_pda,
            beneficiary_ata,
            token_program: spl_token::ID,
        },
        token_mint::instruction::ClaimVested { current_tick: cliff_ticks as u64 },
    );
    let err = send_ix(&mut svm, at_cliff, &beneficiary, &[])
        .expect_err("expect NothingToClaim at exact cliff");
    let logs = format!("{:?}", err);
    assert!(logs.contains("NothingToClaim"), "want NothingToClaim, got: {logs}");

    // 5. Halfway through the linear period: claim ~50% of total.
    let half_tick = (cliff_ticks as u64) + (linear_ticks as u64) / 2;
    let half_claim = anchor_ix(
        tm_pid(),
        token_mint::accounts::ClaimVested {
            beneficiary: beneficiary.pubkey(),
            config: f.config,
            mint: f.mint.pubkey(),
            mint_authority: f.mint_authority,
            vesting: vesting_pda,
            beneficiary_ata,
            token_program: spl_token::ID,
        },
        token_mint::instruction::ClaimVested { current_tick: half_tick },
    );
    send_ix(&mut svm, half_claim, &beneficiary, &[]).expect("halfway claim");
    let mid_balance = read_token_amount(&svm, &beneficiary_ata);
    let expected_mid = total_supply / 2;
    let mid_diff = mid_balance.abs_diff(expected_mid);
    assert!(
        mid_diff <= total_supply / 1000,
        "expected ~{expected_mid} at halfway tick, got {mid_balance} (diff {mid_diff})"
    );

    // 6. After full vesting period: balance == total_supply.
    let full_tick = (cliff_ticks as u64) + (linear_ticks as u64);
    let full_claim = anchor_ix(
        tm_pid(),
        token_mint::accounts::ClaimVested {
            beneficiary: beneficiary.pubkey(),
            config: f.config,
            mint: f.mint.pubkey(),
            mint_authority: f.mint_authority,
            vesting: vesting_pda,
            beneficiary_ata,
            token_program: spl_token::ID,
        },
        token_mint::instruction::ClaimVested { current_tick: full_tick },
    );
    send_ix(&mut svm, full_claim, &beneficiary, &[]).expect("final claim");
    assert_eq!(
        read_token_amount(&svm, &beneficiary_ata),
        total_supply,
        "fully unlocked at start_tick + cliff + linear",
    );

    // 7. Past full vesting: nothing more to claim.
    let extra_claim = anchor_ix(
        tm_pid(),
        token_mint::accounts::ClaimVested {
            beneficiary: beneficiary.pubkey(),
            config: f.config,
            mint: f.mint.pubkey(),
            mint_authority: f.mint_authority,
            vesting: vesting_pda,
            beneficiary_ata,
            token_program: spl_token::ID,
        },
        token_mint::instruction::ClaimVested { current_tick: full_tick + 100 },
    );
    let err = send_ix(&mut svm, extra_claim, &beneficiary, &[])
        .expect_err("expect NothingToClaim past full unlock");
    let logs = format!("{:?}", err);
    assert!(logs.contains("NothingToClaim"), "want NothingToClaim, got: {logs}");
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
