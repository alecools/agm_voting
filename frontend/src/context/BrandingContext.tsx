import { createContext, useContext, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import type { TenantConfig } from "../api/config";
import { getPublicConfig } from "../api/config";

export const DEFAULT_CONFIG: TenantConfig = {
  app_name: "AGM Voting",
  logo_url: "",
  primary_colour: "#005f73",
  support_email: "",
};

interface BrandingContextValue {
  config: TenantConfig;
  isLoading: boolean;
}

export const BrandingContext = createContext<BrandingContextValue>({
  config: DEFAULT_CONFIG,
  isLoading: true,
});

export function useBranding(): BrandingContextValue {
  return useContext(BrandingContext);
}

export function BrandingProvider({ children }: { children: React.ReactNode }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["public-config"],
    queryFn: getPublicConfig,
    // Branding rarely changes; long stale time reduces noise, but invalidation
    // from SettingsPage.handleSubmit will still trigger an immediate re-fetch.
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  // On error fall back to defaults — app remains fully functional.
  const config = (isError || !data) ? DEFAULT_CONFIG : data;

  useEffect(() => {
    if (data) {
      document.documentElement.style.setProperty("--color-primary", data.primary_colour);
      document.title = data.app_name;
    }
  }, [data]);

  return (
    <BrandingContext.Provider value={{ config, isLoading }}>
      {children}
    </BrandingContext.Provider>
  );
}
