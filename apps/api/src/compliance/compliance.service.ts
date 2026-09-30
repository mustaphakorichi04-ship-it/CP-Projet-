import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { TenantConnectionFactory } from '../database/tenant-connection.factory';
import { TenantContext, UserSessionDto } from '@cp-engineer/shared-types';

@Injectable()
export class ComplianceService {
  private readonly logger = new Logger(ComplianceService.name);

  constructor(private readonly connectionFactory: TenantConnectionFactory) {}

  /**
   * Export complet des données du tenant (RGPD Art. 20 - Portabilité des données)
   */
  async exportTenantData(tenant: TenantContext): Promise<Record<string, any>> {
    this.logger.log(`Génération de l'export de données complet pour le tenant ${tenant.tenantId}...`);

    return this.connectionFactory.executeWithTenantContext(tenant.tenantId, async (prisma) => {
      // 1. Informations sur le tenant
      const tenantInfo = await prisma.tenant.findUnique({
        where: { id: tenant.tenantId },
        select: {
          id: true,
          name: true,
          slug: true,
          plan: true,
          isolationMode: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      // 2. Utilisateurs de l'organisation (sans les hashs de mot de passe)
      const users = await prisma.user.findMany({
        where: { tenantId: tenant.tenantId },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
          createdAt: true,
        },
      });

      // 3. Projets d'infrastructures et calculs
      const projects = await prisma.project.findMany({
        where: { tenantId: tenant.tenantId },
      });

      // 4. Journal des calculs certifiés
      const calculationLogs = await prisma.calculationLog.findMany({
        where: { tenantId: tenant.tenantId },
        orderBy: { createdAt: 'desc' },
      });

      // 5. Quotas et historique d'usage
      const quotas = await prisma.apiQuota.findMany({
        where: { tenantId: tenant.tenantId },
      });

      return {
        exportMetadata: {
          formatVersion: '1.0',
          exportedAt: new Date().toISOString(),
          regulation: 'GDPR Article 20 / ISO 27001 Reversibility',
          tenantId: tenant.tenantId,
          organizationName: tenant.organizationName,
        },
        organization: tenantInfo,
        users,
        projects,
        calculationLogs,
        apiQuotas: quotas,
      };
    });
  }

  /**
   * Export des données d'un utilisateur individuel (RGPD Art. 20)
   */
  async exportUserData(tenant: TenantContext, userId: string, format: 'json' | 'csv'): Promise<any> {
    this.logger.log(`Génération de l'export de données (format ${format}) pour l'utilisateur ${userId}...`);

    return this.connectionFactory.executeWithTenantContext(tenant.tenantId, async (prisma) => {
      const user = await prisma.user.findUnique({
        where: { id: userId, tenantId: tenant.tenantId },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      if (!user) {
        throw new BadRequestException('Utilisateur introuvable.');
      }

      const projects = await prisma.project.findMany({
        where: { tenantId: tenant.tenantId, createdById: userId },
      });

      const calculationLogs = await prisma.calculationLog.findMany({
        where: { tenantId: tenant.tenantId, userId: userId },
        orderBy: { createdAt: 'desc' },
      });

      const exportData = {
        exportMetadata: {
          formatVersion: '1.0',
          exportedAt: new Date().toISOString(),
          regulation: 'GDPR Article 20 / Loi 18-07',
          userId: userId,
          tenantId: tenant.tenantId,
        },
        user,
        projects,
        calculationLogs,
      };

      if (format === 'csv') {
        // Conversion basique JSON vers CSV pour les logs d'activité
        let csv = 'Type,Date,Temps Execution (ms),Certifie\n';
        calculationLogs.forEach(log => {
          csv += `${log.type},${log.createdAt.toISOString()},${log.executionMs},${log.isCertified}\n`;
        });
        return csv;
      }

      return exportData;
    });
  }

  /**
   * Suppression définitive du tenant (RGPD Art. 17 - Droit à l'oubli)
   */
  async deleteTenantAccount(tenant: TenantContext, confirmationSlug: string): Promise<{ success: boolean; message: string }> {
    return this.connectionFactory.executeWithTenantContext(tenant.tenantId, async (prisma) => {
      const existing = await prisma.tenant.findUnique({
        where: { id: tenant.tenantId },
      });

      if (!existing) {
        throw new BadRequestException('Organisation introuvable.');
      }

      if (existing.slug !== confirmationSlug) {
        throw new BadRequestException(
          `Confirmation invalide : pour supprimer définitivement votre organisation, veuillez saisir exactement son identifiant ("${existing.slug}").`
        );
      }

      this.logger.warn(`DÉLÉTION IRRÉVERSIBLE DU TENANT : ${existing.name} (${existing.id})`);

      await prisma.tenant.delete({
        where: { id: tenant.tenantId },
      });

      return {
        success: true,
        message: `L'organisation "${existing.name}" et toutes ses données associées ont été définitivement supprimées.`,
      };
    });
  }

  /**
   * Suppression définitive d'un compte utilisateur (Droit à l'oubli)
   */
  async deleteUserAccount(tenant: TenantContext, userId: string, confirmationEmail: string): Promise<{ success: boolean; message: string }> {
    return this.connectionFactory.executeWithTenantContext(tenant.tenantId, async (prisma) => {
      const user = await prisma.user.findUnique({
        where: { id: userId, tenantId: tenant.tenantId },
      });

      if (!user) {
        throw new BadRequestException('Utilisateur introuvable.');
      }

      if (user.email !== confirmationEmail) {
        throw new BadRequestException('L\'email de confirmation ne correspond pas.');
      }

      this.logger.warn(`DÉLÉTION IRRÉVERSIBLE DE L'UTILISATEUR : ${user.email} (${userId})`);

      // La suppression de l'utilisateur mettra à SetNull les createdById des Projets et CalculationLogs (via Prisma schema)
      // Ceci permet l'anonymisation des données.
      await prisma.user.delete({
        where: { id: userId, tenantId: tenant.tenantId },
      });

      return {
        success: true,
        message: `Le compte utilisateur ${user.email} a été définitivement supprimé. Les données liées ont été anonymisées.`,
      };
    });
  }

  /**
   * Mise à jour des consentements de l'utilisateur (Cookies, CGU)
   */
  async updateUserConsent(tenant: TenantContext, userId: string, consentData: { hasAcceptedTerms?: boolean; cookieConsent?: Record<string, boolean> }): Promise<{ success: boolean }> {
    return this.connectionFactory.executeWithTenantContext(tenant.tenantId, async (prisma) => {
      const dataToUpdate: any = {};
      const now = new Date();

      if (consentData.hasAcceptedTerms !== undefined) {
        dataToUpdate.hasAcceptedTerms = consentData.hasAcceptedTerms;
        dataToUpdate.termsAcceptedAt = consentData.hasAcceptedTerms ? now : null;
      }

      if (consentData.cookieConsent !== undefined) {
        dataToUpdate.cookieConsent = consentData.cookieConsent;
        dataToUpdate.cookieConsentAt = now;
      }

      await prisma.user.update({
        where: { id: userId, tenantId: tenant.tenantId },
        data: dataToUpdate,
      });

      return { success: true };
    });
  }
}
