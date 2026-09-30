/**
 * @file cp-calculation.dto.ts
 * Contrats d'interfaces de calcul de protection cathodique (SACP & ICCP)
 * Conformes aux normes NACE SP0169 / ISO 15589-1 / DNV-RP-F103
 */

export type CPStandard = 'ISO 15589-1' | 'NACE SP0169' | 'DNV-RP-F103';

export type AnodeMaterial = 
  | 'Mg' 
  | 'Zn' 
  | 'Al' 
  | 'mmo' 
  | 'sicr' 
  | 'graphite' 
  | 'platinized' 
  | 'ferrosilicium' 
  | 'platine_niobium' 
  | 'tantale';

/**
 * Entrées pour le calcul du courant CP requis
 */
export interface RequiredCurrentRequestDto {
  surfaceAreaM2: number;
  currentDensityMaM2: number;
  coatingBreakdownInitial: number;  // Fraction (0.01 à 1.0)
  coatingBreakdownFinal: number;    // Fraction (0.01 à 1.0)
  agingFactor: number;              // Typiquement 1.2
  standard?: CPStandard;
}

/**
 * Sorties du calcul du courant CP requis
 */
export interface RequiredCurrentResponseDto {
  exposedArea: number;             // m²
  currentAmperes: number;          // A
  currentDensityA_M2: number;      // A/m²
  f_c: number;                     // Facteur de détérioration du revêtement (plafonné à 1.0)
  coatingCapApplied: boolean;
  units: {
    surfaceArea: 'm²';
    currentDensity: 'mA/m²';
    current: 'A';
  };
}

/**
 * Entrées pour le dimensionnement d'un système à anodes galvaniques (SACP)
 */
export interface SACPDesignRequestDto {
  currentRequiredA: number;
  designLifeYears: number;
  anodeType: 'Mg' | 'Zn' | 'Al';
  soilResistivityOhmM: number;
  anodeLengthM: number;
  anodeDiameterM: number;
  anodeUnitMassKg: number;
  utilizationFactor: number;        // Typiquement 0.85
  safetyFactor: number;             // Typiquement 1.2
  soilElectrolytePotentialV: number;
  structureTargetPotentialV: number;
}

/**
 * Sorties du dimensionnement SACP
 */
export interface SACPDesignResponseDto {
  totalMassRequiredKg: number;
  anodeCountRequired: number;
  actualLifeYears: number;
  anodeResistanceOhm: number;
  singleAnodeCurrentA: number;
  totalSystemCurrentA: number;
  circuitResistanceOhm: number;
  lifeOk: boolean;
  isCertified: boolean;             // true si calculé par le serveur
}

/**
 * Entrées pour le dimensionnement du système à courant imposé (ICCP)
 */
export interface ICCPDesignRequestDto {
  totalCurrentA: number;
  soilResistivityOhmM: number;
  anodeCount: number;
  anodeLengthM: number;
  anodeDiameterM: number;
  anodeSpacingM: number;
  anodeType: AnodeMaterial;
  cableLengthM: number;
  cableSectionMm2: number;
  structureResistanceOhm?: number;
  boreholeDiameterMm?: number;
  activeDepthM?: number;
  massPerAnodeKg?: number;
  desiredLifeYears?: number;
  safetyFactorPower?: number;
  agingFactor?: number;
  backEmfVoltage?: number;
}

/**
 * Sorties du dimensionnement ICCP
 */
export interface ICCPDesignResponseDto {
  currentTotal: number;
  currentPerAnode: number;
  voltageInitial: number;
  voltageFinal: number;
  powerInitial: number;
  powerFinal: number;
  powerDesign: number;
  groundbedResistance: number;
  totalResistance: number;
  currentDensityAnodeA_M2: number;
  currentDensityAnode_mA_M2: number;
  densityOk: boolean;
  densityLimit: number;
  lifeEstimateYears: number;
  lifeTheoreticalYears: number | null;
  lifeDesignYears: number;
  totalMassEstimateKg: number;
  rectifierSelection: {
    nominalVoltage: number;
    nominalCurrent: number;
    nominalPower: number;
    trSelectionBasis: string;
  };
  isCertified: boolean;
}
