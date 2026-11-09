// A site-only component: the plugin cannot turn it into Markdown, so the
// build log must name it with its file.
import React from "react";
export default function SampleGauge({ level }) {
  return React.createElement("span", null, `Gauge level ${level}`);
}
