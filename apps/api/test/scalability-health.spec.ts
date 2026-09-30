import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TenantThrottlerGuard } from '../src/common/guards/tenant-throttler.guard';
import { HealthController } from '../src/health/health.controller';
import { HttpException, HttpStatus } from '@nestjs/common';

describe('Scalability, Rate Limiting & Health Tests', () => {
  let throttlerGuard: TenantThrottlerGuard;
  let healthController: HealthController;

  beforeEach(() => {
    throttlerGuard = new TenantThrottlerGuard();
    const mockFactory = {
      getClientForTenant: vi.fn().mockResolvedValue({
        $queryRaw: vi.fn().mockResolvedValue([{ 1: 1 }]),
      }),
    };
    healthController = new HealthController(mockFactory as any);
  });

  it('Health Check Liveness : renvoie le statut UP et les métriques d\'uptime', () => {
    const res = healthController.getLiveness();
    expect(res.status).toBe('UP');
    expect(res.version).toBe('9.6.0');
    expect(res.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('Rate Limiting : autorise les requêtes normales sous la limite du tenant', () => {
    const mockContext = {
      switchToHttp: () => ({
        getRequest: () => ({
          tenant: { tenantId: 'tenant-test-1', plan: 'PRO' },
          ip: '192.168.1.100',
        }),
      }),
    } as any;

    const allowed = throttlerGuard.canActivate(mockContext);
    expect(allowed).toBe(true);
  });

  it('Rate Limiting : bloque et lève une exception 429 lors d\'un dépassement de quota', () => {
    const mockContext = {
      switchToHttp: () => ({
        getRequest: () => ({
          tenant: { tenantId: 'tenant-spam-free', plan: 'FREE' }, // Limite 30 req/min
          ip: '192.168.1.50',
        }),
      }),
    } as any;

    // Simulation de 30 requêtes autorisées
    for (let i = 0; i < 30; i++) {
      expect(throttlerGuard.canActivate(mockContext)).toBe(true);
    }

    // La 31e requête doit être rejetée avec HTTP 429
    expect(() => throttlerGuard.canActivate(mockContext)).toThrow(HttpException);
    try {
      throttlerGuard.canActivate(mockContext);
    } catch (err: any) {
      expect(err.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect(err.getResponse().error).toBe('Too Many Requests');
    }
  });
});
