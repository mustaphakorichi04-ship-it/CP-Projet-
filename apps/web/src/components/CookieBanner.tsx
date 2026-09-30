import React, { useState, useEffect } from 'react';

interface CookieConsent {
  necessary: boolean;
  analytics: boolean;
  marketing: boolean;
}

interface CookieBannerProps {
  onConsentChange: (consent: CookieConsent) => void;
}

export const CookieBanner: React.FC<CookieBannerProps> = ({ onConsentChange }) => {
  const [isVisible, setIsVisible] = useState(false);
  const [consent, setConsent] = useState<CookieConsent>({
    necessary: true, // Toujours vrai
    analytics: false,
    marketing: false,
  });

  useEffect(() => {
    // Vérifier si le consentement a déjà été donné
    const existingConsent = localStorage.getItem('cp_cookie_consent');
    if (!existingConsent) {
      setIsVisible(true);
    }
  }, []);

  const handleAcceptAll = () => {
    const fullConsent = { necessary: true, analytics: true, marketing: true };
    saveConsent(fullConsent);
  };

  const handleSavePreferences = () => {
    saveConsent(consent);
  };

  const saveConsent = (finalConsent: CookieConsent) => {
    localStorage.setItem('cp_cookie_consent', JSON.stringify(finalConsent));
    setIsVisible(false);
    onConsentChange(finalConsent);
    
    // Appel API pour sauvegarder côté serveur si l'utilisateur est connecté
    fetch('/api/v1/compliance/user/consent', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${localStorage.getItem('token')}` // A adapter selon l'auth
      },
      body: JSON.stringify({ cookieConsent: finalConsent })
    }).catch(err => console.error('Erreur sauvegarde consentement:', err));
  };

  if (!isVisible) return null;

  return (
    <div style={styles.bannerContainer}>
      <div style={styles.bannerContent}>
        <h3 style={styles.title}>Politique de Cookies & Confidentialité</h3>
        <p style={styles.text}>
          Nous utilisons des cookies pour assurer le bon fonctionnement de la plateforme (obligatoire), 
          analyser l'usage pour améliorer nos services, et pour le support client.
        </p>
        
        <div style={styles.preferences}>
          <label style={styles.label}>
            <input type="checkbox" checked disabled />
            Strictement nécessaires
          </label>
          <label style={styles.label}>
            <input 
              type="checkbox" 
              checked={consent.analytics} 
              onChange={e => setConsent(c => ({...c, analytics: e.target.checked}))} 
            />
            Analytics & Performance
          </label>
        </div>

        <div style={styles.actions}>
          <button style={styles.buttonOutline} onClick={handleSavePreferences}>Enregistrer les préférences</button>
          <button style={styles.buttonPrimary} onClick={handleAcceptAll}>Tout Accepter</button>
        </div>
      </div>
    </div>
  );
};

const styles = {
  bannerContainer: {
    position: 'fixed' as const,
    bottom: 0, left: 0, right: 0,
    backgroundColor: '#1a1b1e',
    color: '#fff',
    padding: '1.5rem',
    zIndex: 9999,
    boxShadow: '0 -4px 12px rgba(0,0,0,0.15)'
  },
  bannerContent: {
    maxWidth: '1200px',
    margin: '0 auto',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '1rem'
  },
  title: { margin: 0, fontSize: '1.2rem', fontWeight: 600 },
  text: { margin: 0, fontSize: '0.9rem', color: '#c1c2c5', lineHeight: 1.5 },
  preferences: { display: 'flex', gap: '1.5rem', marginTop: '0.5rem' },
  label: { display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.9rem' },
  actions: { display: 'flex', gap: '1rem', justifyContent: 'flex-end', marginTop: '1rem' },
  buttonPrimary: {
    backgroundColor: '#3b82f6', color: 'white', border: 'none',
    padding: '0.5rem 1rem', borderRadius: '4px', cursor: 'pointer', fontWeight: 600
  },
  buttonOutline: {
    backgroundColor: 'transparent', color: '#3b82f6', border: '1px solid #3b82f6',
    padding: '0.5rem 1rem', borderRadius: '4px', cursor: 'pointer', fontWeight: 600
  }
};
