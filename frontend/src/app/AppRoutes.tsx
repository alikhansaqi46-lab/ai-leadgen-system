import { Routes, Route, Navigate } from 'react-router-dom';
import AppShell from './AppShell';
import DashboardPage from '../features/dashboard/DashboardPage';
import LeadsPage from '../features/leads/LeadsPage';
import ScraperPage from '../features/scraper/ScraperPage';
import AIAgentPage from '../features/ai/AIAgentPage';
import InboxPage from '../features/inbox/InboxPage';
import WhatsAppPage from '../features/whatsapp/WhatsAppPage';
import EmailPage from '../features/email/EmailPage';
import SettingsPage from '../features/settings/SettingsPage';
import ComingSoon from '../features/common/ComingSoon';

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/app" replace />} />
      <Route path="/app" element={<AppShell />}>
        <Route index element={<DashboardPage />} />
        <Route path="leads" element={<LeadsPage />} />
        <Route path="scraper" element={<ScraperPage />} />
        <Route path="whatsapp" element={<WhatsAppPage />} />
        <Route path="email" element={<EmailPage />} />
        <Route path="ai-agent" element={<AIAgentPage />} />
        <Route path="inbox" element={<InboxPage />} />
        <Route
          path="automations"
          element={<ComingSoon title="Automations" description="Trigger → condition → action rules across modules." phase="Post-S5" />}
        />
        <Route path="settings" element={<SettingsPage />} />
        {/* Legacy /app/workspace retired in S4.4 — redirect any old links. */}
        <Route path="workspace" element={<Navigate to="/app" replace />} />
      </Route>
      <Route path="*" element={<Navigate to="/app" replace />} />
    </Routes>
  );
}
