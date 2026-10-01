/**
 * @file cpApi.ts
 * Accès unique aux données réelles du tableau de bord.
 *
 * Source de vérité : l'API CP Engineer Pro.
 *   1. GET /api/dashboard/summary  → KPIs + projets + ouvrages réels (backend.py, base cp_data.db)
 *   2. GET /api/v1/projects        → repli BFF NestJS (mêmes projets, données tenant)
 *
 * Aucune donnée n'est inventée : en cas d'indisponibilité, les
 * appelants reçoivent `null` et doivent afficher « N/A ».
 */

export interface DashboardProject {
  id: string;
  name: string;
  type: string | null;
  standard: string | null;
  targetPotential: number | null;
  pipelineLengthKm: number | null;
  pipelineSurfaceM2: number | null;
  rectifiersCount: number | null;
  groundbedsCount: number | null;
  iccpCurrentA: number | null;
  status: string | null;
  updatedAt: string | null;
}

export interface DashboardSummary {
  engineer?: {
    name?: string;
    title?: string;
    certification?: string;
    avatar?: string;
  } | null;
  kpis?: {
    protectedNetworkKm?: number;
    protectedNetworkKmFormatted?: string;
    totalSurfaceM2?: number;
    naceCompliancePercent?: number;
    naceComplianceFormatted?: string;
    naceCriteria?: string;
    activeRectifiersCount?: number;
    activeRectifiersFormatted?: string;
    totalIccpCurrentA?: number;
    totalIccpCurrentFormatted?: string;
    activeProjectsCount?: number;
    quotaUsage?: string;
  } | null;
  projects?: DashboardProject[];
  pipelines?: Array<{
    id: string;
    tag: string;
    projectId: string;
    projectName: string;
    length_km?: number;
    diameter_mm?: number | null;
    surface_m2?: number;
    status?: string;
  }>;
  rectifiers?: Array<{
    id: string;
    tag: string;
    projectId: string;
    projectName: string;
    model?: string;
    nominalCurrent?: number;
    nominalVoltage?: number;
  }>;
}

const API_TIMEOUT_MS = 8000;

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      credentials: 'include',
      ...init,
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Repli BFF NestJS : /api/v1/projects → mêmes projets, sans agrégats.
 */
function mapNestProjects(rows: any[]): { projects: DashboardProject[]; pipelines: DashboardSummary['pipelines'] } {
  const pipelines: NonNullable<DashboardSummary['pipelines']> = [];

  const projects: DashboardProject[] = rows.map((row) => {
    const data = row && row.data && typeof row.data === 'object' ? row.data : {};
    const equipments: any[] = Array.isArray(data.equipments) ? data.equipments : [];

    let lengthM = 0;
    let surfaceM2 = 0;
    let rectifiersCount = 0;
    let groundbedsCount = 0;

    equipments.forEach((eq) => {
      const type = String(eq?.type || '');
      const dims = eq?.dimensions || {};
      const length = numberOrNull(dims.longueur_m) ?? 0;
      const surface = numberOrNull(eq?.surface) ?? 0;
      if (type.includes('pipeline')) {
        lengthM += length;
        surfaceM2 += surface;
        pipelines.push({
          id: String(eq?.id ?? ''),
          tag: String(eq?.tag ?? 'N/A'),
          projectId: String(row.legacyId || row.id),
          projectName: String(row.name ?? ''),
          length_km: length / 1000,
          diameter_mm: numberOrNull(dims.diametre_m) !== null ? (numberOrNull(dims.diametre_m)! * 1000) : null,
          surface_m2: surface,
          status: 'Statut non calculé',
        });
      } else if (type.includes('rectifier')) {
        rectifiersCount += 1;
      } else if (type.includes('groundbed')) {
        groundbedsCount += 1;
      }
    });

    const iccp = data.iccp || {};
    const cp = data.cp || {};

    return {
      id: String(row.legacyId || row.id),
      name: String(row.name ?? row.legacyId ?? row.id),
      type: data?.project?.cpSystemType ?? null,
      standard: row.standard ?? null,
      targetPotential: numberOrNull(data?.project?.targetPotential),
      pipelineLengthKm: lengthM / 1000,
      pipelineSurfaceM2: surfaceM2,
      rectifiersCount,
      groundbedsCount,
      iccpCurrentA: numberOrNull(iccp.current) ?? numberOrNull(cp.current),
      status: null,
      updatedAt: row.updatedAt ?? null,
    };
  });

  return { projects, pipelines };
}

/**
 * Charge le tableau de bord depuis la source de vérité réelle.
 * @returns {Promise<DashboardSummary | null>} null si aucune source n'est joignable.
 */
export async function fetchDashboardSummary(): Promise<DashboardSummary | null> {
  const summary = await fetchJson<DashboardSummary>('/api/dashboard/summary');
  if (summary) return summary;

  const projects = await fetchJson<any[]>('/api/v1/projects');
  if (Array.isArray(projects)) {
    const { projects: mapped, pipelines } = mapNestProjects(projects);
    return { projects: mapped, pipelines };
  }

  return null;
}

export interface QuotaStatus {
  usedCalculations: number;
  includedCalculations: number;
  overageCalculations: number;
  isQuotaExceeded: boolean;
}

/** Quota réel ; `null` si l'API de facturation est indisponible. */
export async function fetchQuotaStatus(): Promise<QuotaStatus | null> {
  return fetchJson<QuotaStatus>('/api/v1/billing/quota-status');
}

/** URL vers un module réel du Studio, contexte projet conservé. */
export function studioUrl(projectId?: string | null, moduleId?: string, extra?: Record<string, string>): string {
  const params = new URLSearchParams();
  if (projectId) params.set('project', projectId);
  if (extra) {
    Object.keys(extra).forEach((key) => {
      if (extra[key]) params.set(key, extra[key]);
    });
  }
  const query = params.toString();
  return `/studio${query ? `?${query}` : ''}${moduleId ? `#${moduleId}` : ''}`;
}

/** Formatage « N/A » par défaut pour toute valeur absente. */
export function formatNumber(value: number | null | undefined, decimals = 2, suffix = ''): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'N/A';
  return `${Number(value).toLocaleString('fr-FR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}${suffix ? ` ${suffix}` : ''}`;
}
