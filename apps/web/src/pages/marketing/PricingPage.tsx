import React, { useState } from 'react';
import '../styles/marketing.css';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Plan {
  name: string;
  monthlyPrice: number | null;  // null = Gratuit ou Sur devis
  annualPrice: number | null;
  priceSuffix: string;
  priceFree?: boolean;
  priceOnRequest?: boolean;
  description: string;
  features: string[];
  cta: string;
  ctaUrl: string;
  highlighted: boolean;
  accentColor: string;
}

// ── Plans data ────────────────────────────────────────────────────────────────

const PLANS: Plan[] = [
  {
    name: 'Starter',
    monthlyPrice: null,
    annualPrice: null,
    priceSuffix: '',
    priceFree: true,
    description: 'Pour les petites équipes et les étudiants en ingénierie CP.',
    features: [
      '1 utilisateur',
      '50 calculs / mois',
      'Calculs SACP de base',
      'Export PDF standard',
      'Support communautaire',
    ],
    cta: 'Commencer gratuitement',
    ctaUrl: '/app/register?plan=FREE',
    highlighted: false,
    accentColor: '#94a3b8',
  },
  {
    name: 'Pro',
    monthlyPrice: 29000,
    annualPrice: 24650,
    priceSuffix: 'DZD HT / siège / mois',
    description: 'La solution complète pour les équipes d\'ingénieurs actives.',
    features: [
      'Sièges illimités (per-seat)',
      '500 calculs / mois / siège',
      'SACP + ICCP + Interférences + Câblage',
      'Export PDF certifié ISO 15589-1',
      'GIS 3D & Intégration GPS',
      'Support email prioritaire',
      'Accès API REST complet',
      'Mode hors-ligne & synchronisation',
    ],
    cta: 'Démarrer l\'essai Pro',
    ctaUrl: '/app/register?plan=PRO',
    highlighted: true,
    accentColor: '#0ea5e9',
  },
  {
    name: 'Enterprise',
    monthlyPrice: null,
    annualPrice: null,
    priceSuffix: '',
    priceOnRequest: true,
    description: 'Pour les grandes compagnies pétrolières et gazières.',
    features: [
      'Tout le plan Pro',
      'Base de données dédiée (isolation totale)',
      'DPA personnalisé & SLA 99.9%',
      'Hébergement local en Algérie',
      'Formation & déploiement sur site',
      'Manager de compte dédié',
      'Audit de sécurité SOC 2',
    ],
    cta: 'Contacter notre équipe',
    ctaUrl: 'mailto:sales@cp-engineer.com',
    highlighted: false,
    accentColor: '#6366f1',
  },
];

// ── FAQ data ──────────────────────────────────────────────────────────────────

const FAQ = [
  {
    q: 'Quelle est la politique de TVA ?',
    a: 'Tous les prix sont affichés HT. Une TVA algérienne de 19% est appliquée sur les factures des clients basés en Algérie. Pour les clients hors Algérie, les règles d\'autoliquidation B2B s\'appliquent.',
  },
  {
    q: 'Peut-on annuler à tout moment ?',
    a: 'Oui, les abonnements mensuels peuvent être annulés à tout moment sans frais. Pour les abonnements annuels, un remboursement au prorata est applicable dans les 30 premiers jours.',
  },
  {
    q: 'Qu\'est-ce qu\'un calcul "overage" ?',
    a: 'Si vous dépassez le quota inclus dans votre plan, chaque calcul supplémentaire est facturé séparément selon la grille tarifaire "overage" visible dans votre portail de facturation.',
  },
  {
    q: 'Hébergement en Algérie : est-ce disponible immédiatement ?',
    a: 'L\'hébergement local en Algérie (datacenter Oran ou Alger) est disponible uniquement sur le plan Enterprise sur demande. Contactez notre équipe pour un devis personnalisé.',
  },
];

// ── Component ─────────────────────────────────────────────────────────────────

export const PricingPage: React.FC = () => {
  const [annual, setAnnual] = useState(false);
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  const getDisplayPrice = (plan: Plan): string => {
    if (plan.priceFree) return 'Gratuit';
    if (plan.priceOnRequest) return 'Sur devis';
    const price = annual ? plan.annualPrice : plan.monthlyPrice;
    return price ? price.toLocaleString('fr-DZ') : '—';
  };

  return (
    <div className="marketing-container">
      {/* ── Navbar ── */}
      <nav className="navbar">
        <a href="/" className="brand">⚡ CP Engineer Pro</a>
        <div className="nav-links">
          <a href="/">Accueil</a>
          <a href="/status">Status</a>
          <a href="/login" style={{ color: '#0ea5e9' }}>Connexion</a>
        </div>
      </nav>

      {/* ── Hero ── */}
      <section style={{ textAlign: 'center', padding: '5rem 5% 1rem', animation: 'fadeIn 0.8s ease forwards' }}>
        <div style={{
          display: 'inline-block',
          background: 'rgba(14,165,233,0.1)',
          border: '1px solid rgba(14,165,233,0.2)',
          color: '#0ea5e9',
          fontSize: '0.8rem',
          fontWeight: 700,
          letterSpacing: '2px',
          textTransform: 'uppercase',
          padding: '5px 14px',
          borderRadius: '20px',
          marginBottom: '1.5rem',
        }}>
          Tarification
        </div>
        <h1 style={{ fontSize: '3rem', fontWeight: 800, marginBottom: '1rem', letterSpacing: '-0.5px' }}>
          Tarifs simples et transparents
        </h1>
        <p style={{ color: '#94a3b8', fontSize: '1.15rem', maxWidth: '520px', margin: '0 auto 2.5rem' }}>
          Pas de frais cachés. Choisissez le plan adapté à votre équipe.
        </p>

        {/* Toggle mensuel / annuel */}
        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.85rem',
          background: 'rgba(30,41,59,0.7)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: '40px',
          padding: '6px 8px',
        }}>
          <button
            id="billing-monthly-btn"
            onClick={() => setAnnual(false)}
            style={{
              padding: '0.45rem 1.25rem',
              borderRadius: '30px',
              border: 'none',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: '0.875rem',
              transition: 'all 0.2s',
              background: !annual ? 'linear-gradient(135deg, #0ea5e9, #6366f1)' : 'transparent',
              color: !annual ? 'white' : '#94a3b8',
              fontFamily: 'Inter, sans-serif',
            }}
          >
            Mensuel
          </button>
          <button
            id="billing-annual-btn"
            onClick={() => setAnnual(true)}
            style={{
              padding: '0.45rem 1.25rem',
              borderRadius: '30px',
              border: 'none',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: '0.875rem',
              transition: 'all 0.2s',
              background: annual ? 'linear-gradient(135deg, #0ea5e9, #6366f1)' : 'transparent',
              color: annual ? 'white' : '#94a3b8',
              fontFamily: 'Inter, sans-serif',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
            }}
          >
            Annuel
            <span style={{
              background: 'rgba(34,197,94,0.15)',
              color: '#22c55e',
              fontSize: '0.7rem',
              fontWeight: 700,
              padding: '2px 7px',
              borderRadius: '20px',
              letterSpacing: '0.5px',
            }}>
              −15%
            </span>
          </button>
        </div>
      </section>

      {/* ── Pricing Grid ── */}
      <div className="pricing-grid">
        {PLANS.map((plan) => (
          <div
            key={plan.name}
            id={`plan-card-${plan.name.toLowerCase()}`}
            className={`pricing-card ${plan.highlighted ? 'pro' : ''}`}
            style={plan.highlighted ? { borderColor: plan.accentColor, boxShadow: `0 0 40px ${plan.accentColor}22` } : {}}
          >
            {plan.highlighted && (
              <div className="badge-popular">⭐ Le plus populaire</div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <div className="price-title" style={{ color: plan.accentColor }}>{plan.name}</div>
            </div>
            <p style={{ color: '#64748b', fontSize: '0.875rem', minHeight: '44px', lineHeight: 1.6 }}>
              {plan.description}
            </p>

            <div className="price-amount" style={{ color: plan.highlighted ? plan.accentColor : 'var(--text-light)' }}>
              {getDisplayPrice(plan)}
              {!plan.priceFree && !plan.priceOnRequest && (
                <span style={{ display: 'block', fontSize: '0.9rem', color: '#64748b', fontWeight: 400, marginTop: '0.25rem' }}>
                  {plan.priceSuffix}
                  {annual && (
                    <span style={{ marginLeft: '0.5rem', color: '#22c55e', fontSize: '0.8rem', fontWeight: 600 }}>
                      Économisez 15%
                    </span>
                  )}
                </span>
              )}
            </div>

            <ul className="features-list">
              {plan.features.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>

            <button
              id={`cta-${plan.name.toLowerCase()}`}
              className={plan.highlighted ? 'btn-primary' : ''}
              style={!plan.highlighted ? {
                width: '100%',
                padding: '0.9rem',
                borderRadius: '50px',
                cursor: 'pointer',
                background: 'transparent',
                border: `1px solid ${plan.accentColor}44`,
                color: plan.accentColor,
                fontWeight: 600,
                fontSize: '1rem',
                transition: 'background 0.2s, border-color 0.2s',
                fontFamily: 'Inter, sans-serif',
              } : {
                width: '100%',
                animation: 'none',
                fontFamily: 'Inter, sans-serif',
              }}
              onMouseEnter={e => {
                if (!plan.highlighted) {
                  (e.currentTarget as HTMLButtonElement).style.background = `${plan.accentColor}11`;
                  (e.currentTarget as HTMLButtonElement).style.borderColor = plan.accentColor;
                }
              }}
              onMouseLeave={e => {
                if (!plan.highlighted) {
                  (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
                  (e.currentTarget as HTMLButtonElement).style.borderColor = `${plan.accentColor}44`;
                }
              }}
              onClick={() => window.location.href = plan.ctaUrl}
            >
              {plan.cta}
            </button>
          </div>
        ))}
      </div>

      {/* ── Trust Badges ── */}
      <section style={{
        display: 'flex',
        justifyContent: 'center',
        gap: '3rem',
        padding: '1rem 5% 4rem',
        flexWrap: 'wrap',
        color: '#475569',
        fontSize: '0.85rem',
      }}>
        {['🔒 Données chiffrées TLS + AES-256', '📜 Conformité ISO 15589-1', '🌍 Hébergement Algérie disponible', '💳 Facturation TVA algérienne'].map(b => (
          <span key={b} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>{b}</span>
        ))}
      </section>

      {/* ── FAQ ── */}
      <section style={{ maxWidth: '720px', margin: '0 auto 5rem', padding: '0 5%' }}>
        <h2 style={{ textAlign: 'center', fontSize: '1.75rem', fontWeight: 800, marginBottom: '2.5rem' }}>
          Questions fréquentes
        </h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {FAQ.map((item, i) => (
            <div
              key={i}
              id={`faq-item-${i}`}
              style={{
                background: 'rgba(30,41,59,0.6)',
                border: `1px solid ${openFaq === i ? 'rgba(14,165,233,0.3)' : 'rgba(255,255,255,0.06)'}`,
                borderRadius: '12px',
                overflow: 'hidden',
                transition: 'border-color 0.2s',
              }}
            >
              <button
                onClick={() => setOpenFaq(openFaq === i ? null : i)}
                style={{
                  width: '100%',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '1.1rem 1.5rem',
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-light)',
                  fontSize: '0.95rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontFamily: 'Inter, sans-serif',
                }}
              >
                {item.q}
                <span style={{
                  color: '#0ea5e9',
                  fontSize: '1.2rem',
                  transform: openFaq === i ? 'rotate(45deg)' : 'none',
                  transition: 'transform 0.2s',
                }}>+</span>
              </button>
              {openFaq === i && (
                <div style={{ padding: '0 1.5rem 1.1rem', color: '#94a3b8', fontSize: '0.9rem', lineHeight: 1.7, animation: 'fadeIn 0.3s ease' }}>
                  {item.a}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* ── Footer note ── */}
      <section style={{ textAlign: 'center', padding: '2rem 5% 3rem', color: '#475569', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
        <p style={{ marginBottom: '0.5rem' }}>
          Tous les prix sont exprimés HT.{' '}
          <strong style={{ color: '#94a3b8' }}>TVA algérienne 19%</strong> applicable sur les factures des clients en Algérie.
        </p>
        <p>
          Des questions ?{' '}
          <a href="mailto:sales@cp-engineer.com" style={{ color: '#0ea5e9' }}>
            Contactez notre équipe commerciale
          </a>
        </p>
      </section>
    </div>
  );
};
