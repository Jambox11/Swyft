jest.mock(
  '@prisma/client',
  () => {
    const mockInstance = {
      token: { upsert: jest.fn() },
      pool: { upsert: jest.fn() },
      position: { upsert: jest.fn() },
      swap: { createMany: jest.fn() },
      priceCandle: { createMany: jest.fn() },
      $disconnect: jest.fn(),
    };
    (global as any).mockPrismaInstance = mockInstance;
    return {
      PrismaClient: jest.fn().mockImplementation(() => mockInstance),
    };
  },
  { virtual: true },
);

import { main } from '../../../prisma/seed';

const getMockPrisma = () => (global as any).mockPrismaInstance;

// Mock stdout and console to keep output clean during tests
const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
const setIntervalSpy = jest.spyOn(global, 'setInterval').mockImplementation(((cb: any) => 123 as any) as any);
const clearIntervalSpy = jest.spyOn(global, 'clearInterval').mockImplementation(() => {});

describe('Prisma Seed', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    stdoutSpy.mockRestore();
    consoleSpy.mockRestore();
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });

  it('should seed the database successfully with all models', async () => {
    const mockPrisma = getMockPrisma();
    
    // Setup mock implementations for the chain
    mockPrisma.token.upsert.mockResolvedValueOnce({ symbol: 'USDC', address: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' });
    mockPrisma.token.upsert.mockResolvedValueOnce({ symbol: 'XLM', address: 'GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR' });
    
    mockPrisma.pool.upsert.mockResolvedValueOnce({ id: 'test-pool-1' });
    mockPrisma.position.upsert.mockResolvedValueOnce({ id: 'test-position-1' });
    mockPrisma.swap.createMany.mockResolvedValueOnce({ count: 2 });
    mockPrisma.priceCandle.createMany.mockResolvedValueOnce({ count: 1 });

    // Execute the seed main function
    await expect(main()).resolves.not.toThrow();

    // Verify all mock methods were called correctly
    expect(mockPrisma.token.upsert).toHaveBeenCalledTimes(2);
    expect(mockPrisma.pool.upsert).toHaveBeenCalledTimes(1);
    expect(mockPrisma.position.upsert).toHaveBeenCalledTimes(1);
    expect(mockPrisma.swap.createMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.priceCandle.createMany).toHaveBeenCalledTimes(1);

    // Verify correct seed data structure is passed
    expect(mockPrisma.token.upsert).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: { address: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' },
      create: expect.objectContaining({
        symbol: 'USDC',
        decimals: 6,
      }),
    }));

    expect(mockPrisma.token.upsert).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { address: 'GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR' },
      create: expect.objectContaining({
        symbol: 'XLM',
        decimals: 7,
      }),
    }));

    expect(mockPrisma.pool.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'test-pool-1' },
      create: expect.objectContaining({
        feeTier: 3000,
      }),
    }));

    expect(mockPrisma.position.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'test-position-1' },
      create: expect.objectContaining({
        poolId: 'test-pool-1',
        lowerTick: -60,
        upperTick: 60,
      }),
    }));

    expect(mockPrisma.swap.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.arrayContaining([
        expect.objectContaining({ transactionHash: 'test-tx-1' }),
        expect.objectContaining({ transactionHash: 'test-tx-2' }),
      ]),
    }));

    expect(mockPrisma.priceCandle.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.arrayContaining([
        expect.objectContaining({
          open: 1.0,
          high: 1.05,
          low: 0.95,
          close: 1.02,
          volumeUsd: 1000000.0,
          interval: '1h',
        }),
      ]),
    }));
  });

  it('should propagate errors if any DB seed step fails', async () => {
    const mockPrisma = getMockPrisma();
    const dbError = new Error('Database connection failed');
    mockPrisma.token.upsert.mockRejectedValueOnce(dbError);

    await expect(main()).rejects.toThrow('Database connection failed');
  });
});
