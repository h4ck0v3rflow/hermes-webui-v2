export interface HermesRuntimeConfig {
  csrfToken: string;
  maxUploadBytes: number;
  imgSrcExtra: string[];
  webuiVersion?: string;
}

declare global {
  interface Window {
    __HERMES_CONFIG__?: Partial<HermesRuntimeConfig>;
  }
}

export function getHermesConfig(): HermesRuntimeConfig {
  const raw = typeof window !== "undefined" ? window.__HERMES_CONFIG__ : undefined;
  return {
    csrfToken: typeof raw?.csrfToken === "string" ? raw.csrfToken : "",
    maxUploadBytes:
      typeof raw?.maxUploadBytes === "number" && Number.isFinite(raw.maxUploadBytes)
        ? raw.maxUploadBytes
        : 0,
    imgSrcExtra: Array.isArray(raw?.imgSrcExtra) ? raw.imgSrcExtra.map(String) : [],
    webuiVersion: typeof raw?.webuiVersion === "string" ? raw.webuiVersion : "v2",
  };
}

export function getWebuiVersion(): string {
  return getHermesConfig().webuiVersion || "v2";
}
