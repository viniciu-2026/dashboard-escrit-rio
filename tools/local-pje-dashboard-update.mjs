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

function looksLikeTimelineOnly(text) {
  const normalized = cleanText(text);
  return /[íi]cone de (download|etiqueta|menu|filtro|lupa|atualizar|recolher|seta|estrela)|processo detalhes|autos digitais|mais detalhes|classe judicial|polo ativo|polo passivo|favoritos|lembretes|juntado por .* magistrado/i.test(normalized);
}

function summarizePjeDocumentText(text, label = '') {
  const normalized = cleanText(text);
  if (normalized.length < 120 || looksLikeTimelineOnly(normalized)) {
    throw new Error('Documento integral nao foi lido; texto extraido parece cronologia ou esta vazio.');
  }

  const sentences = normalized
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => cleanText(sentence))
    .filter(Boolean);
  const priority = sentences.filter((sentence) => (
    /defiro|indefiro|determino|intime-se|cite-se|expeca-se|julgo|homologo|designo|condeno|absolvo|manifestar|prazo|audiencia|sentenca|decisao|despacho/i.test(sentence)
  ));
  const selected = (priority.length ? priority : sentences).slice(0, 4).join(' ');
  const excerpt = cleanText(selected).slice(0, 650).replace(/\s+\S*$/, '');
  const prefix = label ? `PJe/TJRJ: lido ${label}` : 'PJe/TJRJ: lido o documento vinculado ao ultimo andamento';
  return `${prefix} em ${today}. ${excerpt}`;
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

async function hasVisible(page, selectors, timeout = 1000) {
  for (const selector of selectors) {
    try {
      await page.locator(selector).first().waitFor({ state: 'visible', timeout });
      return true;
    } catch {
      // Try next selector.
    }
  }
  return false;
}

async function extractPjeDocumentText(context, detailPage) {
  const candidates = detailPage.locator('a');
  const count = Math.min(await candidates.count().catch(() => 0), 120);
  const terms = /\d{6,}\s*-\s*(despacho|decis[aã]o|senten[cç]a|ac[oó]rd[aã]o|intima[cç][aã]o|certid[aã]o|mandado|peti[cç][aã]o|anexo|outros documentos|informa[cç][aã]o)/i;
  const attempts = [];
  const matches = [];

  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    const meta = await candidate.evaluate((element) => ({
      text: (element.textContent || '').replace(/\s+/g, ' ').trim(),
      title: element.getAttribute('title') || '',
      value: element.getAttribute('value') || '',
      href: element.getAttribute('href') || '',
      onclick: element.getAttribute('onclick') || ''
    })).catch(() => null);
    const label = cleanText(`${meta?.text || ''} ${meta?.title || ''} ${meta?.value || ''}`);
    if (!terms.test(`${label} ${meta?.href || ''} ${meta?.onclick || ''}`)) continue;
    if (/voltar|fechar|imprimir lista|atualizar|recolher|lupa|mais detalhes|adicionar lembretes/i.test(label)) continue;
    const rank = /senten[cç]a|decis[aã]o|despacho|ac[oó]rd[aã]o/i.test(label)
      ? 0
      : (/embargos|peti[cç][aã]o|contesta[cç][aã]o|apela[cç][aã]o|recurso/i.test(label)
          ? 1
          : (/mandado|informa[cç][aã]o/i.test(label) ? 2 : 3));
    matches.push({ index, label, rank });
  }

  matches.sort((a, b) => a.rank - b.rank || a.index - b.index);
  for (const match of matches) {
    const candidate = candidates.nth(match.index);
    const label = match.label;
    try {
      const beforeUrl = detailPage.url();
      const beforeText = cleanText(await detailPage.locator('body').innerText({ timeout: 5000 }).catch(() => ''));
      const directMeta = await candidate.evaluate((element) => ({
        href: element.getAttribute('href') || '',
        onclick: element.getAttribute('onclick') || ''
      })).catch(() => ({ href: '', onclick: '' }));
      const directUrlMatch = /(?:window\.open\(')?([^'"]*documentoHTML\.seam[^'"]*)/.exec(`${directMeta.href || ''}\n${directMeta.onclick || ''}`);
      if (directUrlMatch) {
        const docPage = await context.newPage();
        await docPage.goto(new URL(directUrlMatch[1], detailPage.url()).toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });
        await docPage.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
        await docPage.waitForTimeout(2500);
        const text = await docPage.locator('body').innerText({ timeout: 10000 }).catch(() => '');
        attempts.push({ label, length: cleanText(text).length, method: 'direct-link' });
        if (cleanText(text).length > 120 && !looksLikeTimelineOnly(text)) {
          return { label, text, url: docPage.url() };
        }
        await docPage.close().catch(() => {});
      }

      const popupPromise = detailPage.waitForEvent('popup', { timeout: 7000 }).catch(() => null);
      await candidate.click({ timeout: 5000 });
      const popup = await popupPromise;
      if (popup) {
        await popup.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
        await popup.waitForTimeout(2500);
        const text = await popup.locator('body').innerText({ timeout: 10000 }).catch(() => '');
        attempts.push({ label, length: cleanText(text).length, method: 'popup' });
        if (cleanText(text).length > 120 && !looksLikeTimelineOnly(text)) {
          return { label, text, url: popup.url() };
        }
        await popup.close().catch(() => {});
      }
      await detailPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await detailPage.waitForTimeout(2500);

      const afterText = cleanText(await detailPage.locator('body').innerText({ timeout: 5000 }).catch(() => ''));
      if (detailPage.url() !== beforeUrl || (afterText.length > 120 && afterText !== beforeText && !looksLikeTimelineOnly(afterText))) {
        attempts.push({ label, length: afterText.length, method: 'same-page' });
        return { label, text: afterText, url: detailPage.url() };
      }

      const opener = detailPage.locator('a[id*="detalheDocumento"][title*="Abrir documento"], a[id*="detalheDocumento"][onclick*="documentoHTML.seam"], a[onclick*="documentoHTML.seam"], a[href*="documentoHTML.seam"]').first();
      const onclick = await opener.getAttribute('onclick', { timeout: 8000 }).catch(() => '');
      const href = await opener.getAttribute('href', { timeout: 1000 }).catch(() => '');
      const urlMatch = /window\.open\('([^']+documentoHTML\.seam[^']*)'/.exec(onclick || '') || /([^'"]*documentoHTML\.seam[^'"]*)/.exec(href || '');
      if (!urlMatch) {
        attempts.push({ label, error: 'link documentoHTML.seam nao encontrado apos selecionar documento' });
        continue;
      }

      const docPage = await context.newPage();
      await docPage.goto(new URL(urlMatch[1], detailPage.url()).toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });
      await docPage.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
      await docPage.waitForTimeout(2500);
      const text = await docPage.locator('body').innerText({ timeout: 10000 }).catch(() => '');
      attempts.push({ label, length: cleanText(text).length });
      if (cleanText(text).length > 120 && !looksLikeTimelineOnly(text)) {
        return { label, text, url: docPage.url() };
      }
      await docPage.close().catch(() => {});
    } catch (error) {
      attempts.push({ label, error: String(error.message || error) });
    }
  }

  throw new Error(`Documento integral nao localizado/extraido no PJe. Tentativas: ${JSON.stringify(attempts).slice(0, 800)}`);
}

async function loginPje(page) {
  const ssoUrl = 'https://sso.cloud.pje.jus.br/auth/realms/pje/protocol/openid-connect/auth?response_type=code&client_id=pje-tjrj-1g&redirect_uri=https%3A%2F%2Ftjrj.pje.jus.br%2F1g%2Flogin.seam&state=codex-local-pje&login=true&scope=openid';
  await page.goto(ssoUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  if (String(process.env.MANUAL_PJE_LOGIN || '').toLowerCase() === 'true') {
    const deadline = Date.now() + Number(process.env.MANUAL_PJE_LOGIN_TIMEOUT_MS || 900000);
    while (Date.now() < deadline) {
      await page.waitForTimeout(3000);
      const text = cleanText(await page.locator('body').innerText({ timeout: 5000 }).catch(() => ''));
      const url = page.url();
      if (/tjrj\.pje\.jus\.br\/1g\//i.test(url) && !/login|auth|autentica|c[oó]digo|senha|Solicitar nova senha/i.test(`${url} ${text}`)) {
        return;
      }
    }
    throw new Error('Login manual PJe nao foi concluido dentro do prazo de espera.');
  }
  const userSelectors = ['#username', 'input[name="username"]', 'input[id*="username"]', 'input[type="text"]'];
  const passwordSelectors = ['#password', 'input[name="password"]', 'input[id*="password"]', 'input[type="password"]'];
  if (!(await hasVisible(page, userSelectors, 1500))) {
    await clickFirst(page, [
      page.getByRole('link', { name: /^Entrar$/i }),
      'a:has-text("Entrar")',
      'button:has-text("Entrar")'
    ], 8000);
    await page.waitForLoadState('domcontentloaded', { timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(2000);
  }
  const filledUser = await fillBySelectors(page, userSelectors, requiredEnv('TRIBUNAL_CPF'));
  const filledPassword = await fillBySelectors(page, passwordSelectors, requiredEnv('TRIBUNAL_PASSWORD'));
  if (!filledUser || !filledPassword) {
    throw new Error('Campos de login do PJe nao encontrados apos abrir a tela Entrar.');
  }
  await clickFirst(page, [
    '#btnEntrar',
    '#kc-login',
    'button:has-text("Entrar")',
    'input[type="button"][value*="Entrar"]',
    'input[type="submit"][value*="Entrar"]'
  ], 8000);
  await page.waitForLoadState('domcontentloaded', { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const text = cleanText(await page.locator('body').innerText({ timeout: 10000 }).catch(() => ''));
  if (/aplicativo de autentica|codigo apresentado|configurar novo dispositivo|duas etapas/i.test(text)) {
    throw new Error('Login PJe bloqueado por codigo de aplicativo autenticador; nao ha leitura integral sem concluir essa etapa.');
  }
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
    const looksLikeTjrjPje = /^08\d{5}-\d{2}\.\d{4}\.8\.19\./.test(String(process.cnj || ''));
    return process.cnj?.includes('.8.19.') && (
      system === 'pje' ||
      (!system && looksLikeTjrjPje) ||
      (system === 'no-sistema' && looksLikeTjrjPje)
    );
  });

  const browser = await chromium.launch({
    headless: String(process.env.BROWSER_HEADLESS || 'false').toLowerCase() !== 'false',
    args: ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage']
  });
  const context = await browser.newContext({ locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  const page = await context.newPage();
  const report = { ok: false, startedAt: new Date().toISOString(), total: targets.length, updated: [], failed: [] };

  try {
    try {
      await loginPje(page);
    } catch (error) {
      report.status = 'pje-login-blocked';
      report.reason = String(error.message || error);
      for (const process of targets) {
        report.failed.push({
          cnj: process.cnj,
          cliente: process.cliente,
          dashboardId: process.dashboardId,
          reason: report.reason
        });
      }
      return;
    }
    for (const process of targets) {
      try {
        const detail = await openPjeProcess(context, page, process);
        const document = await extractPjeDocumentText(context, detail.page);
        const res = summarizePjeDocumentText(document.text, document.label);
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
        report.updated.push({
          cnj: process.cnj,
          cliente: process.cliente,
          dashboardId,
          documentLabel: document.label,
          documentUrl: document.url,
          res,
          sourceText: cleanText(document.text).slice(0, 8000)
        });
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
