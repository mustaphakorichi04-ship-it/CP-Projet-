import React from 'react';

export const PrivacyPolicy: React.FC = () => {
  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>Politique de Confidentialité</h1>
        <p style={styles.lastUpdated}>Dernière mise à jour : {new Date().toLocaleDateString('fr-FR')}</p>
        
        <section style={styles.section}>
          <h2 style={styles.heading}>1. Cadre Légal</h2>
          <p style={styles.text}>
            La présente politique s'inscrit dans le respect de la <strong>Loi algérienne 18-07</strong> relative 
            à la protection des personnes physiques dans le traitement des données à caractère personnel, ainsi que du 
            <strong>Règlement Général sur la Protection des Données (RGPD)</strong> européen.
          </p>
        </section>

        <section style={styles.section}>
          <h2 style={styles.heading}>2. Données collectées</h2>
          <p style={styles.text}>
            Nous collectons les données strictement nécessaires à la fourniture de la solution SaaS CP Engineer Pro :<br/>
            - <strong>Données d'identité :</strong> Nom, prénom, fonction, adresse email professionnelle.<br/>
            - <strong>Données techniques de connexion :</strong> Adresse IP, logs de connexion, agent utilisateur.<br/>
            - <strong>Données métiers :</strong> Configurations des pipelines, relevés GPS, paramètres de protection cathodique (SACP/ICCP).
          </p>
        </section>

        <section style={styles.section}>
          <h2 style={styles.heading}>3. Finalité du Traitement</h2>
          <p style={styles.text}>
            Vos données sont utilisées exclusivement pour :<br/>
            - Assurer l'accès sécurisé à l'application et la gestion du multi-tenant.<br/>
            - Exécuter les calculs d'ingénierie (ISO 15589-1) et générer les rapports.<br/>
            - Assurer le suivi de la facturation et des quotas de calculs.<br/>
            - Améliorer la performance de la plateforme via des statistiques anonymisées.
          </p>
        </section>

        <section style={styles.section}>
          <h2 style={styles.heading}>4. Droits des utilisateurs</h2>
          <p style={styles.text}>
            Conformément à la réglementation (Art. 17 et 20 du RGPD, et articles correspondants de la Loi 18-07), vous disposez des droits suivants :<br/>
            - <strong>Droit d'accès et de portabilité :</strong> Vous pouvez exporter l'intégralité de vos données via votre espace compte.<br/>
            - <strong>Droit à l'oubli :</strong> Vous pouvez demander la suppression définitive de votre compte (anonymisation des calculs liés).<br/>
            - <strong>Droit de rectification :</strong> Vous pouvez modifier vos informations depuis les paramètres de l'application.<br/><br/>
            Pour exercer ces droits, utilisez les outils mis à votre disposition dans l'application ou contactez notre DPO à <strong>privacy@cp-engineer.com</strong>.
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
