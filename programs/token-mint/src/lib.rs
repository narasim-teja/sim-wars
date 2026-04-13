use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount};

declare_id!("11111111111111111111111111111111");

#[program]
pub mod token_mint {
    use super::*;

    /// Initialize the token mint. Mint authority is a PDA owned by this program.
    pub fn initialize_mint(ctx: Context<InitializeMint>, decimals: u8) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.mint = ctx.accounts.mint.key();
        config.decimals = decimals;
        config.total_supply = 0;
        config.minted_so_far = 0;
        config.bump = ctx.bumps.config;
        config.mint_authority_bump = ctx.bumps.mint_authority;
        msg!("Token mint initialized: {}", ctx.accounts.mint.key());
        Ok(())
    }

    /// Configure the tokenomics parameters (total supply, allocations).
    pub fn configure_tokenomics(
        ctx: Context<ConfigureTokenomics>,
        total_supply: u64,
        allocations: Vec<AllocationInput>,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(
            config.authority == ctx.accounts.authority.key(),
            TokenError::Unauthorized
        );

        config.total_supply = total_supply;

        // Validate allocations sum to 100% (10000 bps)
        let total_bps: u16 = allocations.iter().map(|a| a.percent_bps).sum();
        require!(total_bps == 10_000, TokenError::InvalidAllocations);

        // Store allocation count
        config.num_allocations = allocations.len() as u8;

        msg!(
            "Tokenomics configured: {} total supply, {} allocations",
            total_supply,
            allocations.len()
        );
        Ok(())
    }

    /// Create an allocation bucket PDA.
    pub fn create_allocation(
        ctx: Context<CreateAllocation>,
        name: [u8; 32],
        percent_bps: u16,
        vesting_ticks: u32,
        cliff_ticks: u32,
    ) -> Result<()> {
        let alloc = &mut ctx.accounts.allocation;
        let config = &ctx.accounts.config;

        alloc.config = config.key();
        alloc.name = name;
        alloc.percent_bps = percent_bps;
        alloc.vesting_ticks = vesting_ticks;
        alloc.cliff_ticks = cliff_ticks;
        alloc.allocated = (config.total_supply as u128 * percent_bps as u128 / 10_000) as u64;
        alloc.distributed = 0;
        alloc.bump = ctx.bumps.allocation;

        msg!("Allocation created: {} bps", percent_bps);
        Ok(())
    }

    /// Distribute tokens from an allocation bucket to a recipient.
    /// For unvested (vesting_ticks == 0): mint immediately.
    /// For vested: create a VestingAccount PDA.
    pub fn distribute_allocation(
        ctx: Context<DistributeAllocation>,
        amount: u64,
    ) -> Result<()> {
        let alloc = &mut ctx.accounts.allocation;
        let config = &mut ctx.accounts.config;

        require!(
            alloc.distributed + amount <= alloc.allocated,
            TokenError::AllocationExceeded
        );

        if alloc.vesting_ticks == 0 {
            // Immediate distribution — mint directly to recipient
            let mint_key = config.mint;
            let seeds = &[
                b"mint_authority",
                mint_key.as_ref(),
                &[config.mint_authority_bump],
            ];
            let signer_seeds = &[&seeds[..]];

            token::mint_to(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    MintTo {
                        mint: ctx.accounts.mint.to_account_info(),
                        to: ctx.accounts.recipient_ata.to_account_info(),
                        authority: ctx.accounts.mint_authority.to_account_info(),
                    },
                    signer_seeds,
                ),
                amount,
            )?;
        }
        // For vested allocations, a separate create_vesting instruction handles VestingAccount creation

        alloc.distributed += amount;
        config.minted_so_far += amount;

        msg!("Distributed {} tokens", amount);
        Ok(())
    }

    /// Create a vesting account for a beneficiary from a vested allocation.
    pub fn create_vesting(
        ctx: Context<CreateVesting>,
        total_amount: u64,
        start_tick: u64,
    ) -> Result<()> {
        let alloc = &mut ctx.accounts.allocation;

        require!(
            alloc.vesting_ticks > 0,
            TokenError::NotVestedAllocation
        );
        require!(
            alloc.distributed + total_amount <= alloc.allocated,
            TokenError::AllocationExceeded
        );

        let vesting = &mut ctx.accounts.vesting;
        vesting.beneficiary = ctx.accounts.beneficiary.key();
        vesting.mint = ctx.accounts.mint.key();
        vesting.config = ctx.accounts.config.key();
        vesting.total_amount = total_amount;
        vesting.claimed_amount = 0;
        vesting.start_tick = start_tick;
        vesting.cliff_ticks = alloc.cliff_ticks;
        vesting.vesting_ticks = alloc.vesting_ticks;
        vesting.bump = ctx.bumps.vesting;

        alloc.distributed += total_amount;

        msg!(
            "Vesting created for {}: {} tokens over {} ticks",
            ctx.accounts.beneficiary.key(),
            total_amount,
            alloc.vesting_ticks
        );
        Ok(())
    }

    /// Claim unlocked vested tokens based on the current simulation tick.
    pub fn claim_vested(ctx: Context<ClaimVested>, current_tick: u64) -> Result<()> {
        let vesting = &mut ctx.accounts.vesting;
        let config = &ctx.accounts.config;

        // Check cliff
        let ticks_elapsed = current_tick.saturating_sub(vesting.start_tick);
        require!(
            ticks_elapsed >= vesting.cliff_ticks as u64,
            TokenError::CliffNotReached
        );

        // Calculate unlocked amount (linear vesting after cliff)
        let ticks_after_cliff = ticks_elapsed - vesting.cliff_ticks as u64;
        let vesting_duration = vesting.vesting_ticks as u64;
        let unlocked = if ticks_after_cliff >= vesting_duration {
            vesting.total_amount
        } else {
            (vesting.total_amount as u128 * ticks_after_cliff as u128 / vesting_duration as u128)
                as u64
        };

        let claimable = unlocked.saturating_sub(vesting.claimed_amount);
        require!(claimable > 0, TokenError::NothingToClaim);

        // Mint the claimable tokens
        let mint_key = config.mint;
        let seeds = &[
            b"mint_authority",
            mint_key.as_ref(),
            &[config.mint_authority_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.beneficiary_ata.to_account_info(),
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
                signer_seeds,
            ),
            claimable,
        )?;

        vesting.claimed_amount += claimable;

        msg!("Claimed {} vested tokens at tick {}", claimable, current_tick);
        Ok(())
    }

    /// LUNA-specific: Burn stablecoin tokens and mint new tokens at current price rate.
    /// This is the algorithmic stablecoin mechanism that creates the death spiral.
    /// burn_amount: amount of stablecoin to burn
    /// price_numerator/price_denominator: current token price as a fraction (to avoid floats)
    pub fn mint_from_burn(
        ctx: Context<MintFromBurn>,
        burn_amount: u64,
        price_numerator: u64,
        price_denominator: u64,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;

        require!(price_numerator > 0 && price_denominator > 0, TokenError::InvalidPrice);

        // Burn the stablecoin tokens
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.stablecoin_mint.to_account_info(),
                    from: ctx.accounts.burner_stablecoin_ata.to_account_info(),
                    authority: ctx.accounts.burner.to_account_info(),
                },
            ),
            burn_amount,
        )?;

        // Calculate tokens to mint: burn_amount / current_price
        // If price is $85: 1_000_000 UST burn / 85 = 11,764 LUNA minted
        // If price is $1:  1_000_000 UST burn / 1  = 1,000,000 LUNA minted (hyperinflation!)
        let tokens_to_mint =
            (burn_amount as u128 * price_denominator as u128 / price_numerator as u128) as u64;

        // Mint new tokens to the burner
        let mint_key = config.mint;
        let seeds = &[
            b"mint_authority",
            mint_key.as_ref(),
            &[config.mint_authority_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.token_mint.to_account_info(),
                    to: ctx.accounts.burner_token_ata.to_account_info(),
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
                signer_seeds,
            ),
            tokens_to_mint,
        )?;

        config.minted_so_far += tokens_to_mint;

        msg!(
            "Burned {} stablecoin, minted {} tokens (price: {}/{})",
            burn_amount,
            tokens_to_mint,
            price_numerator,
            price_denominator
        );
        Ok(())
    }
}

// ============================================================
// Account Structs
// ============================================================

#[account]
pub struct TokenomicsConfig {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub total_supply: u64,
    pub decimals: u8,
    pub minted_so_far: u64,
    pub num_allocations: u8,
    pub bump: u8,
    pub mint_authority_bump: u8,
}

#[account]
pub struct AllocationBucket {
    pub config: Pubkey,
    pub name: [u8; 32],
    pub percent_bps: u16,
    pub vesting_ticks: u32,
    pub cliff_ticks: u32,
    pub allocated: u64,
    pub distributed: u64,
    pub bump: u8,
}

#[account]
pub struct VestingAccount {
    pub beneficiary: Pubkey,
    pub mint: Pubkey,
    pub config: Pubkey,
    pub total_amount: u64,
    pub claimed_amount: u64,
    pub start_tick: u64,
    pub cliff_ticks: u32,
    pub vesting_ticks: u32,
    pub bump: u8,
}

// ============================================================
// Instruction Contexts
// ============================================================

#[derive(Accounts)]
pub struct InitializeMint<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        mint::decimals = 6,
        mint::authority = mint_authority,
    )]
    pub mint: Account<'info, Mint>,

    /// CHECK: PDA used as mint authority
    #[account(
        seeds = [b"mint_authority", mint.key().as_ref()],
        bump,
    )]
    pub mint_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + std::mem::size_of::<TokenomicsConfig>(),
        seeds = [b"config", mint.key().as_ref()],
        bump,
    )]
    pub config: Account<'info, TokenomicsConfig>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct ConfigureTokenomics<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config", config.mint.as_ref()],
        bump = config.bump,
    )]
    pub config: Account<'info, TokenomicsConfig>,
}

#[derive(Accounts)]
#[instruction(name: [u8; 32])]
pub struct CreateAllocation<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [b"config", config.mint.as_ref()],
        bump = config.bump,
        constraint = config.authority == authority.key() @ TokenError::Unauthorized,
    )]
    pub config: Account<'info, TokenomicsConfig>,

    #[account(
        init,
        payer = authority,
        space = 8 + std::mem::size_of::<AllocationBucket>(),
        seeds = [b"allocation", config.key().as_ref(), &name],
        bump,
    )]
    pub allocation: Account<'info, AllocationBucket>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DistributeAllocation<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config", config.mint.as_ref()],
        bump = config.bump,
        constraint = config.authority == authority.key() @ TokenError::Unauthorized,
    )]
    pub config: Account<'info, TokenomicsConfig>,

    #[account(mut)]
    pub mint: Account<'info, Mint>,

    /// CHECK: PDA mint authority
    #[account(
        seeds = [b"mint_authority", mint.key().as_ref()],
        bump = config.mint_authority_bump,
    )]
    pub mint_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"allocation", config.key().as_ref(), &allocation.name],
        bump = allocation.bump,
    )]
    pub allocation: Account<'info, AllocationBucket>,

    #[account(mut)]
    pub recipient_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CreateVesting<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [b"config", config.mint.as_ref()],
        bump = config.bump,
        constraint = config.authority == authority.key() @ TokenError::Unauthorized,
    )]
    pub config: Account<'info, TokenomicsConfig>,

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [b"allocation", config.key().as_ref(), &allocation.name],
        bump = allocation.bump,
    )]
    pub allocation: Account<'info, AllocationBucket>,

    /// CHECK: The beneficiary of the vesting account
    pub beneficiary: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + std::mem::size_of::<VestingAccount>(),
        seeds = [b"vesting", config.key().as_ref(), beneficiary.key().as_ref()],
        bump,
    )]
    pub vesting: Account<'info, VestingAccount>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimVested<'info> {
    pub beneficiary: Signer<'info>,

    #[account(
        seeds = [b"config", config.mint.as_ref()],
        bump = config.bump,
    )]
    pub config: Account<'info, TokenomicsConfig>,

    #[account(mut)]
    pub mint: Account<'info, Mint>,

    /// CHECK: PDA mint authority
    #[account(
        seeds = [b"mint_authority", mint.key().as_ref()],
        bump = config.mint_authority_bump,
    )]
    pub mint_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"vesting", config.key().as_ref(), beneficiary.key().as_ref()],
        bump = vesting.bump,
        constraint = vesting.beneficiary == beneficiary.key() @ TokenError::Unauthorized,
    )]
    pub vesting: Account<'info, VestingAccount>,

    #[account(mut)]
    pub beneficiary_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct MintFromBurn<'info> {
    #[account(mut)]
    pub burner: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config", config.mint.as_ref()],
        bump = config.bump,
    )]
    pub config: Account<'info, TokenomicsConfig>,

    #[account(mut)]
    pub token_mint: Account<'info, Mint>,

    /// The stablecoin mint (e.g., UST)
    #[account(mut)]
    pub stablecoin_mint: Account<'info, Mint>,

    /// CHECK: PDA mint authority for the token
    #[account(
        seeds = [b"mint_authority", token_mint.key().as_ref()],
        bump = config.mint_authority_bump,
    )]
    pub mint_authority: UncheckedAccount<'info>,

    /// Burner's stablecoin token account (tokens will be burned from here)
    #[account(
        mut,
        constraint = burner_stablecoin_ata.owner == burner.key(),
    )]
    pub burner_stablecoin_ata: Account<'info, TokenAccount>,

    /// Burner's main token account (newly minted tokens go here)
    #[account(
        mut,
        constraint = burner_token_ata.owner == burner.key(),
    )]
    pub burner_token_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

// ============================================================
// Supporting Types
// ============================================================

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct AllocationInput {
    pub name: [u8; 32],
    pub percent_bps: u16,
    pub vesting_ticks: u32,
    pub cliff_ticks: u32,
}

// ============================================================
// Errors
// ============================================================

#[error_code]
pub enum TokenError {
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Allocation percentages must sum to 10000 bps (100%)")]
    InvalidAllocations,
    #[msg("Distribution exceeds allocation")]
    AllocationExceeded,
    #[msg("This allocation is not vested")]
    NotVestedAllocation,
    #[msg("Cliff period has not been reached")]
    CliffNotReached,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("Invalid price")]
    InvalidPrice,
}
