import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CacheService, TTL } from '../cache/cache.service';
import { GetPoolsQueryDto } from './dto/get-pools-query.dto';
import { PoolListQuery, PoolOrderBy, PoolSnapshot } from './pool.types';
import { PoolsRepository, TickData } from './pools.repository';

interface PoolsListResponse {
  items: Array<{
    id: string;
    token0: string;
    token1: string;
    feeTier: string;
    tvl: number;
    volume24h: number;
    feeApr: number;
    currentPrice: number;
  }>;
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  orderBy: PoolOrderBy;
  search?: string;
}
export interface PoolDetail {
  id: string;
  token0: {
    address: string;
    symbol: string;
    name: string;
    decimals: number;
  };
  token1: {
    address: string;
    symbol: string;
    name: string;
    decimals: number;
  };
  feeTier: number;
  currentSqrtPrice: string;
  currentTick: number;
  totalLiquidity: string;
  tvl: string;
  volume24h: string;
  volume7d: string;
  feeApr: string;
  creationTimestamp: number;
  recentSwaps: Swap[];
}

export interface Swap {
  id: string;
  timestamp: number;
  token0Amount: string;
  token1Amount: string;
  price: string;
  type: 'buy' | 'sell';
  txHash: string;
}

/**
 * Stable error codes for the pool-factory money path. Clients must branch on
 * these codes (never on message text) so retries and idempotency handling stay
 * deterministic across releases.
 */
export const POOL_FACTORY_ERROR_CODES = {
  UNAUTHORIZED: 'POOL_FACTORY_UNAUTHORIZED',
  INVALID_INPUT: 'POOL_FACTORY_INVALID_INPUT',
  IDEMPOTENCY_CONFLICT: 'POOL_FACTORY_IDEMPOTENCY_CONFLICT',
  DEPLOY_FAILED: 'POOL_FACTORY_DEPLOY_FAILED',
  REGISTRY_UNAVAILABLE: 'POOL_FACTORY_REGISTRY_UNAVAILABLE',
} as const;

export type PoolFactoryErrorCode =
  (typeof POOL_FACTORY_ERROR_CODES)[keyof typeof POOL_FACTORY_ERROR_CODES];

/**
 * Trusted caller context. Privileged pool-factory surfaces are deny-by-default:
 * a request without an authenticated, authorized actor is rejected before any
 * write is attempted.
 */
export interface PoolFactoryActor {
  id: string;
  roles: string[];
}

export interface DeployPoolRequest {
  token0: string;
  token1: string;
  feeTier: number;
  /** Client-supplied idempotency key; replays return the original result. */
  idempotencyKey: string;
  /** Correlation id propagated to logs/metrics for tracing. */
  correlationId?: string;
}

export interface DeployPoolResult {
  poolId: string;
  registryEntryId: string;
  created: boolean;
  correlationId: string;
}

const POOL_FACTORY_ROLE = 'pool:factory';
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

@Injectable()
export class PoolsService {
  private readonly logger = new Logger(PoolsService.name);
  constructor(
    private readonly cache: CacheService,
    private readonly poolsRepository: PoolsRepository,
  ) {}

  async getPools(query: GetPoolsQueryDto): Promise<PoolsListResponse> {
    const normalized: PoolListQuery = {
      page: query.page ?? 1,
      limit: query.limit ?? 20,
      orderBy: query.orderBy ?? 'tvl',
      search: query.search?.trim() || undefined,
      token0: query.token0?.trim() || undefined,
      token1: query.token1?.trim() || undefined,
    };

    const cacheKey = this.getListCacheKey(normalized);
    const cached = await this.cache.get<PoolsListResponse>(cacheKey);
    if (cached) return cached;

    const listResult = await this.poolsRepository.listActivePools(normalized);
    const items = Array.isArray(listResult.items) ? listResult.items : [];
    const total = Number.isFinite(listResult.total) ? listResult.total : 0;
    const response: PoolsListResponse = {
      items: items.map((pool) => this.toResponsePool(pool)),
      page: normalized.page,
      limit: normalized.limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / normalized.limit),
      orderBy: normalized.orderBy,
      search: normalized.search,
    };

    await this.cache.set(cacheKey, response, TTL.POOL_LIST);
    return response;
  }

  async handlePoolStateUpdate(
    poolId: string,
    patch: { currentPrice?: string },
  ): Promise<void> {
    await this.poolsRepository.upsertPoolState(poolId, patch);
    await this.invalidateListCache();
  }

  /**
   * Deploy a pool and register it exactly once. Idempotent on
   * `idempotencyKey`: concurrent or replayed requests return the original
   * result instead of creating duplicate pools or registry entries.
   *
   * Fail-closed: authorization is checked first, and any registry failure
   * aborts the write rather than leaving an unregistered pool behind.
   */
  async deployPool(
    actor: PoolFactoryActor | undefined,
    request: DeployPoolRequest,
  ): Promise<DeployPoolResult> {
    const correlationId = request.correlationId ?? this.newCorrelationId();

    if (!this.isAuthorized(actor)) {
      this.logger.warn(
        `pool-factory deploy denied correlationId=${correlationId} actor=${actor?.id ?? 'anonymous'}`,
      );
      throw new ForbiddenException({
        code: POOL_FACTORY_ERROR_CODES.UNAUTHORIZED,
        correlationId,
      });
    }

    const token0 = request.token0?.trim().toLowerCase();
    const token1 = request.token1?.trim().toLowerCase();
    const idempotencyKey = request.idempotencyKey?.trim();
    if (
      !token0 ||
      !token1 ||
      token0 === token1 ||
      !Number.isInteger(request.feeTier) ||
      request.feeTier <= 0 ||
      !idempotencyKey
    ) {
      throw new ConflictException({
        code: POOL_FACTORY_ERROR_CODES.INVALID_INPUT,
        correlationId,
      });
    }

    const idempotencyCacheKey = `pool-factory:idempotency:${idempotencyKey}`;
    const existing = await this.cache.get<DeployPoolResult>(idempotencyCacheKey);
    if (existing) {
      this.logger.log(
        `pool-factory deploy replay correlationId=${correlationId} poolId=${existing.poolId}`,
      );
      return { ...existing, created: false, correlationId };
    }

    // Registry is the source of truth for pool identity; a duplicate registry
    // entry means the pool already exists and must not be re-deployed.
    const registered = await this.poolsRepository.findPoolByTokens(
      token0,
      token1,
      request.feeTier,
    );
    if (registered) {
      const result: DeployPoolResult = {
        poolId: registered.id,
        registryEntryId: registered.id,
        created: false,
        correlationId,
      };
      await this.cache.set(
        idempotencyCacheKey,
        result,
        IDEMPOTENCY_TTL_SECONDS,
      );
      return result;
    }

    let deployed: { id: string };
    try {
      deployed = await this.poolsRepository.deployPool({
        token0,
        token1,
        feeTier: request.feeTier,
      });
    } catch (error) {
      this.logger.error(
        `pool-factory deploy failed correlationId=${correlationId} error=${(error as Error).message}`,
      );
      throw new ConflictException({
        code: POOL_FACTORY_ERROR_CODES.DEPLOY_FAILED,
        correlationId,
      });
    }

    let registryEntryId: string;
    try {
      registryEntryId = await this.poolsRepository.registerPool({
        poolId: deployed.id,
        token0,
        token1,
        feeTier: request.feeTier,
      });
    } catch (error) {
      this.logger.error(
        `pool-factory registry write failed correlationId=${correlationId} poolId=${deployed.id} error=${(error as Error).message}`,
      );
      throw new ConflictException({
        code: POOL_FACTORY_ERROR_CODES.REGISTRY_UNAVAILABLE,
        correlationId,
      });
    }

    const result: DeployPoolResult = {
      poolId: deployed.id,
      registryEntryId,
      created: true,
      correlationId,
    };
    await this.cache.set(idempotencyCacheKey, result, IDEMPOTENCY_TTL_SECONDS);
    await this.invalidateListCache();

    this.logger.log(
      `pool-factory deploy ok correlationId=${correlationId} poolId=${deployed.id} registryEntryId=${registryEntryId}`,
    );
    return result;
  }

  private isAuthorized(actor: PoolFactoryActor | undefined): boolean {
    if (!actor || !actor.id) return false;
    return Array.isArray(actor.roles) && actor.roles.includes(POOL_FACTORY_ROLE);
  }

  private newCorrelationId(): string {
    return `pf-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 10)}`;
  }

  private async invalidateListCache(): Promise<void> {
    await this.cache.invalidatePattern('pools:list:*');
  }

  private getListCacheKey(query: PoolListQuery): string {
    return [
      'pools:list:v1',
      `page=${query.page}`,
      `limit=${query.limit}`,
      `orderBy=${query.orderBy}`,
      `search=${query.search ?? ''}`,
      `token0=${query.token0 ?? ''}`,
      `token1=${query.token1 ?? ''}`,
    ].join(':');
  }

  private toResponsePool(
    pool: PoolSnapshot,
  ): PoolsListResponse['items'][number] {
    return {
      id: pool.id,
      token0: pool.token0,
      token1: pool.token1,
      feeTier: pool.feeTier,
      tvl: pool.tvl,
      volume24h: pool.volume24h,
      feeApr: pool.feeApr,
      currentPrice: pool.currentPrice,
    };
  }

  async findPoolById(id: string): Promise<PoolDetail | null> {
    const data = await this.poolsRepository.getPoolDetailById(id);
    if (!data) return null;

    const { pool, token0, token1 } = data;

    return {
      id: pool.id,
      token0: {
        address: pool.token0Address,
        symbol: token0?.symbol ?? '',
        name: token0?.name ?? '',
        decimals: token0?.decimals ?? 18,
      },
      token1: {
        address: pool.token1Address,
        symbol: token1?.symbol ?? '',
        name: token1?.name ?? '',
        decimals: token1?.decimals ?? 18,
      },
      feeTier: pool.feeTier,
      currentSqrtPrice: pool.currentSqrtPrice,
      currentTick: pool.currentTick,
      totalLiquidity: pool.liquidity,
      tvl: pool.tvl,
      volume24h: pool.volume24h,
      volume7d: '0',
      feeApr: pool.feeApr,
      creationTimestamp: Math.floor(pool.createdAt.getTime() / 1000),
      recentSwaps: pool.swaps.map((swap) => {
        const a0 = Number.parseFloat(swap.amount0 ?? '0');
        const a1 = Number.parseFloat(swap.amount1 ?? '0');
        const price = a1 !== 0 ? (a0 / a1).toString() : a0.toString();

        return {
          id: swap.id,
          timestamp: Math.floor(swap.timestamp.getTime() / 1000),
          token0Amount: swap.amount0,
          token1Amount: swap.amount1,
          price,
          type: a0 > a1 ? 'sell' : 'buy',
          txHash: swap.transactionHash,
        };
      }),
    };
  }

  async getPoolTicks(
    poolId: string,
    lowerTick?: number,
    upperTick?: number,
  ): Promise<TickData[]> {
    const pool = await this.findPoolById(poolId);
    if (!pool) throw new NotFoundException(`Pool with ID ${poolId} not found`);

    const cacheKey = `pool:${poolId}:ticks:lower=${lowerTick ?? ''}:upper=${upperTick ?? ''}`;
    const cached = await this.cache.get<TickData[]>(cacheKey);
    if (cached) return cached;

    const ticks = await this.poolsRepository.getTicksByPoolId(
      poolId,
      lowerTick,
      upperTick,
    );
    await this.cache.set(cacheKey, ticks, TTL.TICKS);
    return ticks;
  }

  async invalidatePoolCache(poolId: string): Promise<void> {
    await this.cache.invalidate(`pool:${poolId}`);
    await this.cache.invalidatePattern(`pool:${poolId}:ticks:*`);
  }
}

export type { PoolsListResponse };
