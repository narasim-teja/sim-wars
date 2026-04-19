use anchor_lang::prelude::*;
use staking::{StakeAccount, StakingPool};

declare_id!("Hk4eHkcr5njyntu4WEQuafVKkaK4LQJ8dTH5fqAArHFD");

pub const GOVERNANCE_SEED: &[u8] = b"governance";
pub const PROPOSAL_SEED: &[u8] = b"proposal";
pub const VOTE_RECEIPT_SEED: &[u8] = b"vote";

#[program]
pub mod governance {
    use super::*;

    /// Create the governance account. Binds voting power to a specific staking pool.
    pub fn initialize_governance(
        ctx: Context<InitializeGovernance>,
        proposal_threshold: u64,
        quorum_votes: u64,
        voting_period_ticks: u32,
        timelock_ticks: u32,
    ) -> Result<()> {
        require!(voting_period_ticks > 0, GovernanceError::InvalidVotingPeriod);

        let gov = &mut ctx.accounts.governance;
        gov.authority = ctx.accounts.authority.key();
        gov.staking_pool = ctx.accounts.staking_pool.key();
        gov.proposal_threshold = proposal_threshold;
        gov.quorum_votes = quorum_votes;
        gov.voting_period_ticks = voting_period_ticks;
        gov.timelock_ticks = timelock_ticks;
        gov.proposal_count = 0;
        gov.current_tick = 0;
        gov.bump = ctx.bumps.governance;

        msg!(
            "Governance initialized: threshold={}, quorum={}, voting={}t, timelock={}t",
            proposal_threshold,
            quorum_votes,
            voting_period_ticks,
            timelock_ticks
        );
        Ok(())
    }

    /// Admin-gated: advance the governance tick. Monotonic.
    pub fn set_tick(ctx: Context<AdminGov>, current_tick: u64) -> Result<()> {
        let gov = &mut ctx.accounts.governance;
        require!(current_tick >= gov.current_tick, GovernanceError::TickMustAdvance);
        gov.current_tick = current_tick;
        Ok(())
    }

    /// Create a proposal. Requires the proposer's staked balance ≥ proposal_threshold.
    pub fn create_proposal(
        ctx: Context<CreateProposal>,
        description: [u8; 64],
    ) -> Result<()> {
        let gov = &mut ctx.accounts.governance;
        let stake = &ctx.accounts.proposer_stake;

        require!(
            stake.amount >= gov.proposal_threshold,
            GovernanceError::BelowProposalThreshold
        );

        let proposal = &mut ctx.accounts.proposal;
        proposal.governance = gov.key();
        proposal.id = gov.proposal_count;
        proposal.proposer = ctx.accounts.proposer.key();
        proposal.description = description;
        proposal.votes_for = 0;
        proposal.votes_against = 0;
        proposal.tick_created = gov.current_tick;
        proposal.tick_expires = gov
            .current_tick
            .checked_add(gov.voting_period_ticks as u64)
            .ok_or(GovernanceError::MathOverflow)?;
        proposal.status = ProposalStatus::Active as u8;
        proposal.bump = ctx.bumps.proposal;

        gov.proposal_count = gov
            .proposal_count
            .checked_add(1)
            .ok_or(GovernanceError::MathOverflow)?;

        msg!(
            "Proposal {} created by {}: expires at tick {}",
            proposal.id,
            proposal.proposer,
            proposal.tick_expires
        );
        Ok(())
    }

    /// Cast a stake-weighted vote. VoteReceipt PDA init prevents double-voting.
    pub fn cast_vote(ctx: Context<CastVote>, support: bool) -> Result<()> {
        let gov = &ctx.accounts.governance;
        let stake = &ctx.accounts.voter_stake;
        let proposal = &mut ctx.accounts.proposal;

        require!(
            proposal.status == ProposalStatus::Active as u8,
            GovernanceError::ProposalNotActive
        );
        require!(
            gov.current_tick <= proposal.tick_expires,
            GovernanceError::VotingPeriodEnded
        );
        require!(stake.amount > 0, GovernanceError::NoStake);

        let weight = stake.amount;
        if support {
            proposal.votes_for = proposal
                .votes_for
                .checked_add(weight)
                .ok_or(GovernanceError::MathOverflow)?;
        } else {
            proposal.votes_against = proposal
                .votes_against
                .checked_add(weight)
                .ok_or(GovernanceError::MathOverflow)?;
        }

        let receipt = &mut ctx.accounts.vote_receipt;
        receipt.proposal = proposal.key();
        receipt.voter = ctx.accounts.voter.key();
        receipt.weight = weight;
        receipt.support = support;
        receipt.bump = ctx.bumps.vote_receipt;

        msg!(
            "Vote cast: proposal={} voter={} support={} weight={}",
            proposal.id,
            receipt.voter,
            support,
            weight
        );
        Ok(())
    }

    /// After the voting period: tally → Passed if quorum met AND for > against, else Failed.
    pub fn finalize_proposal(ctx: Context<FinalizeProposal>) -> Result<()> {
        let gov = &ctx.accounts.governance;
        let proposal = &mut ctx.accounts.proposal;

        require!(
            proposal.status == ProposalStatus::Active as u8,
            GovernanceError::ProposalNotActive
        );
        require!(
            gov.current_tick > proposal.tick_expires,
            GovernanceError::VotingPeriodActive
        );

        let total_votes = proposal.votes_for.saturating_add(proposal.votes_against);
        if total_votes >= gov.quorum_votes && proposal.votes_for > proposal.votes_against {
            proposal.status = ProposalStatus::Passed as u8;
            msg!("Proposal {} PASSED ({} for / {} against)", proposal.id, proposal.votes_for, proposal.votes_against);
        } else {
            proposal.status = ProposalStatus::Failed as u8;
            msg!("Proposal {} FAILED ({} for / {} against, quorum {})", proposal.id, proposal.votes_for, proposal.votes_against, gov.quorum_votes);
        }
        Ok(())
    }

    /// After timelock: mark executed. Phase 1 does not perform any on-chain side effect;
    /// the flag is observed by the simulation engine to reshape state.
    pub fn execute_proposal(ctx: Context<ExecuteProposal>) -> Result<()> {
        let gov = &ctx.accounts.governance;
        let proposal = &mut ctx.accounts.proposal;

        require!(
            proposal.status == ProposalStatus::Passed as u8,
            GovernanceError::ProposalNotPassed
        );
        let executable_at = proposal
            .tick_expires
            .checked_add(gov.timelock_ticks as u64)
            .ok_or(GovernanceError::MathOverflow)?;
        require!(
            gov.current_tick >= executable_at,
            GovernanceError::TimelockActive
        );

        proposal.status = ProposalStatus::Executed as u8;
        msg!("Proposal {} EXECUTED at tick {}", proposal.id, gov.current_tick);
        Ok(())
    }
}

// ============================================================
// Account Structs
// ============================================================

#[account]
pub struct Governance {
    pub authority: Pubkey,
    pub staking_pool: Pubkey,
    pub proposal_threshold: u64,
    pub quorum_votes: u64,
    pub voting_period_ticks: u32,
    pub timelock_ticks: u32,
    pub proposal_count: u32,
    pub current_tick: u64,
    pub bump: u8,
}

#[account]
pub struct Proposal {
    pub governance: Pubkey,
    pub id: u32,
    pub proposer: Pubkey,
    pub description: [u8; 64],
    pub votes_for: u64,
    pub votes_against: u64,
    pub tick_created: u64,
    pub tick_expires: u64,
    pub status: u8,
    pub bump: u8,
}

#[account]
pub struct VoteReceipt {
    pub proposal: Pubkey,
    pub voter: Pubkey,
    pub weight: u64,
    pub support: bool,
    pub bump: u8,
}

#[repr(u8)]
#[derive(Clone, Copy)]
pub enum ProposalStatus {
    Active = 0,
    Passed = 1,
    Failed = 2,
    Executed = 3,
}

// ============================================================
// Instruction Contexts
// ============================================================

#[derive(Accounts)]
pub struct InitializeGovernance<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub staking_pool: Account<'info, StakingPool>,

    #[account(
        init,
        payer = authority,
        space = 8 + std::mem::size_of::<Governance>(),
        seeds = [GOVERNANCE_SEED, staking_pool.key().as_ref()],
        bump,
    )]
    pub governance: Account<'info, Governance>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminGov<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [GOVERNANCE_SEED, governance.staking_pool.as_ref()],
        bump = governance.bump,
        has_one = authority @ GovernanceError::Unauthorized,
    )]
    pub governance: Account<'info, Governance>,
}

#[derive(Accounts)]
pub struct CreateProposal<'info> {
    #[account(mut)]
    pub proposer: Signer<'info>,

    #[account(
        mut,
        seeds = [GOVERNANCE_SEED, governance.staking_pool.as_ref()],
        bump = governance.bump,
    )]
    pub governance: Account<'info, Governance>,

    /// Proposer's stake account — voting power / threshold source.
    #[account(
        constraint = proposer_stake.owner == proposer.key() @ GovernanceError::Unauthorized,
        constraint = proposer_stake.pool == governance.staking_pool @ GovernanceError::PoolMismatch,
    )]
    pub proposer_stake: Account<'info, StakeAccount>,

    #[account(
        init,
        payer = proposer,
        space = 8 + std::mem::size_of::<Proposal>(),
        seeds = [PROPOSAL_SEED, governance.key().as_ref(), &governance.proposal_count.to_le_bytes()],
        bump,
    )]
    pub proposal: Account<'info, Proposal>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CastVote<'info> {
    #[account(mut)]
    pub voter: Signer<'info>,

    #[account(
        seeds = [GOVERNANCE_SEED, governance.staking_pool.as_ref()],
        bump = governance.bump,
    )]
    pub governance: Account<'info, Governance>,

    #[account(
        mut,
        seeds = [PROPOSAL_SEED, governance.key().as_ref(), &proposal.id.to_le_bytes()],
        bump = proposal.bump,
        constraint = proposal.governance == governance.key() @ GovernanceError::WrongGovernance,
    )]
    pub proposal: Account<'info, Proposal>,

    /// Voter's stake account — voting weight source.
    #[account(
        constraint = voter_stake.owner == voter.key() @ GovernanceError::Unauthorized,
        constraint = voter_stake.pool == governance.staking_pool @ GovernanceError::PoolMismatch,
    )]
    pub voter_stake: Account<'info, StakeAccount>,

    /// One-time receipt; init here prevents double-voting.
    #[account(
        init,
        payer = voter,
        space = 8 + std::mem::size_of::<VoteReceipt>(),
        seeds = [VOTE_RECEIPT_SEED, proposal.key().as_ref(), voter.key().as_ref()],
        bump,
    )]
    pub vote_receipt: Account<'info, VoteReceipt>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FinalizeProposal<'info> {
    #[account(
        seeds = [GOVERNANCE_SEED, governance.staking_pool.as_ref()],
        bump = governance.bump,
    )]
    pub governance: Account<'info, Governance>,

    #[account(
        mut,
        seeds = [PROPOSAL_SEED, governance.key().as_ref(), &proposal.id.to_le_bytes()],
        bump = proposal.bump,
        constraint = proposal.governance == governance.key() @ GovernanceError::WrongGovernance,
    )]
    pub proposal: Account<'info, Proposal>,
}

#[derive(Accounts)]
pub struct ExecuteProposal<'info> {
    #[account(
        seeds = [GOVERNANCE_SEED, governance.staking_pool.as_ref()],
        bump = governance.bump,
    )]
    pub governance: Account<'info, Governance>,

    #[account(
        mut,
        seeds = [PROPOSAL_SEED, governance.key().as_ref(), &proposal.id.to_le_bytes()],
        bump = proposal.bump,
        constraint = proposal.governance == governance.key() @ GovernanceError::WrongGovernance,
    )]
    pub proposal: Account<'info, Proposal>,
}

// ============================================================
// Errors
// ============================================================

#[error_code]
pub enum GovernanceError {
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Voting period must be > 0 ticks")]
    InvalidVotingPeriod,
    #[msg("Proposer stake below proposal threshold")]
    BelowProposalThreshold,
    #[msg("Proposal is not active")]
    ProposalNotActive,
    #[msg("Voting period is still active")]
    VotingPeriodActive,
    #[msg("Voting period has ended")]
    VotingPeriodEnded,
    #[msg("Voter has no stake")]
    NoStake,
    #[msg("Proposal did not pass")]
    ProposalNotPassed,
    #[msg("Timelock has not elapsed")]
    TimelockActive,
    #[msg("Proposal belongs to a different governance")]
    WrongGovernance,
    #[msg("Stake account belongs to a different staking pool")]
    PoolMismatch,
    #[msg("Tick must advance monotonically")]
    TickMustAdvance,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
