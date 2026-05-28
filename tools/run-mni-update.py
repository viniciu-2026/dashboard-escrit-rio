import base64
import json
import os
import re
import tempfile
import time
import urllib.parse
import xml.etree.ElementTree as ET
from datetime import date, datetime

import requests

FIREBASE_URL = "https://dashboard-vg-default-rtdb.firebaseio.com"
DATAJUD_KEY = "APIKey cDZHYzlZa0JadVREZDJCendQbXY6SkJlTzNjLV9TRENyQk1RdnFKZGRQdw=="
NS_SER = "http://www.cnj.jus.br/servico-intercomunicacao-2.2.2/"
NS_TIP = "http://www.cnj.jus.br/tipos-servico-intercomunicacao-2.2.2"
CNJ_RE = re.compile(r"\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}")

PJE_CPF = os.environ.get("PJE_CPF", "").strip()
PJE_SENHA = (os.environ.get("PJE_SENHA") or os.environ.get("PJE_PASSWORD") or "").strip()
FIREBASE_DATABASE_AUTH_TOKEN = os.environ.get("FIREBASE_DATABASE_AUTH_TOKEN", "").strip()
FIREBASE_SERVICE_ACCOUNT_JSON = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip()

ENDPOINTS_MNI = {
    "TJRJ_1G": "https://tjrj.pje.jus.br/1g/intercomunicacao",
    "TJRJ_2G": "https://tjrj.pje.jus.br/2g/intercomunicacao",
}
ENDPOINTS_DATAJUD = {
    "TJRJ": "https://api-publica.datajud.cnj.jus.br/api_publica_tjrj/_search",
    "TJRO": "https://api-publica.datajud.cnj.jus.br/api_publica_tjro/_search",
    "TRF2": "https://api-publica.datajud.cnj.jus.br/api_publica_trf2/_search",
}
PRIORIDADE_DOCS = [
    "ACORDAO", "ACÓRDÃO", "DECISAO", "DECISÃO", "SENTENCA", "SENTENÇA",
    "DESPACHO", "INTIMACAO", "INTIMAÇÃO", "CERTIDAO", "CERTIDÃO"
]


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def firebase_headers():
    if FIREBASE_DATABASE_AUTH_TOKEN:
        return {}, {"auth": FIREBASE_DATABASE_AUTH_TOKEN}
    if not FIREBASE_SERVICE_ACCOUNT_JSON:
        return {}, {}

    import jwt

    service_account = json.loads(FIREBASE_SERVICE_ACCOUNT_JSON)
    now = int(time.time())
    claim = {
        "iss": service_account["client_email"],
        "scope": "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email",
        "aud": "https://oauth2.googleapis.com/token",
        "iat": now,
        "exp": now + 3600,
    }
    assertion = jwt.encode(claim, service_account["private_key"], algorithm="RS256")
    response = requests.post(
        "https://oauth2.googleapis.com/token",
        data={
            "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
            "assertion": assertion,
        },
        timeout=30,
    )
    response.raise_for_status()
    token = response.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}, {}


FIREBASE_HEADERS, FIREBASE_PARAMS = firebase_headers()


def firebase_request(method, path, payload=None):
    url = f"{FIREBASE_URL}{path}.json"
    response = requests.request(
        method,
        url,
        headers={**FIREBASE_HEADERS, "Content-Type": "application/json; charset=utf-8"},
        params=FIREBASE_PARAMS,
        data=json.dumps(payload) if payload is not None else None,
        timeout=30,
    )
    response.raise_for_status()
    return response.json()


def identificar_tribunal(cnj: str):
    match = re.search(r"\d{7}-\d{2}\.\d{4}\.(\d)\.(\d{2})\.\d{4}", cnj)
    if not match:
        return None
    ramo, tribunal = match.group(1), match.group(2)
    if ramo == "8" and tribunal == "19":
        grau = "2G" if cnj.endswith(".0000") else "1G"
        return {
            "tribunal": "TJRJ",
            "sistema": "PJe",
            "endpoint_mni": ENDPOINTS_MNI[f"TJRJ_{grau}"],
            "endpoint_dj": ENDPOINTS_DATAJUD["TJRJ"],
        }
    if ramo == "8" and tribunal == "22":
        return {"tribunal": "TJRO", "sistema": "manual", "endpoint_dj": ENDPOINTS_DATAJUD["TJRO"]}
    if ramo == "4" and tribunal == "02":
        return {"tribunal": "TRF2", "sistema": "manual", "endpoint_dj": ENDPOINTS_DATAJUD["TRF2"]}
    return None


def parse_ptbr_date(value):
    try:
        return datetime.strptime(str(value or ""), "%d/%m/%Y").date()
    except ValueError:
        return date(2026, 1, 1)


def triagem_datajud(cnj, endpoint, desde):
    numero_limpo = re.sub(r"[.\-]", "", cnj)
    headers = {"Authorization": DATAJUD_KEY, "Content-Type": "application/json"}
    body = {"query": {"match": {"numeroProcesso": numero_limpo}}}
    try:
        response = requests.post(endpoint, headers=headers, json=body, timeout=25)
        response.raise_for_status()
    except Exception:
        return None
    hits = response.json().get("hits", {}).get("hits", [])
    if not hits:
        return None
    movimentos = hits[0].get("_source", {}).get("movimentos", [])
    novos = [m for m in movimentos if m.get("dataHora", "")[:10] >= str(desde)]
    return sorted(novos, key=lambda item: item.get("dataHora", ""), reverse=True)


def consultar_mni(cnj, endpoint, incluir_docs=True):
    soap = f"""<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
    xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
    xmlns:ser="{NS_SER}"
    xmlns:tip="{NS_TIP}">
  <soapenv:Header/>
  <soapenv:Body>
    <ser:consultarProcesso>
      <tip:idConsultante>{PJE_CPF}</tip:idConsultante>
      <tip:senhaConsultante>{PJE_SENHA}</tip:senhaConsultante>
      <tip:numeroProcesso>{cnj}</tip:numeroProcesso>
      <tip:movimentos>true</tip:movimentos>
      <tip:incluirCabecalho>true</tip:incluirCabecalho>
      <tip:incluirDocumentos>{str(incluir_docs).lower()}</tip:incluirDocumentos>
    </ser:consultarProcesso>
  </soapenv:Body>
</soapenv:Envelope>"""
    response = requests.post(
        endpoint,
        data=soap.encode("utf-8"),
        headers={"Content-Type": "text/xml; charset=utf-8", "SOAPAction": "consultarProcesso"},
        timeout=80,
    )
    response.raise_for_status()
    raw = response.text
    start = raw.find("<soap:Envelope")
    if start == -1:
        start = raw.find("<Envelope")
    if start == -1:
        raise RuntimeError("Resposta sem envelope SOAP")
    raw = raw[start:]
    end = raw.find("</soap:Envelope>")
    if end != -1:
        raw = raw[: end + len("</soap:Envelope>")]
    root = ET.fromstring(raw)
    sucesso = root.findtext(f".//{{{NS_TIP}}}sucesso") or ""
    mensagem = root.findtext(f".//{{{NS_TIP}}}mensagem") or ""
    if sucesso.lower() == "false":
        raise RuntimeError(f"MNI sucesso=false: {mensagem}")
    movimentos = [
        {
            "nome": mov.findtext(f"{{{NS_TIP}}}descricao", default=""),
            "data": mov.findtext(f"{{{NS_TIP}}}dataHora", default=""),
        }
        for mov in root.findall(f".//{{{NS_TIP}}}movimento")
    ]
    documentos = []
    for doc in root.findall(f".//{{{NS_TIP}}}documento"):
        conteudo = doc.findtext(f"{{{NS_TIP}}}conteudo", default="")
        if conteudo:
            documentos.append({
                "tipo": doc.findtext(f"{{{NS_TIP}}}tipoDocumento", default=""),
                "nome": doc.findtext(f"{{{NS_TIP}}}descricao", default=""),
                "binario": base64.b64decode(conteudo),
            })
    return movimentos, documentos


def selecionar_documento(documentos):
    for prioridade in PRIORIDADE_DOCS:
        for doc in documentos:
            texto = f"{doc.get('tipo', '')} {doc.get('nome', '')}".upper()
            if prioridade in texto:
                return doc
    return documentos[0] if documentos else None


def extrair_texto_pdf(pdf_bytes):
    try:
        import fitz
    except ImportError:
        return ""
    tmp_path = ""
    try:
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
            tmp.write(pdf_bytes)
            tmp_path = tmp.name
        doc = fitz.open(tmp_path)
        try:
            return "\n".join(page.get_text() for page in doc).strip()
        finally:
            doc.close()
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)


def cnjs_do_processo(processo):
    return [cnj for cnj in CNJ_RE.findall(str(processo.get("proc", ""))) if ".5." not in cnj]


def resumir_andamento(doc, movimento, texto):
    tipo = (doc.get("tipo") or doc.get("nome") or "Documento").strip()
    data = (movimento.get("data") or "")[:10]
    nome = (movimento.get("nome") or "").strip()
    primeira_linha = next((line.strip() for line in texto.splitlines() if line.strip()), "")
    base = f"{tipo} em {data} - {nome}".strip(" -")
    if primeira_linha and primeira_linha.lower() not in base.lower():
        return f"{base}. Teor extraido do documento: {primeira_linha[:220]}"
    return base


def main():
    report = {
        "ok": False,
        "startedAt": datetime.utcnow().isoformat() + "Z",
        "todayPtBr": date.today().strftime("%d/%m/%Y"),
        "updated": [],
        "withoutMovement": [],
        "manual": [],
        "errors": [],
    }
    if not PJE_CPF or not PJE_SENHA:
        report["errors"].append({"status": "missing-pje-credentials"})
        write_report(report)
        return 2

    processos = firebase_request("GET", "/dashboard/processes") or {}
    for pid, processo in sorted(processos.items(), key=lambda item: str(item[0])):
        status = processo.get("st") or []
        if isinstance(status, str):
            status = [status]
        if "encerrado" in status:
            continue
        for cnj in cnjs_do_processo(processo):
            info = identificar_tribunal(cnj)
            if not info:
                continue
            cliente = processo.get("cl", "")
            desde = parse_ptbr_date(processo.get("ver"))
            if info["sistema"] != "PJe":
                movimentos = triagem_datajud(cnj, info["endpoint_dj"], desde)
                if movimentos:
                    mov = movimentos[0]
                    report["manual"].append({
                        "id": pid,
                        "cliente": cliente,
                        "cnj": cnj,
                        "status": "movimento-datajud-manual",
                        "movimento": mov.get("nome", ""),
                        "data": mov.get("dataHora", "")[:10],
                    })
                continue
            movimentos_datajud = triagem_datajud(cnj, info["endpoint_dj"], desde)
            if movimentos_datajud == []:
                report["withoutMovement"].append({"id": pid, "cliente": cliente, "cnj": cnj})
                continue
            try:
                movimentos, documentos = consultar_mni(cnj, info["endpoint_mni"], incluir_docs=True)
                movimentos_novos = [mov for mov in movimentos if (mov.get("data") or "")[:10] >= str(desde)]
                if not movimentos_novos and not movimentos_datajud:
                    report["withoutMovement"].append({"id": pid, "cliente": cliente, "cnj": cnj})
                    continue
                doc = selecionar_documento(documentos)
                if not doc:
                    report["manual"].append({"id": pid, "cliente": cliente, "cnj": cnj, "status": "mni-sem-documento"})
                    continue
                texto = extrair_texto_pdf(doc["binario"])
                if not texto:
                    report["manual"].append({"id": pid, "cliente": cliente, "cnj": cnj, "status": "pdf-sem-texto"})
                    continue
                movimento_ref = movimentos_novos[0] if movimentos_novos else (movimentos_datajud[0] if movimentos_datajud else movimentos[0])
                andamento = resumir_andamento(doc, movimento_ref, texto)
                payload = {
                    "res": andamento,
                    "ver": report["todayPtBr"],
                    "updatedAt": datetime.utcnow().isoformat() + "Z",
                    "updatedBy": "Codex skill MNI",
                }
                firebase_request("PATCH", f"/dashboard/processes/{urllib.parse.quote(str(pid), safe='')}", payload)
                report["updated"].append({"id": pid, "cliente": cliente, "cnj": cnj, "andamento": andamento})
            except Exception as exc:
                msg = str(exc)
                status = "fora-do-pje" if "Processo" in msg and "encontrado" in msg else "erro-mni"
                report["manual"].append({"id": pid, "cliente": cliente, "cnj": cnj, "status": status, "reason": msg[:300]})
    report["ok"] = True
    report["finishedAt"] = datetime.utcnow().isoformat() + "Z"
    write_report(report)
    print(json.dumps({
        "ok": report["ok"],
        "updated": len(report["updated"]),
        "withoutMovement": len(report["withoutMovement"]),
        "manual": len(report["manual"]),
        "errors": len(report["errors"]),
    }, ensure_ascii=False))
    return 0


def write_report(report):
    report_dir = os.environ.get("AUTOMATION_REPORT_DIR", "automation-report")
    os.makedirs(report_dir, exist_ok=True)
    with open(os.path.join(report_dir, "mni-update.json"), "w", encoding="utf-8") as file:
        json.dump(report, file, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    raise SystemExit(main())
