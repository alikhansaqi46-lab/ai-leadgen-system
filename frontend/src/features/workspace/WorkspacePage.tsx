// Workspace (Classic) — mounts the existing App.js verbatim so every current
// flow (scraping, full lead management, WhatsApp, CSV export) keeps working
// unchanged while the new modular pages are built out. S4 carves features out
// of here into their dedicated module pages.
// @ts-ignore — legacy JS module without type declarations.
import LegacyApp from '../../App';

export default function WorkspacePage() {
  return (
    <div className="lf-classic">
      <LegacyApp />
    </div>
  );
}
