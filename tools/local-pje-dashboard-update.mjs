import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i].startsWith('--')) {
    args.set(process.argv[i].slice(2), process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : '1');
  }
}

const pendingFile = args.get('pending-file') || 'automation-report-last/pending-processes.json';
const reportDir = args.get('report-dir') || 'automation-report-local-pje';
const only = new Set(String(args.get('only') || '').split(',').map((value) => value.trim()).filter(Boolean));
const today = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric'
}).format(new Date());

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Variavel obrigatoria ausente: ${name}`);
  return value;
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
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

function summarizePjeText(text, cnj) {
  const normalized = cleanText(text);
  const dateMatches = [...normalized.matchAll(/\b(\d{2}\/\d{2}\/\d{4})\b/g)];
  if (!dateMatches.length) {
    return `PJe/TJRJ conferido em ${today}: processo aberto em consulta autenticada, mas a movimentacao nao apareceu em texto estruturado.`;
  }

  const picked = dateMatches[0];
  const start = Math.max(0, picked.index - 80);
  const end = Math.min(normalized.length, picked.index + 520);
  let excerpt = normalized.slice(start, end);
  const cnjIndex = excerpt.indexOf(cnj);
  if (cnjIndex >= 0 && cnjIndex < 120) excerpt = excerpt.slice(cnjIndex + cnj.length);
  excerpt = cleanText(excerpt)
    .replace(/^[-:;. ]+/, '')
    .slice(0, 420)
    .replace(/\s+\S*$/, '');
  return `PJe/TJRJ conferido em ${today}: ${excerpt}.`;
}

async function firebaseFetch(url, options = {}) {
  const token = process.env.FIREBASE_ACCESS_TOKEN || process.env.GCLOUD_ACCESS_TOKEN || '';
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { ...options, headers });
  if (!response.ok) {
    throw new Error(`Firebase HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  return response;
}

async function patchDashboard(processId, payload) {
  const url = `https://dashboard-vg-default-rtdb.firebaseio.com/dashboard/processes/${encodeURIComponent(processId)}.json`;
  await firebaseFetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload)
  });
}

async function createDashboardProcess(payload) {
  const id = String(Date.now());
  const url = `https://dashboard-vg-default-rtdb.firebaseio.com/dashboard/processes/${id}.json`;
  await firebaseFetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ id, ...payload })
  });
  return id;
}

async function fillBySelectors(page, selectors, value) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: 'visible', timeout: 3000 });
      await locator.fill(value);
      await locator.dispatchEvent('input').catch(() => {});
      await locator.dispatchEvent('change').catch(() => {});
      return true;
    } catch {
      // Try next selector.
    }
  }
  return false;
}

async function clickFirst(page, locators, timeout = 3000) {
  for (const item of locators) {
    const locator = typeof item === 'string' ? page.locator(item).first() : item.first();
    try {
      await locator.waitFor({ state: 'visible', timeout });
      await locator.click();
      return true;
    } catch {
      // Try next locator.
    }
  }
  return false;
}

async function loginPje(page) {
  await page.goto('https://tjrj.pje.jus.br/1g/loginOld.seam', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await fillBySelectors(page, ['#username', 'input[name="username"]', 'input[type="text"]'], requiredEnv('TRIBUNAL_CPF'));
  await fillBySelectors(page, ['#password', 'input[name="password"]', 'input[type="password"]'], requiredEnv('TRIBUNAL_PASSWORD'));
  await clickFirst(page, ['#btnEntrar', 'input[type="submit"]', 'button[type="submit"]'], 5000);
  await page.waitForLoadState('domcontentloaded', { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const text = cleanText(await page.locator('body').innerText({ timeout: 10000 }).catch(() => ''));
  if (/inv[aá]lid|incorret|erro.*login/i.test(text) || /loginOld\.seam/i.test(page.url())) {
    throw new Error('Login PJe nao confirmado.');
  }
}

async function openPjeProcess(context, page, process) {
  const parts = splitCnj(process.cnj);
  if (!parts) throw new Error('CNJ invalido para pesquisa PJe.');

  await page.goto('https://tjrj.pje.jus.br/1g/Processo/ConsultaProcesso/listView.seam', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1500);
  const fields = [
    [['input[id*="numeroSequencial"]', 'input[name*="numeroSequencial"]'], parts.sequencial],
    [['input[id*="Digito"]', 'input[id*="digito"]', 'input[name*="Digito"]', 'input[name*="digito"]'], parts.digito],
    [['input[id*="Ano"]', 'input[id*="ano"]', 'input[name*="Ano"]', 'input[name*="ano"]'], parts.ano],
    [['input[id*="ramoJustica"]', 'input[name*="ramoJustica"]'], parts.justica],
    [['input[id*="respectivoTribunal"]', 'input[name*="respectivoTribunal"]'], parts.tribunal],
    [['input[id*="NumeroOrgaoJustica"]', 'input[id*="numeroOrgaoJustica"]', 'input[name*="NumeroOrgaoJustica"]', 'input[name*="numeroOrgaoJustica"]'], parts.origem]
  ];
  for (const [selectors, value] of fields) {
    const filled = await fillBySelectors(page, selectors, value);
    if (!filled) throw new Error('Campos segmentados do PJe nao encontrados.');
    await page.keyboard.press('Tab').catch(() => {});
  }

  await clickFirst(page, ['[id="fPP:searchProcessos"]', 'input[id*="searchProcessos"]', 'button:has-text("Pesquisar")'], 8000);
  await page.waitForLoadState('domcontentloaded', { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(5000);

  const searchText = await page.locator('body').innerText({ timeout: 10000 }).catch(() => '');
  if (!searchText.includes(process.cnj) && !searchText.includes(process.cnj.replace(/\D/g, ''))) {
    throw new Error('Processo nao localizado na busca PJe.');
  }

  const popupPromise = context.waitForEvent('page', { timeout: 8000 }).catch(() => null);
  const clicked = await clickFirst(page, [
    page.getByRole('link', { name: new RegExp(process.cnj.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }),
    `a:has-text("${process.cnj}")`,
    'a[title*="Detalhe"]',
    'a[title*="Visualizar"]',
    'a:has(i)'
  ], 8000);
  if (!clicked) throw new Error('Processo encontrado, mas link de detalhe nao abriu.');

  const popup = await popupPromise;
  const detail = popup || page;
  await detail.waitForLoadState('domcontentloaded', { timeout: 45000 }).catch(() => {});
  await detail.waitForTimeout(3000);
  const text = await detail.locator('body').innerText({ timeout: 15000 }).catch(() => '');
  if (!cleanText(text)) throw new Error('Detalhe do processo abriu sem texto legivel.');
  return { page: detail, text };
}

async function main() {
  await mkdir(reportDir, { recursive: true });
  const pending = JSON.parse(await readFile(pendingFile, 'utf8'));
  const targets = (pending.processes || []).filter((process) => {
    const system = String(process.dashboardSystem || '').toLowerCase();
    if (only.size) return only.has(process.cnj) && process.cnj?.includes('.8.19.');
    return process.dashboardId && process.cnj?.includes('.8.19.') && system === 'pje';
  });

  const browser = await chromium.launch({
    headless: String(process.env.BROWSER_HEADLESS || 'false').toLowerCase() !== 'false',
    args: ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage']
  });
  const context = await browser.newContext({ locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  const page = await context.newPage();
  const report = { ok: false, startedAt: new Date().toISOString(), total: targets.length, updated: [], failed: [] };

  try {
    await loginPje(page);
    for (const process of targets) {
      try {
        const detail = await openPjeProcess(context, page, process);
        const res = summarizePjeText(detail.text, process.cnj);
        const payload = {
          res,
          ver: today,
          updatedAt: new Date().toISOString(),
          updatedBy: 'Codex automacao local - PJe autenticado',
          updatedByUid: ''
        };
        let dashboardId = process.dashboardId;
        if (dashboardId) {
          await patchDashboard(dashboardId, payload);
        } else {
          dashboardId = await createDashboardProcess({
            cl: process.cliente || `Novo processo - ${process.cnj}`,
            proc: `${process.cnj} PJe`,
            prox: 'Identificar cliente e definir providencias.',
            st: ['aguardando'],
            tipo: 'Cível',
            ...payload
          });
        }
        report.updated.push({ cnj: process.cnj, cliente: process.cliente, dashboardId, res });
        if (detail.page !== page) await detail.page.close().catch(() => {});
      } catch (error) {
        report.failed.push({ cnj: process.cnj, cliente: process.cliente, dashboardId: process.dashboardId, reason: String(error.message || error) });
      }
    }
    report.ok = report.failed.length === 0;
  } finally {
    report.finishedAt = new Date().toISOString();
    await writeFile(path.join(reportDir, 'local-pje-update.json'), JSON.stringify(report, null, 2), 'utf8');
    await browser.close().catch(() => {});
  }

  console.log(JSON.stringify({
    ok: report.ok,
    total: report.total,
    updated: report.updated.length,
    failed: report.failed.length
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
