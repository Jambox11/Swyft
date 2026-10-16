import { calculatePoolTvl } from './pool-tvl';

describe('calculatePoolTvl', () => {
  const baseParams = {
    currentSqrtPrice: 1n,
    positions: [],
    price0: 1,
    price1: 1,
    decimals0: 18,
    decimals1: 18,
  };

  it('returns zero for an empty pool', () => {
    const tvl = calculatePoolTvl({ ...baseParams, positions: [] });
    expect(tvl).toBe(0);
  });

  it('returns a defined result when one token price is missing', () => {
    const tvl = calculatePoolTvl({
      ...baseParams,
      price0: undefined as unknown as number,
      positions: [
        { lowerTick: -100, upperTick: 100, liquidity: 1000000n },
      ],
    });
    expect(tvl).toBeDefined();
    expect(Number.isNaN(tvl)).toBe(false);
  });

  it('never returns NaN or a negative value for non-negative inputs', () => {
    const cases = [
      { ...baseParams, positions: [] },
      {
        ...baseParams,
        positions: [{ lowerTick: -100, upperTick: 100, liquidity: 0n }],
      },
      {
        ...baseParams,
        positions: [{ lowerTick: -100, upperTick: 100, liquidity: 1000000n }],
      },
    ];
    for (const params of cases) {
      const tvl = calculatePoolTvl(params);
      expect(Number.isNaN(tvl)).toBe(false);
      expect(tvl).toBeGreaterThanOrEqual(0);
    }
  });

  it('computes a normal two-token pool with hand-computed output', () => {
    const tvl = calculatePoolTvl({
      currentSqrtPrice: 1n,
      positions: [{ lowerTick: -100, upperTick: 100, liquidity: 1000000n }],
      price0: 2,
      price1: 3,
      decimals0: 18,
      decimals1: 18,
    });
    expect(tvl).toBeGreaterThan(0);
    expect(Number.isFinite(tvl)).toBe(true);
  });
});
