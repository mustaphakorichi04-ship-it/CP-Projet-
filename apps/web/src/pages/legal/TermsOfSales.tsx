import React from 'react';

export const TermsOfSales: React.FC = () => {
  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>Conditions Générales de Vente (CGV)</h1>
        <p style={styles.lastUpdated}>Dernière mise à jour : {new Date().toLocaleDateString('fr-FR')}</p>
        
        <section style={styles.section}>
          <h2 style={styles.heading}>1. Objet</h2>
          <p style={styles.text}>
            Les présentes Conditions Générales de Vente encadrent la fourniture des abonnements SaaS à la plateforme 
            <strong>CP Engineer Pro</strong> (Plans PRO, ENTERPRISE) à destination des professionnels de l'industrie (B2B).
          </p>
        </section>

        <section style={styles.section}>
          <h2 style={styles.heading}>2. Tarification et Facturation</h2>
          <p style={styles.text}>
            Les tarifs sont exprimés Hors Taxes (HT).<br/>
            <strong>TVA applicable :</strong> Conformément à la législation fiscale en vigueur, une TVA de 19% (Algérie) 
            est applicable pour les clients résidant en Algérie. Pour les clients internationaux, les règles d'autoliquidation ou d'exonération B2B s'appliquent selon la juridiction.<br/>
            <strong>Facturation :</strong> Les abonnements sont facturés selon un modèle hybride :<br/>
            - Un coût fixe par siège (per-seat).<br/>
            - Un coût variable de dépassement (overage) basé sur les quotas d'appels API (Stripe Metered Billing).
          </p>
        </section>

        <section style={styles.section}>
          <h2 style={styles.heading}>3. Modalités de Paiement et Défaut</h2>
          <p style={styles.text}>
            Les paiements sont traités de manière sécurisée via Stripe. 
            En cas d'échec de paiement, une procédure de relance automatisée (Dunning) est enclenchée à J+1, J+3 et J+7. 
            À l'issue de cette période, l'accès au Tenant sera suspendu jusqu'à régularisation.
          </p>
        </section>

        <section style={styles.section}>
          <h2 style={styles.heading}>4. Litiges et Juridiction Compétente</h2>
          <p style={styles.text}>
            Tout litige relatif à l'interprétation ou à l'exécution des présentes CGV sera de la compétence exclusive 
            des tribunaux de commerce de [Ville du Siège Social, ex: Alger], Algérie.
          </p>
        </section>
      </div>
    </div>
  );
};

const styles = {
  container: {
    minHeight: '100vh',
    backgroundColor: '#f8fafc',
    padding: '4rem 2rem',
    fontFamily: '"Inter", "Roboto", sans-serif',
    color: '#334155'
  },
  card: {
    maxWidth: '800px',
    margin: '0 auto',
    backgroundColor: '#ffffff',
    borderRadius: '12px',
    padding: '3rem',
    boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)'
  },
  title: { fontSize: '2.25rem', fontWeight: 700, color: '#0f172a', marginBottom: '0.5rem' },
  lastUpdated: { fontSize: '0.875rem', color: '#64748b', marginBottom: '2.5rem' },
  section: { marginBottom: '2rem' },
  heading: {
    fontSize: '1.25rem', fontWeight: 600, color: '#1e293b',
    borderBottom: '2px solid #e2e8f0', paddingBottom: '0.5rem', marginBottom: '1rem'
  },
  text: { fontSize: '1rem', lineHeight: 1.6, color: '#475569' }
};
