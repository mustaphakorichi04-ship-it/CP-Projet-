import React, { useState, useEffect } from 'react';

interface QuotaStatus {
  tenantId: string;
  plan: string;
  usedCalculations: number;
  includedCalculations: number;
  overageCalculations: number;
  isQuotaExceeded: boolean;
}

export const BillingDashboard: React.FC = () => {
  const [quota, setQuota] = useState<QuotaStatus | null>(null);
  const [loadingPortal, setLoadingPortal] = useState(false);

  useEffect(() => {
    // Récupérer le statut du quota depuis l'API
    fetch('/api/v1/billing/quota-status', {
      headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
    })
      .then(res => res.json())
      .then(data => setQuota(data))
      .catch(err => console.error("Erreur récupération quota:", err));
  }, []);

  const openCustomerPortal = async () => {
    setLoadingPortal(true);
    try {
      const res = await fetch('/api/v1/billing/portal', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify({ returnUrl: window.location.href })
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url; // Redirection vers Stripe
      }
    } catch (err) {
      console.error("Erreur ouverture portail:", err);
    } finally {
      setLoadingPortal(false);
    }
  };

  if (!quota) return <div style={styles.container}>Chargement des informations de facturation...</div>;

  const usagePercentage = Math.min((quota.usedCalculations / quota.includedCalculations) * 100, 100);
  const getProgressBarColor = () => {
    if (usagePercentage >= 100) return '#ef4444'; // Rouge
    if (usagePercentage >= 80) return '#f59e0b'; // Orange
    return '#3b82f6'; // Bleu
  };

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>Facturation & Abonnement</h1>
      
      <div style={styles.grid}>
        <div style={styles.card}>
          <h2 style={styles.cardTitle}>Plan Actuel : {quota.plan}</h2>
          <p style={styles.text}>
            Gérez vos moyens de paiement, modifiez votre abonnement et téléchargez vos factures 
            (conformes TVA Algérie / Autoliquidation) directement depuis votre espace sécurisé.
          </p>
          <button 
            style={styles.primaryButton} 
            onClick={openCustomerPortal}
            disabled={loadingPortal}
          >
            {loadingPortal ? 'Ouverture...' : 'Ouvrir le portail Stripe'}
          </button>
        </div>

        <div style={styles.card}>
          <h2 style={styles.cardTitle}>Consommation API (Calculs)</h2>
          <div style={styles.statContainer}>
            <span style={styles.statLarge}>{quota.usedCalculations}</span>
            <span style={styles.statLabel}>/ {quota.includedCalculations} calculs inclus</span>
          </div>
          
          <div style={styles.progressTrack}>
            <div 
              style={{
                ...styles.progressFill, 
                width: `${usagePercentage}%`, 
                backgroundColor: getProgressBarColor() 
              }} 
            />
          </div>

          {quota.overageCalculations > 0 && (
            <div style={styles.alertBox}>
              <strong>Attention :</strong> Vous avez effectué {quota.overageCalculations} calcul(s) hors forfait. 
              Ils vous seront facturés à la fin du mois selon la grille tarifaire "overage".
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const styles = {
  container: { padding: '2rem', maxWidth: '1200px', margin: '0 auto', fontFamily: '"Inter", sans-serif' },
  title: { fontSize: '2rem', color: '#0f172a', marginBottom: '2rem' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(350px, 1fr))', gap: '2rem' },
  card: { backgroundColor: '#fff', borderRadius: '8px', padding: '2rem', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', border: '1px solid #e2e8f0' },
  cardTitle: { fontSize: '1.25rem', color: '#1e293b', marginBottom: '1rem', borderBottom: '1px solid #e2e8f0', paddingBottom: '0.5rem' },
  text: { color: '#64748b', lineHeight: 1.6, marginBottom: '1.5rem' },
  primaryButton: { backgroundColor: '#2563eb', color: '#fff', padding: '0.75rem 1.5rem', borderRadius: '6px', border: 'none', fontWeight: 600, cursor: 'pointer', fontSize: '1rem', width: '100%' },
  statContainer: { display: 'flex', alignItems: 'baseline', gap: '0.5rem', marginBottom: '1rem' },
  statLarge: { fontSize: '2.5rem', fontWeight: 700, color: '#0f172a' },
  statLabel: { color: '#64748b', fontWeight: 500 },
  progressTrack: { height: '12px', backgroundColor: '#e2e8f0', borderRadius: '999px', overflow: 'hidden', marginBottom: '1.5rem' },
  progressFill: { height: '100%', transition: 'width 0.3s ease' },
  alertBox: { backgroundColor: '#fef2f2', border: '1px solid #f87171', color: '#991b1b', padding: '1rem', borderRadius: '6px', fontSize: '0.9rem' }
};
