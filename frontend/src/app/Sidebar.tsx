import { NavLink } from 'react-router-dom';
import { NAV_GROUPS, FOOTER_ITEMS, NavItem } from './navigation';

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
  return (
    <aside className={`lf-sidebar${collapsed ? ' is-collapsed' : ''}`}>
      <div className="lf-brand">
        <span className="lf-brand-mark">LF</span>
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
        {!collapsed && (
          <div className="lf-usage" title="AI usage (placeholder until billing)">
            <div className="lf-usage-label">AI replies</div>
            <div className="lf-usage-bar"><span style={{ width: '0%' }} /></div>
            <div className="lf-usage-meta">0 / 1,000</div>
          </div>
        )}
      </div>
    </aside>
  );
}
