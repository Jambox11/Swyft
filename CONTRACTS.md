# Swyft Smart Contracts

All 9 Swyft smart contracts compile and build successfully.

## Contracts

| Contract         | Purpose                     | Status |
| ---------------- | --------------------------- | ------ |
| `hello-world`    | Example contract            | ✅     |
| `math-lib`       | Fixed-point math (Q64.96)   | ✅     |
| `pool`           | Concentrated liquidity pool | ✅     |
| `pool-factory`   | Pool deployment & registry  | ✅     |
| `router`         | Single-hop swap routing     | ✅     |
| `position-nft`   | Liquidity position NFTs     | ✅     |
| `fee-collector`  | Fee accumulation            | ✅     |
| `oracle-adapter` | TWAP oracle                 | ✅     |
| `cl-pool`        | Additional pool logic       | ✅     |

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

## Validation

Run the contract validation CLI:

```bash
pnpm validate:contracts
```

Output:

```
Building hello-world... ✓
Building math-lib... ✓
Building pool... ✓
...
Passed: 9/9
All Swyft contracts validated!
```

## Build Details

- **Language**: Rust
- **Platform**: Stellar Soroban
- **Target**: `wasm32-unknown-unknown`
- **Build Tool**: Cargo + Stellar CLI
- **Workspace**: `packages/contract/Cargo.toml`

## Key Fixes Applied

- Fixed missing `cl-pool/Cargo.toml` and workspace configuration
- Resolved cross-contract linking conflicts (cl-pool → position-nft)
- Fixed type compatibility (i16 → i32 for Soroban)
- Implemented proper error handling with `#[contracterror]`
- Replaced unsafe panic macros with error functions
- Fixed arithmetic overflow and panic safety issues

## Next Steps

- [ ] Add comprehensive contract tests
- [ ] Integrate with Stellar testnet
- [ ] Security audit preparation
- [ ] Documentation for contract interfaces
