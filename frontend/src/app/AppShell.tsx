import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import Topbar from './Topbar';

export default function AppShell() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className={`lf-shell${collapsed ? ' is-collapsed' : ''}`}>
      <Sidebar collapsed={collapsed} />
      <div className="lf-main">
        <Topbar onToggleSidebar={() => setCollapsed((c) => !c)} />
        <main className="lf-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
