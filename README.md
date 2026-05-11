# Dashboard Processual

Dashboard privado para acompanhamento de processos com sincronizacao em tempo real via Firebase Realtime Database.

## O que mudou em 2026-05-11

- O `index.html` publico nao contem mais a lista real de processos no codigo.
- O acesso agora exige login com Google pelo Firebase Authentication.
- Os processos passam a ser lidos e gravados em `dashboard/processes` no Realtime Database.
- Cada criacao, edicao, importacao ou remocao registra evento em `dashboard/history`.
- Foi criado um ponto de restauracao antes das mudancas.

## Backup e restauracao

Backup criado antes das alteracoes de seguranca:

- Branch: `backup/pre-seguranca-2026-05-11`
- Commit original: `89ac3ba84602e92f853a8efbc160a0496e45cea0`
- Arquivo original: `index.html`
- Blob original: `fb80c7de67991871b6585b4a0fa793f67d845a88`

Para restaurar pelo GitHub, abra a branch `backup/pre-seguranca-2026-05-11`, copie o `index.html` antigo e substitua o `index.html` da branch `main`.

## Configuracao obrigatoria no Firebase

1. Abra o Firebase Console do projeto `dashboard-vg`.
2. Va em Authentication > Metodo de login.
3. Ative o provedor Google.
4. Em Realtime Database > Rules, restrinja acesso aos e-mails ou UIDs autorizados.

Exemplo simples por e-mail:

```json
{
  "rules": {
    "dashboard": {
      ".read": "auth != null && (auth.token.email === 'SEU_EMAIL@gmail.com' || auth.token.email === 'EMAIL_DA_ASSISTENTE@gmail.com')",
      ".write": "auth != null && (auth.token.email === 'SEU_EMAIL@gmail.com' || auth.token.email === 'EMAIL_DA_ASSISTENTE@gmail.com')"
    }
  }
}
```

Exemplo mais rigido por UID:

```json
{
  "rules": {
    "dashboard": {
      ".read": "auth != null && (auth.uid === 'SEU_UID' || auth.uid === 'UID_DA_ASSISTENTE')",
      ".write": "auth != null && (auth.uid === 'SEU_UID' || auth.uid === 'UID_DA_ASSISTENTE')"
    }
  }
}
```

Depois do primeiro login de cada pessoa, os usuarios aparecem em Authentication > Usuarios com seus respectivos UIDs.

## Migracao dos processos antigos

A versao antiga, com os dados dentro do HTML, ficou salva na branch de backup.

O dashboard novo possui um botao `Importar JSON`. Cole um array de processos com campos como:

```json
[
  {
    "id": 1,
    "cl": "Cliente exemplo",
    "tipo": "Criminal",
    "proc": "0000000-00.0000.0.00.0000",
    "st": "aguardando",
    "res": "Estado atual do processo",
    "prox": "Proximo passo",
    "ver": "11/05/2026"
  }
]
```

Depois da importacao, os dados ficam no Firebase e sincronizam em tempo real para os usuarios autorizados.

## Uso diario

- Entre com sua conta Google autorizada.
- Use `Novo processo` para cadastrar.
- Use `Editar` para atualizar campos e status.
- Use `Historico` para ver os eventos recentes.
- Use `CSV` para exportar a visao filtrada.
