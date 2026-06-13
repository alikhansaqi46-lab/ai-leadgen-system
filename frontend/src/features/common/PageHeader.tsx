import { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}

export default function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <div className="lf-page-header">
      <div>
        <h1 className="lf-page-title">{title}</h1>
        {subtitle && <p className="lf-page-subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="lf-page-actions">{actions}</div>}
    </div>
  );
}
