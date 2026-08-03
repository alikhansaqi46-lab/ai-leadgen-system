import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

/** Owner-only gate. Subscribers never enter this tree. */
export default function RequireSuperAdmin({ children }: { children: React.ReactNode }) {
  const { user, isAuthenticated, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="sa-loading">
        Verifying owner access…
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  if (user?.role !== 'super_admin') {
    return <Navigate to="/app" replace />;
  }

  return <>{children}</>;
}
