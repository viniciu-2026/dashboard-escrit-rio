import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i].startsWith('--')) {
    args.set(process.argv[i].slice(2), process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : '1');
  }
}

const reportDir = args.get('report-dir') || path.join(process.cwd(), 'automation-report');
const firebaseUrl = 'https://dashboard-vg-default-rtdb.firebaseio.com/dashboard/processes.json';
const cnjPattern = /\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/g;
const gmailListUrl = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';

function has(name) {
  return Boolean(process.env[name] && String(process.env[name]).trim());
}

function secretValue(name, fallbackName = '') {
  if (has(name)) return String(process.env[name]).trim();
  if (fallbackName && has(fallbackName)) return String(process.env[fallbackName]).trim();
  return '';
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

function formatGmailDate(value) {
  const time = ptBrDateToTime(value);
  if (!time) return null;
  const date = new Date(time);
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

function todayPtBr() {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).format(new Date());
}

function tomorrowGmailDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date()).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  const date = new Date(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + 1);
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

function base64UrlDecode(value = '') {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf8');
}

function collectMessageText(payload, chunks = []) {
  if (!payload) return chunks;
  if (payload.body?.data && /^text\/(plain|html)$/i.test(payload.mimeType || '')) {
    chunks.push(base64UrlDecode(payload.body.data));
  }
  for (const part of payload.parts || []) collectMessageText(part, chunks);
  return chunks;
}

function getHeader(headers = [], name) {
  const found = headers.find((header) => String(header.name || '').toLowerCase() === name.toLowerCase());
  return found?.value || '';
}

function uniqueCnjsFromText(text) {
  const seen = new Set();
  for (const match of String(text || '').matchAll(cnjPattern)) {
    const cnj = match[0];
    if (!cnj.includes('.5.')) seen.add(cnj);
  }
  return [...seen];
}

async function readFirebaseProcesses() {
  const response = await fetch(firebaseUrl, { headers: { 'Cache-Control': 'no-cache' } });
  if (!response.ok) {
    throw new Error(`Firebase HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  return response.json();
}

async function getGmailAccessToken() {
  if (!has('GMAIL_OAUTH_JSON')) {
    return null;
  }

  const oauth = JSON.parse(process.env.GMAIL_OAUTH_JSON);
  if (!oauth.client_id || !oauth.client_secret || !oauth.refresh_token) {
    throw new Error('GMAIL_OAUTH_JSON sem client_id, client_secret ou refresh_token.');
  }

  const body = new URLSearchParams({
    client_id: oauth.client_id,
    client_secret: oauth.client_secret,
    refresh_token: oauth.refresh_token,
    grant_type: 'refresh_token'
  });
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(`Falha ao renovar token Gmail: ${JSON.stringify(data).slice(0, 500)}`);
  }
  return data.access_token;
}

async function gmailGet(accessToken, url) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Gmail HTTP ${response.status}: ${JSON.stringify(data).slice(0, 500)}`);
  }
  return data;
}

async function discoverGmailPushes({ fromPtBr, dashboardByCnj }) {
  const accessToken = await getGmailAccessToken();
  if (!accessToken) {
    return {
      ok: false,
      status: 'blocked',
      reason: 'GMAIL_OAUTH_JSON ausente.'
    };
  }

  const after = formatGmailDate(fromPtBr);
  const before = tomorrowGmailDate();
  const queryTerms = '(processo OR processos OR intimação OR intimacao OR PJe OR PDPJ OR tribunal OR TJRJ OR TRF OR eproc OR "Diário de Justiça")';
  const query = [after ? `after:${after}` : '', `before:${before}`, queryTerms].filter(Boolean).join(' ');
  const foundByCnj = new Map();
  const inspectedMessages = [];
  let pageToken = '';
  let listed = 0;

  for (let page = 0; page < 10; page += 1) {
    const url = new URL(gmailListUrl);
    url.searchParams.set('q', query);
    url.searchParams.set('maxResults', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const list = await gmailGet(accessToken, url);
    const messages = list.messages || [];
    listed += messages.length;

    for (const message of messages) {
      const detailUrl = `${gmailListUrl}/${encodeURIComponent(message.id)}?format=full`;
      const detail = await gmailGet(accessToken, detailUrl);
      const headers = detail.payload?.headers || [];
      const subject = getHeader(headers, 'Subject');
      const from = getHeader(headers, 'From');
      const date = getHeader(headers, 'Date');
      const bodyText = collectMessageText(detail.payload).join('\n');
      const searchable = `${subject}\n${from}\n${date}\n${detail.snippet || ''}\n${bodyText}`;
      const cnjs = uniqueCnjsFromText(searchable);

      if (cnjs.length) {
        inspectedMessages.push({
          id: detail.id,
          threadId: detail.threadId,
          subject,
          from,
          date,
          cnjs
        });
      }

      for (const cnj of cnjs) {
        const current = foundByCnj.get(cnj) || {
          cnj,
          origins: ['gmail'],
          knownInDashboard: dashboardByCnj.has(cnj),
          dashboardId: dashboardByCnj.get(cnj)?.id || '',
          cliente: dashboardByCnj.get(cnj)?.cl || '',
          messageCount: 0,
          messages: []
        };
        current.messageCount += 1;
        current.messages.push({
          id: detail.id,
          threadId: detail.threadId,
          subject,
          from,
          date,
          snippet: detail.snippet || ''
        });
        foundByCnj.set(cnj, current);
      }
    }

    pageToken = list.nextPageToken || '';
    if (!pageToken) break;
  }

  return {
    ok: true,
    status: 'gmail-discovery-complete',
    query,
    listedMessages: listed,
    messagesWithCnj: inspectedMessages.length,
    discoveredCnjs: foundByCnj.size,
    processes: [...foundByCnj.values()]
  };
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

async function clickFirstVisible(page, candidates, timeout = 5000) {
  for (const candidate of candidates) {
    const locator = typeof candidate === 'string' ? page.locator(candidate) : candidate;
    try {
      const first = locator.first();
      await first.waitFor({ state: 'visible', timeout });
      await first.click();
      return true;
    } catch {
      // Try the next selector/text candidate.
    }
  }
  return false;
}

async function fillFirstVisible(page, candidates, value, timeout = 5000) {
  for (const selector of candidates) {
    try {
      const locator = page.locator(selector).first();
      await locator.waitFor({ state: 'visible', timeout });
      await locator.fill(value);
      return true;
    } catch {
      // Try the next selector.
    }
  }
  return false;
}

async function getVisibleTextSample(page) {
  try {
    const text = await page.locator('body').innerText({ timeout: 5000 });
    return text.replace(/\s+/g, ' ').trim().slice(0, 700);
  } catch {
    return '';
  }
}

async function runJusbrGovLogin(report) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (error) {
    return {
      ok: false,
      status: 'blocked',
      reason: 'Playwright nao esta instalado no runner.',
      error: String(error.message || error)
    };
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  const loginCpf = secretValue('GOVBR_CPF');
  const loginPassword = secretValue('GOVBR_PASSWORD');
  try {
    await page.goto(process.env.JUSBR_URL || 'https://www.jus.br/servicos/', { waitUntil: 'domcontentloaded', timeout: 60000 });

    const govClicked = await clickFirstVisible(page, [
      page.getByRole('button', { name: /gov\.br|entrar/i }),
      page.getByRole('link', { name: /gov\.br|entrar/i }),
      'button:has-text("gov.br")',
      'a:has-text("gov.br")',
      'button:has-text("Entrar")',
      'a:has-text("Entrar")'
    ], 8000);

    if (govClicked) {
      await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    }

    const portalGovClicked = await clickFirstVisible(page, [
      page.getByRole('button', { name: /entrar com gov\.?br/i }),
      page.getByRole('link', { name: /entrar com gov\.?br/i }),
      'button:has-text("Entrar com gov")',
      'a:has-text("Entrar com gov")',
      'input[value*="gov"]'
    ], 8000);

    if (portalGovClicked) {
      await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(1500);
    }

    const cpfFilled = await fillFirstVisible(page, [
      '#accountId',
      'input[name="accountId"]',
      'input[name="login"]',
      'input[name="username"]',
      'input[type="tel"]',
      'input[type="text"]'
    ], loginCpf, 15000);

    if (!cpfFilled) {
      return {
        ok: false,
        status: 'blocked',
        stage: 'govbr-cpf',
        reason: 'Nao encontrei o campo de CPF/login do GOV.BR.',
        url: page.url(),
        title: await page.title(),
        textSample: await getVisibleTextSample(page)
      };
    }

    await clickFirstVisible(page, [
      '#enter-account-id',
      'button[name="operation"]',
      'button[type="submit"]',
      page.getByRole('button', { name: /continuar|entrar|avançar|avancar/i })
    ], 8000);
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});

    const passwordFilled = await fillFirstVisible(page, [
      '#password',
      'input[name="password"]',
      'input[type="password"]'
    ], loginPassword, 20000);

    if (!passwordFilled) {
      return {
        ok: false,
        status: 'blocked',
        stage: 'govbr-password',
        reason: 'Nao encontrei o campo de senha apos informar CPF. Pode haver captcha, 2FA, conta bloqueada ou mudanca de fluxo.',
        url: page.url(),
        title: await page.title(),
        textSample: await getVisibleTextSample(page)
      };
    }

    await clickFirstVisible(page, [
      '#submit-button',
      'button[type="submit"]',
      page.getByRole('button', { name: /entrar|continuar|autorizar|permitir/i })
    ], 8000);
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);

    const textSample = await getVisibleTextSample(page);
    const lower = textSample.toLowerCase();
    if (/usu[aá]rio ou senha inv[aá]lido|senha inv[aá]lida|credenciais inv[aá]lidas|login inv[aá]lido/.test(lower)) {
      return {
        ok: false,
        status: 'blocked',
        stage: 'post-password',
        reason: 'GOV.BR recusou CPF/senha ou o fluxo retornou erro de credenciais.',
        url: page.url(),
        title: await page.title(),
        textSample
      };
    }

    if (/captcha|verifica|código|codigo|duas etapas|validação|validacao|autenticador/.test(lower)) {
      return {
        ok: false,
        status: 'blocked',
        stage: 'post-password',
        reason: 'GOV.BR solicitou validacao adicional/captcha/2FA no runner.',
        url: page.url(),
        title: await page.title(),
        textSample
      };
    }

    return {
      ok: /jus\.br|pje\.jus\.br|sso\.cloud\.pje\.jus\.br/.test(page.url()),
      status: 'login-attempt-complete',
      url: page.url(),
      title: await page.title(),
      textSample
    };
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
      hasJusbrCpf: has('JUSBR_CPF'),
      hasJusbrPassword: has('JUSBR_PASSWORD'),
      hasFirebaseDatabaseAuthToken: has('FIREBASE_DATABASE_AUTH_TOKEN'),
      hasFirebaseServiceAccountJson: has('FIREBASE_SERVICE_ACCOUNT_JSON'),
      hasGmailCredentialHint: has('GMAIL_OAUTH_JSON') || (has('GMAIL_REFRESH_TOKEN') && has('GMAIL_CLIENT_ID') && has('GMAIL_CLIENT_SECRET')) || has('GMAIL_CONNECTOR_AVAILABLE')
    },
    blockers: []
  };

  try {
    const raw = await readFirebaseProcesses();
    const processes = normalizeProcessList(raw);
    const eligible = [];
    const dashboardByCnj = new Map();
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
          dashboardByCnj.set(match[0], process);
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
    report.todayPtBr = todayPtBr();
    try {
      report.gmail = await discoverGmailPushes({
        fromPtBr: maxVerification || todayPtBr(),
        dashboardByCnj
      });
    } catch (error) {
      report.gmail = {
        ok: false,
        status: 'blocked',
        reason: 'Falha ao consultar Gmail/pushes.',
        error: String(error.message || error)
      };
      report.blockers.push('Nao foi possivel consultar Gmail/pushes; a descoberta de movimentacoes fica incompleta.');
    }
    report.consolidated = {
      status: 'teor-pendente',
      reason: 'Processos descobertos por push/Gmail precisam ser abertos no tribunal respectivo antes de qualquer atualizacao conclusiva do dashboard.',
      totalToVerifyInTribunals: report.gmail.ok ? report.gmail.discoveredCnjs : 0,
      processes: report.gmail.ok ? report.gmail.processes.map((item) => ({
        cnj: item.cnj,
        origins: item.origins,
        knownInDashboard: item.knownInDashboard,
        dashboardId: item.dashboardId,
        cliente: item.cliente,
        messageCount: item.messageCount
      })) : []
    };
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

  if (report.blockers.length === 0) {
    report.jusbrLogin = await runJusbrGovLogin(report);
    if (!report.jusbrLogin.ok) {
      report.blockers.push(`Login Jus.br/GOV bloqueado: ${report.jusbrLogin.reason || report.jusbrLogin.status}`);
    }
  }

  report.finishedAt = new Date().toISOString();
  report.ok = report.blockers.length === 0 && report.browser?.ok === true && report.gmail?.ok === true;
  report.status = report.ok ? 'discovery-complete-teor-pendente' : 'blocked';

  const consoleSummary = {
    ok: report.ok,
    status: report.status,
    totalProcesses: report.totalProcesses,
    eligibleCnjs: report.eligibleCnjs,
    maxVerificationPtBr: report.maxVerificationPtBr,
    gmail: report.gmail ? {
      ok: report.gmail.ok,
      status: report.gmail.status,
      listedMessages: report.gmail.listedMessages,
      messagesWithCnj: report.gmail.messagesWithCnj,
      discoveredCnjs: report.gmail.discoveredCnjs
    } : null,
    consolidated: report.consolidated ? {
      status: report.consolidated.status,
      totalToVerifyInTribunals: report.consolidated.totalToVerifyInTribunals
    } : null,
    browser: report.browser,
    jusbrLogin: report.jusbrLogin ? {
      ok: report.jusbrLogin.ok,
      status: report.jusbrLogin.status,
      stage: report.jusbrLogin.stage,
      reason: report.jusbrLogin.reason,
      title: report.jusbrLogin.title,
      url: report.jusbrLogin.url
    } : null,
    blockers: report.blockers
  };

  await writeFile(path.join(reportDir, 'github-process-update.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(consoleSummary, null, 2));

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
