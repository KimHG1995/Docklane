import { Controller, Get } from '@nestjs/common';
import { Public } from './auth/auth.decorators.js';

@Controller('health')
export class HealthController {
  @Get()
  @Public()
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
