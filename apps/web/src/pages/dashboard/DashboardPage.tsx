import React, { useEffect, useState } from 'react';
import '../styles/dashboard.css';
import { UserSessionDto } from '@cp-engineer/shared-types';

// ── Types ────────────────────────────────────────────────────────────────────

interface Project {
  id: string;
  name: string;
  type: string;
  status: 'active' | 'pending';
  lastUpdated: string;
  calcCount: number;
}

interface QuotaStatus {
  usedCalculations: number;
  includedCalculations: number;
  overageCalculations: number;
  isQuotaExceeded: boolean;
}

// ── Mock data (remplacé par fetch API en prod) ────────────────────────────────

const MOCK_PROJECTS: Project[] = [
  { id: '1', name: 'Pipeline GZ-Nord Alger', type: 'SACP', status: 'active', lastUpdated: 'Il y a 2h', calcCount: 14 },
  { id: '2', name: 'Réseau ICCP Arzew LNG', type: 'ICCP', status: 'active', lastUpdated: 'Hier', calcCount: 8 },
  { id: '3', name: 'Inspection Hassi Rmel', type: 'Câblage', status: 'pending', lastUpdated: 'Il y a 3 jours', calcCount: 3 },
  { id: '4', name: 'Extension DP In Salah', type: 'SACP', status: 'active', lastUpdated: 'Il y a 5 jours', calcCount: 21 },
];

const MOCK_ACTIVITY = [
  { text: <>Calcul <strong>SACP-2024-087</strong> terminé avec succès</>, time: 'Il y a 12 min' },
  { text: <>Rapport PDF <strong>Arzew LNG Phase 2</strong> généré</>, time: 'Il y a 1h' },
  { text: <>Nouveau membre <strong>K. Bouhafs</strong> ajouté à l'organisation</>, time: 'Hier, 14:32' },
  { text: <>Mise à jour du projet <strong>Hassi Rmel</strong> enregistrée</>, time: 'Hier, 09:15' },
  { text: <>Facture <strong>INV-2024-09</strong> disponible</>, time: 'Il y a 3 jours' },
];

// ── Sub-components ────────────────────────────────────────────────────────────

const NAV_ITEMS = [
  { icon: '🏠', label: 'Vue d\'ensemble', key: 'overview' },
  { icon: '📁', label: 'Projets', key: 'projects', badge: '4' },
  { icon: '⚡', label: 'Calculs', key: 'calculations' },
  { icon: '🗺️', label: 'Carte GIS', key: 'gis' },
  { icon: '📄', label: 'Rapports PDF', key: 'reports' },
];

const NAV_SETTINGS = [
  { icon: '💳', label: 'Facturation', key: 'billing' },
  { icon: '⚙️', label: 'Paramètres', key: 'settings' },
];

function QuotaBar({ label, used, total, color }: { label: string; used: number; total: number; color: string }) {
  const pct = Math.min((used / total) * 100, 100);
  return (
    <div className="quota-block">
      <div className="quota-info">
        <span className="quota-label">{label}</span>
        <span className="quota-value">{used} / {total}</span>
      </div>
      <div className="quota-track">
        <div className="quota-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

// ── Main Dashboard ────────────────────────────────────────────────────────────

export const DashboardPage: React.FC = () => {
  const [activeSection, setActiveSection] = useState('overview');
  const [user, setUser] = useState<UserSessionDto | null>(null);
  const [quota, setQuota] = useState<QuotaStatus | null>(null);
  const [apiStatus, setApiStatus] = useState<'checking' | 'up' | 'down'>('checking');
  const [logoutLoading, setLogoutLoading] = useState(false);

  // Charger l'utilisateur depuis la session
  useEffect(() => {
    const raw = sessionStorage.getItem('cp_user');
    if (raw) {
      try { setUser(JSON.parse(raw)); } catch { /* ignore */ }
    }
  }, []);

  // Vérifier le statut de l'API
  useEffect(() => {
    fetch('/api/v1/health')
      .then(r => r.json())
      .then(d => setApiStatus(d.status === 'UP' ? 'up' : 'down'))
      .catch(() => setApiStatus('down'));
  }, []);

  // Récupérer le quota
  useEffect(() => {
    fetch('/api/v1/billing/quota-status', {
      credentials: 'include',
    })
      .then(r => r.json())
      .then(d => setQuota(d))
      .catch(() => {
        // Données mock en dev
        setQuota({ usedCalculations: 127, includedCalculations: 500, overageCalculations: 0, isQuotaExceeded: false });
      });
  }, []);

  const handleLogout = async () => {
    setLogoutLoading(true);
    try {
      await fetch('/api/v1/auth/logout', { method: 'POST', credentials: 'include' });
    } finally {
      sessionStorage.removeItem('cp_user');
      window.location.href = '/login';
    }
  };

  const initials = user
    ? `${user.firstName?.[0] ?? ''}${user.lastName?.[0] ?? ''}`.toUpperCase() || '?'
    : '?';

  const planLabel = user?.tenant?.plan ?? 'FREE';

  return (
    <div className="dashboard-root">
      {/* ── Sidebar ── */}
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="sidebar-logo-text">⚡ CP Engineer Pro</div>
        </div>

        <nav className="sidebar-nav">
          <div className="sidebar-section-label">Navigation</div>
          {NAV_ITEMS.map(item => (
            <button
              key={item.key}
              id={`nav-${item.key}`}
              className={`sidebar-item${activeSection === item.key ? ' active' : ''}`}
              onClick={() => setActiveSection(item.key)}
            >
              <span className="sidebar-item-icon">{item.icon}</span>
              {item.label}
              {item.badge && <span className="sidebar-badge">{item.badge}</span>}
            </button>
          ))}

          <div className="sidebar-section-label">Administration</div>
          {NAV_SETTINGS.map(item => (
            <button
              key={item.key}
              id={`nav-${item.key}`}
              className={`sidebar-item${activeSection === item.key ? ' active' : ''}`}
              onClick={() => {
                if (item.key === 'billing') window.location.href = '/app/billing';
                else setActiveSection(item.key);
              }}
            >
              <span className="sidebar-item-icon">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-user-card">
            <div className="sidebar-avatar">{initials}</div>
            <div className="sidebar-user-info">
              <div className="sidebar-user-name">
                {user ? `${user.firstName} ${user.lastName}` : 'Chargement…'}
              </div>
              <div className="sidebar-user-role">
                {user?.role ?? '—'} · {user?.tenant?.organizationName ?? '—'}
              </div>
            </div>
          </div>
          <button id="logout-btn" className="sidebar-logout" onClick={handleLogout} disabled={logoutLoading}>
            <span>🚪</span>
            {logoutLoading ? 'Déconnexion…' : 'Se déconnecter'}
          </button>
        </div>
      </aside>

      {/* ── Main ── */}
      <main className="main-content">
        {/* Topbar */}
        <div className="topbar">
          <div className="topbar-title">
            {activeSection === 'overview' && 'Vue d\'ensemble'}
            {activeSection === 'projects' && 'Projets'}
            {activeSection === 'calculations' && 'Calculs'}
            {activeSection === 'gis' && 'Carte GIS 3D'}
            {activeSection === 'reports' && 'Rapports PDF'}
            {activeSection === 'settings' && 'Paramètres'}
          </div>
          <div className="topbar-right">
            <div className="topbar-search">
              <span className="topbar-search-icon">🔍</span>
              <input id="dashboard-search" type="text" placeholder="Rechercher un projet…" aria-label="Recherche" />
            </div>
            <div className="topbar-plan-badge">{planLabel}</div>
            <div style={{
              width: 8, height: 8, borderRadius: '50%',
              background: apiStatus === 'up' ? '#22c55e' : apiStatus === 'down' ? '#ef4444' : '#f59e0b',
              boxShadow: apiStatus === 'up' ? '0 0 8px #22c55e' : 'none',
            }} title={`API ${apiStatus}`} />
          </div>
        </div>

        {/* Page Body */}
        <div className="page-body" key={activeSection}>

          {/* ── Overview ── */}
          {activeSection === 'overview' && (
            <>
              <div className="page-header">
                <h1>Bonjour, {user?.firstName ?? 'Ingénieur'} 👋</h1>
                <p>Voici l'état de votre espace {user?.tenant?.organizationName ?? ''}.</p>
              </div>

              {/* Stat Cards */}
              <div className="stats-grid">
                <div className="stat-card">
                  <div className="stat-icon">📁</div>
                  <div className="stat-value">4</div>
                  <div className="stat-label">Projets actifs</div>
                  <div className="stat-delta positive">▲ +1 ce mois</div>
                </div>
                <div className="stat-card">
                  <div className="stat-icon">⚡</div>
                  <div className="stat-value">{quota?.usedCalculations ?? '—'}</div>
                  <div className="stat-label">Calculs effectués</div>
                  <div className="stat-delta neutral">Sur {quota?.includedCalculations ?? 500} inclus</div>
                </div>
                <div className="stat-card">
                  <div className="stat-icon">📄</div>
                  <div className="stat-value">12</div>
                  <div className="stat-label">Rapports générés</div>
                  <div className="stat-delta positive">▲ +3 cette semaine</div>
                </div>
                <div className="stat-card">
                  <div className="stat-icon">👥</div>
                  <div className="stat-value">6</div>
                  <div className="stat-label">Membres équipe</div>
                  <div className="stat-delta neutral">Plan {planLabel}</div>
                </div>
              </div>

              {/* Content Grid */}
              <div className="content-grid">
                {/* Projects */}
                <div className="card">
                  <div className="card-header">
                    <span className="card-title">Projets récents</span>
                    <button className="card-action" onClick={() => setActiveSection('projects')}>
                      Voir tout →
                    </button>
                  </div>
                  <div className="project-list">
                    {MOCK_PROJECTS.map(p => (
                      <div key={p.id} className="project-item" id={`project-item-${p.id}`}>
                        <div className="project-avatar">🔧</div>
                        <div className="project-info">
                          <div className="project-name">{p.name}</div>
                          <div className="project-meta">{p.type} · {p.calcCount} calculs · {p.lastUpdated}</div>
                        </div>
                        <span className={`project-status ${p.status}`}>
                          {p.status === 'active' ? 'Actif' : 'En attente'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Right Column */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                  {/* Quota */}
                  <div className="card">
                    <div className="card-header">
                      <span className="card-title">Consommation</span>
                      <a className="card-action" href="/app/billing">Gérer →</a>
                    </div>
                    {quota && (
                      <>
                        <QuotaBar
                          label="Calculs"
                          used={quota.usedCalculations}
                          total={quota.includedCalculations}
                          color={quota.usedCalculations / quota.includedCalculations > 0.8 ? '#f59e0b' : '#0ea5e9'}
                        />
                        <QuotaBar
                          label="Projets"
                          used={4}
                          total={20}
                          color="#6366f1"
                        />
                        <QuotaBar
                          label="Rapports PDF"
                          used={12}
                          total={50}
                          color="#22c55e"
                        />
                      </>
                    )}
                  </div>

                  {/* Activity */}
                  <div className="card">
                    <div className="card-header">
                      <span className="card-title">Activité récente</span>
                    </div>
                    <div className="activity-list">
                      {MOCK_ACTIVITY.map((a, i) => (
                        <div key={i} className="activity-item">
                          <div className="activity-dot" />
                          <div>
                            <div className="activity-text">{a.text}</div>
                            <div className="activity-time">{a.time}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* ── Projects ── */}
          {activeSection === 'projects' && (
            <>
              <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <h1>Projets</h1>
                  <p>Gérez vos projets de protection cathodique.</p>
                </div>
                <button id="new-project-btn" className="btn btn-primary-dash">
                  ＋ Nouveau projet
                </button>
              </div>
              <div className="card">
                <div className="project-list">
                  {MOCK_PROJECTS.map(p => (
                    <div key={p.id} className="project-item" id={`project-list-item-${p.id}`}>
                      <div className="project-avatar">🔧</div>
                      <div className="project-info">
                        <div className="project-name">{p.name}</div>
                        <div className="project-meta">{p.type} · {p.calcCount} calculs · {p.lastUpdated}</div>
                      </div>
                      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                        <span className={`project-status ${p.status}`}>
                          {p.status === 'active' ? 'Actif' : 'En attente'}
                        </span>
                        <button className="btn btn-ghost" style={{ fontSize: '0.78rem', padding: '0.4rem 0.85rem' }}>
                          Ouvrir
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* ── Calculs ── */}
          {activeSection === 'calculations' && (
            <>
              <div className="page-header">
                <h1>Calculs</h1>
                <p>Lancez et consultez vos calculs CP.</p>
              </div>
              <div className="empty-state">
                <div className="empty-state-icon">⚡</div>
                <h3>Démarrez un calcul</h3>
                <p>
                  Sélectionnez un projet, configurez vos paramètres SACP/ICCP et lancez le moteur de calcul.
                </p>
                <button id="new-calculation-btn" className="btn btn-primary-dash" style={{ margin: '1.5rem auto 0', display: 'flex' }}>
                  ＋ Nouveau calcul
                </button>
              </div>
            </>
          )}

          {/* ── GIS ── */}
          {activeSection === 'gis' && (
            <>
              <div className="page-header">
                <h1>Carte GIS 3D</h1>
                <p>Visualisation des tracés de pipelines et des anodes.</p>
              </div>
              <div className="empty-state">
                <div className="empty-state-icon">🗺️</div>
                <h3>Carte GIS interactive</h3>
                <p>Le module GIS 3D est chargé depuis l'application principale.<br />
                  Sélectionnez un projet pour visualiser son réseau.
                </p>
                <a href="/" className="btn btn-primary-dash" style={{ margin: '1.5rem auto 0', display: 'inline-flex' }}>
                  Ouvrir dans CP Engineer ↗
                </a>
              </div>
            </>
          )}

          {/* ── Rapports ── */}
          {activeSection === 'reports' && (
            <>
              <div className="page-header">
                <h1>Rapports PDF</h1>
                <p>Générez et téléchargez vos rapports certifiés.</p>
              </div>
              <div className="empty-state">
                <div className="empty-state-icon">📄</div>
                <h3>Aucun rapport récent</h3>
                <p>Générez un rapport PDF certifié ISO 15589-1 depuis un calcul terminé.</p>
              </div>
            </>
          )}

          {/* ── Settings ── */}
          {activeSection === 'settings' && (
            <>
              <div className="page-header">
                <h1>Paramètres</h1>
                <p>Gérez votre compte et les préférences de l'organisation.</p>
              </div>
              <div className="card" style={{ maxWidth: 520 }}>
                <div className="card-header">
                  <span className="card-title">Profil</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                  <div><strong style={{ color: 'var(--text)' }}>Nom</strong> : {user?.firstName} {user?.lastName}</div>
                  <div><strong style={{ color: 'var(--text)' }}>Email</strong> : {user?.email}</div>
                  <div><strong style={{ color: 'var(--text)' }}>Rôle</strong> : {user?.role}</div>
                  <div><strong style={{ color: 'var(--text)' }}>Organisation</strong> : {user?.tenant?.organizationName}</div>
                  <div><strong style={{ color: 'var(--text)' }}>Plan</strong> : {user?.tenant?.plan}</div>
                </div>
              </div>
            </>
          )}

        </div>
      </main>
    </div>
  );
};
