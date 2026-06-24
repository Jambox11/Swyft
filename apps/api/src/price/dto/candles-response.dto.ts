import { ApiProperty } from '@nestjs/swagger';
import { PriceCandleDto } from './price-candle.dto';

export class CandlesResponseDto {
  @ApiProperty({
    description: 'Array of candlestick data',
    type: [PriceCandleDto],
  })
  data: PriceCandleDto[];
}
