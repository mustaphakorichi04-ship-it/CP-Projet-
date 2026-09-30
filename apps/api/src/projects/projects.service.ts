import { Injectable, NotFoundException } from '@nestjs/common';
import { TenantConnectionFactory } from '../database/tenant-connection.factory';
import { TenantContext } from '@cp-engineer/shared-types';

export interface CreateProjectDto {
  name: string;
  description?: string;
  standard?: string;
  data?: any;
  legacyId?: string;
}

export interface UpdateProjectDto {
  name?: string;
  description?: string;
  standard?: string;
  data?: any;
  version?: number;
}

@Injectable()
export class ProjectsService {
  constructor(private readonly connectionFactory: TenantConnectionFactory) {}

  /**
   * Récupère tous les projets appartenant strictement au tenant actif
   */
  async findAllForTenant(tenant: TenantContext) {
    return this.connectionFactory.executeWithTenantContext(tenant.tenantId, async (prisma) => {
      return prisma.project.findMany({
        where: { tenantId: tenant.tenantId },
        orderBy: { updatedAt: 'desc' },
      });
    });
  }

  /**
   * Récupère un projet par son ID avec vérification RLS
   */
  async findOne(tenant: TenantContext, id: string) {
    return this.connectionFactory.executeWithTenantContext(tenant.tenantId, async (prisma) => {
      const project = await prisma.project.findFirst({
        where: {
          id,
          tenantId: tenant.tenantId,
        },
      });

      if (!project) {
        throw new NotFoundException(`Projet ${id} introuvable pour ce tenant.`);
      }

      return project;
    });
  }

  /**
   * Crée un nouveau projet attaché au tenant actif
   */
  async create(tenant: TenantContext, dto: CreateProjectDto, userId?: string) {
    return this.connectionFactory.executeWithTenantContext(tenant.tenantId, async (prisma) => {
      // Idempotence : si un legacyId existe déjà pour ce tenant, on met à jour au lieu de dupliquer
      if (dto.legacyId) {
        const existing = await prisma.project.findFirst({
          where: {
            tenantId: tenant.tenantId,
            legacyId: dto.legacyId,
          },
        });

        if (existing) {
          return prisma.project.update({
            where: { id: existing.id },
            data: {
              name: dto.name,
              description: dto.description,
              standard: dto.standard || 'ISO 15589-1',
              data: dto.data || {},
              version: { increment: 1 },
            },
          });
        }
      }

      return prisma.project.create({
        data: {
          tenantId: tenant.tenantId,
          legacyId: dto.legacyId,
          name: dto.name,
          description: dto.description,
          standard: dto.standard || 'ISO 15589-1',
          data: dto.data || {},
          createdById: userId,
          version: 1,
        },
      });
    });
  }

  /**
   * Met à jour un projet avec gestion optimiste des conflits de version
   */
  async update(tenant: TenantContext, id: string, dto: UpdateProjectDto) {
    return this.connectionFactory.executeWithTenantContext(tenant.tenantId, async (prisma) => {
      const existing = await prisma.project.findFirst({
        where: { id, tenantId: tenant.tenantId },
      });

      if (!existing) {
        throw new NotFoundException(`Projet ${id} introuvable.`);
      }

      // Résolution optimiste : si une version est fournie et ne correspond pas
      if (dto.version !== undefined && dto.version !== existing.version) {
        throw new Error(
          `Conflit de version détecté: Version serveur (${existing.version}) vs Version client (${dto.version}).`
        );
      }

      return prisma.project.update({
        where: { id: existing.id },
        data: {
          name: dto.name ?? existing.name,
          description: dto.description ?? existing.description,
          standard: dto.standard ?? existing.standard,
          data: dto.data ?? existing.data,
          version: { increment: 1 },
        },
      });
    });
  }
}
