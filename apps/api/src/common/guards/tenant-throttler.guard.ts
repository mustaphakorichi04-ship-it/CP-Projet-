import { Injectable, CanActivate, ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';

interface ThrottleRecord {
  count: number;
  resetAt: number;
}

@Injectable()
export class TenantThrottlerGuard implements CanActivate {
  // Cache mémoire en cluster local (ou relayé à Redis en production)
  private readonly records = new Map<string, ThrottleRecord>();

  // Fenêtre de 60 secondes par défaut
  private readonly ttlMs = parseInt(process.env.THROTTLE_TTL_MS || '60000', 10);
  
  // Limites par défaut selon le plan du tenant
  private readonly defaultLimits: Record<string, number> = {
    FREE: 30,          // 30 req/min
    PRO: 120,          // 120 req/min
    ENTERPRISE: 600,   // 600 req/min
    ANONYMOUS: 20,     // 20 req/min par IP
  };

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const now = Date.now();

    // 1. Détermination de la clé de limitation (priorité au tenantId, sinon IP)
    const tenant = request.tenant;
    const ip = request.ip || request.connection?.remoteAddress || '127.0.0.1';
    
    let key: string;
    let limit: number;

    if (tenant && tenant.tenantId) {
      key = `tenant:${tenant.tenantId}`;
      limit = this.defaultLimits[tenant.plan] || this.defaultLimits.PRO;
    } else {
      key = `ip:${ip}`;
      limit = this.defaultLimits.ANONYMOUS;
    }

    // 2. Gestion de la fenêtre glissante
    let record = this.records.get(key);
    if (!record || now > record.resetAt) {
      record = {
        count: 1,
        resetAt: now + this.ttlMs,
      };
      this.records.set(key, record);
      return true;
    }

    record.count++;

    // 3. Vérification du dépassement
    if (record.count > limit) {
      const retryAfterSec = Math.ceil((record.resetAt - now) / 1000);
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          message: `Limite de requêtes atteinte pour votre organisation (${limit} req/min). Réessayez dans ${retryAfterSec}s.`,
          retryAfter: retryAfterSec,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}
