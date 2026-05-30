import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CacheService } from '../cache/cache.service';
import { GetPoolsQueryDto } from './dto/get-pools-query.dto';
import { GetTicksQueryDto } from './dto/get-ticks-query.dto';
import { TickData } from './pools.repository';
import { PoolsListResponse, PoolsService } from './pools.service';

@ApiTags('pools')
@Controller('pools')
export class PoolsController {
  constructor(
    private readonly poolsService: PoolsService,
    private readonly cacheService: CacheService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List active pools' })
  @ApiResponse({
    status: 200,
    description: 'Returns a paginated list of pools. Items array is empty when no pools match.',
  })
  /**
   * Returns a paginated list of active pools.
   *
   * @param query - Pagination and filter options (page, limit, feeTier, token).
   * @returns A paginated response containing pool summaries and total count.
   */
  async getPools(@Query() query: GetPoolsQueryDto): Promise<PoolsListResponse> {
    const result = await this.poolsService.getPools(query);

    // Empty result is valid — return it as-is so the UI can render an empty state
    return result;
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get pool details by ID' })
  @ApiParam({ name: 'id', description: 'Pool ID (cuid or contract address)' })
  @ApiResponse({ status: 200, type: PoolDetailDto, description: 'Pool details retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Pool not found' })
  /**
   * Returns full details for a single pool, including token pair, fee tier, and current price.
   * Results are cached for 15 seconds.
   *
   * @param id - Pool ID (cuid) or Soroban contract address.
   * @returns Pool detail object.
   * @throws NotFoundException when no pool matches the given ID.
   */
  async getPoolById(@Param('id') id: string): Promise<PoolDetailDto> {
    const cacheKey = `pool:${id}`;

    const cached = await this.cacheService.get(cacheKey);
    if (cached) {
      return cached;
    }

    const pool = await this.poolsService.findPoolById(id);
    if (!pool) {
      throw new NotFoundException(
        `Pool with ID "${id}" not found. Check the ID and try again.`,
      );
    }

    await this.cacheService.set(cacheKey, pool, 15);
    return pool;
  }

  @Get(':id/ticks')
  @ApiOperation({ summary: 'Get initialized ticks for a pool' })
  @ApiParam({ name: 'id', description: 'Pool ID (cuid or contract address)' })
  @ApiQuery({ name: 'lowerTick', required: false, type: Number })
  @ApiQuery({ name: 'upperTick', required: false, type: Number })
  @ApiResponse({
    status: 200,
    description:
      'Tick data returned in ascending order. Returns an empty array when no ticks exist in the requested range.',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        required: ['tickIndex', 'liquidityNet', 'liquidityGross', 'feeGrowthOutside0X128', 'feeGrowthOutside1X128'],
        properties: {
          tickIndex: { type: 'number', description: 'Tick index' },
          liquidityNet: { type: 'string', description: 'Net liquidity change at this tick' },
          liquidityGross: { type: 'string', description: 'Gross liquidity at this tick' },
          feeGrowthOutside0X128: { type: 'string', description: 'Fee growth outside for token0' },
          feeGrowthOutside1X128: { type: 'string', description: 'Fee growth outside for token1' },
        },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Invalid tick range' })
  @ApiResponse({ status: 404, description: 'Pool not found' })
  /**
   * Returns initialized tick data for a pool, optionally filtered to a tick range.
   * Ticks are returned in ascending order by tick index.
   *
   * @param id - Pool ID (cuid) or Soroban contract address.
   * @param query - Optional `lowerTick` and `upperTick` bounds (inclusive). If omitted, all ticks are returned.
   * @returns Array of tick data objects. Empty array when the pool has no ticks in the requested range.
   * @throws NotFoundException when no pool matches the given ID.
   * @throws BadRequestException when `lowerTick` is greater than `upperTick`.
   */
  async getPoolTicks(
    @Param('id') id: string,
    @Query() query: GetTicksQueryDto,
  ): Promise<TickData[]> {
    const pool = await this.poolsService.findPoolById(id);
    if (!pool) {
      throw new NotFoundException(
        `Pool with ID "${id}" not found. Check the ID and try again.`,
      );
    }

    if (
      query.lowerTick !== undefined &&
      query.upperTick !== undefined &&
      query.lowerTick > query.upperTick
    ) {
      throw new BadRequestException(
        'lowerTick must be less than or equal to upperTick.',
      );
    }

    // Empty array is a valid response — the pool exists but has no ticks in this range
    return this.poolsService.getPoolTicks(id, query.lowerTick, query.upperTick);
  }
}
