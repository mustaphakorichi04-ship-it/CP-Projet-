import { Injectable, Logger } from '@nestjs/common';
import { TenantConnectionFactory } from '../database/tenant-connection.factory';
import { TenantContext } from '@cp-engineer/shared-types';

@Injectable()
export class CalculationAuditService {
  private readonly logger = new Logger(CalculationAuditService.name);

  constructor(private readonly connectionFactory: TenantConnectionFactory) {}

  /**
   * Enregistre un calcul certifié dans le journal d'audit et incrémente le quota API
   */
  async recordCalculation(
    tenant: TenantContext,
    type: 'SACP' | 'ICCP' | 'GROUNDBED' | 'ATTENUATION' | 'INTERFERENCE' | 'CABLE_SIZING',
    inputs: any,
    outputs: any,
    executionMs: number,
    userId?: string,
    projectId?: string,
  ): Promise<void> {
    try {
      await this.connectionFactory.executeWithTenantContext(tenant.tenantId, async (prisma) => {
        // 1. Insertion dans le journal d'audit
        await prisma.calculationLog.create({
          data: {
            tenantId: tenant.tenantId,
            userId: userId || null,
            projectId: projectId || null,
            type,
            inputs: inputs || {},
            outputs: outputs || {},
            isCertified: true,
            executionMs,
          },
        });

        // 2. Incrémentation du compteur de quota mensuel
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

        await prisma.apiQuota.upsert({
          where: {
            tenantId_periodStart: {
              tenantId: tenant.tenantId,
              periodStart: startOfMonth,
            },
          },
          update: {
            usedUnits: { increment: 1 },
          },
          create: {
            tenantId: tenant.tenantId,
            periodStart: startOfMonth,
            periodEnd: endOfMonth,
            includedUnits: tenant.plan === 'PRO' ? 500 : 100,
            usedUnits: 1,
            overageUnits: 0,
          },
        });
      });
    } catch (err) {
      // Le journal d'audit ne doit jamais bloquer la réponse de calcul à l'utilisateur
      this.logger.error(`Erreur d'audit calcul pour tenant ${tenant.tenantId}:`, err);
    }
  }
}
