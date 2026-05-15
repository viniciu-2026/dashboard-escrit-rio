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

function browserHeadless() {
  return String(process.env.BROWSER_HEADLESS || 'true').toLowerCase() !== 'false';
}

function browserLaunchOptions() {
  return {
    headless: browserHeadless(),
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage'
    ]
  };
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

function extractDashboardSystemHint(process) {
  const text = [
    process?.proc,
    process?.res,
    process?.prox,
    process?.sistema,
    process?.system,
    process?.obs,
    process?.tipo
  ].map((value) => String(value || '')).join(' ');
  const normalized = text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  if (/\bpje\b|processo judicial eletronico/.test(normalized)) return { system: 'pje', source: 'dashboard-text' };
  if (/\bdcp\b|portal de servicos|portal servicos|idserverjus/.test(normalized)) return { system: 'dcp', source: 'dashboard-text' };
  if (/no sistema|\bsistema\b/.test(normalized)) return { system: 'no-sistema', source: 'dashboard-text' };
  return { system: '', source: '' };
}

function urlsFromText(text) {
  const seen = new Set();
  for (const match of String(text || '').matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
    const url = match[0].replace(/[).,;]+$/g, '');
    if (/pje|tjrj|portalservicos|jus\.br/i.test(url)) seen.add(url);
  }
  return [...seen].slice(0, 10);
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
  const queryTerms = '(processo OR processos OR intimação OR intimacao OR PJe OR PDPJ OR tribunal OR TJRJ OR TRF OR DCP OR "Portal de Serviços" OR "Diário de Justiça")';
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
      const urls = urlsFromText(searchable);

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
          dashboardSystem: dashboardByCnj.get(cnj)?.dashboardSystem || '',
          dashboardSystemSource: dashboardByCnj.get(cnj)?.dashboardSystemSource || '',
          messageCount: 0,
          candidateLinks: [],
          messages: []
        };
        current.messageCount += 1;
        for (const url of urls) {
          if (!current.candidateLinks.includes(url)) current.candidateLinks.push(url);
        }
        current.messages.push({
          id: detail.id,
          threadId: detail.threadId,
          subject,
          from,
          date,
          candidateLinks: urls,
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

  const browser = await chromium.launch(browserLaunchOptions());
  try {
    const page = await browser.newPage({ locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
    try {
      await page.goto(process.env.JUSBR_URL || 'https://jus.br', { waitUntil: 'domcontentloaded', timeout: 30000 });
      report.browser = {
        ok: true,
        status: 'browser-ready',
        title: await page.title(),
        url: page.url()
      };
      return true;
    } catch (error) {
      report.browser = {
        ok: false,
        status: 'jusbr-smoke-timeout',
        reason: 'Smoke test do Jus.br falhou/expirou; a rotina deve seguir para Gmail e tribunal.',
        error: String(error.message || error)
      };
      return false;
    }
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

async function fillInputWithEvents(locator, value) {
  await locator.click();
  await locator.fill('');
  await locator.type(value, { delay: 20 });
  await locator.evaluate((element, currentValue) => {
    element.value = currentValue;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  return locator.evaluate((element) => String(element.value || '').length);
}

async function fillGovbrCpf(page, value, timeout = 15000) {
  const selectors = [
    '#accountId',
    'input[name="accountId"]',
    'input[name="login"]',
    'input[name="username"]',
    'input[type="tel"]',
    'input[type="text"]'
  ];

  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      await locator.waitFor({ state: 'visible', timeout });
      const valueLength = await fillInputWithEvents(locator, value);
      return { ok: true, selector, valueLength };
    } catch {
      // Try the next selector.
    }
  }

  return { ok: false, valueLength: 0 };
}

async function submitGovbrCpf(page) {
  await page.waitForTimeout(500);
  const clicked = await clickFirstVisible(page, [
    '#enter-account-id',
    'button:has-text("Continuar")',
    'input[type="submit"][value*="Continuar"]',
    'button[name="operation"]',
    'button[type="submit"]',
    page.getByRole('button', { name: /^continuar$/i }),
    page.getByRole('button', { name: /continuar|entrar|avancar/i })
  ], 8000);
  if (!clicked) {
    await page.keyboard.press('Enter').catch(() => {});
  }
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);
  return { clicked };
}

async function getVisibleTextSample(page) {
  try {
    const text = await page.locator('body').innerText({ timeout: 5000 });
    return text.replace(/\s+/g, ' ').trim().slice(0, 700);
  } catch {
    return '';
  }
}

async function getVisibleText(page, limit = 2000) {
  try {
    const text = await page.locator('body').innerText({ timeout: 5000 });
    return text.replace(/\s+/g, ' ').trim().slice(0, limit);
  } catch {
    return '';
  }
}

function classifyGovbrBlock(textSample) {
  const text = String(textSample || '');
  if (/403\s+Forbidden|Request forbidden by administrative rules/i.test(text)) {
    return {
      stage: 'govbr-administrative-rules',
      reason: 'GOV.BR bloqueou o runner por regras administrativas antes do login. Isso normalmente indica bloqueio do IP/ambiente headless do GitHub Actions.'
    };
  }
  return null;
}

async function detectGovbrBlock(page, stage) {
  const textSample = await getVisibleTextSample(page);
  const blocked = classifyGovbrBlock(textSample);
  if (!blocked) return null;
  return {
    ok: false,
    status: 'blocked',
    stage: blocked.stage || stage,
    reason: blocked.reason,
    url: page.url(),
    title: await page.title(),
    textSample
  };
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

  const browser = await chromium.launch(browserLaunchOptions());
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

    const afterInitialClickBlock = await detectGovbrBlock(page, 'jusbr-initial-gov');
    if (afterInitialClickBlock) return afterInitialClickBlock;

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

    const afterPortalGovClickBlock = await detectGovbrBlock(page, 'jusbr-portal-gov');
    if (afterPortalGovClickBlock) return afterPortalGovClickBlock;

    const cpfFilled = await fillGovbrCpf(page, loginCpf, 15000);

    if (!cpfFilled.ok) {
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

    const cpfSubmit = await submitGovbrCpf(page);

    const afterCpfBlock = await detectGovbrBlock(page, 'govbr-after-cpf');
    if (afterCpfBlock) return afterCpfBlock;

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
        cpfField: {
          selector: cpfFilled.selector,
          valueLength: cpfFilled.valueLength,
          submitClicked: cpfSubmit.clicked
        },
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
    const postPasswordBlock = classifyGovbrBlock(textSample);
    if (postPasswordBlock) {
      return {
        ok: false,
        status: 'blocked',
        stage: postPasswordBlock.stage,
        reason: postPasswordBlock.reason,
        url: page.url(),
        title: await page.title(),
        textSample
      };
    }
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

function tribunalTargetForCnj(cnj) {
  if (String(cnj || '').includes('.8.19.')) {
    return {
      name: 'TJRJ PJe 1g',
      url: 'https://tjrj.pje.jus.br/1g/loginOld.seam',
      loginUser: secretValue('TRIBUNAL_CPF'),
      loginPassword: secretValue('TRIBUNAL_PASSWORD'),
      dcp: {
        name: 'TJRJ Portal de Serviços/DCP',
        url: 'https://www3.tjrj.jus.br/idserverjus-front/#/login?indGet=true&sgSist=PORTALSERVICOS',
        loginUser: secretValue('DCP_CPF', 'EPROC_CPF') || secretValue('TRIBUNAL_CPF'),
        loginPassword: secretValue('DCP_PASSWORD', 'EPROC_PASSWORD') || secretValue('TRIBUNAL_PASSWORD')
      }
    };
  }
  return null;
}

function tribunalSearchOrder(process) {
  const hint = String(process?.dashboardSystem || '').toLowerCase();
  if (hint === 'dcp') return ['dcp', 'pje'];
  if (hint === 'pje') return ['pje', 'dcp'];
  return ['pje', 'dcp'];
}

function splitCnj(cnj) {
  const match = /^(\d{7})-(\d{2})\.(\d{4})\.(\d)\.(\d{2})\.(\d{4})$/.exec(String(cnj || '').trim());
  if (!match) return null;
  return {
    sequencial: match[1],
    digito: match[2],
    ano: match[3],
    justica: match[4],
    tribunal: match[5],
    origem: match[6]
  };
}

async function tryTribunalPasswordLogin(page, tribunal) {
  const user = tribunal.loginUser;
  const password = tribunal.loginPassword;
  if (!user || !password) {
    return {
      attempted: false,
      ok: false,
      status: 'tribunal-password-secrets-missing',
      reason: 'Faltam Secrets TRIBUNAL_CPF/TRIBUNAL_PASSWORD para login direto no tribunal. A senha GOV.BR nao deve ser usada como senha do PJe.'
    };
  }

  const userFilled = await fillFirstVisible(page, [
    '#username',
    '#login',
    '#j_username',
    'input[name="username"]',
    'input[name="login"]',
    'input[name="j_username"]',
    'input[type="text"]',
    'input[type="tel"]'
  ], user, 8000);

  const passwordFilled = await fillFirstVisible(page, [
    '#password',
    '#senha',
    '#j_password',
    'input[name="password"]',
    'input[name="senha"]',
    'input[name="j_password"]',
    'input[type="password"]'
  ], password, 8000);

  if (!userFilled || !passwordFilled) {
    return {
      attempted: true,
      ok: false,
      status: 'tribunal-password-fields-not-found',
      reason: 'Nao encontrei os campos de usuario/senha do tribunal na tela do PJe.'
    };
  }

  await clickFirstVisible(page, [
    '#btnEntrar',
    '#kc-login',
    'input[type="submit"]',
    'button[type="submit"]',
    page.getByRole('button', { name: /entrar|acessar|login/i }),
    page.getByRole('link', { name: /entrar|acessar|login/i })
  ], 8000);
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);

  const textSample = await getVisibleTextSample(page);
  const lower = textSample.toLowerCase();
  if (/inv[aá]lid|incorret|erro.*login|usu[aá]rio|senha/.test(lower) && /inv[aá]lid|incorret|erro/.test(lower)) {
    return {
      attempted: true,
      ok: false,
      status: 'tribunal-password-rejected',
      reason: 'O tribunal recusou usuario/senha ou retornou erro de login.',
      textSample
    };
  }

  return {
    attempted: true,
    ok: !/loginOld\.seam|mensagem-erro-login|login\.seam/i.test(page.url()),
    status: /loginOld\.seam|mensagem-erro-login|login\.seam/i.test(page.url()) ? 'tribunal-password-login-not-confirmed' : 'tribunal-password-login-complete',
    textSample
  };
}

async function gotoPjeProcessSearch(page) {
  const candidates = [
    'https://tjrj.pje.jus.br/1g/Processo/ConsultaProcesso/listView.seam',
    'https://tjrj.pje.jus.br/pje/Processo/ConsultaProcesso/listView.seam'
  ];

  for (const url of candidates) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1500);
      const textSample = await getVisibleTextSample(page);
      if (/consulta|pesquisar|processo/i.test(textSample) && !/loginOld\.seam|Identifique-se/i.test(page.url())) {
        return { ok: true, url: page.url(), title: await page.title(), textSample };
      }
    } catch {
      // Try the next URL.
    }
  }

  return {
    ok: false,
    status: 'pje-search-page-not-opened',
    reason: 'Nao consegui abrir a tela autenticada de consulta processual do PJe.',
    url: page.url(),
    title: await page.title(),
    textSample: await getVisibleTextSample(page)
  };
}

async function fillPjeSegment(page, selectors, value) {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      await locator.waitFor({ state: 'visible', timeout: 3000 });
      await fillInputWithEvents(locator, value);
      await page.keyboard.press('Tab').catch(() => {});
      return true;
    } catch {
      // Try next selector.
    }
  }
  return false;
}

async function clickPjeSearchButton(page) {
  const clicked = await clickFirstVisible(page, [
    '[id="fPP:searchProcessos"]',
    'input[id*="searchProcessos"]',
    'button[id*="searchProcessos"]',
    'input[value*="Pesquisar"]',
    'button:has-text("Pesquisar")',
    page.getByRole('button', { name: /pesquisar|consultar/i })
  ], 8000);

  if (!clicked) return false;

  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(6000);
  return true;
}

async function fillFirstCandidate(page, candidates, value, timeout = 3000) {
  for (const candidate of candidates) {
    try {
      const locator = typeof candidate === 'string' ? page.locator(candidate).first() : candidate.first();
      await locator.waitFor({ state: 'visible', timeout });
      await locator.fill(value);
      return true;
    } catch {
      // Try next candidate.
    }
  }
  return false;
}

async function collectSearchFieldDiagnostics(page) {
  try {
    return await page.locator('input, select, textarea, button').evaluateAll((elements) => elements.slice(0, 80).map((element) => ({
      tag: element.tagName.toLowerCase(),
      type: element.getAttribute('type') || '',
      id: element.getAttribute('id') || '',
      name: element.getAttribute('name') || '',
      value: element.tagName.toLowerCase() === 'button' ? (element.textContent || '').trim().slice(0, 80) : '',
      placeholder: element.getAttribute('placeholder') || '',
      title: element.getAttribute('title') || '',
      ariaLabel: element.getAttribute('aria-label') || ''
    })));
  } catch {
    return [];
  }
}

async function collectPjeNavigationDiagnostics(page) {
  try {
    return await page.locator('a, button, input[type="submit"], input[type="button"]').evaluateAll((elements) => elements.slice(0, 120).map((element) => ({
      tag: element.tagName.toLowerCase(),
      id: element.getAttribute('id') || '',
      name: element.getAttribute('name') || '',
      href: element.getAttribute('href') || '',
      value: element.getAttribute('value') || '',
      title: element.getAttribute('title') || '',
      ariaLabel: element.getAttribute('aria-label') || '',
      text: (element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120)
    })));
  } catch {
    return [];
  }
}

function pageTextHasCnj(text, cnj) {
  const digits = String(cnj || '').replace(/[^\d]/g, '');
  return String(text || '').includes(cnj) || (digits && String(text || '').includes(digits));
}

async function openPjeResultIfVisible(page, process) {
  const escapedCnj = process.cnj.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const opened = await clickFirstVisible(page, [
    page.getByRole('link', { name: new RegExp(escapedCnj) }),
    `a:has-text("${process.cnj}")`,
    'a[title*="Detalhe"]',
    'a[title*="detalhe"]',
    'a[title*="Visualizar"]',
    'a[title*="visualizar"]',
    'a[title*="Abrir"]',
    'a[title*="abrir"]',
    'a:has(i)'
  ], 5000);

  if (opened) {
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);
  }
  return opened;
}

async function tryPjeFreeSearch(page, process) {
  await gotoPjeProcessSearch(page);

  await clickFirstVisible(page, [
    page.getByText(/^Livre$/i),
    page.getByLabel(/Livre/i),
    'label:has-text("Livre")',
    'input[value*="LIVRE"]',
    'input[value*="Livre"]'
  ], 3000);

  const filled = await fillFirstCandidate(page, [
    page.getByLabel(/n[uú]mero do processo/i),
    page.getByLabel(/processo refer[eê]ncia/i),
    page.getByLabel(/numera[cç][aã]o [uú]nica/i),
    'input[id*="numeroProcesso"][type="text"]',
    'input[id*="NumeroProcesso"][type="text"]',
    'input[id*="processoReferencia"][type="text"]',
    'input[id*="ProcessoReferencia"][type="text"]',
    'input[name*="numeroProcesso"][type="text"]',
    'input[name*="processoReferencia"][type="text"]'
  ], process.cnj, 5000);

  if (!filled) return { ok: false, status: 'pje-free-search-field-not-found' };

  await clickPjeSearchButton(page);

  const textSample = await getVisibleTextSample(page);
  const found = textSample.includes(process.cnj) || textSample.includes(process.cnj.replace(/[^\d]/g, ''));
  return {
    ok: found,
    status: found ? 'pje-process-found-free-search' : 'pje-process-not-found-free-search',
    found,
    url: page.url(),
    title: await page.title(),
    textSample
  };
}

async function tryPjeAdvogadoPanelSearch(page, process) {
  const digits = process.cnj.replace(/[^\d]/g, '');
  const candidates = [
    'https://tjrj.pje.jus.br/1g/Painel/painel_usuario/advogado.seam',
    'https://tjrj.pje.jus.br/1g/Processo/ConsultaProcesso/listView.seam'
  ];
  const attempts = [];

  for (const url of candidates) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2500);
      let text = await getVisibleText(page);
      if (/loginOld\.seam|Identifique-se|Acesse sua conta/i.test(page.url()) || /usu[aá]rio|senha/i.test(text)) {
        attempts.push({ url, status: 'login-required', title: await page.title(), textSample: text.slice(0, 700) });
        continue;
      }

      if (pageTextHasCnj(text, process.cnj)) {
        const opened = await openPjeResultIfVisible(page, process);
        return {
          ok: true,
          status: opened ? 'pje-process-opened-from-panel-teor-pending' : 'pje-process-found-in-panel-open-pending',
          found: true,
          opened,
          url: page.url(),
          title: await page.title(),
          textSample: await getVisibleText(page)
        };
      }

      await clickFirstVisible(page, [
        page.getByRole('tab', { name: /acervo/i }),
        page.getByRole('link', { name: /^acervo$/i }),
        page.getByText(/^ACERVO$/i),
        'a:has-text("ACERVO")',
        'button:has-text("ACERVO")'
      ], 2000);
      await page.waitForTimeout(1500);

      for (const value of [process.cnj, digits]) {
        const filled = await fillFirstCandidate(page, [
          page.getByLabel(/processo|pesquisar|buscar|filtro|consulta/i),
          'input[id*="processo" i]',
          'input[name*="processo" i]',
          'input[id*="numero" i]',
          'input[name*="numero" i]',
          'input[id*="filtro" i]',
          'input[name*="filtro" i]',
          'input[id*="pesquisa" i]',
          'input[name*="pesquisa" i]',
          'input[id*="search" i]',
          'input[name*="search" i]',
          'input[id*="globalFilter" i]',
          'input[name*="globalFilter" i]',
          'input[type="search"]',
          'input[type="text"]'
        ], value, 3000);

        if (!filled) {
          attempts.push({ url: page.url(), valueKind: value === process.cnj ? 'formatted' : 'digits', status: 'search-input-not-found', title: await page.title(), textSample: text.slice(0, 700) });
          continue;
        }

        await clickFirstVisible(page, [
          page.getByRole('button', { name: /pesquisar|buscar|filtrar|consultar/i }),
          'button:has-text("Pesquisar")',
          'button:has-text("Buscar")',
          'button:has-text("Filtrar")',
          'input[type="submit"][value*="Pesquisar"]',
          'input[type="button"][value*="Pesquisar"]',
          'input[type="submit"]'
        ], 3000);
        await page.keyboard.press('Enter').catch(() => {});
        await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(4000);

        text = await getVisibleText(page);
        const found = pageTextHasCnj(text, process.cnj);
        attempts.push({ url: page.url(), valueKind: value === process.cnj ? 'formatted' : 'digits', status: found ? 'found' : 'not-found', title: await page.title(), textSample: text.slice(0, 700) });
        if (found) {
          const opened = await openPjeResultIfVisible(page, process);
          return {
            ok: true,
            status: opened ? 'pje-process-opened-from-panel-search-teor-pending' : 'pje-process-found-in-panel-search-open-pending',
            found: true,
            opened,
            url: page.url(),
            title: await page.title(),
            textSample: await getVisibleText(page),
            attempts
          };
        }
      }
    } catch (error) {
      attempts.push({ url, status: 'exception', error: String(error.message || error) });
    }
  }

  return {
    ok: false,
    status: 'pje-process-not-found-panel-search',
    attempts,
    fields: await collectSearchFieldDiagnostics(page),
    navigation: await collectPjeNavigationDiagnostics(page),
    url: page.url(),
    title: await page.title(),
    textSample: await getVisibleText(page)
  };
}

async function searchPjeProcess(page, process) {
  for (const link of process.candidateLinks || []) {
    if (!/tjrj\.pje|pje\.jus|pje/i.test(link)) continue;
    try {
      await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);
      const textSample = await getVisibleTextSample(page);
      const found = textSample.includes(process.cnj) || textSample.includes(process.cnj.replace(/[^\d]/g, ''));
      if (found || /detalhe|autos|movimenta|documento|expediente|processo/i.test(textSample)) {
        return {
          ok: true,
          status: 'pje-process-opened-from-push-link-teor-pending',
          cnj: process.cnj,
          cliente: process.cliente,
          dashboardId: process.dashboardId,
          found,
          opened: true,
          sourceLink: link,
          url: page.url(),
          title: await page.title(),
          textSample
        };
      }
    } catch {
      // Try the normal PJe search flow below.
    }
  }

  const parts = splitCnj(process.cnj);
  if (!parts) {
    return {
      ok: false,
      status: 'invalid-cnj',
      cnj: process.cnj,
      reason: 'Numero CNJ invalido para pesquisa segmentada.'
    };
  }

  const searchPage = await gotoPjeProcessSearch(page);
  if (!searchPage.ok) return { ...searchPage, ok: false, cnj: process.cnj, cliente: process.cliente };

  const fills = {
    sequencial: await fillPjeSegment(page, [
      'input[id*="numeroSequencial"]',
      'input[name*="numeroSequencial"]',
      'input[id*="inputNumeroProcesso"]',
      'input[name*="inputNumeroProcesso"]'
    ], parts.sequencial),
    digito: await fillPjeSegment(page, [
      'input[id*="Digito"]',
      'input[id*="digito"]',
      'input[name*="Digito"]',
      'input[name*="digito"]'
    ], parts.digito),
    ano: await fillPjeSegment(page, [
      'input[id*="Ano"]',
      'input[id*="ano"]',
      'input[name*="Ano"]',
      'input[name*="ano"]'
    ], parts.ano),
    justica: await fillPjeSegment(page, [
      'input[id*="ramoJustica"]',
      'input[name*="ramoJustica"]',
      'input[id*="Justica"]',
      'input[id*="justica"]'
    ], parts.justica),
    tribunal: await fillPjeSegment(page, [
      'input[id*="respectivoTribunal"]',
      'input[name*="respectivoTribunal"]',
      'input[id*="Tribunal"]',
      'input[id*="tribunal"]'
    ], parts.tribunal),
    origem: await fillPjeSegment(page, [
      'input[id*="NumeroOrgaoJustica"]',
      'input[id*="numeroOrgaoJustica"]',
      'input[name*="NumeroOrgaoJustica"]',
      'input[name*="numeroOrgaoJustica"]',
      'input[id*="NumeroOrigem"]',
      'input[id*="numeroOrigem"]',
      'input[name*="NumeroOrigem"]',
      'input[name*="numeroOrigem"]',
      'input[id*="Origem"]',
      'input[id*="origem"]'
    ], parts.origem)
  };

  if (!Object.values(fills).every(Boolean)) {
    const freeSearch = await tryPjeFreeSearch(page, process);
    if (freeSearch.ok) {
      return {
        ok: true,
        status: 'pje-process-found-free-search-open-pending',
        cnj: process.cnj,
        cliente: process.cliente,
        dashboardId: process.dashboardId,
        found: true,
        opened: false,
        url: freeSearch.url,
        title: freeSearch.title,
        textSample: freeSearch.textSample
      };
    }

    return {
      ok: false,
      status: 'pje-search-fields-not-found',
      cnj: process.cnj,
      cliente: process.cliente,
      reason: 'Nao encontrei todos os campos segmentados de numero CNJ na tela de consulta do PJe.',
      fills,
      freeSearch: {
        ok: freeSearch.ok,
        status: freeSearch.status
      },
      fields: await collectSearchFieldDiagnostics(page),
      url: page.url(),
      title: await page.title(),
      textSample: await getVisibleTextSample(page)
    };
  }

  await clickPjeSearchButton(page);

  const textSample = await getVisibleTextSample(page);
  const found = pageTextHasCnj(textSample, process.cnj);

  let opened = false;
  if (found) {
    opened = await openPjeResultIfVisible(page, process);
  }

  if (!found) {
    const panelSearch = await tryPjeAdvogadoPanelSearch(page, process);
    if (panelSearch.ok) {
      return {
        ok: true,
        status: panelSearch.status,
        cnj: process.cnj,
        cliente: process.cliente,
        dashboardId: process.dashboardId,
        found: true,
        opened: panelSearch.opened,
        url: panelSearch.url,
        title: panelSearch.title,
        textSample: panelSearch.textSample,
        panelSearch: {
          attempts: panelSearch.attempts
        }
      };
    }

    const fields = await collectSearchFieldDiagnostics(page);
    const navigation = await collectPjeNavigationDiagnostics(page);
    return {
      ok: false,
      status: 'pje-process-not-found',
      cnj: process.cnj,
      cliente: process.cliente,
      dashboardId: process.dashboardId,
      found: false,
      opened: false,
      url: page.url(),
      title: await page.title(),
      textSample: await getVisibleText(page),
      fields,
      navigation,
      panelSearch: {
        status: panelSearch.status,
        attempts: panelSearch.attempts
      }
    };
  }

  const detailText = opened ? await getVisibleTextSample(page) : textSample;
  return {
    ok: found,
    status: found ? (opened ? 'pje-process-opened-teor-pending' : 'pje-process-found-open-pending') : 'pje-process-not-found',
    cnj: process.cnj,
    cliente: process.cliente,
    dashboardId: process.dashboardId,
    found,
    opened,
    url: page.url(),
    title: await page.title(),
    textSample: detailText
  };
}

async function tryDcpLogin(page, dcp) {
  if (!dcp?.loginUser || !dcp?.loginPassword) {
    return {
      ok: false,
      status: 'dcp-secrets-missing',
      reason: 'Faltam Secrets DCP_CPF/DCP_PASSWORD ou credenciais equivalentes do Portal de Serviços.'
    };
  }

  await page.goto(dcp.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);
  await clickFirstVisible(page, [
    page.getByRole('button', { name: /^fechar$/i }),
    'button:has-text("Fechar")',
    'button[aria-label="Close"]'
  ], 3000);
  await page.waitForTimeout(500);

  const userFilled = await fillFirstCandidate(page, [
    '#usuario',
    '#username',
    '#login',
    '#txtUsuario',
    '#mat-input-0',
    'input[name="username"]',
    'input[name="login"]',
    'input[name="usuario"]',
    'input[name*="Usuario"]',
    'input[formcontrolname*="login" i]',
    'input[formcontrolname*="usuario" i]',
    'input[aria-label*="login" i]',
    'input[aria-label*="usu" i]',
    'input[placeholder*="CPF" i]',
    'input[placeholder*="Usu" i]',
    'input[placeholder*="Login" i]',
    'input[type="text"]'
  ], dcp.loginUser, 8000);

  const passwordFilled = await fillFirstCandidate(page, [
    '#senha',
    '#password',
    '#pwdSenha',
    '#mat-input-1',
    'input[name="password"]',
    'input[name="senha"]',
    'input[name*="Senha"]',
    'input[formcontrolname*="senha" i]',
    'input[formcontrolname*="password" i]',
    'input[aria-label*="senha" i]',
    'input[placeholder*="Senha" i]',
    'input[type="password"]'
  ], dcp.loginPassword, 8000);

  if (!userFilled || !passwordFilled) {
    return {
      ok: false,
      status: 'dcp-login-fields-not-found',
      reason: 'Nao encontrei campos de usuario/senha do Portal de Serviços/DCP.',
      url: page.url(),
      title: await page.title(),
      fields: await collectSearchFieldDiagnostics(page),
      textSample: await getVisibleTextSample(page)
    };
  }

  await clickFirstVisible(page, [
    '#btnEntrar',
    '#kc-login',
    'button:has-text("Entrar")',
    'input[type="submit"][value*="Entrar"]',
    'input[type="submit"]',
    'button[type="submit"]',
    page.getByRole('button', { name: /entrar|acessar|enviar|login/i })
  ], 8000);
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);

  const textSample = await getVisibleText(page);
  const lower = textSample.toLowerCase();
  const fieldsAfterSubmit = await collectSearchFieldDiagnostics(page);
  const stillHasLoginFields = fieldsAfterSubmit.some((field) => /usuario|username|login/i.test(`${field.id || ''} ${field.name || ''} ${field.placeholder || ''}`))
    && fieldsAfterSubmit.some((field) => /senha|password/i.test(`${field.id || ''} ${field.name || ''} ${field.placeholder || ''}`));
  const needsEmailCode = /c[oó]digo de autentica[cç][aã]o|c[oó]digo de acesso|duplo fator|2fa|enviado.*e-mail|enviado.*email|confirme seu e-mail|confirme seu email/i.test(textSample);
  const rejected = /senha inv[aá]lida|usu[aá]rio inv[aá]lido|credenciais inv[aá]lidas|login inv[aá]lido|incorreto/.test(lower);
  const stillLogin = stillHasLoginFields || /idserverjus-front\/#\/login/i.test(page.url());

  return {
    ok: !needsEmailCode && !rejected && !stillLogin,
    status: needsEmailCode ? 'dcp-email-code-required' : (rejected ? 'dcp-login-rejected' : (stillLogin ? 'dcp-login-not-complete' : 'dcp-login-complete')),
    reason: needsEmailCode ? 'Portal de Serviços/DCP solicitou codigo de autenticacao enviado por e-mail.' : (rejected ? 'Portal de Serviços/DCP recusou usuario/senha.' : (stillLogin ? 'Portal de Serviços/DCP permaneceu na tela de login.' : undefined)),
    url: page.url(),
    title: await page.title(),
    textSample
  };
}

async function openDcpSearchArea(page) {
  await clickFirstVisible(page, [
    page.getByRole('link', { name: /consultas/i }),
    page.getByRole('button', { name: /consultas/i }),
    'a:has-text("Consultas")',
    'button:has-text("Consultas")'
  ], 3000);
  await page.waitForTimeout(1000);
  await clickFirstVisible(page, [
    page.getByRole('link', { name: /consultas processuais|consulta processual/i }),
    page.getByRole('button', { name: /consultas processuais|consulta processual/i }),
    'a:has-text("Consultas Processuais")',
    'a:has-text("Consulta Processual")',
    'button:has-text("Consultas Processuais")',
    'button:has-text("Consulta Processual")'
  ], 3000);
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);
}

async function searchDcpProcess(page, process, dcp) {
  const login = await tryDcpLogin(page, dcp);
  if (!login.ok) {
    return {
      ok: false,
      status: login.status,
      reason: login.reason,
      cnj: process.cnj,
      cliente: process.cliente,
      dashboardId: process.dashboardId,
      tribunal: dcp?.name || 'TJRJ Portal de Serviços/DCP',
      url: login.url,
      title: login.title,
      fields: login.fields,
      textSample: login.textSample
    };
  }

  await openDcpSearchArea(page);
  const digits = process.cnj.replace(/[^\d]/g, '');
  const attempts = [];

  for (const value of [process.cnj, digits]) {
    const filled = await fillFirstCandidate(page, [
      page.getByLabel(/n[uú]mero|processo|pesquisar|busca/i),
      'input[id*="numero" i]',
      'input[name*="numero" i]',
      'input[id*="processo" i]',
      'input[name*="processo" i]',
      'input[placeholder*="processo" i]',
      'input[type="search"]',
      'input[type="text"]'
    ], value, 5000);

    if (!filled) {
      attempts.push({ valueKind: value === process.cnj ? 'formatted' : 'digits', status: 'search-input-not-found' });
      continue;
    }

    await clickFirstVisible(page, [
      page.getByRole('button', { name: /pesquisar|buscar|consultar/i }),
      'button:has-text("Pesquisar")',
      'button:has-text("Buscar")',
      'input[type="submit"][value*="Pesquisar"]',
      'input[type="button"][value*="Pesquisar"]',
      'input[type="submit"]'
    ], 5000);
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(4000);

    const textSample = await getVisibleText(page);
    const found = pageTextHasCnj(textSample, process.cnj);
    attempts.push({ valueKind: value === process.cnj ? 'formatted' : 'digits', status: found ? 'found' : 'not-found', url: page.url(), title: await page.title(), textSample: textSample.slice(0, 700) });
    if (found) {
      const opened = await openPjeResultIfVisible(page, process) || await clickFirstVisible(page, [
        page.getByRole('link', { name: new RegExp(process.cnj.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }),
        `a:has-text("${process.cnj}")`,
        'button:has-text("Processo Eletrônico")',
        'a:has-text("Processo Eletrônico")',
        'button:has-text("Visualizador")',
        'a:has-text("Visualizador")'
      ], 5000);
      if (opened) {
        await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(2500);
      }
      return {
        ok: true,
        status: opened ? 'dcp-process-opened-teor-pending' : 'dcp-process-found-open-pending',
        cnj: process.cnj,
        cliente: process.cliente,
        dashboardId: process.dashboardId,
        tribunal: dcp.name,
        found: true,
        opened,
        attempts,
        url: page.url(),
        title: await page.title(),
        textSample: await getVisibleText(page)
      };
    }
  }

  return {
    ok: false,
    status: 'dcp-process-not-found',
    reason: 'Processo nao foi localizado no Portal de Serviços/DCP com busca automatica por numero.',
    cnj: process.cnj,
    cliente: process.cliente,
    dashboardId: process.dashboardId,
    tribunal: dcp.name,
    attempts,
    fields: await collectSearchFieldDiagnostics(page),
    navigation: await collectPjeNavigationDiagnostics(page),
    url: page.url(),
    title: await page.title(),
    textSample: await getVisibleText(page)
  };
}

function isEprocLoginOrExpired(url, title, text) {
  const haystack = `${url || ''}\n${title || ''}\n${text || ''}`;
  return /sess.*foi encerrada|entrar no sistema|usu.rio\s+senha|senha\s+visibility|esqueci minha senha|externo_controlador\.php\?acao=principal/i.test(haystack);
}

function textLooksLikeEprocProcess(text, cnj, digits) {
  if (!text) return false;
  if (isEprocLoginOrExpired('', '', text)) return false;
  if (/n.o encontrado|inexistente|nenhum registro|processo n.o localizado/i.test(text)) return false;
  if (text.includes(cnj) || text.includes(digits)) return true;
  return /eventos do processo|evento\s+data|movimenta..o|partes do processo|autos com/i.test(text);
}

async function tryEprocLogin(page, eproc) {
  if (!eproc?.loginUser || !eproc?.loginPassword) {
    return {
      ok: false,
      status: 'eproc-secrets-missing',
      reason: 'Faltam Secrets EPROC_CPF/EPROC_PASSWORD.'
    };
  }

  await page.goto(eproc.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);

  const userFilled = await fillFirstCandidate(page, [
    '#txtUsuario',
    'input[name="txtUsuario"]',
    'input[id*="Usuario"]',
    'input[name*="Usuario"]',
    'input[type="text"]'
  ], eproc.loginUser, 8000);

  const passwordFilled = await fillFirstCandidate(page, [
    '#pwdSenha',
    'input[name="pwdSenha"]',
    'input[id*="Senha"]',
    'input[name*="Senha"]',
    'input[type="password"]'
  ], eproc.loginPassword, 8000);

  if (!userFilled || !passwordFilled) {
    return {
      ok: false,
      status: 'eproc-login-fields-not-found',
      reason: 'Nao encontrei campos de usuario/senha no eproc.',
      url: page.url(),
      title: await page.title(),
      textSample: await getVisibleTextSample(page)
    };
  }

  await clickFirstVisible(page, [
    '#sbmEntrar',
    '#sbmEnviar',
    'button:has-text("Entrar")',
    'button:has-text("Enviar")',
    'input[type="submit"][value*="Entrar"]',
    'input[type="submit"][value*="Enviar"]',
    'input[type="submit"]',
    'input[type="button"][value*="Entrar"]'
  ], 8000);
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);

  const textSample = await getVisibleTextSample(page);
  const title = await page.title();
  const loginPage = isEprocLoginOrExpired(page.url(), title, textSample);
  const rejected = /senha inv[aá]lida|usu[aá]rio inv[aá]lido|inv[aá]lido|2fa|autentica[cç][aã]o|c[oó]digo|token/i.test(textSample);
  return {
    ok: !rejected && !loginPage,
    status: rejected ? 'eproc-login-blocked' : (loginPage ? 'eproc-login-not-complete' : 'eproc-login-complete'),
    reason: rejected ? 'eproc recusou login ou solicitou autenticacao adicional.' : (loginPage ? 'eproc permaneceu na tela de login ou encerrou a sessao apos envio das credenciais.' : undefined),
    url: page.url(),
    title,
    textSample,
    diagnostics: loginPage ? await collectSearchFieldDiagnostics(page) : undefined
  };
}

async function searchEprocProcess(page, process, eproc) {
  const login = await tryEprocLogin(page, eproc);
  if (!login.ok) {
    return {
      ok: false,
      status: login.status,
      reason: login.reason,
      cnj: process.cnj,
      cliente: process.cliente,
      tribunal: eproc?.name || 'eproc',
      url: login.url,
      title: login.title,
      textSample: login.textSample,
      diagnostics: login.diagnostics
    };
  }

  const digits = process.cnj.replace(/[^\d]/g, '');
  const urls = [
    `${eproc.url}controlador.php?acao=processo_selecionar&num_processo=${digits}`,
    `${eproc.url}controlador.php?acao=processo_consulta&num_processo=${digits}`,
    `${eproc.url}controlador.php?acao=processo_consulta&txtNumProcesso=${digits}`
  ];

  for (const url of urls) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2500);
      const textSample = await getVisibleTextSample(page);
      const found = textLooksLikeEprocProcess(textSample, process.cnj, digits);
      if (!found) continue;
      if (found && !/n[aã]o encontrado|inexistente/i.test(textSample)) {
        return {
          ok: true,
          status: 'eproc-process-opened-teor-pending',
          cnj: process.cnj,
          cliente: process.cliente,
          dashboardId: process.dashboardId,
          found,
          opened: true,
          tribunal: eproc.name,
          url: page.url(),
          title: await page.title(),
          textSample
        };
      }
    } catch {
      // Try next eproc URL.
    }
  }

  try {
    await page.goto(`${eproc.url}controlador.php?acao=processo_consulta`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
    const beforeSearchText = await getVisibleTextSample(page);
    if (isEprocLoginOrExpired(page.url(), await page.title(), beforeSearchText)) {
      return {
        ok: false,
        status: 'eproc-session-expired-before-search',
        reason: 'A sessao do eproc encerrou antes da busca interna do processo.',
        cnj: process.cnj,
        cliente: process.cliente,
        dashboardId: process.dashboardId,
        tribunal: eproc.name,
        url: page.url(),
        title: await page.title(),
        textSample: beforeSearchText
      };
    }

    const formattedFilled = await fillFirstCandidate(page, [
      '#txtNumProcesso',
      'input[name="txtNumProcesso"]',
      'input[id*="NumProcesso"]',
      'input[name*="NumProcesso"]',
      'input[placeholder*="processo" i]',
      'input[type="text"]'
    ], process.cnj, 8000);

    if (formattedFilled) {
      const clicked = await clickFirstVisible(page, [
        '#sbmConsultar',
        'button:has-text("Consultar")',
        'input[type="submit"][value*="Consultar"]',
        'input[type="button"][value*="Consultar"]',
        'button:has-text("Pesquisar")',
        'input[type="submit"]'
      ], 8000);

      if (!clicked) await page.keyboard.press('Enter').catch(() => {});
      await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(2500);

      const textSample = await getVisibleTextSample(page);
      const found = textLooksLikeEprocProcess(textSample, process.cnj, digits);
      if (found) {
        return {
          ok: true,
          status: 'eproc-process-opened-teor-pending',
          cnj: process.cnj,
          cliente: process.cliente,
          dashboardId: process.dashboardId,
          found,
          opened: true,
          tribunal: eproc.name,
          url: page.url(),
          title: await page.title(),
          textSample
        };
      }
    }
  } catch {
    // Keep the final not-found report below with the current page state.
  }

  return {
    ok: false,
    status: 'eproc-process-not-found',
    cnj: process.cnj,
    cliente: process.cliente,
    dashboardId: process.dashboardId,
    tribunal: eproc.name,
    url: page.url(),
    title: await page.title(),
    textSample: await getVisibleTextSample(page)
  };
}

async function runTribunalProbes(report) {
  const processes = report.consolidated?.processes || [];
  const targets = processes
    .map((process) => ({ process, tribunal: tribunalTargetForCnj(process.cnj) }))
    .filter((item) => item.tribunal)
    .slice(0, 6);

  if (!targets.length) {
    return {
      ok: true,
      status: 'no-supported-tribunal-probe',
      reason: 'Nenhum processo consolidado pertence aos tribunais com probe direto implementado.'
    };
  }

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

  const browser = await chromium.launch(browserLaunchOptions());
  try {
    const probes = [];
    const first = targets[0];
    const page = await browser.newPage({ locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
    try {
      await page.goto(first.tribunal.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      const govClicked = await clickFirstVisible(page, [
        page.getByRole('button', { name: /gov\.br|entrar com gov/i }),
        page.getByRole('link', { name: /gov\.br|entrar com gov/i }),
        'button:has-text("gov.br")',
        'a:has-text("gov.br")',
        'input[value*="gov"]'
      ], 5000);

      if (govClicked) {
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(1500);
      }

      const govBlock = await detectGovbrBlock(page, 'tribunal-gov-login');
      const passwordLogin = govBlock ? null : await tryTribunalPasswordLogin(page, first.tribunal);
      const textSample = govBlock?.textSample || await getVisibleTextSample(page);
      const loggedIn = !govBlock && (govClicked || passwordLogin?.ok);
      probes.push({
        ok: loggedIn,
        status: govBlock ? 'blocked' : (passwordLogin?.ok ? passwordLogin.status : (govClicked ? 'gov-login-opened' : (passwordLogin?.status || 'gov-login-not-found'))),
        stage: govBlock?.stage,
        reason: govBlock?.reason || passwordLogin?.reason,
        cnj: first.process.cnj,
        tribunal: first.tribunal.name,
        passwordLogin: passwordLogin ? {
          attempted: passwordLogin.attempted,
          ok: passwordLogin.ok,
          status: passwordLogin.status,
          reason: passwordLogin.reason
        } : null,
        url: page.url(),
        title: await page.title(),
        textSample
      });

      if (loggedIn) {
        let dcpBlocked = false;
        for (let index = 0; index < targets.length; index += 1) {
          const target = targets[index];
          if (dcpBlocked) {
            probes.push({
              ok: false,
              status: 'tribunal-check-skipped-after-dcp-blocker',
              reason: 'O Portal de Serviços/DCP ja bloqueou o acesso automatico ao teor nesta execucao; os demais processos ficam pendentes pelo mesmo bloqueio de ambiente.',
              cnj: target.process.cnj,
              cliente: target.process.cliente,
              tribunal: target.tribunal.dcp?.name || target.tribunal.name
            });
            continue;
          }

          const order = tribunalSearchOrder(target.process);
          let foundInPreferredSystem = false;
          for (const system of order) {
            if (system === 'pje') {
              const pjeResult = await searchPjeProcess(page, target.process);
              probes.push({
                ...pjeResult,
                dashboardSystem: target.process.dashboardSystem || '',
                dashboardSystemSource: target.process.dashboardSystemSource || ''
              });
              foundInPreferredSystem = pjeResult.ok;
              if (foundInPreferredSystem) break;
            }

            if (system === 'dcp' && target.tribunal.dcp && !dcpBlocked) {
              const dcpPage = await browser.newPage({ locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
              try {
                const dcpResult = await searchDcpProcess(dcpPage, target.process, target.tribunal.dcp);
                probes.push({
                  ...dcpResult,
                  dashboardSystem: target.process.dashboardSystem || '',
                  dashboardSystemSource: target.process.dashboardSystemSource || ''
                });
                foundInPreferredSystem = dcpResult.ok;
                dcpBlocked = /dcp-(email-code-required|login-rejected|login-not-complete|login-fields-not-found|secrets-missing)/i.test(`${dcpResult.status || ''} ${dcpResult.reason || ''}`);
                if (foundInPreferredSystem || dcpBlocked) break;
              } finally {
                await dcpPage.close().catch(() => {});
              }
            }
          }
        }
      }
    } catch (error) {
      probes.push({
        ok: false,
        status: 'blocked',
        cnj: first.process.cnj,
        tribunal: first.tribunal.name,
        reason: 'Falha ao abrir o tribunal para prova de fallback.',
        error: String(error.message || error)
      });
    } finally {
      await page.close().catch(() => {});
    }

    const processOpened = probes.some((probe) => /process-opened/.test(probe.status || ''));
    const processFound = probes.some((probe) => /process-(opened|found)/.test(probe.status || ''));
    const dcpBlocked = probes.some((probe) => /^dcp-(email-code-required|login-rejected|login-not-complete|login-fields-not-found|secrets-missing)/.test(probe.status || ''));
    const tribunalLoggedIn = probes.some((probe) => probe.status === 'tribunal-password-login-complete' || probe.status === 'dcp-login-complete');
    return {
      ok: processFound,
      status: processOpened ? 'tribunal-processes-opened-teor-pending' : (dcpBlocked ? 'dcp-login-blocked-or-incomplete' : (tribunalLoggedIn ? 'tribunal-login-complete-search-pending' : 'tribunal-login-blocked')),
      reason: dcpBlocked ? 'O PJe nao localizou o processo e o Portal de Serviços/DCP nao concluiu acesso automatico ao teor no runner.' : undefined,
      probes
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
      hasFirebaseDatabaseAuthToken: has('FIREBASE_DATABASE_AUTH_TOKEN'),
      hasFirebaseServiceAccountJson: has('FIREBASE_SERVICE_ACCOUNT_JSON'),
      hasGmailCredentialHint: has('GMAIL_OAUTH_JSON') || (has('GMAIL_REFRESH_TOKEN') && has('GMAIL_CLIENT_ID') && has('GMAIL_CLIENT_SECRET')) || has('GMAIL_CONNECTOR_AVAILABLE')
    },
    warnings: [],
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
          const systemHint = extractDashboardSystemHint(process);
          const enrichedProcess = {
            ...process,
            dashboardSystem: systemHint.system,
            dashboardSystemSource: systemHint.source
          };
          dashboardByCnj.set(match[0], enrichedProcess);
          eligible.push({
            id: String(process.id || ''),
            cliente: String(process.cl || ''),
            tipo: String(process.tipo || ''),
            cnj: match[0],
            ver: verification,
            dashboardSystem: systemHint.system,
            dashboardSystemSource: systemHint.source
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
        dashboardSystem: item.dashboardSystem || '',
        dashboardSystemSource: item.dashboardSystemSource || '',
        messageCount: item.messageCount,
        candidateLinks: item.candidateLinks || []
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
    try {
      report.jusbrLogin = await runJusbrGovLogin(report);
    } catch (error) {
      report.jusbrLogin = {
        ok: false,
        status: 'blocked',
        stage: 'jusbr-exception',
        reason: 'Jus.br falhou/expirou; seguindo para o tribunal conforme regra de fallback.',
        error: String(error.message || error)
      };
    }
    if (!report.jusbrLogin.ok) {
      report.warnings.push(`Login Jus.br/GOV bloqueado; prosseguindo pelo tribunal conforme regra de fallback: ${report.jusbrLogin.reason || report.jusbrLogin.status}`);
    }
  }

  if (report.consolidated?.totalToVerifyInTribunals > 0) {
    report.tribunalProbes = await runTribunalProbes(report);
    if (!report.tribunalProbes.ok) {
      report.blockers.push(`Nao foi possivel abrir os processos no tribunal para ler o teor: ${report.tribunalProbes.reason || report.tribunalProbes.status}`);
    } else {
      report.blockers.push('Processos localizados/abertos no tribunal, mas leitura automatica do teor dos andamentos ainda nao foi concluida.');
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
    tribunalProbes: report.tribunalProbes ? {
      ok: report.tribunalProbes.ok,
      status: report.tribunalProbes.status,
      probes: report.tribunalProbes.probes ? report.tribunalProbes.probes.map((probe) => ({
        ok: probe.ok,
        status: probe.status,
        stage: probe.stage,
        reason: probe.reason,
        cnj: probe.cnj,
        tribunal: probe.tribunal,
        title: probe.title,
        url: probe.url
      })) : []
    } : null,
    warnings: report.warnings,
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
