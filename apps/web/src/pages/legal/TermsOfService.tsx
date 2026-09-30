import React from 'react';

export const TermsOfService: React.FC = () => {
  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>Conditions Générales d'Utilisation (CGU)</h1>
        <p style={styles.lastUpdated}>Dernière mise à jour : {new Date().toLocaleDateString('fr-FR')}</p>
        
        <section style={styles.section}>
          <h2 style={styles.heading}>1. Préambule</h2>
          <p style={styles.text}>
            Les présentes Conditions Générales d'Utilisation déterminent les règles d'accès et d'utilisation 
            de la plateforme SaaS <strong>CP Engineer Pro</strong>, spécialisée dans les calculs d'ingénierie en protection cathodique.
          </p>
        </section>

        <section style={styles.section}>
          <h2 style={styles.heading}>2. Accès au service et Sécurité</h2>
          <p style={styles.text}>
            L'accès à la plateforme est strictement réservé aux utilisateurs disposant d'un compte actif 
            attaché à un <strong>Tenant (Organisation)</strong>.<br/>
            L'utilisateur s'engage à ne pas partager ses identifiants. Toute action réalisée sous un compte 
            sera réputée effectuée par le titulaire de ce compte. En cas de suspicion de compromission, 
            le Client doit en informer immédiatement l'administration de CP Engineer Pro.
          </p>
        </section>

        <section style={styles.section}>
          <h2 style={styles.heading}>3. Propriété Intellectuelle & Données</h2>
          <p style={styles.text}>
            <strong>Le logiciel :</strong> CP Engineer Pro reste le propriétaire exclusif de l'application, de son code 
            source, de ses algorithmes de calcul et de son interface (droits d'auteur).<br/>
            <strong>Vos données :</strong> L'Organisation (Tenant) conserve l'entière propriété intellectuelle 
            des données saisies (designs de protection cathodique, données géographiques, relevés terrains). 
            Le Client autorise l'Éditeur à héberger et traiter ces données dans le seul but de fournir le service.
          </p>
        </section>

        <section style={styles.section}>
          <h2 style={styles.heading}>4. Limitation de Responsabilité</h2>
          <p style={styles.text}>
            Les résultats des calculs fournis par CP Engineer Pro sont des outils d'aide à la décision (respectant 
            la norme ISO 15589-1). Ils doivent être validés par un ingénieur qualifié. L'Éditeur ne saurait être tenu 
            responsable des dommages directs ou indirects résultant d'une erreur de conception ou d'une mauvaise interprétation des résultats.
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
