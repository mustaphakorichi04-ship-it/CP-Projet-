import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComplianceService } from '../src/compliance/compliance.service';
import { TenantContext } from '@cp-engineer/shared-types';
import { BadRequestException } from '@nestjs/common';

describe('Compliance & GDPR Reversibility Tests', () => {
  let complianceService: ComplianceService;
  let mockPrisma: any;

  const mockTenant: TenantContext = {
    tenantId: '00000000-0000-0000-0000-000000000001',
    organizationName: 'Sonatrach Pipeline Division',
    plan: 'PRO',
    isolationMode: 'SHARED_RLS',
  };

  beforeEach(() => {
    mockPrisma = {
      tenant: {
        findUnique: vi.fn().mockResolvedValue({
          id: mockTenant.tenantId,
          name: mockTenant.organizationName,
          slug: 'sonatrach-pipeline',
        }),
        delete: vi.fn().mockResolvedValue({ id: mockTenant.tenantId }),
      },
      user: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'u1', email: 'lead@sonatrach.dz', firstName: 'Karim', role: 'LEAD_ENGINEER' },
        ]),
      },
      project: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'p1', name: 'Gazoduc Hassi R\'Mel - Skikda', standard: 'ISO 15589-1' },
        ]),
      },
      calculationLog: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'c1', type: 'ICCP', isCertified: true },
        ]),
      },
      apiQuota: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    };

    const mockFactory = {
      executeWithTenantContext: vi.fn().mockImplementation(async (tenantId, action) => {
        return action(mockPrisma);
      }),
    };

    complianceService = new ComplianceService(mockFactory as any);
  });

  it('exportTenantData : extrait toutes les données du compte sans hash de mot de passe', async () => {
    const res = await complianceService.exportTenantData(mockTenant);

    expect(res.exportMetadata).toBeDefined();
    expect(res.exportMetadata.tenantId).toBe(mockTenant.tenantId);
    expect(res.projects.length).toBe(1);
    expect(res.users[0].passwordHash).toBeUndefined(); // Pas de fuite de credential
    expect(res.calculationLogs.length).toBe(1);
  });

  it('deleteTenantAccount : rejette la suppression si le slug de confirmation ne correspond pas', async () => {
    await expect(
      complianceService.deleteTenantAccount(mockTenant, 'wrong-slug')
    ).rejects.toThrow(BadRequestException);

    expect(mockPrisma.tenant.delete).not.toHaveBeenCalled();
  });

  it('deleteTenantAccount : supprime le tenant en cascade si la confirmation est exacte', async () => {
    const res = await complianceService.deleteTenantAccount(mockTenant, 'sonatrach-pipeline');

    expect(res.success).toBe(true);
    expect(mockPrisma.tenant.delete).toHaveBeenCalledWith({
      where: { id: mockTenant.tenantId },
    });
  });
});
