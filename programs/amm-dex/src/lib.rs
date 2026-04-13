use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};

declare_id!("Dz3ZGCtmpqrxLs3GaKxc12wJGT7qNZNebdd6pzU5JnFx");

#[program]
pub mod amm_dex {
    use super::*;

    /// Initialize a new liquidity pool for a token pair.
    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        fee_bps: u16,
        protocol_fee_bps: u16,
    ) -> Result<()> {
        require!(fee_bps <= 1000, AmmError::FeeTooHigh); // Max 10%
        require!(protocol_fee_bps <= fee_bps, AmmError::ProtocolFeeTooHigh);

        let pool = &mut ctx.accounts.pool;
        pool.authority = ctx.accounts.authority.key();
        pool.token_a_mint = ctx.accounts.token_a_mint.key();
        pool.token_b_mint = ctx.accounts.token_b_mint.key();
        pool.token_a_vault = ctx.accounts.token_a_vault.key();
        pool.token_b_vault = ctx.accounts.token_b_vault.key();
        pool.lp_mint = ctx.accounts.lp_mint.key();
        pool.fee_bps = fee_bps;
        pool.protocol_fee_bps = protocol_fee_bps;
        pool.reserve_a = 0;
        pool.reserve_b = 0;
        pool.lp_supply = 0;
        pool.cumulative_volume = 0;
        pool.bump = ctx.bumps.pool;
        pool.vault_a_bump = ctx.bumps.token_a_vault;
        pool.vault_b_bump = ctx.bumps.token_b_vault;

        msg!(
            "Pool initialized: {} / {} (fee: {} bps)",
            ctx.accounts.token_a_mint.key(),
            ctx.accounts.token_b_mint.key(),
            fee_bps
        );
        Ok(())
    }

    /// Add liquidity to the pool. First deposit sets the ratio; subsequent deposits
    /// must match the existing ratio.
    pub fn add_liquidity(
        ctx: Context<AddLiquidity>,
        amount_a: u64,
        amount_b: u64,
        min_lp_tokens: u64,
    ) -> Result<()> {
        let pool = &mut ctx.accounts.pool;

        let lp_tokens_to_mint;

        if pool.reserve_a == 0 && pool.reserve_b == 0 {
            // First deposit — set initial ratio
            require!(amount_a > 0 && amount_b > 0, AmmError::ZeroAmount);
            // LP tokens = sqrt(amount_a * amount_b) to prevent manipulation
            lp_tokens_to_mint = isqrt(amount_a as u128 * amount_b as u128);
            require!(lp_tokens_to_mint > 0, AmmError::InsufficientLiquidity);
        } else {
            // Subsequent deposits — proportional to existing reserves
            let lp_a = (amount_a as u128 * pool.lp_supply as u128) / pool.reserve_a as u128;
            let lp_b = (amount_b as u128 * pool.lp_supply as u128) / pool.reserve_b as u128;
            lp_tokens_to_mint = std::cmp::min(lp_a, lp_b);
        }

        require!(
            lp_tokens_to_mint >= min_lp_tokens as u128,
            AmmError::SlippageExceeded
        );

        // Transfer token A from provider to vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.provider_token_a.to_account_info(),
                    to: ctx.accounts.token_a_vault.to_account_info(),
                    authority: ctx.accounts.provider.to_account_info(),
                },
            ),
            amount_a,
        )?;

        // Transfer token B from provider to vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.provider_token_b.to_account_info(),
                    to: ctx.accounts.token_b_vault.to_account_info(),
                    authority: ctx.accounts.provider.to_account_info(),
                },
            ),
            amount_b,
        )?;

        // Mint LP tokens to provider
        let pool_key = pool.key();
        let seeds = &[b"pool" as &[u8], pool_key.as_ref(), &[pool.bump]];
        let signer_seeds = &[&seeds[..]];

        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.lp_mint.to_account_info(),
                    to: ctx.accounts.provider_lp.to_account_info(),
                    authority: ctx.accounts.pool_authority.to_account_info(),
                },
                signer_seeds,
            ),
            lp_tokens_to_mint as u64,
        )?;

        pool.reserve_a += amount_a;
        pool.reserve_b += amount_b;
        pool.lp_supply += lp_tokens_to_mint as u64;

        msg!(
            "Added liquidity: {} A + {} B = {} LP",
            amount_a,
            amount_b,
            lp_tokens_to_mint
        );
        Ok(())
    }

    /// Remove liquidity by burning LP tokens and receiving proportional reserves.
    pub fn remove_liquidity(
        ctx: Context<RemoveLiquidity>,
        lp_amount: u64,
        min_a: u64,
        min_b: u64,
    ) -> Result<()> {
        let pool = &mut ctx.accounts.pool;

        require!(lp_amount > 0, AmmError::ZeroAmount);
        require!(pool.lp_supply > 0, AmmError::InsufficientLiquidity);

        // Calculate proportional share
        let amount_a = (lp_amount as u128 * pool.reserve_a as u128 / pool.lp_supply as u128) as u64;
        let amount_b = (lp_amount as u128 * pool.reserve_b as u128 / pool.lp_supply as u128) as u64;

        require!(amount_a >= min_a && amount_b >= min_b, AmmError::SlippageExceeded);

        // Burn LP tokens
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.lp_mint.to_account_info(),
                    from: ctx.accounts.provider_lp.to_account_info(),
                    authority: ctx.accounts.provider.to_account_info(),
                },
            ),
            lp_amount,
        )?;

        // Transfer tokens from vaults to provider
        let token_a_mint = pool.token_a_mint;
        let token_b_mint = pool.token_b_mint;
        let seeds = &[
            b"pool",
            token_a_mint.as_ref(),
            token_b_mint.as_ref(),
            &[pool.bump],
        ];
        let signer_seeds = &[&seeds[..]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.token_a_vault.to_account_info(),
                    to: ctx.accounts.provider_token_a.to_account_info(),
                    authority: ctx.accounts.pool_authority.to_account_info(),
                },
                signer_seeds,
            ),
            amount_a,
        )?;

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.token_b_vault.to_account_info(),
                    to: ctx.accounts.provider_token_b.to_account_info(),
                    authority: ctx.accounts.pool_authority.to_account_info(),
                },
                signer_seeds,
            ),
            amount_b,
        )?;

        pool.reserve_a -= amount_a;
        pool.reserve_b -= amount_b;
        pool.lp_supply -= lp_amount;

        msg!(
            "Removed liquidity: {} LP = {} A + {} B",
            lp_amount,
            amount_a,
            amount_b
        );
        Ok(())
    }

    /// Swap token A for token B (or vice versa) using constant product formula.
    /// a_to_b: if true, swap A → B; if false, swap B → A.
    pub fn swap(
        ctx: Context<Swap>,
        amount_in: u64,
        minimum_out: u64,
        a_to_b: bool,
    ) -> Result<()> {
        let pool = &mut ctx.accounts.pool;

        require!(amount_in > 0, AmmError::ZeroAmount);
        require!(
            pool.reserve_a > 0 && pool.reserve_b > 0,
            AmmError::InsufficientLiquidity
        );

        let (reserve_in, reserve_out) = if a_to_b {
            (pool.reserve_a, pool.reserve_b)
        } else {
            (pool.reserve_b, pool.reserve_a)
        };

        // Apply fee: amount_in_after_fee = amount_in * (10000 - fee_bps) / 10000
        let fee = (amount_in as u128 * pool.fee_bps as u128) / 10_000;
        let amount_in_after_fee = amount_in as u128 - fee;

        // Constant product: (x + dx) * (y - dy) = x * y
        // dy = y * dx / (x + dx)
        let numerator = reserve_out as u128 * amount_in_after_fee;
        let denominator = reserve_in as u128 + amount_in_after_fee;
        let amount_out = (numerator / denominator) as u64;

        require!(amount_out >= minimum_out, AmmError::SlippageExceeded);
        require!(amount_out < reserve_out, AmmError::InsufficientLiquidity);

        // Transfer input tokens from swapper to vault
        let (from_account, to_vault) = if a_to_b {
            (
                ctx.accounts.swapper_token_in.to_account_info(),
                ctx.accounts.token_a_vault.to_account_info(),
            )
        } else {
            (
                ctx.accounts.swapper_token_in.to_account_info(),
                ctx.accounts.token_b_vault.to_account_info(),
            )
        };

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: from_account,
                    to: to_vault,
                    authority: ctx.accounts.swapper.to_account_info(),
                },
            ),
            amount_in,
        )?;

        // Transfer output tokens from vault to swapper
        let token_a_mint = pool.token_a_mint;
        let token_b_mint = pool.token_b_mint;
        let seeds = &[
            b"pool",
            token_a_mint.as_ref(),
            token_b_mint.as_ref(),
            &[pool.bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let (from_vault, to_account) = if a_to_b {
            (
                ctx.accounts.token_b_vault.to_account_info(),
                ctx.accounts.swapper_token_out.to_account_info(),
            )
        } else {
            (
                ctx.accounts.token_a_vault.to_account_info(),
                ctx.accounts.swapper_token_out.to_account_info(),
            )
        };

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: from_vault,
                    to: to_account,
                    authority: ctx.accounts.pool_authority.to_account_info(),
                },
                signer_seeds,
            ),
            amount_out,
        )?;

        // Update reserves
        if a_to_b {
            pool.reserve_a += amount_in;
            pool.reserve_b -= amount_out;
        } else {
            pool.reserve_b += amount_in;
            pool.reserve_a -= amount_out;
        }

        pool.cumulative_volume += amount_in;

        msg!(
            "Swap: {} in → {} out ({})",
            amount_in,
            amount_out,
            if a_to_b { "A→B" } else { "B→A" }
        );
        Ok(())
    }
}

// ============================================================
// Account Structs
// ============================================================

#[account]
pub struct LiquidityPool {
    pub authority: Pubkey,
    pub token_a_mint: Pubkey,
    pub token_b_mint: Pubkey,
    pub token_a_vault: Pubkey,
    pub token_b_vault: Pubkey,
    pub lp_mint: Pubkey,
    pub fee_bps: u16,
    pub protocol_fee_bps: u16,
    pub reserve_a: u64,
    pub reserve_b: u64,
    pub lp_supply: u64,
    pub cumulative_volume: u64,
    pub bump: u8,
    pub vault_a_bump: u8,
    pub vault_b_bump: u8,
}

// ============================================================
// Instruction Contexts
// ============================================================

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_a_mint: Account<'info, Mint>,
    pub token_b_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        space = 8 + std::mem::size_of::<LiquidityPool>(),
        seeds = [b"pool", token_a_mint.key().as_ref(), token_b_mint.key().as_ref()],
        bump,
    )]
    pub pool: Account<'info, LiquidityPool>,

    /// CHECK: PDA used as pool authority for vault transfers
    #[account(
        seeds = [b"pool_authority", pool.key().as_ref()],
        bump,
    )]
    pub pool_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        token::mint = token_a_mint,
        token::authority = pool_authority,
        seeds = [b"vault_a", pool.key().as_ref()],
        bump,
    )]
    pub token_a_vault: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = authority,
        token::mint = token_b_mint,
        token::authority = pool_authority,
        seeds = [b"vault_b", pool.key().as_ref()],
        bump,
    )]
    pub token_b_vault: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = authority,
        mint::decimals = 6,
        mint::authority = pool_authority,
    )]
    pub lp_mint: Account<'info, Mint>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AddLiquidity<'info> {
    #[account(mut)]
    pub provider: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool", pool.token_a_mint.as_ref(), pool.token_b_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, LiquidityPool>,

    /// CHECK: PDA pool authority
    #[account(
        seeds = [b"pool_authority", pool.key().as_ref()],
        bump,
    )]
    pub pool_authority: UncheckedAccount<'info>,

    #[account(mut, address = pool.token_a_vault)]
    pub token_a_vault: Account<'info, TokenAccount>,

    #[account(mut, address = pool.token_b_vault)]
    pub token_b_vault: Account<'info, TokenAccount>,

    #[account(mut, address = pool.lp_mint)]
    pub lp_mint: Account<'info, Mint>,

    #[account(mut, constraint = provider_token_a.owner == provider.key())]
    pub provider_token_a: Account<'info, TokenAccount>,

    #[account(mut, constraint = provider_token_b.owner == provider.key())]
    pub provider_token_b: Account<'info, TokenAccount>,

    #[account(mut, constraint = provider_lp.owner == provider.key())]
    pub provider_lp: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RemoveLiquidity<'info> {
    #[account(mut)]
    pub provider: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool", pool.token_a_mint.as_ref(), pool.token_b_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, LiquidityPool>,

    /// CHECK: PDA pool authority
    #[account(
        seeds = [b"pool_authority", pool.key().as_ref()],
        bump,
    )]
    pub pool_authority: UncheckedAccount<'info>,

    #[account(mut, address = pool.token_a_vault)]
    pub token_a_vault: Account<'info, TokenAccount>,

    #[account(mut, address = pool.token_b_vault)]
    pub token_b_vault: Account<'info, TokenAccount>,

    #[account(mut, address = pool.lp_mint)]
    pub lp_mint: Account<'info, Mint>,

    #[account(mut, constraint = provider_token_a.owner == provider.key())]
    pub provider_token_a: Account<'info, TokenAccount>,

    #[account(mut, constraint = provider_token_b.owner == provider.key())]
    pub provider_token_b: Account<'info, TokenAccount>,

    #[account(mut, constraint = provider_lp.owner == provider.key())]
    pub provider_lp: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(mut)]
    pub swapper: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool", pool.token_a_mint.as_ref(), pool.token_b_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, LiquidityPool>,

    /// CHECK: PDA pool authority
    #[account(
        seeds = [b"pool_authority", pool.key().as_ref()],
        bump,
    )]
    pub pool_authority: UncheckedAccount<'info>,

    #[account(mut, address = pool.token_a_vault)]
    pub token_a_vault: Account<'info, TokenAccount>,

    #[account(mut, address = pool.token_b_vault)]
    pub token_b_vault: Account<'info, TokenAccount>,

    /// The swapper's input token account
    #[account(mut, constraint = swapper_token_in.owner == swapper.key())]
    pub swapper_token_in: Account<'info, TokenAccount>,

    /// The swapper's output token account
    #[account(mut, constraint = swapper_token_out.owner == swapper.key())]
    pub swapper_token_out: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

// ============================================================
// Helpers
// ============================================================

/// Integer square root using Newton's method.
fn isqrt(n: u128) -> u128 {
    if n == 0 {
        return 0;
    }
    let mut x = n;
    let mut y = (x + 1) / 2;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x
}

// ============================================================
// Errors
// ============================================================

#[error_code]
pub enum AmmError {
    #[msg("Fee too high (max 10%)")]
    FeeTooHigh,
    #[msg("Protocol fee cannot exceed total fee")]
    ProtocolFeeTooHigh,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Insufficient liquidity in pool")]
    InsufficientLiquidity,
    #[msg("Slippage tolerance exceeded")]
    SlippageExceeded,
}
