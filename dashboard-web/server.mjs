import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_FILE = path.join(PROJECT_ROOT, 'data', 'applications.md');
const REPORTS_DIR = path.join(PROJECT_ROOT, 'reports');
const PORT = 3737;

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
    return parseMarkdownTable(content);
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
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
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
