import { useEffect, useState } from 'react';
import { NavLink, Link } from 'react-router-dom';
import Logo from '../components/Logo';
import { NAV_GROUPS, FOOTER_ITEMS, NavItem } from './navigation';
import { getOpenAiStatus } from '../lib/apiClient';
import { useAuth } from '../features/auth/AuthContext';

interface SidebarProps {
  collapsed: boolean;
  unreadInbox?: number;
}

function Item({ item, collapsed, unreadInbox }: { item: NavItem; collapsed: boolean; unreadInbox?: number }) {
  return (
    <NavLink
      to={item.to}
      end={item.to === '/app'}
      className={({ isActive }) => `lf-nav-item${isActive ? ' is-active' : ''}`}
      title={collapsed ? item.label : undefined}
    >
      <span className="lf-nav-icon" aria-hidden>{item.icon}</span>
      {!collapsed && <span className="lf-nav-label">{item.label}</span>}
      {!collapsed && item.badge === 'inbox' && unreadInbox ? (
        <span className="lf-nav-badge">{unreadInbox}</span>
      ) : null}
    </NavLink>
  );
}

export default function Sidebar({ collapsed, unreadInbox = 0 }: SidebarProps) {
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'super_admin';
  const [aiUsage, setAiUsage] = useState<{ remaining: number; total: number } | null>(null);

  useEffect(() => {
    let active = true;
    getOpenAiStatus()
      .then((s) => {
        if (!active || !s) return;
        setAiUsage({
          remaining: Number(s.freeMessagesRemaining) || 0,
          total: Number(s.freeMessagesTotal) || 0,
        });
      })
      .catch(() => {
        if (active) setAiUsage(null);
      });
    return () => { active = false; };
  }, []);

  const used = aiUsage ? Math.max(0, aiUsage.total - aiUsage.remaining) : 0;
  const pct = aiUsage && aiUsage.total > 0 ? Math.min(100, Math.round((used / aiUsage.total) * 100)) : 0;

  return (
    <aside className={`lf-sidebar${collapsed ? ' is-collapsed' : ''}`}>
      <div className="lf-brand">
        <Logo size={collapsed ? 80 : 96} className="lf-brand-logo" />
        {!collapsed && <span className="lf-brand-name">LeadFlow AI</span>}
      </div>

      <nav className="lf-nav">
        {NAV_GROUPS.map((group) => (
          <div className="lf-nav-group" key={group.heading}>
            {!collapsed && <div className="lf-nav-heading">{group.heading}</div>}
            {group.items.map((item) => (
              <Item key={item.to} item={item} collapsed={collapsed} unreadInbox={unreadInbox} />
            ))}
          </div>
        ))}
      </nav>

      <div className="lf-nav-footer">
        {FOOTER_ITEMS.map((item) => (
          <Item key={item.to} item={item} collapsed={collapsed} />
        ))}
        {isSuperAdmin && (
          <Link
            to="/super-admin"
            className="lf-nav-item"
            title={collapsed ? 'Owner Console' : undefined}
            style={{ opacity: 0.75 }}
          >
            <span className="lf-nav-icon" aria-hidden>◈</span>
            {!collapsed && <span className="lf-nav-label">Owner Console</span>}
          </Link>
        )}
        {!collapsed && aiUsage && (
          <div className="lf-usage" title="Free AI message quota from your account">
            <div className="lf-usage-label">AI messages</div>
            <div className="lf-usage-bar"><span style={{ width: `${pct}%` }} /></div>
            <div className="lf-usage-meta">{used.toLocaleString()} / {aiUsage.total.toLocaleString()}</div>
          </div>
        )}
      </div>
    </aside>
  );
}
