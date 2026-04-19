// Shared test helpers: spin up LiteSVM, load both .so files, helpers for SPL setup.

use anchor_lang::{InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use litesvm_token::{CreateAssociatedTokenAccount, CreateMint, MintTo as LtMintTo};
use anchor_lang::system_program;
use solana_sdk::{
    instruction::Instruction,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    transaction::Transaction,
};
use std::path::PathBuf;

pub const TOKEN_MINT_PROGRAM_ID: &str = "8hFR2Zw5tmX9ysKBPwGkhF9VxaV7pj24TDu6im7jPBXj";
pub const AMM_DEX_PROGRAM_ID: &str = "Dz3ZGCtmpqrxLs3GaKxc12wJGT7qNZNebdd6pzU5JnFx";
pub const STAKING_PROGRAM_ID: &str = "2ecsTtNNuZUDSs19BfUx2yZ4n3WHTKKR2XfDWz6PAmdY";
pub const GOVERNANCE_PROGRAM_ID: &str = "Hk4eHkcr5njyntu4WEQuafVKkaK4LQJ8dTH5fqAArHFD";

pub fn deploy_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("target")
        .join("deploy")
}

pub fn setup_svm() -> LiteSVM {
    let mut svm = LiteSVM::new();
    let dep = deploy_dir();
    svm.add_program_from_file(
        TOKEN_MINT_PROGRAM_ID.parse::<Pubkey>().unwrap(),
        dep.join("token_mint.so"),
    )
    .expect("load token_mint.so");
    svm.add_program_from_file(
        AMM_DEX_PROGRAM_ID.parse::<Pubkey>().unwrap(),
        dep.join("amm_dex.so"),
    )
    .expect("load amm_dex.so");
    svm.add_program_from_file(
        STAKING_PROGRAM_ID.parse::<Pubkey>().unwrap(),
        dep.join("staking.so"),
    )
    .expect("load staking.so");
    svm.add_program_from_file(
        GOVERNANCE_PROGRAM_ID.parse::<Pubkey>().unwrap(),
        dep.join("governance.so"),
    )
    .expect("load governance.so");
    svm
}

pub fn airdrop(svm: &mut LiteSVM, to: &Pubkey, lamports: u64) {
    svm.airdrop(to, lamports).expect("airdrop");
}

pub fn new_funded_keypair(svm: &mut LiteSVM, lamports: u64) -> Keypair {
    let kp = Keypair::new();
    airdrop(svm, &kp.pubkey(), lamports);
    kp
}

pub fn create_mint(svm: &mut LiteSVM, payer: &Keypair, decimals: u8) -> Pubkey {
    CreateMint::new(svm, payer)
        .decimals(decimals)
        .send()
        .expect("create mint")
}

pub fn create_ata(svm: &mut LiteSVM, payer: &Keypair, owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    CreateAssociatedTokenAccount::new(svm, payer, mint)
        .owner(owner)
        .send()
        .expect("create ata")
}

pub fn mint_to(svm: &mut LiteSVM, payer: &Keypair, mint: &Pubkey, to: &Pubkey, amount: u64) {
    LtMintTo::new(svm, payer, mint, to, amount)
        .send()
        .expect("mint_to");
}

pub fn send_ix(
    svm: &mut LiteSVM,
    ix: Instruction,
    payer: &Keypair,
    extra_signers: &[&Keypair],
) -> Result<(), litesvm::types::FailedTransactionMetadata> {
    let mut signers: Vec<&Keypair> = vec![payer];
    signers.extend(extra_signers.iter().copied());
    // Fresh blockhash per tx so byte-identical retries get distinct signatures.
    svm.expire_blockhash();
    let blockhash = svm.latest_blockhash();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &signers,
        blockhash,
    );
    svm.send_transaction(tx).map(|_| ())
}

pub fn anchor_ix<A: ToAccountMetas, D: InstructionData>(
    program_id: Pubkey,
    accounts: A,
    data: D,
) -> Instruction {
    Instruction {
        program_id,
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}

#[allow(dead_code)]
pub fn sys_program() -> Pubkey {
    system_program::ID
}
