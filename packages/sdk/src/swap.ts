/** Stellar contract address (56-char strkey starting with C). */
export type ContractAddress = `C${string}`;

/** Stellar account address (56-char strkey starting with G). */
export type AccountAddress = `G${string}`;

/** Unsigned 128-bit integer represented as a decimal string. */
export type U128String = string;

export interface SwapTxParams {
  /** Pool contract address. */
  poolId: ContractAddress;
  /** Contract address of the token being sold. */
  tokenInId: ContractAddress;
  /** Contract address of the token being bought. */
  tokenOutId: ContractAddress;
  /** Exact amount of tokenIn to sell, as a decimal string (e.g. "1000000"). */
  amountIn: U128String;
  /** Slippage-adjusted minimum amount of tokenOut to accept. */
  minimumReceived: U128String;
  /** Stellar account address of the swap initiator. */
  ownerAddress: AccountAddress;
}

export interface SwapUnsignedTx {
  /** Base64-encoded Soroban transaction XDR. */
  xdr: string;
  type: "swap";
}

/**
 * Builds an unsigned swap transaction XDR.
 * Stub — replace with real Soroban router contract invocation via stellar-sdk.
 */
export function buildSwapTx(params: SwapTxParams): SwapUnsignedTx {
  const payload = JSON.stringify({ op: "swap", ...params });
  const xdr = Buffer.from(payload).toString("base64");
  return { xdr, type: "swap" };
}
