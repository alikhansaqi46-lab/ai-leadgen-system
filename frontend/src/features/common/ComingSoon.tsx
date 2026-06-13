import { Link } from 'react-router-dom';
import PageHeader from './PageHeader';

interface ComingSoonProps {
  title: string;
  description: string;
  phase: string;
  useClassic?: boolean;
}

export default function ComingSoon({ title, description, phase, useClassic }: ComingSoonProps) {
  return (
    <div className="lf-page">
      <PageHeader title={title} subtitle={description} />
      <div className="lf-empty">
        <div className="lf-empty-badge">{phase}</div>
        <p className="lf-empty-text">
          This module's dedicated UI is being built. The architecture (routing, shell, typed API
          client) is ready; the feature migrates into this page during its phase.
        </p>
        {useClassic && (
          <Link className="lf-btn lf-btn-primary" to="/app/workspace">
            Use it in Workspace (Classic) →
          </Link>
        )}
      </div>
    </div>
  );
}
