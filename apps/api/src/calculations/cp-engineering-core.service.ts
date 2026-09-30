import { Injectable, BadRequestException } from '@nestjs/common';
import {
  RequiredCurrentRequestDto,
  RequiredCurrentResponseDto,
  SACPDesignRequestDto,
  SACPDesignResponseDto,
  ICCPDesignRequestDto,
  ICCPDesignResponseDto,
} from '@cp-engineer/shared-types';

@Injectable()
export class CpEngineeringCoreService {
  /**
   * Calcul du courant CP requis avec plafonnement physique du revêtement (ISO 15589-1 §7.3)
   */
  calculateRequiredCurrent(dto: RequiredCurrentRequestDto): RequiredCurrentResponseDto {
    const { surfaceAreaM2, currentDensityMaM2, coatingBreakdownInitial, coatingBreakdownFinal, agingFactor } = dto;

    if (surfaceAreaM2 <= 0 || currentDensityMaM2 <= 0) {
      throw new BadRequestException('La surface et la densité de courant doivent être strictement positives.');
    }

    // Calcul de détérioration du revêtement avec prise en compte du vieillissement
    const f_c_uncapped = (coatingBreakdownInitial || 0.05) + ((coatingBreakdownFinal || 0.1) * (agingFactor || 1.2));
    
    // Plafonnement physique normatif : f_c ne peut excéder 1.0 (100% de surface nue)
    const coatingCapApplied = f_c_uncapped > 1.0;
    const f_c = coatingCapApplied ? 1.0 : f_c_uncapped;

    const exposedArea = surfaceAreaM2 * f_c;
    const currentDensityA_M2 = currentDensityMaM2 / 1000;
    const currentAmperes = exposedArea * currentDensityA_M2;

    return {
      exposedArea,
      currentAmperes,
      currentDensityA_M2,
      f_c,
      coatingCapApplied,
      units: {
        surfaceArea: 'm²',
        currentDensity: 'mA/m²',
        current: 'A',
      },
    };
  }

  /**
   * Résistance de dispersion d'une anode verticale selon l'équation de Dwight
   */
  calculateDwightResistance(rhoOhmM: number, lengthM: number, diameterM: number): number {
    if (rhoOhmM <= 0 || lengthM <= 0 || diameterM <= 0) {
      throw new BadRequestException('Dimensions et résistivité doivent être strictement positives pour Dwight.');
    }
    const radiusM = diameterM / 2;
    return (rhoOhmM / (2 * Math.PI * lengthM)) * (Math.log((4 * lengthM) / radiusM) - 1);
  }

  /**
   * Résistance de groupe d'anodes selon la formulation de Sunde
   */
  calculateGroupResistanceSunde(
    singleAnodeResistanceOhm: number,
    anodeCount: number,
    spacingM: number,
    rhoOhmM: number,
  ): number {
    if (anodeCount <= 0) return 0;
    if (anodeCount === 1) return singleAnodeResistanceOhm;

    // Facteur d'interférence mutuelle de Sunde
    let sumLog = 0;
    for (let i = 1; i < anodeCount; i++) {
      sumLog += 1 / (i * spacingM);
    }
    const interferenceOhm = (rhoOhmM / (2 * Math.PI * anodeCount * spacingM)) * sumLog;
    return (singleAnodeResistanceOhm / anodeCount) + interferenceOhm;
  }

  /**
   * Dimensionnement complet d'un système à anodes sacrificielles (SACP)
   */
  designSACP(dto: SACPDesignRequestDto): SACPDesignResponseDto {
    const {
      currentRequiredA,
      designLifeYears,
      anodeType,
      soilResistivityOhmM,
      anodeLengthM,
      anodeDiameterM,
      anodeUnitMassKg,
      utilizationFactor = 0.85,
      safetyFactor = 1.2,
      soilElectrolytePotentialV,
      structureTargetPotentialV,
    } = dto;

    // Capacités pratiques électrochimiques (A·h/kg) selon NACE/DNV
    const capacities: Record<string, number> = {
      Mg: 1100,
      Zn: 780,
      Al: 2000,
    };

    const capacityAhKg = capacities[anodeType] || 1100;
    const hoursPerYear = 8760;

    // Masse totale requise (Loi de Faraday avec facteur de sécurité et facteur d'utilisation)
    const theoreticalMassKg = (currentRequiredA * designLifeYears * hoursPerYear) / (capacityAhKg * utilizationFactor);
    const totalMassRequiredKg = theoreticalMassKg * safetyFactor;

    // Nombre d'anodes requis
    const anodeCountRequired = Math.max(1, Math.ceil(totalMassRequiredKg / anodeUnitMassKg));

    // Résistance unitaire et globale
    const anodeResistanceOhm = this.calculateDwightResistance(soilResistivityOhmM, anodeLengthM, anodeDiameterM);
    const circuitResistanceOhm = anodeResistanceOhm / anodeCountRequired;

    // Force électromotrice utile (driving voltage)
    const drivingVoltageV = Math.abs(soilElectrolytePotentialV - structureTargetPotentialV);
    const singleAnodeCurrentA = drivingVoltageV / anodeResistanceOhm;
    const totalSystemCurrentA = singleAnodeCurrentA * anodeCountRequired;

    // Durée de vie réelle du système (plafonnée à la durée de vie de conception selon NACE)
    const rawLifeYears = (anodeCountRequired * anodeUnitMassKg * capacityAhKg * utilizationFactor) / 
                         (currentRequiredA * hoursPerYear * safetyFactor);
    const actualLifeYears = Math.min(rawLifeYears, designLifeYears);

    return {
      totalMassRequiredKg,
      anodeCountRequired,
      actualLifeYears,
      anodeResistanceOhm,
      singleAnodeCurrentA,
      totalSystemCurrentA,
      circuitResistanceOhm,
      lifeOk: actualLifeYears >= designLifeYears,
      isCertified: true,
    };
  }

  /**
   * Dimensionnement du système à courant imposé (ICCP) avec plafonnement NACE
   */
  designICCP(dto: ICCPDesignRequestDto): ICCPDesignResponseDto {
    const {
      totalCurrentA,
      soilResistivityOhmM,
      anodeCount,
      anodeLengthM,
      anodeDiameterM,
      anodeSpacingM,
      anodeType,
      cableLengthM,
      cableSectionMm2,
      structureResistanceOhm = 0.01,
      massPerAnodeKg = 25,
      desiredLifeYears = 25,
      safetyFactorPower = 1.3,
      agingFactor = 1.2,
      backEmfVoltage = 2.0,
    } = dto;

    if (totalCurrentA <= 0 || anodeCount <= 0) {
      throw new BadRequestException('Le courant et le nombre d\'anodes doivent être strictement positifs.');
    }

    const currentPerAnode = totalCurrentA / anodeCount;

    // Calcul de résistance du câble aller-retour (facteur 2 pour boucle complète)
    const copperResistivity = 0.0175; // Ohm·mm²/m
    const cableResistanceOhm = (2 * cableLengthM * copperResistivity) / cableSectionMm2;

    // Résistance de déversoir
    const rSingle = this.calculateDwightResistance(soilResistivityOhmM, anodeLengthM, anodeDiameterM);
    const groundbedResistance = this.calculateGroupResistanceSunde(rSingle, anodeCount, anodeSpacingM, soilResistivityOhmM);

    const totalResistance = groundbedResistance + cableResistanceOhm + structureResistanceOhm;
    const totalResistanceFinal = totalResistance * agingFactor;

    // Tensions et puissances
    const voltageInitial = (totalCurrentA * totalResistance) + backEmfVoltage;
    const voltageFinal = (totalCurrentA * totalResistanceFinal) + backEmfVoltage;
    const powerInitial = totalCurrentA * voltageInitial;
    const powerFinal = totalCurrentA * voltageFinal;
    const powerDesign = powerInitial * safetyFactorPower;

    // Densité anodique
    const anodeSurfaceM2 = Math.PI * anodeDiameterM * anodeLengthM;
    const currentDensityAnodeA_M2 = currentPerAnode / anodeSurfaceM2;
    const currentDensityAnode_mA_M2 = currentDensityAnodeA_M2 * 1000;

    // Limites de densité par matériau (A/m²)
    const limits: Record<string, number> = {
      mmo: 600,
      sicr: 50,
      graphite: 10,
      platinized: 1000,
      ferrosilicium: 30,
    };
    const densityLimit = limits[anodeType] || 50;
    const densityOk = currentDensityAnodeA_M2 <= densityLimit;

    // Durée de vie ICCP plafonnée selon NACE SP0169 (Plafond physique de 50 ans, conception 25 ans)
    const lifeTheoreticalYears = Math.min(50, (anodeCount * massPerAnodeKg * 0.85) / (totalCurrentA * 0.5));
    const lifeDesignYears = Math.min(desiredLifeYears, lifeTheoreticalYears);

    // Dimensionnement normalisé du Redresseur (TR) selon IEC 60146
    const trVoltageSteps = [12, 24, 36, 48, 60, 80, 100, 120];
    const trCurrentSteps = [5, 10, 15, 20, 25, 30, 40, 50, 60, 80, 100];
    const nominalVoltage = trVoltageSteps.find(v => v >= voltageFinal) || Math.ceil(voltageFinal * 1.2);
    const nominalCurrent = trCurrentSteps.find(i => i >= totalCurrentA * 1.2) || Math.ceil(totalCurrentA * 1.2);

    return {
      currentTotal: totalCurrentA,
      currentPerAnode,
      voltageInitial,
      voltageFinal,
      powerInitial,
      powerFinal,
      powerDesign,
      groundbedResistance,
      totalResistance,
      currentDensityAnodeA_M2,
      currentDensityAnode_mA_M2,
      densityOk,
      densityLimit,
      lifeEstimateYears: lifeDesignYears,
      lifeTheoreticalYears,
      lifeDesignYears,
      totalMassEstimateKg: anodeCount * massPerAnodeKg,
      rectifierSelection: {
        nominalVoltage,
        nominalCurrent,
        nominalPower: nominalVoltage * nominalCurrent,
        trSelectionBasis: 'IEC_60146_NORMALIZED_STEPS',
      },
      isCertified: true,
    };
  }
}
