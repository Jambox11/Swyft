import { Module } from '@nestjs/common';
import { CacheModule } from '../cache/cache.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PoolsController } from './pools.controller';
import { PoolsRepository } from './pools.repository';
import { PoolsService } from './pools.service';
import { PoolFactoryService } from './pool-factory.service';
import { PoolRegistryService } from './pool-registry.service';

@Module({
  imports: [CacheModule, PrismaModule],
  controllers: [PoolsController],
  providers: [
    PoolsRepository,
    PoolsService,
    PoolFactoryService,
    PoolRegistryService,
  ],
  exports: [PoolsService, PoolFactoryService, PoolRegistryService],
})
export class PoolsModule {}
