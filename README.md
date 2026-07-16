<!-- LOGO -->

<div align="center">
  <a href="https://flare.network/" target="blank">
    <img src="https://content.flare.network/Flare-2.svg" width="300" alt="Flare Logo" />
  </a>
  <br />
  Example TypeScript scripts for interacting with the Flare smart accounts using Viem.
  <br />
  <a href="#PROJECT_NAME">About</a>
  ·
  <a href="CONTRIBUTING.md">Contributing</a>
  ·
  <a href="SECURITY.md">Security</a>
  ·
  <a href="CHANGELOG.md">Changelog</a>
</div>

# Flare smart account with Viem

This repository contains example code for interacting with the Flare smart accounts system using the Viem library.
All example scripts live in the `src` directory and are grouped by demo flow.

## Setup

1. **Clone the repository:**

   ```sh
   git clone <repository-url>
   cd flare-smart-accounts-viem
   ```

2. **Create a `.env` file:**

   ```sh
   cp .env.example .env
   ```

3. **Configure your environment:**
   Edit the `.env` file and add your configuration values (private keys, RPC URLs, etc.).

4. **Install dependencies:**

   ```sh
   pnpm install
   ```

   > **Note:** You can use `npm` or `yarn` instead of `pnpm` if you prefer.

## Running Scripts

Execute any script in the `src` directory using:

```sh
pnpm run script <path-to-file>
```

**Example:**

```sh
pnpm run script src/mint-and-transfer.ts
```

## Layout

```sh
src
├── abis/                                # Solidity ABIs exported as typed TypeScript objects
├── utils/                               # Shared helpers: clients, FDC, smart-account encoding, XRPL
├── fassets/                             # FAssets direct minting, tag transfer, redemption, and rate-limit inspection
├── flare-lending/                       # Dummy lending demo on coston2 (FXRP collateral, MPT loan, bridge)
├── layer-zero/                          # Cross-chain FXRP via the LayerZero OFT adapter
├── morpho/                              # Morpho Blue borrow / repay cycle through a personal account
├── roulette/                            # Roulette demo: buy chips, place a bet, cash out
├── usdt0/                               # USDT0 ERC-20 control: balance, transfer, SparkDEX swap
├── custom-instructions.ts               # Atomic multi-call demo against three dummy coston2 contracts
├── custom-instructions-memo-field.ts    # Same as above via the memo-field encoding
├── index.ts                             # (empty)
├── is-smart-account.ts                  # Read-only: check whether an XRPL account maps to a smart account
├── mint-and-transfer.ts                 # Legacy operator-routed mint + transfer FXRP
├── redeem.ts                            # Redeem 1 lot of FXRP
├── redeem-memo-field.ts                 # Same as above via the memo-field encoding
├── state-lookup.ts                      # Read-only diagnostic: balances, vaults, operator state
├── tag-owner.ts                         # Read-only: `MintingTagManager.ownerOf(42)`
└── upshift-mint-and-deposit.ts          # Legacy operator-routed mint + Upshift vault deposit
```

## Script catalogue

Each entry below lists what the script does, the environment variables it reads, what state must already exist on-chain or in `.env` before running it, and whether it depends on another script in this repo having been run first.

Many demos exist in two variants:

- **Hash-memo (0xFE) variant** - the XRPL payment carries a 32-byte hash that points at calldata uploaded separately to the personal account. One XRPL payment per logical operation.
- **Memo-field variant** (`*-memo-field.ts`) - the XRPL payment encodes the calldata inline in a 1024-byte memo. When the calls don't fit in a single memo, the variant splits them across multiple sequential XRPL payments.

Unless stated otherwise the two variants share the same prerequisites and are listed together.

A common assumption across all 0xFE / memo-field scripts: the personal account derived from `XRPL_SEED` must be funded with C2FLR (for gas), and the XRPL wallet must hold enough XRP to cover the minting + executor fees of every payment the script will send. The catalogue calls out anything beyond that.

### `src/` (root)

#### `is-smart-account.ts`

Read-only: derives the personal account for a hardcoded XRPL address and checks whether the on-chain reverse mapping resolves it back, i.e. whether the smart account has been activated.

- **Env:** none.
- **Prereqs:** none.
- **Status:** standalone.

#### `state-lookup.ts`

Read-only diagnostic.
Prints the operator XRPL addresses, the personal account address derived from `XRPL_SEED`, that account's FXRP balance, the XRPL wallet's XRP balance, the list of Upshift `Vault` entries with the personal account's ERC4626 share balance, and the list of agent vaults.

- **Env:** `XRPL_TESTNET_RPC_URL`, `XRPL_SEED`.
- **Prereqs:** none.
- **Status:** standalone.

#### `tag-owner.ts`

Read-only: reads the `MintingTagManager` address from `AssetManagerFXRP` and prints `ownerOf(42)`.
Reverts if tag 42 has never been reserved.

- **Env:** none.
- **Prereqs:** none.
- **Status:** standalone.

#### `custom-instructions.ts` / `custom-instructions-memo-field.ts`

Mints FXRP and, in the same user op, atomically batches three demo calls: `Checkpoint.passCheckpoint`, `PiggyBank.deposit(1 FXRP)`, `NoticeBoard.pinNotice("Hello World!", 1 FXRP)`.
The memo-field variant splits into two XRPL payments because `pinNotice` pushes the calldata over the 1024-byte memo cap.

- **Env:** `XRPL_TESTNET_RPC_URL`, `XRPL_SEED`.
- **Prereqs:** none beyond the common funding assumption above.
- **Status:** standalone.

#### `mint-and-transfer.ts`

Legacy two-step demo using the operator-routed `FXRPCollateralReservationInstruction` / `FXRPTransferInstruction` encoders (not 0xFE).
Reserves collateral, sends the XRPL mint payment to the agent vault address, waits for `MintingExecuted`, then transfers 10 FXRP from the personal account to a hardcoded EVM recipient.

- **Env:** `XRPL_TESTNET_RPC_URL`, `XRPL_SEED`.
- **Prereqs:** XRPL wallet funded with XRP; agent vault id `1` and wallet id `0` are hardcoded.
- **Status:** standalone.

#### `redeem.ts` / `redeem-memo-field.ts`

Calls `AssetManagerFXRP.redeem(1 lot, xrplWallet.address, zero)` from the personal account.
Despite the name, the script also sends an XRPL payment sized to mint 10 FXRP plus fees, so it mints first and then issues the redeem call inside the same user op.

- **Env:** `XRPL_TESTNET_RPC_URL`, `XRPL_SEED`.
- **Prereqs:** none beyond the common funding assumption.
- **Status:** standalone.

#### `upshift-mint-and-deposit.ts`

Legacy operator-routed flow (not 0xFE) using `UpshiftCollateralReservationAndDepositInstruction`.
Reserves collateral, sends the XRPL mint payment, waits for `MintingExecuted`, then waits for `Deposited` on the `MasterAccountController` showing the FXRP landed in vault id 2.

- **Env:** `XRPL_TESTNET_RPC_URL`, `XRPL_SEED`.
- **Prereqs:** XRPL wallet funded with XRP; Upshift vault id `2` must exist (hardcoded, along with `walletId=0`, `agentVaultId=1`).
- **Status:** standalone.

### `src/fassets/`

#### `fassets-status.ts`

Read-only: prints the `AssetManagerFXRP`, `MintingTagManager`, and `CoreVaultManager` addresses plus the Core Vault's XRPL address (the destination XRPL address for direct-minting payments).

- **Env:** none.
- **Prereqs:** none.
- **Status:** standalone.

#### `direct-minting-limits.ts`

Read-only: queries the tumbling-window hourly/daily direct-minting rate limiter state from `AssetManagerFXRP`, replays the window slide off-chain so the displayed `used` / `remaining` reflect the current second, and prints the large-mint threshold + delay and the unblock-until flag.

- **Env:** none.
- **Prereqs:** none.
- **Status:** standalone.

#### `direct-mint.ts`

Direct mint by XRPL `PaymentReference` memo (32 bytes: `0x4642505266410018` tag + 4 zero bytes + personal account address).
Net mint = 10 XRP; payment amount = net + minting + executor fees.
Waits for `DirectMintingExecuted`.

- **Env:** `XRPL_TESTNET_RPC_URL`, `XRPL_SEED`.
- **Prereqs:** hourly / daily direct-mint limits must have headroom (`direct-minting-limits.ts` reports current state).
- **Status:** standalone.

#### `direct-mint-tag.ts`

Direct mint addressed by XRPL destination tag rather than by 32-byte memo.
If `MINTING_TAG` is set, reuses that tag; otherwise reserves a new tag on `MintingTagManager` (paying `reservationFee`) and binds it to the personal account via `setMintingRecipient`.
Sends the XRPL payment with `destinationTag=tag` and waits for `DirectMintingExecuted`.

- **Env:** `XRPL_TESTNET_RPC_URL`, `XRPL_SEED`, optional `MINTING_TAG`.
- **Prereqs:** externally owned account funded with C2FLR for the tag reservation tx.
- **Status:** standalone, but also acts as `setup` for `redeem-with-tag.ts` and `layer-zero/cross-chain-redeem-to-tag.ts` because it writes a reusable tag binding.

#### `transfer-minting-tag.ts`

Direct ERC-721 transfer of a reserved minting tag (`MintingTagManager.transferFrom`).
Reads owner/recipient before transfer, validates caller ownership, performs transfer, then prints owner/recipient after transfer.

- **Env:** standard wallet env via `PRIVATE_KEY`; set `MINTING_TAG` / `MINTING_TAG_RECIPIENT` constants in the script file.
- **Prereqs:** tag already reserved and currently owned by the configured wallet (`PRIVATE_KEY`).
- **Status:** standalone.

#### `redeem-amount.ts`

Calls `AssetManagerFXRP.redeemAmount(5_000_000 UBA, hardcoded XRPL address, zero)` directly from the externally owned account (not via personal account / 0xFE).
Validates the amount against `minimumRedeemAmountUBA` and the redemption queue before sending.

- **Env:** standard wallet env (private key consumed by `walletClient`).
- **Prereqs:** the externally owned account must already hold at least 5 000 000 UBA of FXRP.
- **Status:** standalone.

#### `redeem-with-tag.ts`

Same as `redeem-amount.ts` but calls `redeemWithTag(..., destinationTag=72)`, producing a `RedemptionWithTagRequested` event.

- **Env:** standard wallet env.
- **Prereqs:** externally owned account holds the FXRP to redeem; destination tag `72` is pre-registered on `MintingTagManager`.
- **Status:** requires `direct-mint-tag.ts` (or any other path that registers tag 72).

### `src/flare-lending/`

This module has two independent setup scripts and four flow scripts. The order is:

1. `issue-mint-mpt.ts` writes `MPT_ISSUANCE_ID` to `config.ts` and seeds the vault with MPT.
2. `issue-credential.ts` issues the XRPL credential the `certified-*` flows attest to.
3. Then run any of the deposit-borrow scripts.

#### `issue-mint-mpt.ts`

Issues a fresh MPT (Multi-Purpose Token) from `MPT_ISSUER_SEED` with hardcoded `DEMO` metadata, sends 10 000 000 000 base units to `VAULT_SEED`, and writes the resulting issuance ID into `src/flare-lending/config.ts` as `export const MPT_ISSUANCE_ID`.

- **Env:** `XRPL_TESTNET_RPC_URL`, `MPT_ISSUER_SEED`, `VAULT_SEED`.
- **Prereqs:** `MPT_ISSUER_SEED` and `VAULT_SEED` must resolve to two _different_ XRPL accounts.
  Both accounts funded with XRP for reserves and fees.
  The XRPL testnet must have the MPTokensV1 amendment enabled.
- **Status:** setup. Consumed by every `(certified-)deposit-fxrp-borrow-mpt*` script.

> The issuer account cannot authorize itself to hold its own MPT, so if both seeds resolve to the same r-address the second step (`MPTokenAuthorize` from the vault) fails with `tecNO_PERMISSION`. Use a separate funded XRPL account for `VAULT_SEED`.

#### `issue-credential.ts`

Issues an XRPL `Credential` of type `flare-lending-vault` (hex-encoded UTF-8) from `VAULT_SEED` and accepts it.
Note: as written, the credential is issued from `VAULT_SEED` to itself.
The `certified-*` scripts attest against the XRPL_SEED account's credentials, so for that flow you will want to issue the credential from `VAULT_SEED` to `xrplWallet.address` (the XRPL_SEED account) and accept it as that user.

- **Env:** `XRPL_TESTNET_RPC_URL`, `VAULT_SEED`.
- **Prereqs:** vault and recipient XRPL accounts funded with XRP.
- **Status:** setup. Consumed by the `certified-deposit-fxrp-borrow-mpt*` scripts.

#### `deposit-fxrp-borrow-mpt.ts` / `deposit-fxrp-borrow-mpt-memo-field.ts`

Five-call DeFi flow against the coston2 dummy contracts:
`FXRP.approve(loan, 100)`, `DummyLending.depositCollateral(100)`, `DummyLending.takeLoan(10)`, `DummyUSDT.approve(bridge, 10)`, `DummyBridge.initiateBridge(xrplAddress, 10)`.
After the EVM side settles, the script uses `VAULT_SEED` to MPT-transfer the bridged amount to the XRPL wallet.
The memo-field variant splits the five calls across four sequential XRPL payments because each `approve` / `initiateBridge` blows the 1024-byte memo on its own.

- **Env:** `XRPL_TESTNET_RPC_URL`, `XRPL_SEED`, `VAULT_SEED`.
- **Prereqs:** `issue-mint-mpt.ts` has been run (provides `MPT_ISSUANCE_ID` and funds the vault with MPT).
- **Status:** requires `issue-mint-mpt.ts`.

#### `certified-deposit-fxrp-borrow-mpt.ts` / `certified-deposit-fxrp-borrow-mpt-memo-field.ts`

Same five-call flow as above but against `DummyCertifiedLending`, which gates access on an FDC Web2Json proof attesting that the XRPL wallet holds the expected credential.
If `validUser(personalAccount)` is already true, the proof step is skipped.
Otherwise the script prepares the verifier request body (XRPL `account_objects` lookup + jq filter), submits it, retrieves the proof, and calls `validateUser(proof)` from the externally owned account before running the batch.

- **Env:** `XRPL_TESTNET_RPC_URL`, `XRPL_SEED`, `VAULT_SEED`, `VERIFIER_URL_TESTNET`, `VERIFIER_API_KEY_TESTNET`.
- **Prereqs:** `issue-mint-mpt.ts` (for `MPT_ISSUANCE_ID` and vault MPT balance) and `issue-credential.ts` (the XRPL_SEED account must hold the `flare-lending-vault` credential the FDC proof attests to).
- **Status:** requires `issue-mint-mpt.ts`, `issue-credential.ts`.

#### `test.ts`

Developer scratch script: decodes a hardcoded ABI-encoded `IWeb2Json.Response` hex blob using the `validateUser` input type from the `DummyCertifiedLending` ABI and prints the result.
Useful for debugging proof decoding offline.

- **Env:** none.
- **Prereqs:** none.
- **Status:** standalone (scratch).

### `src/layer-zero/`

#### `bridge-fxrp.ts`

Bridges existing FXRP from coston2 to Sepolia via the LayerZero OFT Adapter.
Approves the adapter (and optionally a Composer) to spend `BRIDGE_LOTS` worth of FXRP, quotes the LayerZero fee, then calls `OFTAdapter.send` from the externally owned account.

- **Env:** optional `BRIDGE_LOTS` (default `"1"`), optional `COSTON2_COMPOSER`, plus standard wallet env.
- **Prereqs:** externally owned account must hold at least `BRIDGE_LOTS` worth of FXRP and enough C2FLR for the LayerZero native fee.
- **Status:** standalone.

#### `cross-chain-mint.ts` / `cross-chain-mint-memo-field.ts`

End-to-end mint-and-bridge from XRPL to Sepolia, driven from the personal account.
The 0xFE variant builds two calls directly against the OFT Adapter (`FXRP.approve(adapter)` then `adapter.send`) and forwards the LayerZero `nativeFee` as `msg.value`.
The memo-field variant routes through `FxrpLzBridgeShim` because the raw `OFT.send` calldata exceeds the 1024-byte memo cap.
After the executor tx, the script polls Sepolia for the `OFTReceived` event.

- **Env:** `XRPL_TESTNET_RPC_URL`, `XRPL_SEED`, `SEPOLIA_FXRP_OFT` (required), optional `FXRP_LZ_BRIDGE_SHIM` (memo-field only).
- **Prereqs:** Sepolia RPC reachable via `sepoliaPublicClient`.
- **Status:** standalone.

#### `cross-chain-redeem.ts`

Sepolia-side script (no 0xFE involved).
Sends FXRP from the externally owned Sepolia account back to coston2 with a `RedeemComposeMessage` (no tag) compose payload directed at the `COSTON2_COMPOSER`, which auto-triggers a redemption on arrival.
Polls `FAssetRedeemed` on the composer in 25-block chunks.

- **Env:** `SEPOLIA_FXRP_OFT` (required), optional `COSTON2_COMPOSER`, `SEND_LOTS` (default `"1"`), `XRP_ADDRESS` (default `rpHuw4bKSjonKRrKKVYUZYYVedg1jyPrmp`), plus Sepolia + coston2 wallet env.
- **Prereqs:** externally owned account must hold FXRP on Sepolia (typically from a prior `bridge-fxrp.ts` or `cross-chain-mint*` run) and enough Sepolia ETH for `OFT.send` + LayerZero native fee.
- **Status:** requires `bridge-fxrp.ts` (or any other path that puts FXRP on the Sepolia OFT).

#### `cross-chain-redeem-to-tag.ts`

Identical to `cross-chain-redeem.ts` except the compose message sets `redeemWithTag=true` and supplies `destinationTag=REDEMPTION_DESTINATION_TAG` (default `72`), so the composer auto-calls `redeemWithTag` instead of `redeem` on coston2.

- **Env:** same as `cross-chain-redeem.ts`, plus optional `REDEMPTION_DESTINATION_TAG`.
- **Prereqs:** same as `cross-chain-redeem.ts`, plus the destination tag (72 by default) must be reserved and bound on `MintingTagManager`.
- **Status:** requires `bridge-fxrp.ts` and a tag-registration script such as `fassets/direct-mint-tag.ts`.

### `src/morpho/`

Run order: `setup*` -> `borrow*` -> `repay*`.
The 0xFE and memo-field variants are independent of each other; pick one and stay on it across the three steps.

#### `setup.ts` / `setup-memo-field.ts`

One-shot initialisation for the Morpho borrow / repay cycle.
Mints mock collateral and loan tokens to the personal account (permissionless `setBalance` on the mock ERC20s, called from the externally owned account) and issues the necessary approvals via 0xFE / memo-field.
The 0xFE variant approves Morpho Blue directly for both tokens.
The memo-field variant approves the `MorphoMarketShim` for both tokens and calls `setAuthorization(shim)` on Morpho Blue.
Both variants are idempotent: they read on-chain state first and skip work already done.

- **Env:** `XRPL_TESTNET_RPC_URL`, `XRPL_SEED`.
- **Prereqs:** externally owned account funds the mock-mint txs.
- **Status:** setup.

#### `borrow.ts` / `borrow-memo-field.ts`

Opens a Morpho Blue position from the personal account: supplies 100 collateral units, then borrows 99% of the LLTV-derived max against it.
The 0xFE variant batches both Morpho ops inline.
The memo-field variant calls `MorphoMarketShim.supplyAndBorrow` because two Morpho ops in one memo would exceed the 1024-byte cap.

- **Env:** `XRPL_TESTNET_RPC_URL`, `XRPL_SEED`.
- **Prereqs:** matching `setup*` has been run.
- **Status:** requires `setup.ts` (or `setup-memo-field.ts`).

#### `repay.ts` / `repay-memo-field.ts`

Closes the position opened by `borrow*`.
Reads `borrowShares` and `collateral` from on-chain state and emits a `repay(0, shares)` and `withdrawCollateral(all)` pair.
The 0xFE variant calls Morpho Blue directly; the memo-field variant uses `MorphoMarketShim.repayAndWithdrawCollateral`.
Early-exits if the position is already empty.

- **Env:** `XRPL_TESTNET_RPC_URL`, `XRPL_SEED`.
- **Prereqs:** matching `setup*` (for the approvals and a loan-token buffer to cover interest) and `borrow*` (so there is a position to close).
- **Status:** requires `setup.ts`, `borrow.ts` (or the memo-field equivalents).

### `src/roulette/`

Run order: `fund-game*` -> `bet*` -> `cash-out*`.
The Roulette contract address is hardcoded in `deploys.ts`; it must already be deployed and `fundHouse`d by its owner before any of these scripts will succeed end to end.

#### `fund-game.ts` / `fund-game-memo-field.ts`

Mints 10 FXRP via direct minting and converts all of it into chips.
The 0xFE variant batches `FXRP.approve(roulette, 10e6)` and `Roulette.buyChips(10e6)` into a single XRPL payment.
The memo-field variant splits the approve + buyChips across two XRPL payments.

- **Env:** `XRPL_TESTNET_RPC_URL`, `XRPL_SEED`.
- **Prereqs:** the Roulette contract referenced by `deploys.ts` exists and has been funded by its owner via `fundHouse`.
- **Status:** setup for the bet / cash-out cycle.

#### `bet.ts` / `bet-memo-field.ts`

Plays one round: `placeBet(BLACK, 0, 1 FXRP)`, waits for the next `RandomNumberV2` round whose timestamp is past the bet's `placedAt`, then `settleBet(betId)`.
Two batches in sequence because the random round publishes asynchronously; each batch runs the full 0xFE / memo-field protocol.

- **Env:** `XRPL_TESTNET_RPC_URL`, `XRPL_SEED`.
- **Prereqs:** matching `fund-game*` has been run so the personal account holds chips; the Roulette house must be funded with at least `betAmount * 35` (worst-case straight-up payout).
- **Status:** requires `fund-game.ts` (or `fund-game-memo-field.ts`).

#### `cash-out.ts` / `cash-out-memo-field.ts`

Calls `Roulette.cashOut(chipsBalance)` from the personal account in a single user op, converting all chips 1:1 back to FXRP.
Early-exits if the chip balance is zero.

- **Env:** `XRPL_TESTNET_RPC_URL`, `XRPL_SEED`.
- **Prereqs:** the personal account holds nonzero chips on the Roulette contract.
- **Status:** requires `fund-game.ts` (and typically `bet.ts` if you want post-bet settlement first).

### `src/usdt0/`

ERC-20 control of USDT0 from the personal account.
Addresses, amounts, and the transfer recipient live in `config.ts`.
Mutating scripts use fee-only 0xFE UserOps (no FXRP mint).

#### `balance.ts`

Read-only: prints the personal account's USDT0 `balanceOf` and `allowance` to the SparkDEX SwapRouter.

- **Env:** `XRPL_SEED`.
- **Prereqs:** none.
- **Status:** standalone.

#### `transfer.ts`

Transfers `DEFAULT_AMOUNT_IN_UNITS` (1 USDT0) from the personal account to `DEFAULT_TRANSFER_RECIPIENT` via a single-call 0xFE UserOp.

- **Env:** `XRPL_TESTNET_RPC_URL`, `XRPL_SEED`, `PRIVATE_KEY` (executor step).
- **Prereqs:** faucet C2FLR to the personal account; faucet USDT0 to the same EVM address via the [Coston2 faucet](https://faucet.flare.network/coston2). The personal account must hold at least `DEFAULT_AMOUNT_IN_UNITS` before running.
- **Status:** standalone.

#### `swap-usdt0-to-fxrp.ts`

Swaps USDT0 to FXRP from the personal account via SparkDEX's Uniswap V3 router.
The XRPL payment carries only direct-minting fees (no FXRP mint); the 0xFE UserOp batches `USDT0.approve(router)` and `router.exactInputSingle(USDT0 → FXRP)` atomically.

- **Env:** `XRPL_TESTNET_RPC_URL`, `XRPL_SEED`, `PRIVATE_KEY` (executor step).
- **Prereqs:** faucet C2FLR to the personal account; faucet USDT0 to the same EVM address via the [Coston2 faucet](https://faucet.flare.network/coston2). The personal account must hold at least `DEFAULT_AMOUNT_IN_UNITS` (1 USDT0) before running.
- **Status:** standalone.
- **Reference:** [Swap USDT0 to FXRP](https://dev.flare.network/fxrp/token-interactions/usdt0-fxrp-swap)

## Resources

- [Flare Developer Hub](https://dev.flare.network/)
- [Viem Documentation](https://viem.sh/)
