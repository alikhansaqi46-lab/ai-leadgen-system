import { Routes, Route, Navigate } from 'react-router-dom';
import AppShell from './AppShell';
import DashboardPage from '../features/dashboard/DashboardPage';
import LeadsPage from '../features/leads/LeadsPage';
import ScraperPage from '../features/scraper/ScraperPage';
import WorkspacePage from '../features/workspace/WorkspacePage';
import AIAgentPage from '../features/ai/AIAgentPage';
import InboxPage from '../features/inbox/InboxPage';
import WhatsAppPage from '../features/whatsapp/WhatsAppPage';
import ComingSoon from '../features/common/ComingSoon';

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/app" replace />} />
      <Route path="/app" element={<AppShell />}>
        <Route index element={<DashboardPage />} />
        <Route path="leads" element={<LeadsPage />} />
        <Route path="workspace" element={<WorkspacePage />} />
        <Route path="scraper" element={<ScraperPage />} />
        <Route path="whatsapp" element={<WhatsAppPage />} />
        <Route
          path="email"
          element={<ComingSoon title="Email" description="Send and sequence email outreach." phase="UI in S4" useClassic />}
        />
        <Route path="ai-agent" element={<AIAgentPage />} />
        <Route path="inbox" element={<InboxPage />} />
        <Route
          path="automations"
          element={<ComingSoon title="Automations" description="Trigger → condition → action rules across modules." phase="Post-S5" />}
        />
        <Route
          path="settings"
          element={<ComingSoon title="Settings" description="Workspace, integrations, and billing." phase="Expanded in S6" useClassic />}
        />
      </Route>
      <Route path="*" element={<Navigate to="/app" replace />} />
    </Routes>
  );
}
