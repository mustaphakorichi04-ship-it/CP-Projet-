import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TenantConnectionFactory } from '../src/database/tenant-connection.factory';
import { ProjectsService } from '../src/projects/projects.service';
import { TenantContext } from '@cp-engineer/shared-types';

describe('Tenant Isolation & RLS Security Tests', () => {
  let connectionFactory: TenantConnectionFactory;
  let projectsService: ProjectsService;

  const tenantA: TenantContext = {
    tenantId: '00000000-0000-0000-0000-000000000001',
    organizationName: 'Sonatrach Pipeline Division',
    plan: 'PRO',
    isolationMode: 'SHARED_RLS',
  };

  const tenantB: TenantContext = {
    tenantId: '00000000-0000-0000-0000-000000000002',
    organizationName: 'TotalEnergies Infrastructure',
    plan: 'PRO',
    isolationMode: 'SHARED_RLS',
  };

  const tenantEnterprise: TenantContext = {
    tenantId: '00000000-0000-0000-0000-000000000099',
    organizationName: 'Enterprise Client',
    plan: 'ENTERPRISE',
    isolationMode: 'DEDICATED_DATABASE',
    dedicatedDbUri: 'postgresql://ent_user:secret@enterprise-db.internal:5432/ent_db',
  };

  beforeEach(() => {
    connectionFactory = new TenantConnectionFactory();
    projectsService = new ProjectsService(connectionFactory);
  });

  it('TenantConnectionFactory aiguille vers la base dédiée pour un tenant Enterprise', async () => {
    const spy = vi.spyOn(connectionFactory as any, 'getDedicatedClient');
    spy.mockResolvedValueOnce({ $connect: vi.fn(), project: {} } as any);

    await connectionFactory.getClientForTenant(tenantEnterprise);

    expect(spy).toHaveBeenCalledWith(tenantEnterprise);
  });

  it('TenantConnectionFactory utilise RLS partagée pour un tenant standard', async () => {
    const spy = vi.spyOn(connectionFactory as any, 'getSharedRlsClient');

    await connectionFactory.getClientForTenant(tenantA);

    expect(spy).toHaveBeenCalledWith(tenantA.tenantId);
  });

  it('Empêche la fuite de données inter-tenant : requête filtrée strictement par tenant_id', async () => {
    const mockFindMany = vi.fn().mockResolvedValue([
      { id: 'proj-1', tenantId: tenantA.tenantId, name: 'Pipeline Gaz Nord' },
    ]);

    vi.spyOn(connectionFactory, 'executeWithTenantContext').mockImplementation(
      async (tenantId, action) => {
        return action({
          project: {
            findMany: mockFindMany,
          },
        } as any);
      },
    );

    const results = await projectsService.findAllForTenant(tenantA);

    expect(mockFindMany).toHaveBeenCalledWith({
      where: { tenantId: tenantA.tenantId },
      orderBy: { updatedAt: 'desc' },
    });
    expect(results[0].tenantId).toBe(tenantA.tenantId);
    expect(results[0].tenantId).not.toBe(tenantB.tenantId);
  });

  it('Rejette les conflits de version concurrente sur la mise à jour de projet', async () => {
    vi.spyOn(connectionFactory, 'executeWithTenantContext').mockImplementation(
      async (tenantId, action) => {
        return action({
          project: {
            findFirst: vi.fn().mockResolvedValue({
              id: 'proj-1',
              tenantId: tenantA.tenantId,
              version: 5,
            }),
          },
        } as any);
      },
    );

    await expect(
      projectsService.update(tenantA, 'proj-1', { name: 'New Name', version: 4 }),
    ).rejects.toThrow('Conflit de version détecté');
  });
});
