//! Tests for the staking program: APY accrual, lock/cooldown enforcement, admin gating.

mod common;

use common::*;
use anchor_lang::{system_program, AccountDeserialize};
use solana_program::program_pack::Pack;
use solana_program::sysvar::rent;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};

fn st_pid() -> Pubkey {
    STAKING_PROGRAM_ID.parse().unwrap()
}

fn pool_seeds(mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"staking_pool", mint.as_ref()], &st_pid())
}

fn pool_authority_seeds(pool: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"pool_authority", pool.as_ref()], &st_pid())
}

fn stake_vault_seeds(pool: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"stake_vault", pool.as_ref()], &st_pid())
}

fn reward_vault_seeds(pool: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"reward_vault", pool.as_ref()], &st_pid())
}

fn stake_account_seeds(pool: &Pubkey, user: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"stake_account", pool.as_ref(), user.as_ref()],
        &st_pid(),
    )
}

#[allow(dead_code)]
struct StFixture {
    authority: Keypair,
    mint: Pubkey,
    pool: Pubkey,
    pool_authority: Pubkey,
    stake_vault: Pubkey,
    reward_vault: Pubkey,
}

/// Initialize a pool with the given parameters, seeded with a freshly-created mint.
fn setup_pool(
    svm: &mut litesvm::LiteSVM,
    base_apy_bps: u16,
    ticks_per_year: u32,
    lock_period_ticks: u32,
    unstake_cooldown_ticks: u32,
) -> StFixture {
    let authority = new_funded_keypair(svm, 100_000_000_000);
    let mint = create_mint(svm, &authority, 6);

    let (pool, _) = pool_seeds(&mint);
    let (pool_authority, _) = pool_authority_seeds(&pool);
    let (stake_vault, _) = stake_vault_seeds(&pool);
    let (reward_vault, _) = reward_vault_seeds(&pool);

    let ix = anchor_ix(
        st_pid(),
        staking::accounts::InitializePool {
            authority: authority.pubkey(),
            stake_mint: mint,
            pool,
            pool_authority,
            stake_vault,
            reward_vault,
            system_program: system_program::ID,
            token_program: spl_token::ID,
            rent: rent::ID,
        },
        staking::instruction::InitializePool {
            base_apy_bps,
            ticks_per_year,
            lock_period_ticks,
            unstake_cooldown_ticks,
        },
    );
    send_ix(svm, ix, &authority, &[]).expect("initialize_pool");

    StFixture {
        authority,
        mint,
        pool,
        pool_authority,
        stake_vault,
        reward_vault,
    }
}

/// Create a user keypair, its ATA, and mint `amount` tokens into it. Also init their stake account.
fn setup_user(svm: &mut litesvm::LiteSVM, f: &StFixture, amount: u64) -> (Keypair, Pubkey, Pubkey) {
    let user = new_funded_keypair(svm, 100_000_000_000);
    let ata = create_ata(svm, &user, &user.pubkey(), &f.mint);
    mint_to(svm, &f.authority, &f.mint, &ata, amount);
    let (stake_account, _) = stake_account_seeds(&f.pool, &user.pubkey());

    let ix = anchor_ix(
        st_pid(),
        staking::accounts::InitializeStakeAccount {
            user: user.pubkey(),
            pool: f.pool,
            stake_account,
            system_program: system_program::ID,
        },
        staking::instruction::InitializeStakeAccount {},
    );
    send_ix(svm, ix, &user, &[]).expect("initialize_stake_account");

    (user, ata, stake_account)
}

fn do_stake(
    svm: &mut litesvm::LiteSVM,
    f: &StFixture,
    user: &Keypair,
    user_ata: Pubkey,
    stake_account: Pubkey,
    amount: u64,
) -> Result<(), litesvm::types::FailedTransactionMetadata> {
    let ix = anchor_ix(
        st_pid(),
        staking::accounts::Stake {
            user: user.pubkey(),
            pool: f.pool,
            stake_account,
            owner: user.pubkey(),
            stake_vault: f.stake_vault,
            user_ata,
            token_program: spl_token::ID,
        },
        staking::instruction::Stake { amount },
    );
    send_ix(svm, ix, user, &[])
}

fn do_set_tick(
    svm: &mut litesvm::LiteSVM,
    f: &StFixture,
    signer: &Keypair,
    tick: u64,
) -> Result<(), litesvm::types::FailedTransactionMetadata> {
    let ix = anchor_ix(
        st_pid(),
        staking::accounts::AdminPool {
            authority: signer.pubkey(),
            pool: f.pool,
        },
        staking::instruction::SetTick { current_tick: tick },
    );
    send_ix(svm, ix, signer, &[])
}

fn do_request_unstake(
    svm: &mut litesvm::LiteSVM,
    f: &StFixture,
    user: &Keypair,
    stake_account: Pubkey,
    amount: u64,
) -> Result<(), litesvm::types::FailedTransactionMetadata> {
    let ix = anchor_ix(
        st_pid(),
        staking::accounts::RequestUnstake {
            user: user.pubkey(),
            pool: f.pool,
            stake_account,
            owner: user.pubkey(),
        },
        staking::instruction::RequestUnstake { amount },
    );
    send_ix(svm, ix, user, &[])
}

fn do_complete_unstake(
    svm: &mut litesvm::LiteSVM,
    f: &StFixture,
    user: &Keypair,
    user_ata: Pubkey,
    stake_account: Pubkey,
) -> Result<(), litesvm::types::FailedTransactionMetadata> {
    let ix = anchor_ix(
        st_pid(),
        staking::accounts::CompleteUnstake {
            user: user.pubkey(),
            pool: f.pool,
            pool_authority: f.pool_authority,
            stake_account,
            owner: user.pubkey(),
            stake_vault: f.stake_vault,
            user_ata,
            token_program: spl_token::ID,
        },
        staking::instruction::CompleteUnstake {},
    );
    send_ix(svm, ix, user, &[])
}

fn do_claim_rewards(
    svm: &mut litesvm::LiteSVM,
    f: &StFixture,
    user: &Keypair,
    user_ata: Pubkey,
    stake_account: Pubkey,
) -> Result<(), litesvm::types::FailedTransactionMetadata> {
    let ix = anchor_ix(
        st_pid(),
        staking::accounts::ClaimRewards {
            user: user.pubkey(),
            pool: f.pool,
            pool_authority: f.pool_authority,
            stake_account,
            owner: user.pubkey(),
            reward_vault: f.reward_vault,
            user_ata,
            token_program: spl_token::ID,
        },
        staking::instruction::ClaimRewards {},
    );
    send_ix(svm, ix, user, &[])
}

fn fund_rewards(
    svm: &mut litesvm::LiteSVM,
    f: &StFixture,
    funder: &Keypair,
    funder_ata: Pubkey,
    amount: u64,
) {
    let ix = anchor_ix(
        st_pid(),
        staking::accounts::FundRewardVault {
            funder: funder.pubkey(),
            pool: f.pool,
            reward_vault: f.reward_vault,
            funder_ata,
            token_program: spl_token::ID,
        },
        staking::instruction::FundRewardVault { amount },
    );
    send_ix(svm, ix, funder, &[]).expect("fund_reward_vault");
}

fn ata_balance(svm: &litesvm::LiteSVM, ata: &Pubkey) -> u64 {
    let acct = svm.get_account(ata).expect("account exists");
    let parsed = spl_token::state::Account::unpack_from_slice(&acct.data).expect("spl token account");
    parsed.amount
}

fn stake_account_amount(svm: &litesvm::LiteSVM, stake_account: &Pubkey) -> u64 {
    let acct = svm.get_account(stake_account).expect("stake account exists");
    // Skip 8-byte discriminator for Anchor.
    let parsed = staking::StakeAccount::try_deserialize(&mut acct.data.as_slice())
        .expect("StakeAccount decode");
    parsed.amount
}

// ============================================================
// Tests
// ============================================================

#[test]
fn stake_and_accrue_rewards() {
    let mut svm = setup_svm();
    // 100% APY, 100 ticks/year → 1% per tick. Easy math.
    let f = setup_pool(&mut svm, 10_000, 100, 0, 0);

    // User gets 100_000 tokens + stakes 10_000.
    let (user, user_ata, stake_account) = setup_user(&mut svm, &f, 100_000);
    do_stake(&mut svm, &f, &user, user_ata, stake_account, 10_000).expect("stake");
    assert_eq!(stake_account_amount(&svm, &stake_account), 10_000);

    // Fund reward vault (anyone can).
    fund_rewards(&mut svm, &f, &user, user_ata, 50_000);

    // Advance 10 ticks → expected rewards = 10_000 * 10_000bps * 10 / (10_000 * 100) = 1000.
    do_set_tick(&mut svm, &f, &f.authority, 10).expect("set_tick");

    let before = ata_balance(&svm, &user_ata);
    do_claim_rewards(&mut svm, &f, &user, user_ata, stake_account).expect("claim");
    let after = ata_balance(&svm, &user_ata);
    assert_eq!(after - before, 1_000, "expected 1% of 10_000 per tick × 10 ticks");
}

#[test]
fn lock_period_blocks_early_unstake() {
    let mut svm = setup_svm();
    // 5-tick lock, 0 cooldown.
    let f = setup_pool(&mut svm, 0, 100, 5, 0);
    let (user, user_ata, stake_account) = setup_user(&mut svm, &f, 100_000);
    do_stake(&mut svm, &f, &user, user_ata, stake_account, 10_000).expect("stake");

    // Try to unstake immediately → LockPeriodActive.
    do_set_tick(&mut svm, &f, &f.authority, 4).expect("set_tick 4");
    let err = do_request_unstake(&mut svm, &f, &user, stake_account, 5_000)
        .expect_err("lock not elapsed");
    let logs = format!("{:?}", err);
    assert!(logs.contains("LockPeriodActive"), "got: {logs}");

    // Advance to tick 5 → now OK.
    do_set_tick(&mut svm, &f, &f.authority, 5).expect("set_tick 5");
    do_request_unstake(&mut svm, &f, &user, stake_account, 5_000).expect("unstake now allowed");
}

#[test]
fn cooldown_blocks_early_complete_unstake() {
    let mut svm = setup_svm();
    // 0 lock, 3-tick cooldown.
    let f = setup_pool(&mut svm, 0, 100, 0, 3);
    let (user, user_ata, stake_account) = setup_user(&mut svm, &f, 100_000);
    do_stake(&mut svm, &f, &user, user_ata, stake_account, 10_000).expect("stake");

    do_request_unstake(&mut svm, &f, &user, stake_account, 10_000).expect("request_unstake");

    // Advance to tick 2 → still CooldownActive.
    do_set_tick(&mut svm, &f, &f.authority, 2).expect("set_tick 2");
    let err = do_complete_unstake(&mut svm, &f, &user, user_ata, stake_account)
        .expect_err("cooldown not elapsed");
    let logs = format!("{:?}", err);
    assert!(logs.contains("CooldownActive"), "got: {logs}");

    // Advance to tick 3 → cooldown met. Tokens flow back.
    do_set_tick(&mut svm, &f, &f.authority, 3).expect("set_tick 3");
    let before = ata_balance(&svm, &user_ata);
    do_complete_unstake(&mut svm, &f, &user, user_ata, stake_account).expect("complete");
    let after = ata_balance(&svm, &user_ata);
    assert_eq!(after - before, 10_000);
}

#[test]
fn set_tick_requires_authority() {
    let mut svm = setup_svm();
    let f = setup_pool(&mut svm, 0, 100, 0, 0);
    let attacker = new_funded_keypair(&mut svm, 10_000_000_000);

    let err = do_set_tick(&mut svm, &f, &attacker, 5).expect_err("attacker cannot set tick");
    let logs = format!("{:?}", err);
    assert!(
        logs.contains("ConstraintHasOne") || logs.contains("Unauthorized"),
        "got: {logs}"
    );
}

#[test]
fn set_tick_must_be_monotonic() {
    let mut svm = setup_svm();
    let f = setup_pool(&mut svm, 0, 100, 0, 0);
    do_set_tick(&mut svm, &f, &f.authority, 10).expect("set_tick 10");

    let err = do_set_tick(&mut svm, &f, &f.authority, 5).expect_err("cannot go back");
    let logs = format!("{:?}", err);
    assert!(logs.contains("TickMustAdvance"), "got: {logs}");
}

#[test]
fn claim_capped_by_empty_reward_vault() {
    let mut svm = setup_svm();
    let f = setup_pool(&mut svm, 10_000, 100, 0, 0);
    let (user, user_ata, stake_account) = setup_user(&mut svm, &f, 100_000);
    do_stake(&mut svm, &f, &user, user_ata, stake_account, 10_000).expect("stake");
    do_set_tick(&mut svm, &f, &f.authority, 5).expect("set_tick");

    // Reward vault is empty → RewardVaultEmpty.
    let err = do_claim_rewards(&mut svm, &f, &user, user_ata, stake_account)
        .expect_err("empty vault");
    let logs = format!("{:?}", err);
    assert!(logs.contains("RewardVaultEmpty"), "got: {logs}");
}
