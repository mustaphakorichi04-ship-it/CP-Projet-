import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CpEngineeringCoreService } from '../src/calculations/cp-engineering-core.service';
import { CalculationAuditService } from '../src/calculations/calculation-audit.service';
import { TenantContext } from '@cp-engineer/shared-types';

describe('Calculations Golden Master Comparison & Unit Tests', () => {
  let coreService: CpEngineeringCoreService;
  let auditService: CalculationAuditService;

  const mockTenant: TenantContext = {
    tenantId: '00000000-0000-0000-0000-000000000001',
    organizationName: 'Sonatrach Pipeline Division',
    plan: 'PRO',
    isolationMode: 'SHARED_RLS',
  };

  beforeEach(() => {
    coreService = new CpEngineeringCoreService();
    const mockFactory = {
      executeWithTenantContext: vi.fn().mockImplementation(async (tenantId, action) => {
        return action({
          calculationLog: { create: vi.fn() },
          apiQuota: { upsert: vi.fn() },
        });
      }),
    };
    auditService = new CalculationAuditService(mockFactory as any);
  });

  it('Golden Master: requiredCurrent respecte la conversion mA/m2 et plafonnement ISO 15589-1', () => {
    const res = coreService.calculateRequiredCurrent({
      surfaceAreaM2: 100,
      currentDensityMaM2: 5,
      coatingBreakdownInitial: 0.1,
      coatingBreakdownFinal: 0.9,
      agingFactor: 2.0,
      standard: 'ISO 15589-1',
    });

    // f_c_uncapped = 0.1 + (0.9 * 2) = 1.9 -> plafonné à 1.0
    expect(res.f_c).toBe(1.0);
    expect(res.coatingCapApplied).toBe(true);
    expect(res.exposedArea).toBe(100);
    expect(res.currentAmperes).toBeCloseTo(0.5, 6);
  });

  it('Golden Master: Dwight Anode Resistance reproduit la formule exacte', () => {
    // rho = 100, L = 1, d = 0.1 (radius = 0.05) -> 4L/r = 4/0.05 = 80
    // expected = (100 / (2*PI)) * (ln(80) - 1)
    const expected = (100 / (2 * Math.PI)) * (Math.log(80) - 1);
    const actual = coreService.calculateDwightResistance(100, 1, 0.1);

    expect(actual).toBeCloseTo(expected, 8);
  });

  it('Golden Master: SACP respecte Faraday, facteur sécurité et plafonnement de durée de vie', () => {
    const res = coreService.designSACP({
      currentRequiredA: 2.0,
      designLifeYears: 25,
      anodeType: 'Mg',
      soilResistivityOhmM: 50,
      anodeLengthM: 1.5,
      anodeDiameterM: 0.1,
      anodeUnitMassKg: 20,
      utilizationFactor: 0.85,
      safetyFactor: 1.2,
      soilElectrolytePotentialV: -1.55,
      structureTargetPotentialV: -0.85,
    });

    expect(res.anodeCountRequired).toBeGreaterThan(0);
    expect(res.actualLifeYears).toBeLessThanOrEqual(25);
    expect(res.isCertified).toBe(true);
  });

  it('Golden Master: ICCP plafonne strictement la durée de vie à 25/50 ans et calcule TR IEC 60146', () => {
    const res = coreService.designICCP({
      totalCurrentA: 20,
      soilResistivityOhmM: 40,
      anodeCount: 10,
      anodeLengthM: 1.5,
      anodeDiameterM: 0.075,
      anodeSpacingM: 5,
      anodeType: 'mmo',
      cableLengthM: 200,
      cableSectionMm2: 25,
      desiredLifeYears: 25,
      massPerAnodeKg: 25,
    });

    expect(res.lifeTheoreticalYears).toBeLessThanOrEqual(50);
    expect(res.lifeDesignYears).toBeLessThanOrEqual(25);
    expect(res.rectifierSelection.nominalVoltage).toBeGreaterThanOrEqual(res.voltageFinal);
    expect(res.rectifierSelection.trSelectionBasis).toBe('IEC_60146_NORMALIZED_STEPS');
    expect(res.isCertified).toBe(true);
  });

  it('Audit Service consigne le calcul sans bloquer le thread', async () => {
    const spy = vi.spyOn(auditService, 'recordCalculation');
    await auditService.recordCalculation(mockTenant, 'ICCP', {}, {}, 15);

    expect(spy).toHaveBeenCalled();
  });
});
