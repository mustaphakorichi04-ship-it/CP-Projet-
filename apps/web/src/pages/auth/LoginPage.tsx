import React, { useState } from 'react';
import '../styles/auth.css';

interface LoginFormData {
  email: string;
  password: string;
  tenantSlug: string;
}

export const LoginPage: React.FC = () => {
  const [form, setForm] = useState<LoginFormData>({ email: '', password: '', tenantSlug: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<LoginFormData>>({});

  const validate = (): boolean => {
    const errs: Partial<LoginFormData> = {};
    if (!form.email.trim()) errs.email = 'L'email est requis.';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) errs.email = 'Email invalide.';
    if (!form.password) errs.password = 'Le mot de passe est requis.';
    if (!form.tenantSlug.trim()) errs.tenantSlug = 'L'identifiant organisation est requis.';
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!validate()) return;

    setLoading(true);
    try {
      const res = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          email: form.email.toLowerCase().trim(),
          password: form.password,
          tenantSlug: form.tenantSlug.toLowerCase().trim(),
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.message || 'Identifiants ou organisation incorrects.');
      }

      // Stocker les infos en mémoire pour le dashboard
      if (data.user) {
        sessionStorage.setItem('cp_user', JSON.stringify(data.user));
      }

      window.location.href = '/dashboard';
    } catch (err: any) {
      setError(err.message ?? 'Une erreur inattendue est survenue.');
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (field: keyof LoginFormData) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm(prev => ({ ...prev, [field]: e.target.value }));
    if (fieldErrors[field]) setFieldErrors(prev => ({ ...prev, [field]: undefined }));
  };

  return (
    <div className="auth-root">
      {/* ── Brand Panel ── */}
      <div className="auth-brand-panel">
        <div className="brand-logo">⚡ CP Engineer Pro</div>

        <h1 className="brand-headline">
          La plateforme<br />
          <span>SaaS pour ingénieurs</span><br />
          CP
        </h1>
        <p className="brand-desc">
          Calculs SACP & ICCP certifiés ISO 15589-1. Rapports PDF normés, 
          visualisation GIS 3D, multi-tenant sécurisé. Conçu pour le terrain algérien.
        </p>

        <div className="brand-badges">
          <div className="brand-badge">
            <div className="brand-badge-icon">🔒</div>
            <span>Isolation multi-tenant + Row-Level Security PostgreSQL</span>
          </div>
          <div className="brand-badge">
            <div className="brand-badge-icon">⚡</div>
            <span>Résultats de calcul en &lt; 200ms</span>
          </div>
          <div className="brand-badge">
            <div className="brand-badge-icon">📄</div>
            <span>Rapports conformes NACE SP0169 &amp; ISO 15589-1</span>
          </div>
          <div className="brand-badge">
            <div className="brand-badge-icon">🌍</div>
            <span>Hébergement local en Algérie disponible</span>
          </div>
        </div>
      </div>

      {/* ── Form Panel ── */}
      <div className="auth-form-panel">
        <div className="auth-card">
          <h2 className="auth-card-title">Connexion</h2>
          <p className="auth-card-subtitle">
            Accédez à votre espace d'ingénierie sécurisé.
          </p>

          {error && (
            <div className="auth-alert error" role="alert">
              <span>⚠️</span>
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} noValidate>
            {/* Organisation */}
            <div className="form-group">
              <label className="form-label" htmlFor="tenantSlug">
                Identifiant organisation
              </label>
              <div className="form-input-wrapper">
                <span className="form-input-icon">🏢</span>
                <input
                  id="tenantSlug"
                  type="text"
                  className={`form-input${fieldErrors.tenantSlug ? ' error' : ''}`}
                  placeholder="ex: sonatrach-dz"
                  value={form.tenantSlug}
                  onChange={handleChange('tenantSlug')}
                  autoComplete="organization"
                  spellCheck={false}
                />
              </div>
              {fieldErrors.tenantSlug && (
                <p className="form-error-msg">{fieldErrors.tenantSlug}</p>
              )}
            </div>

            {/* Email */}
            <div className="form-group">
              <label className="form-label" htmlFor="login-email">
                Adresse email
              </label>
              <div className="form-input-wrapper">
                <span className="form-input-icon">✉️</span>
                <input
                  id="login-email"
                  type="email"
                  className={`form-input${fieldErrors.email ? ' error' : ''}`}
                  placeholder="vous@entreprise.dz"
                  value={form.email}
                  onChange={handleChange('email')}
                  autoComplete="email"
                />
              </div>
              {fieldErrors.email && (
                <p className="form-error-msg">{fieldErrors.email}</p>
              )}
            </div>

            {/* Password */}
            <div className="form-group">
              <label className="form-label" htmlFor="login-password">
                Mot de passe
              </label>
              <div className="form-input-wrapper">
                <span className="form-input-icon">🔑</span>
                <input
                  id="login-password"
                  type={showPassword ? 'text' : 'password'}
                  className={`form-input${fieldErrors.password ? ' error' : ''}`}
                  placeholder="••••••••"
                  value={form.password}
                  onChange={handleChange('password')}
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  className="form-input-toggle"
                  onClick={() => setShowPassword(s => !s)}
                  aria-label={showPassword ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
                >
                  {showPassword ? '🙈' : '👁️'}
                </button>
              </div>
              {fieldErrors.password && (
                <p className="form-error-msg">{fieldErrors.password}</p>
              )}
            </div>

            <div className="auth-forgot">
              <a href="mailto:support@cp-engineer.com">Mot de passe oublié ?</a>
            </div>

            <button
              id="login-submit-btn"
              type="submit"
              className="auth-submit-btn"
              disabled={loading}
            >
              {loading ? (
                <>
                  <span className="auth-spinner" />
                  Connexion en cours…
                </>
              ) : (
                'Se connecter'
              )}
            </button>
          </form>

          <div className="auth-divider">ou</div>

          <p className="auth-link-row">
            Pas encore de compte ?{' '}
            <a href="/app/register">Créer votre organisation</a>
          </p>
          <p className="auth-link-row" style={{ marginTop: '0.5rem' }}>
            <a href="/status" style={{ color: 'var(--text-dim)', fontSize: '0.8rem' }}>
              État du service
            </a>
            {' · '}
            <a href="/legal/privacy" style={{ color: 'var(--text-dim)', fontSize: '0.8rem' }}>
              Confidentialité
            </a>
          </p>
        </div>
      </div>
    </div>
  );
};
