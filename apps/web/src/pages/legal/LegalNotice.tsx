import React from 'react';

export const LegalNotice: React.FC = () => {
  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>Mentions Légales</h1>
        <p style={styles.lastUpdated}>Dernière mise à jour : {new Date().toLocaleDateString('fr-FR')}</p>
        
        <section style={styles.section}>
          <h2 style={styles.heading}>1. Éditeur du Service</h2>
          <p style={styles.text}>
            Le service SaaS <strong>CP Engineer Pro</strong> est édité par la société [Nom de votre Société], 
            société [Forme juridique, ex: SARL] au capital de [Montant] DZD.<br/>
            <strong>Siège social :</strong> [Adresse complète en Algérie]<br/>
            <strong>Numéro de RC (Registre de Commerce) :</strong> [Numéro]<br/>
            <strong>NIF (Numéro d'Identification Fiscale) :</strong> [Numéro]<br/>
            <strong>NIS (Numéro d'Identification Statistique) :</strong> [Numéro]<br/>
            <strong>Directeur de la publication :</strong> [Nom du représentant légal]
          </p>
        </section>

        <section style={styles.section}>
          <h2 style={styles.heading}>2. Hébergement</h2>
          <p style={styles.text}>
            Les serveurs principaux de l'application sont hébergés par [Nom de l'hébergeur (ex: AWS, Azure, ou hébergeur local)].<br/>
            <strong>Adresse de l'hébergeur :</strong> [Adresse de l'hébergeur]<br/>
            Conformément aux exigences légales, les données sensibles liées aux infrastructures nationales 
            peuvent faire l'objet d'un hébergement local ou dédié selon le plan souscrit.
          </p>
        </section>

        <section style={styles.section}>
          <h2 style={styles.heading}>3. Délégué à la Protection des Données (DPO)</h2>
          <p style={styles.text}>
            Pour toute question relative à la protection de vos données personnelles (Loi 18-07 et RGPD), 
            vous pouvez contacter notre Délégué à la Protection des Données :<br/>
            <strong>Email :</strong> privacy@cp-engineer.com<br/>
            <strong>Courrier :</strong> À l'attention du DPO, [Adresse du siège]
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
  title: {
    fontSize: '2.25rem',
    fontWeight: 700,
    color: '#0f172a',
    marginBottom: '0.5rem'
  },
  lastUpdated: {
    fontSize: '0.875rem',
    color: '#64748b',
    marginBottom: '2.5rem'
  },
  section: {
    marginBottom: '2rem'
  },
  heading: {
    fontSize: '1.25rem',
    fontWeight: 600,
    color: '#1e293b',
    borderBottom: '2px solid #e2e8f0',
    paddingBottom: '0.5rem',
    marginBottom: '1rem'
  },
  text: {
    fontSize: '1rem',
    lineHeight: 1.6,
    color: '#475569'
  }
};
