import { STATE_COLORS } from "../constants";
import type { WorkerStatus } from "./types";

function renderRowHtml(s: WorkerStatus): string {
  const color = (STATE_COLORS as Record<string, string>)[s.state] ?? "#888";
  return `<tr id="worker-${s.id}">
    <td>${s.id}</td>
    <td><span class="state" style="color:${color}">${s.state}</span></td>
    <td class="target-url-cell" title="${esc(s.targetUrl)}">${esc(s.targetUrl) || "—"}</td>
    <td class="url-cell" title="${esc(s.url)}">${esc(s.url) || "—"}</td>
    <td>${esc(s.lastAction)}</td>
    <td>${esc(s.proxy ?? "—")}</td>
    <td>
      <button class="row-btn" hx-post="/cmd" hx-vals='{"command":"START","workerId":${s.id}}' hx-swap="none">▶</button>
      <button class="row-btn" hx-post="/cmd" hx-vals='{"command":"STOP","workerId":${s.id}}' hx-swap="none">■</button>
      <button class="row-btn" hx-post="/cmd" hx-vals='{"command":"CLICK_PRIMARY","workerId":${s.id}}' hx-swap="none">⚡</button>
      <button class="row-btn" hx-post="/cmd" hx-vals='{"command":"FOCUS","workerId":${s.id}}' hx-swap="none">⊞</button>
      <button class="row-btn destroy-btn" hx-post="/destroy" hx-vals='{"workerId":${s.id}}' hx-swap="none">✕</button>
    </td>
  </tr>`;
}

function buildSummaryInner(statuses: WorkerStatus[]): string {
  const counts: Record<string, number> = {};
  for (const s of statuses) counts[s.state] = (counts[s.state] ?? 0) + 1;
  return Object.entries(counts)
    .map(([state, n]) => {
      const color = (STATE_COLORS as Record<string, string>)[state] ?? "#888";
      return `<span style="color:${color}">${state}: ${n}</span>`;
    })
    .join("  |  ");
}

export function buildWsUpdate(statuses: WorkerStatus[]): string {
  const rows = statuses.map(renderRowHtml).join("");
  const summaryContent = buildSummaryInner(statuses);
  return (
    `<tbody id="worker-rows" hx-swap-oob="true">${rows}</tbody>` +
    `<div id="summary" hx-swap-oob="true">${summaryContent}</div>`
  );
}

export function renderInitialPage(template: string, statuses: WorkerStatus[]): string {
  const rows = statuses.map(renderRowHtml).join("");
  const summaryContent = buildSummaryInner(statuses);
  return template
    .replace("{{WORKER_ROWS}}", rows)
    .replace("{{SUMMARY_CONTENT}}", summaryContent);
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
