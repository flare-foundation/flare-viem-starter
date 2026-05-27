# Flare Smart Accounts (Viem) – Agent Guide

This file helps AI agents and developers quickly understand the repository and where to look when making changes.

## What This Repo Is

**flare-smart-accounts-viem** is an example/starter codebase for interacting with **Flare smart accounts** using **Viem** and **xrpl** libraries. It is maintained by Flare Network.

- **Purpose:** TypeScript scripts that demonstrate Flare smart-account flows: FXRP minting/transfer, vault deposits, memo-instruction UserOps, and lending-related operations.
- **Audience:** Developers integrating with Flare (testnet/mainnet) who want copy-paste or reference implementations.

## Tech Stack

- **Package manager:** `pnpm` (preferred). Scripts are run through pnpm (e.g. `pnpm run script …`).
- **Runtime:** Node.js, scripts run with `tsx` (see `package.json` → `script`).
- **EVM:** [Viem](https://viem.sh/) 2.x; chain used in examples is **Flare Coston2 Testnet** (see `src/utils/client.ts`).
- **XRPL:** [xrpl](https://js.xrpl.org/) for XRPL wallets and payments (used to submit instructions and pay fees).
- **Flare packages:** `@flarenetwork/flare-wagmi-periphery-package` (ABIs, chain config), `@flarenetwork/smart-accounts-encoder` (human-readable interface and automatic encoding of Flare smart account instructions).

## Repository Layout

```
flare-smart-accounts-viem/
├── src/
│   ├── abis/              # Contract ABIs (ERC20, IMemoInstructionsFacet, DummyBridge, DummyLending, etc.)
│   ├── utils/             # Shared client, smart-account helpers, XRPL, fassets, event types
│   ├── flare-lending/     # Flare lending protocol demonstration
│   ├── index.ts           # (currently empty)
│   ├── mint-and-transfer.ts
│   ├── state-lookup.ts
│   ├── upshift-mint-and-deposit.ts
│   ├── custom-instructions.ts
│   ├── custom-instructions-memo-field.ts
│   └── ...
├── package.json
├── README.md
└── .env                   # Not committed; copy from .env.example
```

- **Scripts** are in `src/` (and `src/flare-lending/`). Run with: `pnpm run script <path>`, e.g. `pnpm run script src/mint-and-transfer.ts`.
- **Shared logic** lives in `src/utils/`: Viem/XRPL clients, smart-account reads (personal account, vaults, fees, memo-opcode UserOp encoding), fassets (FXRP balance/decimals), and event types.

## Flare Smart Accounts (official overview)

The [Flare Smart Accounts overview](https://dev.flare.network/smart-accounts/overview) describes the system this repo builds on:

- **Account abstraction:** Each XRPL address has a unique **smart account** on Flare, controllable only by that XRPL user. The on-chain instance is the `PersonalAccount` contract (beacon proxy) behind the `MasterAccountController` diamond. Users can act on Flare without holding FLR; they pay in XRP on the XRPL.
- **Two instruction paths:**
  - **Legacy path:** XRPL Payment to an operator address. Operator gets an FDC `IPayment.Proof` and calls `executeInstruction` on `InstructionsFacet` with the proof. The first byte of `standardPaymentReference` is the legacy instruction code (type nibble + command nibble) and the rest carries parameters. Legacy type IDs: `FXRP (0x00)`, `Firelight (0x01)`, `Upshift (0x02)`.
  - **Memo path:** XRPL Payment to the FXRP direct-minting payment address. The AssetManagerFXRP mints FXRP into the MasterAccountController and calls `handleMintedFAssets()` on `MemoInstructionsFacet` with the XRPL memo (and optional `_data`). Memo opcodes:
    - `0xFF` — execute UserOp with the `PackedUserOperation` inlined in the memo.
    - `0xFE` — execute UserOp with data; memo carries `keccak256(_data)`, the UserOp arrives through the AssetManager-forwarded `_data` parameter.
    - `0xE0/0xE1/0xE2` — ignore memo / increase nonce / replace fee.
    - `0xD0/0xD1` — set/remove executor.

This repo implements both paths via XRPL payments and waits for execution on Flare.

## Core Concepts (for agents)

1. **Personal account**  
   The smart account for an XRPL address: derived via MasterAccountController (`getPersonalAccountAddress`). All on-chain actions run as this EVM account.

2. **Legacy instructions and fees**  
   Actions are encoded as legacy instructions and sent via **XRPL Payment** to the operator address (memo = receipt, amount = fee). Fee from `getInstructionFee(encodedInstruction)`, which is keyed off the leading instruction-id byte and applies to both legacy and memo-opcode paths.

3. **Memo-opcode UserOps (`0xFF`, `0xFE`)**  
   Arbitrary EVM calls (target + value + data) bundled into a `PackedUserOperation` and executed by `MemoInstructionsFacet` via the FXRP direct-minting `handleMintedFAssets` callback. No registration step - the memo's first byte selects the opcode. See `custom-instructions.ts` (0xFE, only `keccak256(userOp)` in the memo; the bytes travel via `_data`) and `custom-instructions-memo-field.ts` (0xFF, UserOp inlined in the memo). Encoder helpers: `encodeHashInstructionMemo` / `encodeExecuteUserOpMemo` and senders `sendHashInstruction` / `sendMemoFieldInstruction` in `utils/smart-accounts.ts`. The 0xFE flow is exposed in scripts as three explicit steps: (1) `sendHashInstruction` (user side - XRPL Payment with the hash memo), (2) `executeDirectMintingWithData` (executor side - waits for the XRPL transaction to reach 3 confirmations per the FDC Payment finality requirement, fetches the proof, calls `AssetManagerFXRP.executeDirectMintingWithData(proof, _data, { value: totalCallValue })`), (3) `findUserOperationExecuted` (confirmation - parses the event off the executor receipt).

4. **FXRP and vaults**  
   FXRP = wrapped XRP on Flare. Vaults (Firelight/Upshift, ERC-4626) and agent vaults are registered on MasterAccountController. Helpers in `utils/fassets.ts` and `utils/smart-accounts.ts`.

5. **Environment**  
   `.env` (from `.env.example`): `PRIVATE_KEY` (EVM signer in `client.ts`), `XRPL_SEED` (XRPL wallet for instruction payments).

## Where to Look When…

- **Adding a new “do something with my smart account” script:** Reuse `utils/client.ts`, `utils/smart-accounts.ts`, and either `utils/xrpl.ts` (for XRPL payments) or existing scripts (e.g. `mint-and-transfer.ts`, `custom-instructions.ts`, `custom-instructions-memo-field.ts`) for the flow (encode → get fee → XRPL payment → wait for event).
- **Changing how instructions are encoded or sent:** `utils/smart-accounts.ts` (fees, personal account, memo-opcode UserOp encoding via `encodeExecuteUserOpMemo` / `encodeHashInstructionMemo`), and the encoder package for FXRP-specific legacy instructions.
- **Adding or changing contract calls:** `src/abis/` for ABIs; `utils/client.ts` for `publicClient` / `walletClient` and chain.
- **Lending examples:** `src/flare-lending/` (deposit-and-borrow flows over FXRP/MPT, with both 0xFF and 0xFE variants) and ABIs like `DummyBridge`, `DummyLending`, `ERC20`.

## Commands

All commands use **pnpm** (preferred package manager). Run scripts via pnpm:

- Install: `pnpm install`
- Run a script: `pnpm run script src/<script>.ts`
- Build: `pnpm run build`
- Lint: `pnpm run lint` / `pnpm run lint:check`
- Format: `pnpm run format` / `pnpm run format:check`
- Tests: `pnpm run test` (Vitest, root `./src`)

## External Docs

- [Flare Developer Hub](https://dev.flare.network/)
- [Flare Smart Accounts overview](https://dev.flare.network/smart-accounts/overview) — workflow, instruction format, FXRP/Firelight/Upshift command IDs
- [Viem](https://viem.sh/)
