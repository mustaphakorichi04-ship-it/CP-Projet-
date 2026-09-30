import { Controller, Post, UseGuards } from '@nestjs/common';
import { AlertingService } from './alerting.service';
import { TenantConnectionFactory } from '../database/tenant-connection.factory';
import { AuthGuard } from '../auth/guards/auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller('api/v1/operations')
export class OperationsController {
  constructor(
    private readonly alertingService: AlertingService,
    private readonly connectionFactory: TenantConnectionFactory,
  ) {}

  /**
   * Endpoint de type "Job" (peut être appelé par un CRON externe via un token système)
   * Vérifie les quotas de tous les Tenants et déclenche des alertes si nécessaires
   */
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('ADMIN') // Dans la vraie vie, un rôle 'SYSTEM' serait idéal
  @Post('check-quotas')
  async checkQuotasAndAlert() {
    const prisma = await this.connectionFactory.getClientForTenant({
      tenantId: 'system',
      organizationName: 'System',
      plan: 'PRO',
      isolationMode: 'SHARED_RLS',
      status: 'ACTIVE'
    });

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const quotas = await prisma.apiQuota.findMany({
      where: { periodStart: { gte: startOfMonth } },
      include: { tenant: true },
    });

    let alertsTriggered = 0;

    for (const quota of quotas) {
      const usagePercentage = (quota.usedUnits / quota.includedUnits) * 100;
      
      // 1. Alerte Dépassement 100%
      if (usagePercentage >= 100 && quota.overageUnits === 0) { // Si c'est le premier dépassement
        await this.alertingService.sendAlert({
          level: 'WARNING',
          title: '🚨 Dépassement de Quota (100%)',
          message: `L'organisation ${quota.tenant.name} a consommé 100% de son forfait. Le tarif 'overage' s'applique.`,
          metadata: { tenantId: quota.tenantId, used: quota.usedUnits, plan: quota.tenant.plan }
        });
        alertsTriggered++;
      } 
      // 2. Alerte Prévention 80%
      else if (usagePercentage >= 80 && usagePercentage < 100) {
        await this.alertingService.sendAlert({
          level: 'INFO',
          title: '⚠️ Quota bientôt atteint (80%)',
          message: `L'organisation ${quota.tenant.name} a consommé ${Math.round(usagePercentage)}% de son forfait.`,
          metadata: { tenantId: quota.tenantId, used: quota.usedUnits, included: quota.includedUnits }
        });
        alertsTriggered++;
      }
    }

    return { success: true, checked: quotas.length, alertsTriggered };
  }
}
