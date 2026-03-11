import { Navigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { adminGetMe } from "../../api/admin";

interface RequireAdminAuthProps {
  children: React.ReactNode;
}

export default function RequireAdminAuth({ children }: RequireAdminAuthProps) {
  const { isLoading, isError } = useQuery({
    queryKey: ["admin", "me"],
    queryFn: adminGetMe,
    retry: false,
  });

  if (isLoading) {
    return <p className="state-message">Loading…</p>;
  }

  if (isError) {
    return <Navigate to="/admin/login" replace />;
  }

  return <>{children}</>;
}
