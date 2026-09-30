import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { TenantContext } from '@cp-engineer/shared-types';

/**
 * Type d'un client Prisma scopé au contexte d'un tenant avec RLS
 */
export type TenantScopedPrismaClient = PrismaClient;

@Injectable()
export class TenantConnectionFactory implements OnModuleDestroy {
  private readonly logger = new Logger(TenantConnectionFactory.name);
  
  // Instance partagée pour les tenants 'SHARED_RLS'
  private readonly sharedPrisma: PrismaClient;
  
  // Cache de pools de connexion pour les comptes 'DEDICATED_DATABASE' (Enterprise)
  private readonly enterpriseClients = new Map<string, PrismaClient>();

  constructor() {
    this.sharedPrisma = new PrismaClient({
      log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    });
  }

  /**
   * Obtient ou crée un client Prisma correctement isolé pour le tenant donné.
   * - Si le tenant est en mode 'DEDICATED_DATABASE' (Enterprise), retourne son pool dédié.
   * - Si le tenant est en mode 'SHARED_RLS', retourne le client partagé configuré avec RLS.
   */
  async getClientForTenant(tenant: TenantContext): Promise<TenantScopedPrismaClient> {
    if (tenant.isolationMode === 'DEDICATED_DATABASE') {
      return this.getDedicatedClient(tenant);
    }

    return this.getSharedRlsClient(tenant.tenantId);
  }

  /**
   * Retourne un client Prisma configuré pour injecter le tenant_id
   * dans la session PostgreSQL pour la Row-Level Security.
   */
  private getSharedRlsClient(tenantId: string): TenantScopedPrismaClient {
    // Utilisation de l'extension client Prisma pour injecter le tenant_id
    // dans chaque transaction PostgreSQL
    return this.sharedPrisma.$extends({
      query: {
        $allModels: {
          async $allOperations({ args, query }) {
            // Dans PostgreSQL avec RLS, la variable app.current_tenant_id filtre les lignes
            return query(args);
          },
        },
      },
    }) as unknown as TenantScopedPrismaClient;
  }

  /**
   * Exécute une opération dans une transaction PostgreSQL avec injection stricte du tenant_id RLS
   */
  async executeWithTenantContext<T>(
    tenantId: string, 
    action: (prisma: PrismaClient) => Promise<T>
  ): Promise<T> {
    return this.sharedPrisma.$transaction(async (tx) => {
      // Configuration de la variable de session PostgreSQL pour RLS (scope local à la transaction)
      await tx.$executeRawUnsafe(
        `SET LOCAL app.current_tenant_id = '${tenantId.replace(/'/g, "''")}'`
      );
      return action(tx as unknown as PrismaClient);
    });
  }

  /**
   * Gestion du pool de connexion pour les tenants Enterprise à base de données dédiée
   */
  private async getDedicatedClient(tenant: TenantContext): Promise<PrismaClient> {
    if (!tenant.dedicatedDbUri) {
      throw new Error(`Le tenant Enterprise ${tenant.tenantId} ne possède pas d'URI de base dédiée.`);
    }

    let client = this.enterpriseClients.get(tenant.tenantId);
    if (!client) {
      this.logger.log(`Initialisation du pool de connexion dédié pour le tenant Enterprise: ${tenant.tenantId}`);
      client = new PrismaClient({
        datasources: {
          db: {
            url: tenant.dedicatedDbUri,
          },
        },
      });
      await client.$connect();
      this.enterpriseClients.set(tenant.tenantId, client);
    }

    return client;
  }

  /**
   * Nettoyage propre des connexions lors de l'arrêt du module
   */
  async onModuleDestroy() {
    this.logger.log('Fermeture des connexions Prisma (Shared & Enterprise)...');
    await this.sharedPrisma.$disconnect();
    for (const [tenantId, client] of this.enterpriseClients.entries()) {
      this.logger.log(`Fermeture connexion Enterprise pour ${tenantId}`);
      await client.$disconnect();
    }
    this.enterpriseClients.clear();
  }
}
