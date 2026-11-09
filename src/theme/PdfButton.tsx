/**
 * The «Download PDF» button on a docs page, and the line under it. The
 * link goes to the page's own PDF when the site renders one, else to the
 * module the page belongs to, else to the manual; in the theme the visitor
 * reads in when both were rendered. The data comes from the plugin's
 * global data (index.ts, allContentLoaded).
 */
import React from "react";
import { useLocation } from "@docusaurus/router";
import { useColorMode } from "@docusaurus/theme-common";
import useBaseUrl from "@docusaurus/useBaseUrl";
import { useAllPluginInstancesData } from "@docusaurus/useGlobalData";

import { BUTTON_TEXT, CREDIT_TEXT, CREDIT_URL } from "../credit.js";
import { pathKey, pdfFor, type ButtonData } from "../button-data.js";

export const PLUGIN_NAME = "docusaurus-plugin-legivel";

export default function PdfButton(): React.ReactElement | null {
  // A site may run several instances (one per docs plugin): the page's
  // button reads the instance whose outline holds the page.
  const instances = (useAllPluginInstancesData(PLUGIN_NAME) ?? {}) as Record<string, ButtonData | undefined>;
  // The page's id from its address: `useDoc` moved between Docusaurus 3
  // releases, the router did not.
  const { pathname } = useLocation();
  const { colorMode } = useColorMode();
  const key = pathKey(pathname);
  const data = Object.values(instances).find((d) => d?.paths[key] !== undefined);
  const docId = data?.paths[key];
  const href = data && docId ? pdfFor(data, docId, colorMode) : null;
  // A file name with a space or a non-ASCII letter is a valid address only encoded.
  const url = useBaseUrl(href ? encodeURI(href) : "/");
  if (!data || !href) return null;
  return React.createElement(
    "div",
    { className: "legivel-pdf", style: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "0.25rem", margin: "0 0 1rem" } },
    React.createElement("a", { className: "button button--secondary button--sm", href: url, download: true }, BUTTON_TEXT),
    data.credit
      ? React.createElement("a", { href: CREDIT_URL, style: { fontSize: "0.75rem", opacity: 0.75 }, target: "_blank", rel: "noopener" }, CREDIT_TEXT)
      : null,
  );
}
