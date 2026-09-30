import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';

// Legal pages (Phase 8)
import { LegalNotice } from './pages/legal/LegalNotice';
import { PrivacyPolicy } from './pages/legal/PrivacyPolicy';
import { TermsOfService } from './pages/legal/TermsOfService';
import { TermsOfSales } from './pages/legal/TermsOfSales';

// Billing (Phase 9)
import { BillingDashboard } from './pages/billing/BillingDashboard';

// Marketing (Phase 11)
import { LandingPage } from './pages/marketing/LandingPage';
import { PricingPage } from './pages/marketing/PricingPage';

// Operations (Phase 10)
import { StatusPage } from './pages/operations/StatusPage';

// Auth (Phase 12)
import { LoginPage } from './pages/auth/LoginPage';

// Dashboard (Phase 12)
import { DashboardPage } from './pages/dashboard/DashboardPage';

// Cookie Banner (Phase 8)
import { CookieBanner } from './components/CookieBanner';

export default function App() {
  return (
    <>
      {/* Bandeau cookies affiché sur toutes les pages */}
      <CookieBanner onConsentChange={(consent) => {
        if (consent.analytics) {
          console.log('Analytics activés (charge ici ton script GA/Plausible)');
        }
      }} />

      <Routes>
        {/* ── Marketing (Phase 11) ── */}
        <Route path="/" element={<LandingPage />} />
        <Route path="/pricing" element={<PricingPage />} />

        {/* ── Opérations (Phase 10) ── */}
        <Route path="/status" element={<StatusPage />} />

        {/* ── Auth (Phase 12) ── */}
        <Route path="/login" element={<LoginPage />} />
        {/* Alias pour compatibilité avec les anciens liens /app/login */}
        <Route path="/app/login" element={<LoginPage />} />

        {/* ── Dashboard (Phase 12) ── */}
        <Route path="/dashboard" element={<DashboardPage />} />
        {/* Alias /app/dashboard */}
        <Route path="/app/dashboard" element={<DashboardPage />} />

        {/* ── Facturation (Phase 9) ── */}
        <Route path="/app/billing" element={<BillingDashboard />} />

        {/* ── Légal (Phase 8) ── */}
        <Route path="/legal/notice" element={<LegalNotice />} />
        <Route path="/legal/privacy" element={<PrivacyPolicy />} />
        <Route path="/legal/terms" element={<TermsOfService />} />
        <Route path="/legal/sales" element={<TermsOfSales />} />

        {/* Fallback */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
