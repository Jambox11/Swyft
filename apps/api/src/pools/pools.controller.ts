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
import { GetPoolsQueryDto } from './dto/get-pools-query.dto';
import { GetTicksQueryDto } from './dto/get-ticks-query.dto';
import { PoolDetailDto } from './dto/pool-detail.dto';
import { PoolsListResponse, PoolsService } from './pools.service';
import { TickData } from './pools.repository';
import { CacheService } from '../cache/cache.service';

@ApiTags('pools')
@Controller('pools')
export class PoolsController {
  constructor(
    private readonly poolsService: PoolsService,
    private readonly cacheService: CacheService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List all active pools' })
  @ApiResponse({ status: 200, description: 'Paginated list of pools' })
  getPools(@Query() query: GetPoolsQueryDto): Promise<PoolsListResponse> {
    return this.poolsService.getPools(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get pool details by ID' })
  @ApiParam({ name: 'id', description: 'Pool ID (cuid or contract address)' })
  @ApiResponse({ status: 200, type: PoolDetailDto, description: 'Pool details retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Pool not found' })
  async getPoolById(@Param('id') id: string): Promise<PoolDetailDto> {
    const cacheKey = `pool:${id}`;

    const cached = await this.cacheService.get<PoolDetailDto>(cacheKey);
    if (cached) {
      return cached;
    }

    const pool = await this.poolsService.findPoolById(id);
    if (!pool) {
      throw new NotFoundException(`Pool with ID ${id} not found`);
    }

    await this.cacheService.set(cacheKey, pool, 15);

    return pool as unknown as PoolDetailDto;
  }

  @Get(':id/ticks')
  @ApiOperation({ summary: 'Get initialized ticks for a pool' })
  @ApiParam({ name: 'id', description: 'Pool ID (cuid or contract address)' })
  @ApiQuery({ name: 'lowerTick', required: false, type: Number, description: 'Lower bound tick index (inclusive)' })
  @ApiQuery({ name: 'upperTick', required: false, type: Number, description: 'Upper bound tick index (inclusive)' })
  @ApiResponse({
    status: 200,
    description: 'Tick data returned in ascending order',
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
  @ApiResponse({ status: 400, description: 'Invalid tick range — lowerTick must be ≤ upperTick' })
  @ApiResponse({ status: 404, description: 'Pool not found' })
  async getPoolTicks(
    @Param('id') poolId: string,
    @Query() query: GetTicksQueryDto,
  ): Promise<TickData[]> {
    const pool = await this.poolsService.findPoolById(poolId);
    if (!pool) {
      throw new NotFoundException(`Pool with ID ${poolId} not found`);
    }

    if (query.lowerTick !== undefined && query.upperTick !== undefined) {
      if (query.lowerTick > query.upperTick) {
        throw new BadRequestException('lowerTick must be less than or equal to upperTick');
      }
    }

    return this.poolsService.getPoolTicks(poolId, query.lowerTick, query.upperTick);
  }
}
