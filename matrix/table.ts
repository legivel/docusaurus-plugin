/**
 * matrix/results.txt → a Markdown results table (option × site shape, pass
 * or fail, outputs and pages), the shape the task asks for.
 * `bun matrix/table.ts > matrix/results.md`.
 */
import { readFileSync } from "node:fs";

const text = readFileSync(new URL("./results.txt", import.meta.url), "utf8");
const blocks = text.split(/^=== /m).filter(Boolean);
const rows: string[] = ["| Site | Shape | Result | Outputs | Build | Notes |", "|---|---|---|---|---|---|"];
for (const block of blocks) {
  const [head, ...lines] = block.split("\n");
  const [site, shape] = head!.split(" — ");
  const exit = /build: (\d+) s, exit (\d+)/.exec(block);
  const outputs = lines.filter((l) => /^  build\/.*\.pdf: /.test(l)).map((l) => l.trim().replace(/^build\//, "").replace(": ", " "));
  const spent = /(\d+) documents? spent/.exec(block)?.[1] ?? "0";
  const errors = lines.filter((l) => /\[ERROR\]|Error:|legivel answered/.test(l)).map((l) => l.trim());
  const notes = lines.filter((l) => /left out|removed|could not|no PDF|unchanged|rendered again|Free plan/.test(l)).map((l) => l.trim().replace("[legivel-pdf] ", ""));
  const result = exit?.[2] === "0" && outputs.length > 0 ? "pass" : "fail";
  const noteText = [...new Set([...errors, ...notes])].slice(0, 4).join("; ").replace(/\|/g, "\\|");
  rows.push(`| ${site} | ${shape?.replace(/\|/g, "\\|")} | ${result} | ${outputs.length} PDF${outputs.length === 1 ? "" : "s"}: ${outputs.slice(0, 6).join(", ")}${outputs.length > 6 ? ", …" : ""} | ${exit?.[1] ?? "?"} s, ${spent} doc${spent === "1" ? "" : "s"} | ${noteText} |`);
}
console.log(rows.join("\n"));
