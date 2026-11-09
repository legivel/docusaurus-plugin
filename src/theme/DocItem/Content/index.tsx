/**
 * The docs page's content, with the «Download PDF» button above it. The
 * theme's own component renders as before (`@theme-init` keeps it); this
 * wrapper only adds the button, so a site that swizzled the component
 * keeps its version.
 */
import React from "react";
import Content from "@theme-init/DocItem/Content";

import PdfButton from "../../PdfButton.js";

export default function ContentWithPdfButton(props: { children: React.ReactNode }): React.ReactElement {
  return React.createElement(React.Fragment, null, React.createElement(PdfButton), React.createElement(Content, props));
}
