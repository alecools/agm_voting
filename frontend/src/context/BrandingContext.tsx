import { createContext, useContext, useEffect, useState } from "react";
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
  const [config, setConfig] = useState<TenantConfig>(DEFAULT_CONFIG);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getPublicConfig()
      .then((data) => {
        if (cancelled) return;
        setConfig(data);
        document.documentElement.style.setProperty("--color-primary", data.primary_colour);
        document.title = data.app_name;
      })
      .catch(() => {
        // Config fetch failed — keep defaults, app remains functional
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <BrandingContext.Provider value={{ config, isLoading }}>
      {children}
    </BrandingContext.Provider>
  );
}
