-- ============================================================
-- init-rls.sql
-- Initialisation de l'isolation Multi-Tenant PostgreSQL RLS
-- ============================================================

-- 1. Extension UUID
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. Schéma et fonction de contexte de session
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS UUID AS $$
BEGIN
    RETURN NULLIF(current_setting('app.current_tenant_id', true), '')::UUID;
END;
$$ LANGUAGE plpgsql STABLE;

-- 3. Table des Organisations (Tenants)
CREATE TABLE IF NOT EXISTS tenants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,
    plan VARCHAR(50) NOT NULL DEFAULT 'PRO',
    isolation_mode VARCHAR(50) NOT NULL DEFAULT 'SHARED_RLS',
    dedicated_db_uri TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Table des Utilisateurs
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'LEAD_ENGINEER',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(tenant_id, email)
);

-- 5. Table des Projets CP (Sous RLS)
CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    legacy_id VARCHAR(100) NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT NULL,
    standard VARCHAR(50) NOT NULL DEFAULT 'ISO 15589-1',
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    version INT NOT NULL DEFAULT 1,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index pour les perfs et l'idempotence de migration
CREATE INDEX IF NOT EXISTS idx_projects_tenant ON projects(tenant_id);
CREATE INDEX IF NOT EXISTS idx_projects_legacy ON projects(tenant_id, legacy_id);

-- 6. Activation de la Row-Level Security (RLS)
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;

-- Politique d'isolation stricte par tenant_id
DROP POLICY IF EXISTS tenant_isolation_policy ON projects;
CREATE POLICY tenant_isolation_policy ON projects
    FOR ALL
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- 7. Seed de données de Staging / Baseline
INSERT INTO tenants (id, name, slug, plan, isolation_mode)
VALUES 
    ('00000000-0000-0000-0000-000000000001', 'Sonatrach Pipeline Division', 'sonatrach-pipeline', 'PRO', 'SHARED_RLS'),
    ('00000000-0000-0000-0000-000000000002', 'TotalEnergies Infrastructure', 'total-infra', 'ENTERPRISE', 'DEDICATED_DATABASE')
ON CONFLICT (id) DO NOTHING;

INSERT INTO users (id, tenant_id, email, password_hash, first_name, last_name, role)
VALUES 
    ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'lead@sonatrach.dz', '$2b$10$EpBmDFaYnL68e/D68V2vUu...', 'Karim', 'Mansour', 'LEAD_ENGINEER'),
    ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'tech@sonatrach.dz', '$2b$10$EpBmDFaYnL68e/D68V2vUu...', 'Sofiane', 'Brahimi', 'FIELD_TECHNICIAN')
ON CONFLICT DO NOTHING;
