/**
 * The site-side modules the theme components import. They exist in the
 * site that runs the plugin, not in this package, so they are declared here
 * for the compiler only.
 */
declare module "@theme-init/DocItem/Content" {
  import type { ComponentType, ReactNode } from "react";
  const Content: ComponentType<{ children: ReactNode }>;
  export default Content;
}

declare module "@docusaurus/useGlobalData" {
  export function usePluginData(pluginName: string, pluginId?: string): unknown;
  export function useAllPluginInstancesData(pluginName: string): Record<string, unknown> | undefined;
}

declare module "@docusaurus/useBaseUrl" {
  export default function useBaseUrl(path: string): string;
}

declare module "@docusaurus/router" {
  export function useLocation(): { pathname: string };
}

declare module "@docusaurus/theme-common" {
  export function useColorMode(): { colorMode: "light" | "dark" };
}
