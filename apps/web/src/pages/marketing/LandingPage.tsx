import React from 'react';
import '../styles/marketing.css';

export const LandingPage: React.FC = () => {
  return (
    <div className="marketing-container">
      {/* ─── Navbar ─── */}
      <nav className="navbar">
        <div className="brand">⚡ CP Engineer Pro</div>
        <div className="nav-links">
          <a href="/pricing">Tarifs</a>
          <a href="/status">Status</a>
          <a href="/legal/notice">Mentions légales</a>
          <a href="/app/login" style={{ color: '#0ea5e9' }}>Connexion</a>
        </div>
      </nav>

      {/* ─── Hero ─── */}
      <section className="hero">
        <p style={{ color: '#0ea5e9', fontWeight: 700, letterSpacing: '2px', textTransform: 'uppercase', fontSize: '0.85rem', marginBottom: '1rem' }}>
          SaaS Industriel • Protection Cathodique
        </p>
        <h1 className="hero-title">
          Calculs CP certifiés<br />
          <span style={{ background: 'linear-gradient(135deg, #0ea5e9 0%, #6366f1 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            en quelques secondes
          </span>
        </h1>
        <p className="hero-subtitle">
          La seule plateforme SaaS multi-tenant dédiée aux ingénieurs de protection cathodique. 
          SACP, ICCP, câblage, atténuation — conformes NACE SP0169 & ISO 15589-1.
        </p>
        <button className="btn-primary" onClick={() => window.location.href = '/app/register'}>
          Démarrer gratuitement
        </button>
        <span style={{ display: 'block', marginTop: '1rem', color: '#64748b', fontSize: '0.85rem' }}>
          Aucune carte bancaire requise · 14 jours d'essai
        </span>
      </section>

      {/* ─── Features ─── */}
      <section style={{ padding: '4rem 5%', maxWidth: '1200px', margin: '0 auto', width: '100%' }}>
        <h2 style={{ textAlign: 'center', fontSize: '2rem', fontWeight: 700, marginBottom: '3rem' }}>
          Conçu pour les vrais ingénieurs de terrain
        </h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '2rem' }}>
          {FEATURES.map((f, i) => (
            <div key={i} style={{ background: 'rgba(30,41,59,0.7)', borderRadius: '12px', padding: '2rem', border: '1px solid rgba(255,255,255,0.07)', transition: 'transform 0.3s' }}
              onMouseEnter={e => (e.currentTarget.style.transform = 'translateY(-6px)')}
              onMouseLeave={e => (e.currentTarget.style.transform = 'none')}
            >
              <div style={{ fontSize: '2.5rem', marginBottom: '1rem' }}>{f.icon}</div>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '0.5rem' }}>{f.title}</h3>
              <p style={{ color: '#94a3b8', lineHeight: 1.6, fontSize: '0.95rem' }}>{f.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ─── Footer ─── */}
      <footer style={{ borderTop: '1px solid rgba(255,255,255,0.05)', padding: '2rem 5%', display: 'flex', justifyContent: 'space-between', color: '#475569', fontSize: '0.875rem' }}>
        <span>© {new Date().getFullYear()} CP Engineer Pro. Tous droits réservés.</span>
        <div style={{ display: 'flex', gap: '1.5rem' }}>
          <a href="/legal/privacy" style={{ color: '#475569', textDecoration: 'none' }}>Confidentialité</a>
          <a href="/legal/terms" style={{ color: '#475569', textDecoration: 'none' }}>CGU</a>
          <a href="/legal/sales" style={{ color: '#475569', textDecoration: 'none' }}>CGV</a>
          <a href="/legal/notice" style={{ color: '#475569', textDecoration: 'none' }}>Mentions légales</a>
        </div>
      </footer>
    </div>
  );
};

const FEATURES = [
  {
    icon: '⚡',
    title: 'Calculs instantanés SACP & ICCP',
    description: 'Moteur de calcul multi-couche conforme ISO 15589-1. Résultats certifiés en moins de 200ms, même pour les pipelines longue-distance.'
  },
  {
    icon: '🗺️',
    title: 'Intégration GIS & GPS',
    description: 'Visualisation 3D des tracés de pipelines, positionnement GPS des anodes de galvanisation sacrificielles et des prises de potentiel.'
  },
  {
    icon: '🏢',
    title: 'Multi-tenant & RBAC',
    description: 'Isolation complète par organisation. Rôles Admin, Ingénieur Principal, Technicien Terrain et Observateur.'
  },
  {
    icon: '📄',
    title: 'Rapports PDF certifiés',
    description: 'Génération de rapports d\'ingénierie normés en un clic, prêts à être soumis aux autorités réglementaires.'
  },
  {
    icon: '🔒',
    title: 'Sécurité industrielle',
    description: 'PostgreSQL avec Row-Level Security. Chiffrement en transit (TLS) et au repos. Conforme RGPD & Loi 18-07.'
  },
  {
    icon: '📡',
    title: 'Mode hors-ligne & sync',
    description: 'Continuez à travailler sur le terrain sans connexion. Synchronisation automatique dès le retour en ligne.'
  },
];
