interface TopbarProps {
  onToggleSidebar: () => void;
  workspace?: string;
}

export default function Topbar({ onToggleSidebar, workspace = 'default' }: TopbarProps) {
  return (
    <header className="lf-topbar">
      <button className="lf-icon-btn" onClick={onToggleSidebar} aria-label="Toggle sidebar">≡</button>
      <div className="lf-topbar-search">
        <input type="text" placeholder="Search leads, conversations…" aria-label="Search" />
      </div>
      <div className="lf-topbar-right">
        <span className="lf-workspace-pill" title="Current workspace">⬢ {workspace}</span>
        <button className="lf-icon-btn" aria-label="Help">?</button>
        <span className="lf-avatar" aria-hidden>U</span>
      </div>
    </header>
  );
}
