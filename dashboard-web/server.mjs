import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_FILE = path.join(PROJECT_ROOT, 'data', 'applications.md');
const PIPELINE_FILE = path.join(PROJECT_ROOT, 'data', 'pipeline.md');
const REPORTS_DIR = path.join(PROJECT_ROOT, 'reports');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'output');
const CV_FILE = path.join(PROJECT_ROOT, 'cv.md');
const CV_TEMPLATE_FILE = path.join(PROJECT_ROOT, 'templates', 'cv-template.html');
const GENERATE_PDF_SCRIPT = path.join(PROJECT_ROOT, 'generate-pdf.mjs');
const PORT = 3737;

const ALLOWED_STATUSES = ['Applied', 'Rejected', 'Interview', 'Offer', 'Discarded', 'SKIP', 'Evaluated', 'Responded'];

// ─── Markdown table parser ────────────────────────────────────────────────────

function parseMarkdownTable(content) {
  const lines = content.split('\n');
  const tableLines = lines.filter(l => l.trim().startsWith('|'));

  if (tableLines.length < 2) return [];

  // First line = headers, second line = separator, rest = data
  const headers = tableLines[0]
    .split('|')
    .map(h => h.trim())
    .filter(Boolean);

  const dataLines = tableLines.slice(2); // skip header + separator

  return dataLines
    .map((line, idx) => {
      const cells = line
        .split('|')
        .map(c => c.trim())
        .filter((_, i, arr) => i > 0 && i < arr.length - 1); // trim leading/trailing empty from split

      if (cells.length === 0 || cells.every(c => c === '')) return null;

      const row = {};
      headers.forEach((h, i) => {
        row[h] = cells[i] ?? '';
      });

      // Normalize fields
      const num = row['#'] || String(idx + 1);
      const scoreRaw = row['Score'] || '';
      const scoreMatch = scoreRaw.match(/(\d+\.?\d*)/);
      const score = scoreMatch ? parseFloat(scoreMatch[1]) : null;

      // Extract report filename from markdown link [text](path)
      const reportRaw = row['Report'] || '';
      const reportMatch = reportRaw.match(/\[.*?\]\((.*?)\)/);
      const reportPath = reportMatch ? reportMatch[1] : '';
      const reportFile = reportPath ? path.basename(reportPath) : '';

      return {
        id: num,
        date: row['Date'] || '',
        company: row['Company'] || '',
        role: row['Role'] || '',
        score,
        scoreRaw,
        status: row['Status'] || '',
        pdf: row['PDF'] || '',
        report: reportFile,
        reportPath,
        notes: row['Notes'] || '',
      };
    })
    .filter(Boolean);
}

function readApplications() {
  try {
    const content = fs.readFileSync(DATA_FILE, 'utf8');
    const apps = parseMarkdownTable(content);
    // Enrich each app with the job URL extracted from its report
    for (const app of apps) {
      app.url = extractUrlFromReport(app.report);
    }
    return apps;
  } catch {
    return [];
  }
}

function readReports() {
  try {
    if (!fs.existsSync(REPORTS_DIR)) return [];
    return fs
      .readdirSync(REPORTS_DIR)
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function readReport(filename) {
  // Sanitize: no path traversal
  const safe = path.basename(filename);
  const full = path.join(REPORTS_DIR, safe);
  if (!full.startsWith(REPORTS_DIR)) throw new Error('Forbidden');
  return fs.readFileSync(full, 'utf8');
}

/** Extract the **URL:** field from a report markdown file. Returns '' if not found. */
function extractUrlFromReport(filename) {
  if (!filename) return '';
  try {
    const content = readReport(filename);
    // Match "**URL :**", "**URL:**", "**Url:**" etc.
    const match = content.match(/\*\*URL\s*:\*\*\s*(.+)/i);
    return match ? match[1].trim() : '';
  } catch {
    return '';
  }
}

/**
 * Update the Status column of a given application row in applications.md.
 * Preserves the exact markdown table format.
 */
function updateApplicationStatus(num, newStatus) {
  const content = fs.readFileSync(DATA_FILE, 'utf8');
  const lines = content.split('\n');

  // Match a table row whose first data column equals num (e.g. "| 1 |" or "| 001 |")
  const targetNum = String(num).replace(/^0+/, ''); // strip leading zeros for matching
  let found = false;

  const updated = lines.map(line => {
    if (!line.trim().startsWith('|')) return line;

    const cells = line.split('|');
    // cells[0] = '' (before first |), cells[1] = # col, cells[last] = '' (after last |)
    if (cells.length < 3) return line;

    const rowNum = cells[1].trim().replace(/^0+/, '');
    if (rowNum !== targetNum) return line;

    // Column indices (1-based in cells array): # cols in table:
    // | # | Date | Company | Role | Score | Status | PDF | Report | Notes |
    //   1    2       3        4       5       6      7       8        9
    // In split array: cells[1]=# cells[2]=Date ... cells[6]=Status
    if (cells.length < 7) return line;

    cells[6] = ` ${newStatus} `;
    found = true;
    return cells.join('|');
  });

  if (!found) throw new Error(`Application #${num} not found`);

  fs.writeFileSync(DATA_FILE, updated.join('\n'), 'utf8');
}

/** Slugify a company name for use in filenames. */
function slugify(str) {
  return String(str)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Build a minimal but clean A4 HTML wrapping markdown CV content.
 * Used when cv-template.html does not exist.
 */
function buildFallbackCvHtml(markdownContent, companyName) {
  const escaped = markdownContent
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Very basic markdown → html conversion (headings, bold, lists, hr)
  let html = escaped;
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/^---+$/gm, '<hr>');
  html = html.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`);
  html = html.replace(/^(?!<[a-z]).+$/gm, line => line.trim() ? `<p>${line}</p>` : '');

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>CV — ${escapeHtml(companyName)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  @page { size: A4; margin: 15mm 15mm; }
  body {
    font-family: -apple-system, Arial, sans-serif;
    font-size: 11pt;
    line-height: 1.5;
    color: #1a1a1a;
    background: #fff;
    padding: 0;
  }
  h1 { font-size: 22pt; margin-bottom: 4px; }
  h2 { font-size: 13pt; margin: 18px 0 6px; border-bottom: 1.5px solid #222; padding-bottom: 3px; }
  h3 { font-size: 11pt; margin: 12px 0 4px; }
  p  { margin-bottom: 6px; }
  ul { padding-left: 18px; margin-bottom: 8px; }
  li { margin-bottom: 2px; }
  hr { border: none; border-top: 1px solid #ccc; margin: 14px 0; }
  strong { font-weight: 700; }
</style>
</head>
<body>${html}</body>
</html>`;
}

function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function computeStats(applications) {
  const total = applications.length;
  const byStatus = {};
  let scoreSum = 0;
  let scoreCount = 0;

  for (const app of applications) {
    const s = app.status || 'Unknown';
    byStatus[s] = (byStatus[s] || 0) + 1;
    if (app.score !== null) {
      scoreSum += app.score;
      scoreCount++;
    }
  }

  const avgScore = scoreCount > 0 ? Math.round((scoreSum / scoreCount) * 10) / 10 : null;

  const active = (byStatus['Applied'] || 0) +
    (byStatus['Responded'] || 0) +
    (byStatus['Interview'] || 0);

  return {
    total,
    avgScore,
    active,
    interviews: byStatus['Interview'] || 0,
    offers: byStatus['Offer'] || 0,
    byStatus,
  };
}

// ─── Pipeline helpers ─────────────────────────────────────────────────────────

const PIPELINE_HEADER = `# Pipeline — Offres en attente d'évaluation

| Date ajout | URL | Note | Status |
|------------|-----|------|--------|
`;

function parsePipelineTable(content) {
  const lines = content.split('\n');
  const tableLines = lines.filter(l => l.trim().startsWith('|'));
  if (tableLines.length < 2) return [];

  const dataLines = tableLines.slice(2);
  return dataLines
    .map(line => {
      const cells = line.split('|').map(c => c.trim()).filter((_, i, arr) => i > 0 && i < arr.length - 1);
      if (cells.length < 4 || cells.every(c => c === '')) return null;
      return {
        date: cells[0] ?? '',
        url: cells[1] ?? '',
        note: cells[2] ?? '',
        status: cells[3] ?? '',
      };
    })
    .filter(Boolean);
}

function readPipeline() {
  try {
    const content = fs.readFileSync(PIPELINE_FILE, 'utf8');
    return parsePipelineTable(content);
  } catch {
    return [];
  }
}

function appendToPipeline(url, note, date) {
  let content;
  try {
    content = fs.readFileSync(PIPELINE_FILE, 'utf8');
  } catch {
    content = PIPELINE_HEADER;
  }

  // Ensure the file has the header if it's empty or malformed
  if (!content.includes('| Date ajout |')) {
    content = PIPELINE_HEADER;
  }

  const escapedNote = (note || '').replace(/\|/g, '\\|');
  const escapedUrl = url.replace(/\|/g, '\\|');
  const newRow = `| ${date} | ${escapedUrl} | ${escapedNote} | pending |\n`;
  content = content.trimEnd() + '\n' + newRow;

  fs.writeFileSync(PIPELINE_FILE, content, 'utf8');

  const updated = parsePipelineTable(content);
  return updated.filter(r => r.status === 'pending').length;
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

function sendJSON(res, data, status = 200) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

function sendText(res, text, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  });
  res.end(text);
}

function sendHTML(res, html) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  res.end(html);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  try {
    if (pathname === '/' || pathname === '/index.html') {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
      sendHTML(res, html);
      return;
    }

    if (pathname === '/api/applications') {
      sendJSON(res, readApplications());
      return;
    }

    if (pathname === '/api/pipeline' && req.method === 'GET') {
      sendJSON(res, readPipeline());
      return;
    }

    if (pathname === '/api/pipeline' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { url, note } = JSON.parse(body);
          if (!url || !/^https?:\/\/.+/.test(url.trim())) {
            sendJSON(res, { error: 'URL invalide. Elle doit commencer par http:// ou https://' }, 400);
            return;
          }
          const today = new Date().toISOString().slice(0, 10);
          try {
            const count = appendToPipeline(url.trim(), (note || '').trim(), today);
            sendJSON(res, { success: true, count });
          } catch (writeErr) {
            console.error('Pipeline write error:', writeErr);
            sendJSON(res, { error: 'Impossible d\'écrire dans pipeline.md' }, 500);
          }
        } catch {
          sendJSON(res, { error: 'Corps JSON invalide' }, 400);
        }
      });
      return;
    }

    if (pathname === '/api/reports') {
      sendJSON(res, readReports());
      return;
    }

    if (pathname.startsWith('/api/reports/')) {
      const filename = decodeURIComponent(pathname.replace('/api/reports/', ''));
      try {
        const content = readReport(filename);
        sendText(res, content);
      } catch {
        sendJSON(res, { error: 'Report not found' }, 404);
      }
      return;
    }

    if (pathname === '/api/stats') {
      const apps = readApplications();
      sendJSON(res, computeStats(apps));
      return;
    }

    // ── POST /api/applications/:num/status ────────────────────────────────────
    {
      const statusMatch = pathname.match(/^\/api\/applications\/(\d+)\/status$/);
      if (statusMatch && req.method === 'POST') {
        const num = statusMatch[1];
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const { status } = JSON.parse(body);
            if (!status || !ALLOWED_STATUSES.includes(status)) {
              sendJSON(res, {
                error: `Statut invalide. Valeurs acceptées : ${ALLOWED_STATUSES.join(', ')}`
              }, 400);
              return;
            }
            updateApplicationStatus(num, status);
            sendJSON(res, { success: true });
          } catch (err) {
            if (err.message && err.message.includes('not found')) {
              sendJSON(res, { error: err.message }, 404);
            } else {
              console.error('Status update error:', err);
              sendJSON(res, { error: 'Erreur lors de la mise à jour du statut' }, 500);
            }
          }
        });
        return;
      }
    }

    // ── POST /api/applications/:num/generate-cv ───────────────────────────────
    {
      const cvMatch = pathname.match(/^\/api\/applications\/(\d+)\/generate-cv$/);
      if (cvMatch && req.method === 'POST') {
        const num = cvMatch[1];
        (async () => {
          try {
            // Find the application
            const apps = readApplications();
            const app = apps.find(a => String(a.id).replace(/^0+/, '') === String(num).replace(/^0+/, ''));
            if (!app) {
              sendJSON(res, { error: `Candidature #${num} introuvable` }, 404);
              return;
            }

            // Read cv.md
            if (!fs.existsSync(CV_FILE)) {
              sendJSON(res, { error: 'cv.md introuvable dans le dossier projet' }, 500);
              return;
            }
            const cvContent = fs.readFileSync(CV_FILE, 'utf8');

            // Build HTML — use template if it exists, otherwise fallback
            let htmlContent;
            if (fs.existsSync(CV_TEMPLATE_FILE)) {
              htmlContent = fs.readFileSync(CV_TEMPLATE_FILE, 'utf8');
              // The template uses {{CONTENT}} or similar — if it doesn't have that
              // placeholder we just use the fallback to avoid a broken PDF.
              if (!htmlContent.includes('{{CONTENT}}') && !htmlContent.includes('{{CV}}')) {
                htmlContent = buildFallbackCvHtml(cvContent, app.company);
              } else {
                htmlContent = htmlContent
                  .replace(/\{\{CONTENT\}\}/g, cvContent)
                  .replace(/\{\{CV\}\}/g, cvContent)
                  .replace(/\{\{NAME\}\}/g, 'Cyril Shalaby')
                  .replace(/\{\{LANG\}\}/g, 'fr');
              }
            } else {
              htmlContent = buildFallbackCvHtml(cvContent, app.company);
            }

            // Write temp HTML
            const tmpHtml = path.join(os.tmpdir(), `cv-tmp-${num}-${Date.now()}.html`);
            fs.writeFileSync(tmpHtml, htmlContent, 'utf8');

            // Ensure output dir exists
            if (!fs.existsSync(OUTPUT_DIR)) {
              fs.mkdirSync(OUTPUT_DIR, { recursive: true });
            }

            const companySlug = slugify(app.company);
            const paddedNum = String(app.id).padStart(3, '0');
            const pdfFilename = `cv-${companySlug}-${paddedNum}.pdf`;
            const pdfPath = path.join(OUTPUT_DIR, pdfFilename);

            // Spawn generate-pdf.mjs
            await new Promise((resolve, reject) => {
              const proc = spawn('node', [GENERATE_PDF_SCRIPT, tmpHtml, pdfPath], {
                cwd: PROJECT_ROOT,
              });

              let stderr = '';
              proc.stderr.on('data', d => { stderr += d.toString(); });
              proc.stdout.on('data', () => {}); // drain stdout

              proc.on('close', code => {
                // Clean up temp file
                try { fs.unlinkSync(tmpHtml); } catch {}

                if (code === 0) {
                  resolve();
                } else {
                  reject(new Error(stderr || `generate-pdf.mjs exited with code ${code}`));
                }
              });

              proc.on('error', err => {
                try { fs.unlinkSync(tmpHtml); } catch {}
                reject(err);
              });
            });

            sendJSON(res, {
              success: true,
              pdfPath: `output/${pdfFilename}`,
              downloadUrl: `/api/download/${pdfFilename}`,
            });
          } catch (err) {
            console.error('CV generation error:', err);
            sendJSON(res, { error: err.message || 'Erreur lors de la génération du CV' }, 500);
          }
        })();
        return;
      }
    }

    // ── GET /api/download/report/:filename ────────────────────────────────────
    {
      const reportDlMatch = pathname.match(/^\/api\/download\/report\/(.+)$/);
      if (reportDlMatch && req.method === 'GET') {
        const rawFilename = decodeURIComponent(reportDlMatch[1]);
        // Path traversal protection
        if (rawFilename.includes('..') || rawFilename.includes('/') || rawFilename.includes('\\')) {
          sendJSON(res, { error: 'Nom de fichier invalide' }, 400);
          return;
        }
        const safe = path.basename(rawFilename);
        const filePath = path.join(REPORTS_DIR, safe);
        if (!fs.existsSync(filePath)) {
          sendJSON(res, { error: 'Fichier introuvable' }, 404);
          return;
        }
        const ext = path.extname(safe).toLowerCase();
        const contentType = ext === '.pdf' ? 'application/pdf' : 'text/markdown; charset=utf-8';
        const data = fs.readFileSync(filePath);
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Disposition': `attachment; filename="${safe}"`,
          'Content-Length': data.length,
          'Access-Control-Allow-Origin': '*',
        });
        res.end(data);
        return;
      }
    }

    // ── GET /api/download/:filename ───────────────────────────────────────────
    {
      const downloadMatch = pathname.match(/^\/api\/download\/([^/]+)$/);
      if (downloadMatch && req.method === 'GET') {
        const rawFilename = decodeURIComponent(downloadMatch[1]);
        // Path traversal protection
        if (rawFilename.includes('..') || rawFilename.includes('/') || rawFilename.includes('\\')) {
          sendJSON(res, { error: 'Nom de fichier invalide' }, 400);
          return;
        }
        const safe = path.basename(rawFilename);
        const filePath = path.join(OUTPUT_DIR, safe);
        if (!fs.existsSync(filePath)) {
          sendJSON(res, { error: 'Fichier introuvable' }, 404);
          return;
        }
        const ext = path.extname(safe).toLowerCase();
        const contentType = ext === '.pdf' ? 'application/pdf'
          : ext === '.md' ? 'text/markdown; charset=utf-8'
          : 'application/octet-stream';
        const data = fs.readFileSync(filePath);
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Disposition': `attachment; filename="${safe}"`,
          'Content-Length': data.length,
          'Access-Control-Allow-Origin': '*',
        });
        res.end(data);
        return;
      }
    }

    sendJSON(res, { error: 'Not found' }, 404);
  } catch (err) {
    console.error('Server error:', err);
    sendJSON(res, { error: 'Internal server error' }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`Career-Ops Dashboard running at http://localhost:${PORT}`);
  console.log(`Project root: ${PROJECT_ROOT}`);
  console.log(`Data file:    ${DATA_FILE}`);
  console.log(`Reports dir:  ${REPORTS_DIR}`);
});
