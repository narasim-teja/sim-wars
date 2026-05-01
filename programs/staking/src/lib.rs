use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("2ecsTtNNuZUDSs19BfUx2yZ4n3WHTKKR2XfDWz6PAmdY");

pub const STAKING_POOL_SEED: &[u8] = b"staking_pool";
pub const STAKE_VAULT_SEED: &[u8] = b"stake_vault";
pub const REWARD_VAULT_SEED: &[u8] = b"reward_vault";
pub const POOL_AUTHORITY_SEED: &[u8] = b"pool_authority";
pub const STAKE_ACCOUNT_SEED: &[u8] = b"stake_account";

#[program]
pub mod staking {
    use super::*;

    /// Create the staking pool for a given stake mint. One pool per mint.
    ///
    /// `max_apy_bps` and `unstake_penalty_bps` are stored alongside the
    /// existing parameters so the on-chain config matches the SimulationConfig
    /// extracted from the whitepaper. `max_apy_bps` is currently informational
    /// (used by future dynamic-APY logic); `unstake_penalty_bps` is enforced
    /// at `complete_unstake` time — the slashed remainder is forwarded to the
    /// reward vault, recycling sell-pressure haircuts back into yield.
    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        base_apy_bps: u16,
        ticks_per_year: u32,
        lock_period_ticks: u32,
        unstake_cooldown_ticks: u32,
        max_apy_bps: u16,
        unstake_penalty_bps: u16,
    ) -> Result<()> {
        require!(base_apy_bps <= 10_000, StakingError::ApyTooHigh);
        require!(max_apy_bps <= 10_000, StakingError::ApyTooHigh);
        require!(max_apy_bps >= base_apy_bps, StakingError::MaxBelowBase);
        require!(unstake_penalty_bps <= 10_000, StakingError::PenaltyTooHigh);
        require!(ticks_per_year > 0, StakingError::InvalidTicksPerYear);

        let pool = &mut ctx.accounts.pool;
        pool.authority = ctx.accounts.authority.key();
        pool.stake_mint = ctx.accounts.stake_mint.key();
        pool.stake_vault = ctx.accounts.stake_vault.key();
        pool.reward_vault = ctx.accounts.reward_vault.key();
        pool.base_apy_bps = base_apy_bps;
        pool.ticks_per_year = ticks_per_year;
        pool.lock_period_ticks = lock_period_ticks;
        pool.unstake_cooldown_ticks = unstake_cooldown_ticks;
        pool.max_apy_bps = max_apy_bps;
        pool.unstake_penalty_bps = unstake_penalty_bps;
        pool.total_staked = 0;
        pool.current_tick = 0;
        pool.bump = ctx.bumps.pool;
        pool.pool_authority_bump = ctx.bumps.pool_authority;

        msg!(
            "Staking pool initialized: apy={}bps (max={}), lock={}ticks, cooldown={}ticks, penalty={}bps",
            base_apy_bps,
            max_apy_bps,
            lock_period_ticks,
            unstake_cooldown_ticks,
            unstake_penalty_bps,
        );
        Ok(())
    }

    /// Admin-gated: advance the simulation tick. Monotonic.
    pub fn set_tick(ctx: Context<AdminPool>, current_tick: u64) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        require!(current_tick >= pool.current_tick, StakingError::TickMustAdvance);
        pool.current_tick = current_tick;
        Ok(())
    }

    /// One-time PDA init for a user's stake record. Separated from `stake` so we don't
    /// require `init_if_needed` (cleaner for Anchor 1.0).
    pub fn initialize_stake_account(ctx: Context<InitializeStakeAccount>) -> Result<()> {
        let stake = &mut ctx.accounts.stake_account;
        let pool = &ctx.accounts.pool;
        stake.pool = pool.key();
        stake.owner = ctx.accounts.user.key();
        stake.amount = 0;
        stake.stake_start_tick = pool.current_tick;
        stake.last_reward_tick = pool.current_tick;
        stake.unclaimed_rewards = 0;
        stake.pending_unstake_amount = 0;
        stake.pending_unlock_tick = 0;
        stake.bump = ctx.bumps.stake_account;
        Ok(())
    }

    /// Deposit tokens into the pool. Accrues rewards up to the current tick first.
    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        require!(amount > 0, StakingError::ZeroAmount);

        let pool = &mut ctx.accounts.pool;
        let stake_account = &mut ctx.accounts.stake_account;

        // Accrue then mark start tick on first-ever stake (for lock period enforcement).
        let was_empty = stake_account.amount == 0 && stake_account.pending_unstake_amount == 0;
        stake_account.accrue(pool.current_tick, pool.base_apy_bps, pool.ticks_per_year)?;
        if was_empty {
            stake_account.stake_start_tick = pool.current_tick;
        }

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.user_ata.to_account_info(),
                    to: ctx.accounts.stake_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;

        stake_account.amount = stake_account
            .amount
            .checked_add(amount)
            .ok_or(StakingError::MathOverflow)?;
        pool.total_staked = pool
            .total_staked
            .checked_add(amount)
            .ok_or(StakingError::MathOverflow)?;

        msg!("Stake: {} tokens (total_staked={})", amount, pool.total_staked);
        Ok(())
    }

    /// Request an unstake. Enforces lock period; moves tokens from `amount` to
    /// `pending_unstake_amount` and starts the cooldown clock.
    pub fn request_unstake(ctx: Context<RequestUnstake>, amount: u64) -> Result<()> {
        require!(amount > 0, StakingError::ZeroAmount);

        let pool = &mut ctx.accounts.pool;
        let stake_account = &mut ctx.accounts.stake_account;

        let ticks_since_stake = pool.current_tick.saturating_sub(stake_account.stake_start_tick);
        require!(
            ticks_since_stake >= pool.lock_period_ticks as u64,
            StakingError::LockPeriodActive
        );
        require!(amount <= stake_account.amount, StakingError::InsufficientStake);
        require!(
            stake_account.pending_unstake_amount == 0,
            StakingError::PendingUnstakeExists
        );

        stake_account.accrue(pool.current_tick, pool.base_apy_bps, pool.ticks_per_year)?;

        stake_account.amount = stake_account
            .amount
            .checked_sub(amount)
            .ok_or(StakingError::MathOverflow)?;
        stake_account.pending_unstake_amount = amount;
        stake_account.pending_unlock_tick = pool
            .current_tick
            .checked_add(pool.unstake_cooldown_ticks as u64)
            .ok_or(StakingError::MathOverflow)?;
        pool.total_staked = pool
            .total_staked
            .checked_sub(amount)
            .ok_or(StakingError::MathOverflow)?;

        msg!(
            "Unstake requested: {} (unlock_tick={})",
            amount,
            stake_account.pending_unlock_tick
        );
        Ok(())
    }

    /// After cooldown: release pending tokens to the user, minus any configured
    /// `unstake_penalty_bps`. The penalty stays inside the staking program —
    /// it transfers from the stake vault to the reward vault, which means
    /// "early-exit haircuts fund yield for the holders who stayed."
    pub fn complete_unstake(ctx: Context<CompleteUnstake>) -> Result<()> {
        let pool = &ctx.accounts.pool;
        let stake_account = &mut ctx.accounts.stake_account;

        require!(
            stake_account.pending_unstake_amount > 0,
            StakingError::NoPendingUnstake
        );
        require!(
            pool.current_tick >= stake_account.pending_unlock_tick,
            StakingError::CooldownActive
        );

        let amount = stake_account.pending_unstake_amount;
        let pool_key = pool.key();
        let seeds: &[&[u8]] = &[
            POOL_AUTHORITY_SEED,
            pool_key.as_ref(),
            &[pool.pool_authority_bump],
        ];
        let signer_seeds = &[seeds];

        // Split the released amount into (user_share, penalty_share) using the
        // pool's configured penalty in bps. user_share rounds DOWN so we never
        // overpay; penalty_share gets the remainder.
        let penalty_bps = pool.unstake_penalty_bps as u128;
        let user_share = if penalty_bps == 0 {
            amount
        } else {
            let user_u128 = (amount as u128)
                .checked_mul(10_000u128 - penalty_bps)
                .ok_or(StakingError::MathOverflow)?
                .checked_div(10_000u128)
                .ok_or(StakingError::MathOverflow)?;
            u64::try_from(user_u128).map_err(|_| StakingError::MathOverflow)?
        };
        let penalty_share = amount.checked_sub(user_share).ok_or(StakingError::MathOverflow)?;

        if user_share > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    Transfer {
                        from: ctx.accounts.stake_vault.to_account_info(),
                        to: ctx.accounts.user_ata.to_account_info(),
                        authority: ctx.accounts.pool_authority.to_account_info(),
                    },
                    signer_seeds,
                ),
                user_share,
            )?;
        }
        if penalty_share > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    Transfer {
                        from: ctx.accounts.stake_vault.to_account_info(),
                        to: ctx.accounts.reward_vault.to_account_info(),
                        authority: ctx.accounts.pool_authority.to_account_info(),
                    },
                    signer_seeds,
                ),
                penalty_share,
            )?;
        }

        stake_account.pending_unstake_amount = 0;
        stake_account.pending_unlock_tick = 0;

        msg!(
            "Unstake completed: {} → user, {} → reward vault (penalty {}bps)",
            user_share,
            penalty_share,
            pool.unstake_penalty_bps,
        );
        Ok(())
    }

    /// Transfer accrued rewards from the reward vault to the user. Caps at vault balance.
    pub fn claim_rewards(ctx: Context<ClaimRewards>) -> Result<()> {
        let pool = &ctx.accounts.pool;
        let stake_account = &mut ctx.accounts.stake_account;

        stake_account.accrue(pool.current_tick, pool.base_apy_bps, pool.ticks_per_year)?;

        let rewards = stake_account.unclaimed_rewards;
        require!(rewards > 0, StakingError::NoRewards);

        let available = ctx.accounts.reward_vault.amount;
        let payable = std::cmp::min(rewards, available);
        require!(payable > 0, StakingError::RewardVaultEmpty);

        let pool_key = pool.key();
        let seeds: &[&[u8]] = &[
            POOL_AUTHORITY_SEED,
            pool_key.as_ref(),
            &[pool.pool_authority_bump],
        ];
        let signer_seeds = &[seeds];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.reward_vault.to_account_info(),
                    to: ctx.accounts.user_ata.to_account_info(),
                    authority: ctx.accounts.pool_authority.to_account_info(),
                },
                signer_seeds,
            ),
            payable,
        )?;

        stake_account.unclaimed_rewards = stake_account
            .unclaimed_rewards
            .checked_sub(payable)
            .ok_or(StakingError::MathOverflow)?;

        msg!("Claimed {} reward tokens", payable);
        Ok(())
    }

    /// Anyone can top up the reward vault (admin pattern in Phase 1).
    pub fn fund_reward_vault(ctx: Context<FundRewardVault>, amount: u64) -> Result<()> {
        require!(amount > 0, StakingError::ZeroAmount);
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.funder_ata.to_account_info(),
                    to: ctx.accounts.reward_vault.to_account_info(),
                    authority: ctx.accounts.funder.to_account_info(),
                },
            ),
            amount,
        )?;
        Ok(())
    }
}

// ============================================================
// Account Structs
// ============================================================

#[account]
pub struct StakingPool {
    pub authority: Pubkey,
    pub stake_mint: Pubkey,
    pub stake_vault: Pubkey,
    pub reward_vault: Pubkey,
    pub base_apy_bps: u16,
    pub ticks_per_year: u32,
    pub lock_period_ticks: u32,
    pub unstake_cooldown_ticks: u32,
    /// Upper bound for dynamic-APY logic. Currently informational; future
    /// enhancement may scale APY based on staked %. Must be >= base_apy_bps.
    pub max_apy_bps: u16,
    /// Bps deducted from the released amount in `complete_unstake`. Slashed
    /// portion transfers to the reward vault instead of the user's ATA.
    pub unstake_penalty_bps: u16,
    pub total_staked: u64,
    pub current_tick: u64,
    pub bump: u8,
    pub pool_authority_bump: u8,
}

#[account]
pub struct StakeAccount {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub stake_start_tick: u64,
    pub last_reward_tick: u64,
    pub unclaimed_rewards: u64,
    pub pending_unstake_amount: u64,
    pub pending_unlock_tick: u64,
    pub bump: u8,
}

impl StakeAccount {
    /// Accrue linear rewards: amount * apy_bps * ticks_elapsed / (10_000 * ticks_per_year).
    /// Updates `last_reward_tick` unconditionally so subsequent calls don't double-count.
    pub fn accrue(
        &mut self,
        current_tick: u64,
        base_apy_bps: u16,
        ticks_per_year: u32,
    ) -> Result<()> {
        if self.amount == 0 {
            self.last_reward_tick = current_tick;
            return Ok(());
        }
        let ticks_elapsed = current_tick.saturating_sub(self.last_reward_tick);
        if ticks_elapsed == 0 {
            return Ok(());
        }
        let rewards_u128 = (self.amount as u128)
            .checked_mul(base_apy_bps as u128)
            .ok_or(StakingError::MathOverflow)?
            .checked_mul(ticks_elapsed as u128)
            .ok_or(StakingError::MathOverflow)?
            .checked_div(10_000u128 * ticks_per_year as u128)
            .ok_or(StakingError::MathOverflow)?;
        let rewards = u64::try_from(rewards_u128).map_err(|_| StakingError::MathOverflow)?;
        self.unclaimed_rewards = self
            .unclaimed_rewards
            .checked_add(rewards)
            .ok_or(StakingError::MathOverflow)?;
        self.last_reward_tick = current_tick;
        Ok(())
    }
}

// ============================================================
// Instruction Contexts
// ============================================================

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub stake_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        space = 8 + std::mem::size_of::<StakingPool>(),
        seeds = [STAKING_POOL_SEED, stake_mint.key().as_ref()],
        bump,
    )]
    pub pool: Account<'info, StakingPool>,

    /// CHECK: PDA used as vault authority
    #[account(
        seeds = [POOL_AUTHORITY_SEED, pool.key().as_ref()],
        bump,
    )]
    pub pool_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        token::mint = stake_mint,
        token::authority = pool_authority,
        seeds = [STAKE_VAULT_SEED, pool.key().as_ref()],
        bump,
    )]
    pub stake_vault: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = authority,
        token::mint = stake_mint,
        token::authority = pool_authority,
        seeds = [REWARD_VAULT_SEED, pool.key().as_ref()],
        bump,
    )]
    pub reward_vault: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AdminPool<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [STAKING_POOL_SEED, pool.stake_mint.as_ref()],
        bump = pool.bump,
        has_one = authority @ StakingError::Unauthorized,
    )]
    pub pool: Account<'info, StakingPool>,
}

#[derive(Accounts)]
pub struct InitializeStakeAccount<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [STAKING_POOL_SEED, pool.stake_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, StakingPool>,

    #[account(
        init,
        payer = user,
        space = 8 + std::mem::size_of::<StakeAccount>(),
        seeds = [STAKE_ACCOUNT_SEED, pool.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub stake_account: Account<'info, StakeAccount>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [STAKING_POOL_SEED, pool.stake_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, StakingPool>,

    #[account(
        mut,
        seeds = [STAKE_ACCOUNT_SEED, pool.key().as_ref(), user.key().as_ref()],
        bump = stake_account.bump,
        has_one = owner @ StakingError::Unauthorized,
        constraint = stake_account.pool == pool.key() @ StakingError::PoolMismatch,
    )]
    pub stake_account: Account<'info, StakeAccount>,

    /// CHECK: matches stake_account.owner via has_one above
    pub owner: UncheckedAccount<'info>,

    #[account(
        mut,
        address = pool.stake_vault,
    )]
    pub stake_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_ata.owner == user.key() @ StakingError::Unauthorized,
        constraint = user_ata.mint == pool.stake_mint @ StakingError::MintMismatch,
    )]
    pub user_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RequestUnstake<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [STAKING_POOL_SEED, pool.stake_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, StakingPool>,

    #[account(
        mut,
        seeds = [STAKE_ACCOUNT_SEED, pool.key().as_ref(), user.key().as_ref()],
        bump = stake_account.bump,
        has_one = owner @ StakingError::Unauthorized,
        constraint = stake_account.pool == pool.key() @ StakingError::PoolMismatch,
    )]
    pub stake_account: Account<'info, StakeAccount>,

    /// CHECK: matches stake_account.owner via has_one above
    pub owner: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CompleteUnstake<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [STAKING_POOL_SEED, pool.stake_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, StakingPool>,

    /// CHECK: PDA pool authority
    #[account(
        seeds = [POOL_AUTHORITY_SEED, pool.key().as_ref()],
        bump = pool.pool_authority_bump,
    )]
    pub pool_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [STAKE_ACCOUNT_SEED, pool.key().as_ref(), user.key().as_ref()],
        bump = stake_account.bump,
        has_one = owner @ StakingError::Unauthorized,
        constraint = stake_account.pool == pool.key() @ StakingError::PoolMismatch,
    )]
    pub stake_account: Account<'info, StakeAccount>,

    /// CHECK: matches stake_account.owner via has_one above
    pub owner: UncheckedAccount<'info>,

    #[account(mut, address = pool.stake_vault)]
    pub stake_vault: Account<'info, TokenAccount>,

    /// Reward vault — receives the slashed remainder when `unstake_penalty_bps > 0`.
    /// Required even when penalty is 0 (cheaper than two account variants).
    #[account(mut, address = pool.reward_vault)]
    pub reward_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_ata.owner == user.key() @ StakingError::Unauthorized,
        constraint = user_ata.mint == pool.stake_mint @ StakingError::MintMismatch,
    )]
    pub user_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ClaimRewards<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [STAKING_POOL_SEED, pool.stake_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, StakingPool>,

    /// CHECK: PDA pool authority
    #[account(
        seeds = [POOL_AUTHORITY_SEED, pool.key().as_ref()],
        bump = pool.pool_authority_bump,
    )]
    pub pool_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [STAKE_ACCOUNT_SEED, pool.key().as_ref(), user.key().as_ref()],
        bump = stake_account.bump,
        has_one = owner @ StakingError::Unauthorized,
        constraint = stake_account.pool == pool.key() @ StakingError::PoolMismatch,
    )]
    pub stake_account: Account<'info, StakeAccount>,

    /// CHECK: matches stake_account.owner via has_one above
    pub owner: UncheckedAccount<'info>,

    #[account(mut, address = pool.reward_vault)]
    pub reward_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_ata.owner == user.key() @ StakingError::Unauthorized,
        constraint = user_ata.mint == pool.stake_mint @ StakingError::MintMismatch,
    )]
    pub user_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct FundRewardVault<'info> {
    #[account(mut)]
    pub funder: Signer<'info>,

    #[account(
        seeds = [STAKING_POOL_SEED, pool.stake_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, StakingPool>,

    #[account(mut, address = pool.reward_vault)]
    pub reward_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = funder_ata.owner == funder.key() @ StakingError::Unauthorized,
        constraint = funder_ata.mint == pool.stake_mint @ StakingError::MintMismatch,
    )]
    pub funder_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

// ============================================================
// Errors
// ============================================================

#[error_code]
pub enum StakingError {
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("APY bps must be <= 10000")]
    ApyTooHigh,
    #[msg("max_apy_bps must be >= base_apy_bps")]
    MaxBelowBase,
    #[msg("unstake_penalty_bps must be <= 10000")]
    PenaltyTooHigh,
    #[msg("ticks_per_year must be > 0")]
    InvalidTicksPerYear,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Lock period has not elapsed")]
    LockPeriodActive,
    #[msg("Cooldown has not elapsed")]
    CooldownActive,
    #[msg("Not enough staked to unstake that amount")]
    InsufficientStake,
    #[msg("A pending unstake already exists; complete it first")]
    PendingUnstakeExists,
    #[msg("No pending unstake to complete")]
    NoPendingUnstake,
    #[msg("No rewards accrued")]
    NoRewards,
    #[msg("Reward vault is empty")]
    RewardVaultEmpty,
    #[msg("Stake account does not belong to the given pool")]
    PoolMismatch,
    #[msg("Token account mint does not match pool stake mint")]
    MintMismatch,
    #[msg("Tick must advance monotonically")]
    TickMustAdvance,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
