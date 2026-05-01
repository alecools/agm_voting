import { Navigate } from "react-router-dom";
import { authClient } from "../../lib/auth-client";

interface RequireAdminAuthProps {
  children: React.ReactNode;
}

export default function RequireAdminAuth({ children }: RequireAdminAuthProps) {
  const { data: session, isPending } = authClient.useSession();

  if (isPending) {
    return <p className="state-message">Loading…</p>;
  }

  if (!session) {
    return <Navigate to="/admin/login" replace />;
  }

  return <>{children}</>;
}
