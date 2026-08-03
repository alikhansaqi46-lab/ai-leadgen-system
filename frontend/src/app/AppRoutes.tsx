import { Routes, Route, Navigate } from 'react-router-dom';
import AppShell from './AppShell';
import DashboardPage from '../features/dashboard/DashboardPage';
import ContactsPage from '../features/contacts/ContactsPage';
import LeadsPage from '../features/leads/LeadsPage';
import ScraperPage from '../features/scraper/ScraperPage';
import AIAgentPage from '../features/ai/AIAgentPage';
import WhatsAppBrainPage from '../features/ai/WhatsAppBrainPage';
import EmailBrainPage from '../features/ai/EmailBrainPage';
import SMSBrainPage from '../features/ai/SMSBrainPage';
import InboxPage from '../features/inbox/InboxPage';
import WhatsAppPage from '../features/whatsapp/WhatsAppPage';
import EmailPage from '../features/email/EmailPage';
import SmsPage from '../features/sms/SmsPage';
import SettingsPage from '../features/settings/SettingsPage';
import SubscriptionPage from '../features/settings/SubscriptionPage';
import AutomationsPage from '../features/automations/AutomationsPage';
import ShareQuotePage from '../features/quotes/ShareQuotePage';
import ReportsPage from '../features/reports/ReportsPage';
import LoginPage from '../features/auth/LoginPage';
import SignupPage from '../features/auth/SignupPage';
import VerifyEmailPage from '../features/auth/VerifyEmailPage';
import ForgotPasswordPage from '../features/auth/ForgotPasswordPage';
import AccountSettingsPage from '../features/auth/AccountSettingsPage';
import ProtectedRoute from '../features/auth/ProtectedRoute';
import LandingPage from '../features/landing/LandingPage';
import PricingPage from '../features/landing/PricingPage';
import RequireSuperAdmin from '../features/superAdmin/RequireSuperAdmin';
import SuperAdminPage from '../features/superAdmin/SuperAdminPage';

export default function AppRoutes() {
  return (
    <Routes>
      {/* Public marketing pages */}
      <Route path="/" element={<LandingPage />} />
      <Route path="/pricing" element={<PricingPage />} />

      {/* Public auth routes */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />

      {/* Owner-only Super Admin console — separate from product shell / nav */}
      <Route
        path="/super-admin"
        element={
          <RequireSuperAdmin>
            <SuperAdminPage />
          </RequireSuperAdmin>
        }
      />

      {/* Protected app shell */}
      <Route
        path="/app"
        element={
          <ProtectedRoute>
            <AppShell />
          </ProtectedRoute>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="contacts" element={<ContactsPage />} />
        <Route path="leads" element={<LeadsPage />} />
        <Route path="scraper" element={<ScraperPage />} />
        <Route path="whatsapp" element={<WhatsAppPage />} />
        <Route path="email" element={<EmailPage />} />
        <Route path="sms" element={<SmsPage />} />
        <Route path="ai-agent" element={<AIAgentPage />} />
        <Route path="ai/whatsapp-brain" element={<WhatsAppBrainPage />} />
        <Route path="ai/email-brain" element={<EmailBrainPage />} />
        <Route path="ai/sms-brain" element={<SMSBrainPage />} />
        <Route path="inbox" element={<InboxPage />} />
        <Route path="automations" element={<AutomationsPage />} />
        <Route path="quotes" element={<Navigate to="/app/inbox" replace />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="settings/subscription" element={<SubscriptionPage />} />
        <Route path="account" element={<AccountSettingsPage />} />
        {/* Legacy /app/workspace retired in S4.4 — redirect any old links. */}
        <Route path="workspace" element={<Navigate to="/app" replace />} />
      </Route>

      <Route path="/share/quote/:token" element={<ShareQuotePage />} />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
