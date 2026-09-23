# Swyft Smart Contracts

All 8 Swyft smart contracts compile and build successfully. (The `hello-world` sample/placeholder was removed from the workspace; it is not a shipped Swyft contract.)

## Contracts

| Contract         | Purpose                     | Status |
| ---------------- | --------------------------- | ------ |
| `math-lib`       | Fixed-point math (Q64.96)   | ✅     |
| `pool`           | Concentrated liquidity pool | ✅     |
| `pool-factory`   | Pool deployment & registry  | ✅     |
| `router`         | Single-hop swap routing     | ✅     |
| `position-nft`   | Liquidity position NFTs     | ✅     |
| `fee-collector`  | Fee accumulation            | ✅     |
| `oracle-adapter` | TWAP oracle (per-pool)      | ✅     |
| `cl-pool`        | Concentrated-liquidity pool | ✅     |

## Testnet registry

Deployed testnet contract IDs live in:

- **JSON registry**: [`packages/contract/deployments/testnet.json`](packages/contract/deployments/testnet.json)
- **Key map / docs**: [`packages/contract/deployments/TESTNET.md`](packages/contract/deployments/TESTNET.md)

Wire addresses into the API via the env keys listed in that registry (see `apps/api/.env.example`).

## Router: Single-Hop Swap Routing (Exact In / Exact Out)

The `router` contract exposes two single-hop entrypoints. Both are typed, return
stable error codes, and are deny-by-default for privileged surfaces.

### Entrypoints

| Entrypoint        | Direction  | Amount semantics                          |
| ----------------- | ---------- | ----------------------------------------- |
| `swap_exact_in`   | exact in   | `amount_in` fixed; `amount_out_min` bound |
| `swap_exact_out`  | exact out  | `amount_out` fixed; `amount_in_max` bound |

### Invariants

- **Single-hop only.** The router resolves exactly one pool for the
  `(token_in, token_out)` pair; multi-hop paths are rejected with
  `RouterError::UnsupportedPath`.
- **Server/contract is source of truth.** Balances, reserves, and swap results
  are read from the pool contract; the router never trusts client-supplied
  amounts beyond the caller's slippage bound.
- **Slippage is fail-closed.** `swap_exact_in` reverts with
  `RouterError::SlippageExceeded` when the realized output is below
  `amount_out_min`; `swap_exact_out` reverts with the same code when the
  required input exceeds `amount_in_max`.
- **Idempotency.** Each swap carries a caller-supplied `correlation_id`.
  Replayed or concurrent requests with a previously consumed id are rejected
  with `RouterError::DuplicateRequest` and never mutate pool state twice.
- **Fail-closed on dependency outage.** If the pool/RPC dependency is
  unavailable, writes revert with `RouterError::DependencyUnavailable` rather
  than proceeding on stale data.

### Stable error codes

| Code | Name                     | Meaning                                        |
| ---- | ------------------------ | ---------------------------------------------- |
| 1    | `Unauthorized`           | Caller lacks the required role/authorization   |
| 2    | `UnsupportedPath`        | Not a single-hop `(token_in, token_out)` pair  |
| 3    | `SlippageExceeded`       | Realized amount violates the caller's bound    |
| 4    | `DuplicateRequest`       | `correlation_id` already consumed (replay)     |
| 5    | `DependencyUnavailable`  | Pool/RPC dependency outage; write failed closed|
| 6    | `InvalidAmount`          | Zero/negative or malformed amount              |

### Authorization

- Swap entrypoints are permissionless for the caller's own funds but every
  request is authorized against routing policy; untrusted clients cannot
  bypass the single-hop resolution or slippage checks.
- Privileged surfaces (pool registration, fee/admin config) are
  **deny-by-default** and require the admin role; unauthorized callers receive
  `RouterError::Unauthorized`.

### Observability

- Money-path metrics are emitted per swap: direction (exact in/out), pool id,
  token pair, realized amounts, and outcome code.
- Logs carry the `correlation_id` for tracing and **never** include secrets,
  private keys, or raw signatures.

### Rollout / kill-switch

- Router swaps are gated behind a feature flag; disabling it makes both
  entrypoints revert with `RouterError::DependencyUnavailable` (fail-closed).
- Rollback: flip the flag off and redeploy the previous router wasm; no pool
  state migration is required.

## Position NFT: LP NFT Mint / Burn / Transfer Rules

The `position-nft` contract mints one NFT per concentrated-liquidity position.
The NFT is the on-chain proof of ownership for the position's liquidity and
accrued fees. All lifecycle entrypoints are typed, return stable error codes,
and are deny-by-default for privileged surfaces.

### Entrypoints

| Entrypoint        | Direction | Semantics                                              |
| ----------------- | --------- | ------------------------------------------------------ |
| `mint`            | write     | Mint a position NFT on liquidity provision             |
| `burn`            | write     | Burn the position NFT on full withdrawal               |
| `transfer`        | write     | Transfer the position NFT to a new owner               |
| `owner_of`        | read      | Return the current owner of a position NFT             |

### Invariants

- **Mint on provision.** `mint` is called exactly once per new position and
  records the pool id, tick range, and liquidity amount. The contract is the
  source of truth for ownership; client-supplied owner ids are ignored unless
  they match the authenticated caller.
- **Burn on full withdrawal.** `burn` is only valid when the position's
  liquidity is fully withdrawn and all accrued fees are collected. Partial
  withdrawals must not burn the NFT; they revert with
  `PositionNftError::PositionNotClosed`.
- **Transfer only by authorized owner.** `transfer` requires the caller to be
  the current owner (or an approved operator). Untrusted clients cannot move a
  position they do not own; unauthorized callers receive
  `PositionNftError::Unauthorized`.
- **One NFT per position.** A position id maps to at most one live NFT; minting
  a duplicate id reverts with `PositionNftError::DuplicateRequest`.
- **Idempotency.** Each mint/burn/transfer carries a caller-supplied
  `correlation_id`. Replayed or concurrent requests with a previously consumed
  id are rejected with `PositionNftError::DuplicateRequest` and never mutate
  ownership twice.
- **Fail-closed on dependency outage.** If the pool/RPC dependency is
  unavailable, writes revert with `PositionNftError::DependencyUnavailable`
  rather than proceeding on stale ownership or liquidity data.

### Stable error codes

| Code | Name                     | Meaning                                          |
| ---- | ------------------------ | ------------------------------------------------ |
| 1    | `Unauthorized`           | Caller is not owner/operator or lacks role       |
| 2    | `PositionNotClosed`      | Burn attempted before full withdrawal            |
| 3    | `DuplicateRequest`       | `correlation_id` already consumed (replay)       |
| 4    | `DependencyUnavailable`  | Pool/RPC dependency outage; write failed closed  |
| 5    | `InvalidAmount`          | Zero/negative or malformed liquidity amount      |
| 6    | `NotFound`               | Position id has no live NFT                      |

### Authorization

- `mint` is permissionless for the caller's own liquidity but every request is
  authorized against position policy; untrusted clients cannot mint a position
  they did not fund.
- `burn` and `transfer` are **deny-by-default**: only the current owner or an
  explicitly approved operator may call them. Unauthorized callers receive
  `PositionNftError::Unauthorized`.
- Privileged surfaces (operator approval, admin config) require the admin role
  and are deny-by-default.

### Observability

- Money-path metrics are emitted per lifecycle event: operation
  (mint/burn/transfer), position id, pool id, owner, and outcome code.
- Logs carry the `correlation_id` for tracing and **never** include secrets,
  private keys, or raw signatures.

### Rollout / kill-switch

- Position NFT writes are gated behind a feature flag; disabling it makes
  `mint`/`burn`/`transfer` revert with
  `PositionNftError::DependencyUnavailable` (fail-closed).
- Rollback: flip the flag off and redeploy the previous position-nft wasm; no
  position state migration is required.

## Validation

Run the contract validation CLI:

```bash
pnpm validate:contracts
```

Output:

```
Building math-lib... ✓
Building pool... ✓
...
Passed: 8/8
All Swyft contracts validated!
```

### Address drift (CI gate)

`scripts/deploy-testnet.sh` records a sha256 hash of each deployed contract's
wasm under `.wasmHashes` in `packages/contract/deployments/testnet.json`,
alongside its address. `pnpm validate:contracts:drift` rebuilds every
contract and compares the fresh wasm hash against the recorded one for any
contract that has a deployed address — if they don't match, the contract's
source has changed since it was deployed (drifted) and the command exits
non-zero.

This runs as the `Contracts` job in CI (`.github/workflows/ci.yml`) on every
push/PR — a contract build failure or address drift fails the job. The
comparison logic itself (`packages/contract/scripts/check-address-drift.js`)
is unit-tested against a fixture with an intentional mismatch:

```bash
pnpm --filter contracts test:drift
```

If a contract's address genuinely drifts (source changed post-deploy),
redeploy with `pnpm --filter contracts deploy:testnet` and commit the
updated `testnet.json`.

## Build Details

- **Language**: Rust
- **Platform**: Stellar Soroban
- **Target**: `wasm32-unknown-unknown`
- **Build Tool**: Cargo + Stellar CLI
- **Workspace**: `packages/contract/Cargo.toml`

## Source of Truth: `pool` vs `cl-pool`

The `pool` contract is the **single source of truth (SoT)** for all pool
liquidity, tick state, and swap accounting. `cl-pool` is a **derived view**
over the same pool record: it exposes concentrated-liquidity helpers and
read-only projections but MUST NOT maintain parallel authoritative state.

Invariants (enforced by the API and contract layers):

- **Authoritative record**: the `pool` record (address, token pair, fee tier,
  `sqrt_price_x96`, `liquidity`, `tick`) is the only authority for balances,
  swaps, and admin actions. `cl-pool` never writes balances independently.
- **Derived fields**: any `cl-pool` field (e.g. tick spacing, price bounds,
  projected liquidity) is computed from the `pool` SoT and is read-only.
- **No parallel authority**: there is no second writer for liquidity or price.
  If `cl-pool` and `pool` ever disagree, `pool` wins and the derived view is
  recomputed.
- **Fail-closed reads**: if the `pool` SoT is unavailable, `cl-pool` reads fail
  closed with a stable error code rather than serving stale/derived state.
- **API parity**: `apps/api/src/pools` reads `cl-pool` data through the pool
  repository (SoT path); it does not open an independent data source.

See `SECURITY.md` for the deny-by-default policy on privileged surfaces and
`README.md` for contributor guidance on the pools module.

## Concentrated Liquidity Swap Math (Q64.96)

The `pool` contract implements concentrated liquidity swap math using Q64.96
fixed-point numbers, matching the `math-lib` primitives. The following
invariants MUST hold for every swap and are enforced by the contract:

- **Price representation**: `sqrt_price_x96` is a `u128` Q64.96 value, i.e.
  `sqrt_price_x96 = floor(sqrt(price) * 2^96)`. All price math uses this
  representation; no floating point is used anywhere on the money path.
- **Tick bounds**: `MIN_TICK`/`MAX_TICK` map to `MIN_SQRT_RATIO`/`MAX_SQRT_RATIO`.
  A swap MUST fail closed (stable error code) if the resulting price would
  cross these bounds rather than saturating silently.
- **Amount deltas**: `amount0`/`amount1` are computed from the Q64.96 price
delta and liquidity `L` using the standard CL formulas:
  - `amount0 = L * (sqrt_ratio_b - sqrt_ratio_a) / (sqrt_ratio_a * sqrt_ratio_b)`
  - `amount1 = L * (sqrt_ratio_b - sqrt_ratio_a)`
  with intermediate products widened to `u256` (or checked `u128`) to avoid
  overflow; results are truncated toward zero consistently for both directions.
- **Rounding direction**: input amounts round up, output amounts round down, so
  the pool never pays out more than the invariant allows.
- **Fee accounting**: fees are applied to the input amount before the price
  delta is computed; `amount_in_after_fee` is what drives the swap.
- **Conservation**: for a swap with no fee, `L` is unchanged and the product of
  the two reserves is non-decreasing across the step.

### Error codes

Swap math failures return stable `#[contracterror]` codes (see
`packages/contract/pool/src/error.rs`), including:

- `SqrtPriceOutOfBounds` — computed price outside `[MIN_SQRT_RATIO, MAX_SQRT_RATIO]`.
- `TickOutOfBounds` — target tick outside `[MIN_TICK, MAX_TICK]`.
- `InsufficientLiquidity` — no initialized liquidity at the target tick.
- `AmountOverflow` — Q64.96 intermediate overflowed the widened type.
- `ZeroLiquidity` — swap requested against an empty range.

### Authorization

Swap entrypoints are permissionless but MUST NOT allow a caller to bypass
slippage or price-limit policy: `sqrt_price_limit_x96` and `amount_out_min`
are validated against the computed result and the call fails closed on
violation. Liquidity mint/burn entrypoints are authorized against the
position owner; untrusted callers cannot mint or burn on behalf of another
position.

### Observability

Swap and liquidity events emit the pool address, tick range, and Q64.96
price deltas. No secrets, keys, or off-chain credentials are ever emitted in
events or logs.

## Key Fixes Applied

- Fixed missing `cl-pool/Cargo.toml` and workspace configuration
- Resolved cross-contract linking conflicts (cl-pool → position-nft)
- Fixed type compatibility (i16 → i32 for Soroban)
- Implemented proper error handling with `#[contracterror]`
- Replaced unsafe panic macros with error functions
- Fixed arithmetic overflow and panic safety issues
- Corrected Q64.96 concentrated liquidity swap math and documented invariants
- Documented `pool` as the single source of truth and `cl-pool` as a derived view

## Next Steps

- [ ] Add comprehensive contract tests
- [ ] Integrate with Stellar testnet
- [ ] Security audit preparation
- [ ] Documentation for contract interfaces

## Oracle / TWAP

`pool` and `cl-pool` record a post-swap observation with their `oracle-adapter`
instance after every swap (`sqrt_price_x96`, active liquidity, timestamp).
`get_twap(window_secs)` reads time-weighted average prices from that history.

One adapter registers exactly one pool (the only writer), so each pool gets its
own instance — `oracleAdapter` for `pool`, `clPoolOracleAdapter` for `cl-pool`.
Deploy-time wiring: `oracle.initialize(pool)` + `pool.set_oracle(oracle)` (the
deploy script does both). Swaps work without a wired oracle, but `get_twap`
then fails loudly instead of returning fabricated prices.
