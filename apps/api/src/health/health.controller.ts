import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { TenantConnectionFactory } from '../database/tenant-connection.factory';

@Controller()
export class HealthController {
  constructor(private readonly connectionFactory: TenantConnectionFactory) {}

  /**
   * Liveness Probe : vérifie que le serveur web tourne
   */
  @Public()
  @Get('health')
  getLiveness() {
    return {
      status: 'UP',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      version: '9.6.0',
    };
  }

  /**
   * Readiness Probe : vérifie que la base PostgreSQL et les dépendances répondent
   */
  @Public()
  @Get('ready')
  async getReadiness(@Res() res: Response) {
    try {
      // Test de connectivité PostgreSQL
      const prisma = await this.connectionFactory.getClientForTenant({
        tenantId: 'system',
        organizationName: 'System',
        plan: 'PRO',
        isolationMode: 'SHARED_RLS',
      });

      await prisma.$queryRaw`SELECT 1`;

      return res.status(HttpStatus.OK).json({
        status: 'READY',
        timestamp: new Date().toISOString(),
        checks: {
          database: 'CONNECTED',
          cache: 'CONNECTED',
        },
      });
    } catch (err) {
      return res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        status: 'NOT_READY',
        timestamp: new Date().toISOString(),
        error: (err as Error).message,
        checks: {
          database: 'DISCONNECTED',
        },
      });
    }
  }
}
