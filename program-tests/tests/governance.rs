//! Tests for the governance program: thresholds, stake-weighted voting, lifecycle.

mod common;

use common::*;
use anchor_lang::system_program;
use solana_program::sysvar::rent;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};

fn st_pid() -> Pubkey {
    STAKING_PROGRAM_ID.parse().unwrap()
}

fn gov_pid() -> Pubkey {
    GOVERNANCE_PROGRAM_ID.parse().unwrap()
}

fn staking_pool_seeds(mint: &Pubkey) -> (Pubkey, u8) {
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

fn governance_seeds(pool: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"governance", pool.as_ref()], &gov_pid())
}

fn proposal_seeds(gov: &Pubkey, id: u32) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"proposal", gov.as_ref(), &id.to_le_bytes()],
        &gov_pid(),
    )
}

fn vote_receipt_seeds(proposal: &Pubkey, voter: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"vote", proposal.as_ref(), voter.as_ref()],
        &gov_pid(),
    )
}

#[allow(dead_code)]
struct GovFixture {
    authority: Keypair,
    mint: Pubkey,
    pool: Pubkey,
    stake_vault: Pubkey,
    reward_vault: Pubkey,
    governance: Pubkey,
}

/// Sets up a staking pool + governance bound to it.
fn setup_fixture(
    svm: &mut litesvm::LiteSVM,
    proposal_threshold: u64,
    quorum_votes: u64,
    voting_period_ticks: u32,
    timelock_ticks: u32,
) -> GovFixture {
    let authority = new_funded_keypair(svm, 100_000_000_000);
    let mint = create_mint(svm, &authority, 6);
    let (pool, _) = staking_pool_seeds(&mint);
    let (pool_authority, _) = pool_authority_seeds(&pool);
    let (stake_vault, _) = stake_vault_seeds(&pool);
    let (reward_vault, _) = reward_vault_seeds(&pool);

    // Init staking pool.
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
            base_apy_bps: 0,
            ticks_per_year: 100,
            lock_period_ticks: 0,
            unstake_cooldown_ticks: 0,
        },
    );
    send_ix(svm, ix, &authority, &[]).expect("staking init_pool");

    // Init governance.
    let (governance, _) = governance_seeds(&pool);
    let ix = anchor_ix(
        gov_pid(),
        governance::accounts::InitializeGovernance {
            authority: authority.pubkey(),
            staking_pool: pool,
            governance,
            system_program: system_program::ID,
        },
        governance::instruction::InitializeGovernance {
            proposal_threshold,
            quorum_votes,
            voting_period_ticks,
            timelock_ticks,
        },
    );
    send_ix(svm, ix, &authority, &[]).expect("governance init");

    GovFixture {
        authority,
        mint,
        pool,
        stake_vault,
        reward_vault,
        governance,
    }
}

/// Create a user, mint them tokens, init their stake account, and stake `amount`.
fn setup_staker(
    svm: &mut litesvm::LiteSVM,
    f: &GovFixture,
    token_amount: u64,
    stake_amount: u64,
) -> (Keypair, Pubkey, Pubkey) {
    let user = new_funded_keypair(svm, 100_000_000_000);
    let ata = create_ata(svm, &user, &user.pubkey(), &f.mint);
    mint_to(svm, &f.authority, &f.mint, &ata, token_amount);
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
    send_ix(svm, ix, &user, &[]).expect("init_stake_account");

    if stake_amount > 0 {
        let ix = anchor_ix(
            st_pid(),
            staking::accounts::Stake {
                user: user.pubkey(),
                pool: f.pool,
                stake_account,
                owner: user.pubkey(),
                stake_vault: f.stake_vault,
                user_ata: ata,
                token_program: spl_token::ID,
            },
            staking::instruction::Stake {
                amount: stake_amount,
            },
        );
        send_ix(svm, ix, &user, &[]).expect("stake");
    }

    (user, ata, stake_account)
}

fn gov_set_tick(
    svm: &mut litesvm::LiteSVM,
    f: &GovFixture,
    signer: &Keypair,
    tick: u64,
) -> Result<(), litesvm::types::FailedTransactionMetadata> {
    let ix = anchor_ix(
        gov_pid(),
        governance::accounts::AdminGov {
            authority: signer.pubkey(),
            governance: f.governance,
        },
        governance::instruction::SetTick { current_tick: tick },
    );
    send_ix(svm, ix, signer, &[])
}

fn do_create_proposal(
    svm: &mut litesvm::LiteSVM,
    f: &GovFixture,
    proposer: &Keypair,
    proposer_stake: Pubkey,
    id: u32,
    description: [u8; 64],
) -> Result<Pubkey, litesvm::types::FailedTransactionMetadata> {
    let (proposal, _) = proposal_seeds(&f.governance, id);
    let ix = anchor_ix(
        gov_pid(),
        governance::accounts::CreateProposal {
            proposer: proposer.pubkey(),
            governance: f.governance,
            proposer_stake,
            proposal,
            system_program: system_program::ID,
        },
        governance::instruction::CreateProposal { description },
    );
    send_ix(svm, ix, proposer, &[]).map(|_| proposal)
}

fn do_cast_vote(
    svm: &mut litesvm::LiteSVM,
    f: &GovFixture,
    voter: &Keypair,
    voter_stake: Pubkey,
    proposal: Pubkey,
    support: bool,
) -> Result<(), litesvm::types::FailedTransactionMetadata> {
    let (vote_receipt, _) = vote_receipt_seeds(&proposal, &voter.pubkey());
    let ix = anchor_ix(
        gov_pid(),
        governance::accounts::CastVote {
            voter: voter.pubkey(),
            governance: f.governance,
            proposal,
            voter_stake,
            vote_receipt,
            system_program: system_program::ID,
        },
        governance::instruction::CastVote { support },
    );
    send_ix(svm, ix, voter, &[])
}

fn do_finalize(
    svm: &mut litesvm::LiteSVM,
    f: &GovFixture,
    payer: &Keypair,
    proposal: Pubkey,
) -> Result<(), litesvm::types::FailedTransactionMetadata> {
    let ix = anchor_ix(
        gov_pid(),
        governance::accounts::FinalizeProposal {
            governance: f.governance,
            proposal,
        },
        governance::instruction::FinalizeProposal {},
    );
    send_ix(svm, ix, payer, &[])
}

fn do_execute(
    svm: &mut litesvm::LiteSVM,
    f: &GovFixture,
    payer: &Keypair,
    proposal: Pubkey,
) -> Result<(), litesvm::types::FailedTransactionMetadata> {
    let ix = anchor_ix(
        gov_pid(),
        governance::accounts::ExecuteProposal {
            governance: f.governance,
            proposal,
        },
        governance::instruction::ExecuteProposal {},
    );
    send_ix(svm, ix, payer, &[])
}

fn short_desc(s: &str) -> [u8; 64] {
    let mut out = [0u8; 64];
    let bytes = s.as_bytes();
    let n = std::cmp::min(bytes.len(), 64);
    out[..n].copy_from_slice(&bytes[..n]);
    out
}

// ============================================================
// Tests
// ============================================================

#[test]
fn happy_path_propose_vote_pass_execute() {
    let mut svm = setup_svm();
    // threshold 1_000, quorum 5_000, voting 3 ticks, timelock 2 ticks.
    let f = setup_fixture(&mut svm, 1_000, 5_000, 3, 2);

    // Proposer has 10_000 staked (above threshold).
    let (proposer, _, proposer_stake) = setup_staker(&mut svm, &f, 50_000, 10_000);
    // Voter also has 10_000 staked → total for-votes 10_000 ≥ quorum 5_000.
    let (voter, _, voter_stake) = setup_staker(&mut svm, &f, 50_000, 10_000);

    let proposal = do_create_proposal(
        &mut svm,
        &f,
        &proposer,
        proposer_stake,
        0,
        short_desc("redirect treasury to governance"),
    )
    .expect("create_proposal");

    do_cast_vote(&mut svm, &f, &voter, voter_stake, proposal, true).expect("vote");

    // Advance past expiry (tick_expires = 3).
    gov_set_tick(&mut svm, &f, &f.authority, 4).expect("advance tick");
    do_finalize(&mut svm, &f, &proposer, proposal).expect("finalize");

    // Execute still blocked by timelock (executable at 3 + 2 = 5).
    let err = do_execute(&mut svm, &f, &proposer, proposal).expect_err("timelock blocks");
    let logs = format!("{:?}", err);
    assert!(logs.contains("TimelockActive"), "got: {logs}");

    // Advance past timelock → executes.
    gov_set_tick(&mut svm, &f, &f.authority, 5).expect("advance to timelock end");
    do_execute(&mut svm, &f, &proposer, proposal).expect("execute");
}

#[test]
fn proposer_below_threshold_rejected() {
    let mut svm = setup_svm();
    let f = setup_fixture(&mut svm, 1_000, 5_000, 3, 0);

    // Proposer only stakes 500 — below threshold 1_000.
    let (proposer, _, proposer_stake) = setup_staker(&mut svm, &f, 10_000, 500);
    let err = do_create_proposal(
        &mut svm,
        &f,
        &proposer,
        proposer_stake,
        0,
        short_desc("short"),
    )
    .expect_err("below threshold");
    let logs = format!("{:?}", err);
    assert!(logs.contains("BelowProposalThreshold"), "got: {logs}");
}

#[test]
fn double_vote_rejected() {
    let mut svm = setup_svm();
    let f = setup_fixture(&mut svm, 1_000, 5_000, 5, 0);

    let (proposer, _, proposer_stake) = setup_staker(&mut svm, &f, 50_000, 10_000);
    let (voter, _, voter_stake) = setup_staker(&mut svm, &f, 50_000, 10_000);

    let proposal = do_create_proposal(
        &mut svm,
        &f,
        &proposer,
        proposer_stake,
        0,
        short_desc("p"),
    )
    .expect("create");

    do_cast_vote(&mut svm, &f, &voter, voter_stake, proposal, true).expect("first vote");
    let err = do_cast_vote(&mut svm, &f, &voter, voter_stake, proposal, false)
        .expect_err("double vote");
    let logs = format!("{:?}", err);
    // VoteReceipt init fails because PDA already exists.
    assert!(
        logs.contains("already in use")
            || logs.contains("Allocate")
            || logs.contains("0x0"),
        "expected already-exists failure, got: {logs}"
    );
}

#[test]
fn finalize_before_period_ends_rejected() {
    let mut svm = setup_svm();
    let f = setup_fixture(&mut svm, 1_000, 5_000, 5, 0);

    let (proposer, _, proposer_stake) = setup_staker(&mut svm, &f, 50_000, 10_000);
    let proposal = do_create_proposal(
        &mut svm,
        &f,
        &proposer,
        proposer_stake,
        0,
        short_desc("p"),
    )
    .expect("create");

    // Period not over yet (expires at 5, current_tick is still 0).
    let err = do_finalize(&mut svm, &f, &proposer, proposal).expect_err("voting still active");
    let logs = format!("{:?}", err);
    assert!(logs.contains("VotingPeriodActive"), "got: {logs}");
}

#[test]
fn quorum_unmet_proposal_fails() {
    let mut svm = setup_svm();
    // Quorum = 20_000, voting 2 ticks.
    let f = setup_fixture(&mut svm, 1_000, 20_000, 2, 0);

    let (proposer, _, proposer_stake) = setup_staker(&mut svm, &f, 50_000, 5_000);
    let (voter, _, voter_stake) = setup_staker(&mut svm, &f, 50_000, 5_000);

    let proposal = do_create_proposal(
        &mut svm,
        &f,
        &proposer,
        proposer_stake,
        0,
        short_desc("p"),
    )
    .expect("create");
    do_cast_vote(&mut svm, &f, &voter, voter_stake, proposal, true).expect("vote");

    gov_set_tick(&mut svm, &f, &f.authority, 3).expect("advance past expiry");
    do_finalize(&mut svm, &f, &proposer, proposal).expect("finalize");

    // Now try to execute → ProposalNotPassed.
    let err = do_execute(&mut svm, &f, &proposer, proposal).expect_err("quorum unmet");
    let logs = format!("{:?}", err);
    assert!(logs.contains("ProposalNotPassed"), "got: {logs}");
}

#[test]
fn vote_after_period_ends_rejected() {
    let mut svm = setup_svm();
    let f = setup_fixture(&mut svm, 1_000, 5_000, 2, 0);

    let (proposer, _, proposer_stake) = setup_staker(&mut svm, &f, 50_000, 10_000);
    let (voter, _, voter_stake) = setup_staker(&mut svm, &f, 50_000, 10_000);

    let proposal = do_create_proposal(
        &mut svm,
        &f,
        &proposer,
        proposer_stake,
        0,
        short_desc("p"),
    )
    .expect("create");

    gov_set_tick(&mut svm, &f, &f.authority, 3).expect("past expiry");
    let err = do_cast_vote(&mut svm, &f, &voter, voter_stake, proposal, true)
        .expect_err("voting ended");
    let logs = format!("{:?}", err);
    assert!(logs.contains("VotingPeriodEnded"), "got: {logs}");
}
