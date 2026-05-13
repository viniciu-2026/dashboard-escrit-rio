import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i].startsWith('--')) {
    args.set(process.argv[i].slice(2), process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : '1');
  }
}

const reportDir = args.get('report-dir') || path.join(process.cwd(), 'automation-report');
const firebaseUrl = 'https://dashboard-vg-default-rtdb.firebaseio.com/dashboard/processes.json';
const cnjPattern = /\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/g;

function has(name) {
  return Boolean(process.env[name] && String(process.env[name]).trim());
}

function ptBrDateToTime(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value || '').trim());
  if (!match) return 0;
  return new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1])).getTime();
}

function normalizeProcessList(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean);
  return Object.entries(raw).filter(([, value]) => value).map(([id, value]) => ({ id, ...value }));
}

async function readFirebaseProcesses() {
  const response = await fetch(firebaseUrl, { headers: { 'Cache-Control': 'no-cache' } });
  if (!response.ok) {
    throw new Error(`Firebase HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  return response.json();
}

async function runBrowserSmoke(report) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (error) {
    report.browser = {
      ok: false,
      status: 'blocked',
      reason: 'Playwright nao esta instalado no runner.',
      error: String(error.message || error)
    };
    return false;
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
    await page.goto(process.env.JUSBR_URL || 'https://jus.br', { waitUntil: 'domcontentloaded', timeout: 60000 });
    report.browser = {
      ok: true,
      status: 'browser-ready',
      title: await page.title(),
      url: page.url()
    };
    return true;
  } finally {
    await browser.close();
  }
}

async function main() {
  await mkdir(reportDir, { recursive: true });

  const missing = [];
  for (const name of ['GOVBR_CPF', 'GOVBR_PASSWORD']) {
    if (!has(name)) missing.push(name);
  }

  const report = {
    ok: false,
    status: 'blocked',
    source: firebaseUrl,
    startedAt: new Date().toISOString(),
    environment: {
      githubActions: process.env.GITHUB_ACTIONS === 'true',
      hasGovbrCpf: has('GOVBR_CPF'),
      hasGovbrPassword: has('GOVBR_PASSWORD'),
      hasFirebaseDatabaseAuthToken: has('FIREBASE_DATABASE_AUTH_TOKEN'),
      hasFirebaseServiceAccountJson: has('FIREBASE_SERVICE_ACCOUNT_JSON'),
      hasGmailCredentialHint: has('GMAIL_REFRESH_TOKEN') || has('GMAIL_CONNECTOR_AVAILABLE')
    },
    blockers: []
  };

  try {
    const raw = await readFirebaseProcesses();
    const processes = normalizeProcessList(raw);
    const eligible = [];
    let maxVerification = '';
    let maxVerificationTime = 0;

    for (const process of processes) {
      const verification = String(process.ver || '');
      const verificationTime = ptBrDateToTime(verification);
      if (verificationTime > maxVerificationTime) {
        maxVerificationTime = verificationTime;
        maxVerification = verification;
      }

      const text = String(process.proc || '');
      for (const match of text.matchAll(cnjPattern)) {
        if (!match[0].includes('.5.')) {
          eligible.push({
            id: String(process.id || ''),
            cliente: String(process.cl || ''),
            tipo: String(process.tipo || ''),
            cnj: match[0],
            ver: verification
          });
        }
      }
    }

    report.totalProcesses = processes.length;
    report.eligibleCnjs = eligible.length;
    report.maxVerificationPtBr = maxVerification || null;
    report.sample = eligible.slice(0, 10);
  } catch (error) {
    report.blockers.push('Nao foi possivel ler o Firebase publicado; sem isso nao ha periodo confiavel.');
    report.error = String(error.message || error);
  }

  if (missing.length) {
    report.blockers.push(`Secrets ausentes no GitHub: ${missing.join(', ')}.`);
  }
  if (!report.environment.hasFirebaseDatabaseAuthToken && !report.environment.hasFirebaseServiceAccountJson) {
    report.blockers.push('Falta Secret FIREBASE_DATABASE_AUTH_TOKEN ou FIREBASE_SERVICE_ACCOUNT_JSON para gravar alteracoes no Firebase.');
  }
  if (!report.environment.hasGmailCredentialHint) {
    report.blockers.push('Falta configuracao de Gmail/pushes no runner; a descoberta por e-mail ficara incompleta.');
  }

  if (!report.blockers.some((item) => item.startsWith('Secrets ausentes'))) {
    await runBrowserSmoke(report);
  }

  report.finishedAt = new Date().toISOString();
  report.ok = report.blockers.length === 0 && report.browser?.ok === true;
  report.status = report.ok ? 'ready-for-authenticated-case-update' : 'blocked';

  await writeFile(path.join(reportDir, 'github-process-update.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 2));

  process.exit(report.ok ? 0 : 2);
}

main().catch(async (error) => {
  const report = {
    ok: false,
    status: 'blocked',
    reason: 'Falha inesperada no runner GitHub.',
    error: String(error && error.stack ? error.stack : error)
  };
  await mkdir(reportDir, { recursive: true });
  await writeFile(path.join(reportDir, 'github-process-update.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 2));
  process.exit(2);
});
