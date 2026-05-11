# Dashboard Processual

Dashboard privado para acompanhamento de processos com sincronizacao em tempo real via Firebase Realtime Database.

## O que mudou em 2026-05-11

- O `index.html` publico nao contem mais a lista real de processos no codigo.
- O acesso agora exige login pelo Firebase Authentication.
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
2. Va em Authentication > Sign-in method.
3. Ative Email/Password.
4. Crie usuarios para voce e para sua assistente em Authentication > Users.
5. Va em Realtime Database > Rules.
6. Use regras restritas por UID.

Exemplo de regras:

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

Troque `SEU_UID` e `UID_DA_ASSISTENTE` pelos UIDs exibidos em Authentication > Users.

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

- Entre com e-mail e senha cadastrados no Firebase Authentication.
- Use `Novo processo` para cadastrar.
- Use `Editar` para atualizar campos e status.
- Use `Historico` para ver os eventos recentes.
- Use `CSV` para exportar a visao filtrada.
