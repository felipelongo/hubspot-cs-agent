export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function page(title: string, body: string, authed: boolean): string {
  const nav = authed
    ? `<nav>
        <a href="/">Queue</a>
        <a href="/runs">Runs</a>
        <a href="/audit">Audit</a>
        <a href="/metrics">Metrics</a>
        <a href="/logout">Log out</a>
      </nav>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} · CS agent</title>
  <style>
    :root { color-scheme: light; }
    body { margin: 0; font: 16px/1.5 system-ui, sans-serif; color: #1c2430; background: #f4f6f8; }
    main { max-width: 960px; margin: 0 auto; padding: 28px 20px 64px; }
    nav { max-width: 960px; margin: 0 auto; padding: 18px 20px 0; display: flex; gap: 18px; }
    nav a, a { color: #1f3a5f; }
    h1 { font-size: 28px; font-weight: 650; margin: 0 0 8px; }
    h2 { font-size: 18px; font-weight: 650; margin: 0 0 8px; }
    p.lead { color: #526071; margin-top: 0; }
    table { width: 100%; border-collapse: collapse; background: #fff; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #e4e7ec; vertical-align: top; overflow-wrap: anywhere; word-break: break-word; }
    table { table-layout: fixed; }
    th { font-size: 13px; color: #526071; font-weight: 600; }
    .card { background: #fff; border: 1px solid #e4e7ec; border-radius: 10px; padding: 16px 18px; margin: 14px 0; }
    .scroll { overflow-x: auto; border: 1px solid #e4e7ec; border-radius: 10px; }
    .pill { display: inline-block; border-radius: 999px; padding: 2px 10px; font-size: 13px; font-weight: 600; }
    .band-healthy { background: #e5f6ea; color: #146c36; }
    .band-watch { background: #fff4d6; color: #8a5a00; }
    .band-at_risk { background: #ffead9; color: #9a4d00; }
    .band-critical { background: #fde2e1; color: #9d1c1c; }
    .state { color: #526071; font-size: 13px; }
    button, .button { background: #243044; color: #fff; border: 0; border-radius: 6px; padding: 8px 14px; font: inherit; cursor: pointer; }
    button.danger { background: #8d2f2f; }
    button.quiet { background: #4d5d73; }
    form { margin: 0; }
    label { display: block; font-size: 14px; margin: 8px 0 4px; }
    input[type="text"], input[type="password"], textarea { width: 100%; box-sizing: border-box; font: inherit; padding: 8px 10px; border: 1px solid #cfd6df; border-radius: 6px; background: #fff; }
    textarea { min-height: 220px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
    pre { white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; background: #f7f8fa; padding: 12px; border-radius: 8px; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
    .error { background: #fde2e1; color: #6d1616; padding: 10px 12px; border-radius: 8px; }
    .notice { background: #e7f2ea; color: #14532d; padding: 10px 12px; border-radius: 8px; }
    .actions { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-end; }
    .muted { color: #526071; }
  </style>
</head>
<body>
  ${nav}
  <main>
    <h1>${escapeHtml(title)}</h1>
    ${body}
  </main>
</body>
</html>`;
}

export function bandPill(band: string | undefined): string {
  if (!band) return '<span class="muted">—</span>';
  const known = ['healthy', 'watch', 'at_risk', 'critical'];
  if (!known.includes(band)) return escapeHtml(band);
  const label = band === 'at_risk' ? 'at risk' : band;
  return `<span class="pill band-${band}">${label}</span>`;
}

export function flash(error?: string, notice?: string): string {
  const parts: string[] = [];
  if (error) parts.push(`<p class="error">${escapeHtml(error)}</p>`);
  if (notice) parts.push(`<p class="notice">${escapeHtml(notice)}</p>`);
  return parts.join('');
}
