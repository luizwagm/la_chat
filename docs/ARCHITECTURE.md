# ARCHITECTURE.md

As **decisões** de arquitetura, com problema, alternativa, benefício, risco e
escolha, estão em **[../CHAT_ARCHITECTURE.md](../CHAT_ARCHITECTURE.md)**.

O **terreno** em que foram tomadas — a stack medida no código dos 20 projetos
do parque — está em **[../PROJECT_ANALYSIS.md](../PROJECT_ANALYSIS.md)**.

Este arquivo é só o mapa de onde as coisas moram.

---

## Camadas

```
navegador
   │  <la-chat>   Web Components + Shadow DOM, sem build
   │      ↕ WebSocket (eventos)    ↓ HTTP (histórico, upload, busca)
   ├──────────────────────────────────────────────────────────────
   │  src/http/          roteamento e resposta
   ├──────────────────────────────────────────────────────────────
   │  src/aplicacao/     casos de uso — a ORDEM das coisas
   ├──────────────────────────────────────────────────────────────
   │  src/dominio/       regras puras: SEM banco, SEM http, SEM navegador
   ├──────────────────────────────────────────────────────────────
   │  src/infra/
   │     dados/          repositórios · SQLite | PostgreSQL
   │     realtime/       Transporte (WebSocket) · presença
   │     seguranca/      passe · sessão · CSRF · origem · limites ·
   │                     cifragem · índice cego · IP
   │     storage/        Armazenamento (local hoje, S3 preparado)
   │     eventos/        barramento
   └──────────────────────────────────────────────────────────────
```

**A regra que sustenta tudo: `dominio/` não importa nada de `infra/`.**

É o que permite exercitar regra de negócio sem subir banco — a suíte de unidade
roda 104 testes em menos de um segundo porque não sobe nada.

---

## Onde cada coisa mora

| Preciso mexer em… | Vá para |
|---|---|
| um limite, um teto, um prazo | `config.js` — **o único lugar com número mágico** |
| o que acontece ao enviar uma mensagem | `src/aplicacao/chat.js` |
| como a mensagem é gravada | `src/infra/dados/repositorios/mensagens.js` |
| o esquema do banco | `src/infra/dados/migracoes/` |
| o que viaja pelo socket | `src/infra/realtime/websocket.js` |
| quem pode o quê | `chat.js` → `exigirMembro` e `repositorios/*` |
| a aparência | `publico/la-chat.js`, bloco `CSS` no topo |
| a marcação de texto | `src/dominio/texto.js` **e** o espelho em `la-chat.js` |
| a instalação no hospedeiro | `conector/lachat.js` |

---

## Fluxos

### Entrar

```
hospedeiro assina passe (HMAC, 60s, uso único)
   → POST /chat/entrar
   → confere assinatura → marca jti como usado
   → garante contexto e usuário (upsert)
   → abre sessão (cookie HttpOnly + cookie CSRF)
```

### Enviar mensagem

```
POST /chat/conversas/:id/mensagens
   → exigirMembro           ← a PRIMEIRA coisa, sempre
   → limite por minuto
   → validar texto (dominio/texto.js)
   → transação: incrementa seq · cifra · grava · indexa tokens
   → barramento: MENSAGEM_ENVIADA
        → transporte.publicar(membros lidos do BANCO)
        → auditoria (sem conteúdo)
```

### Reconectar

```
socket caiu → recuo exponencial com ruído
   → POST /chat/bilhete (cookie + CSRF + Origin)
   → WS /chat/ws?t=bilhete
   → {"t":"sinc","desde":<último seq>}
   → recebe só o que faltou
```

---

## Por que não há framework

Não é ideologia: é o terreno. Os 20 projetos do parque rodam `node server.js`
com uma a três dependências, sem passo de build, em servidores onde às vezes
ninguém rodou `npm ci`. Um módulo que exigisse React, bundler ou ORM não seria
instalável neles — e instalabilidade **é** o requisito central (§2, §38).

A única dependência de execução é **`ws`**, e a escolha está justificada em
[SECURITY.md](SECURITY.md#a06--componentes-vulneráveis): escrever um analisador
de quadros binários exposto à internet seria contrariar a prioridade declarada
do projeto.
