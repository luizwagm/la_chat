# INTEGRATION.md — o contrato com o hospedeiro

O chat **não conhece** o sistema onde é instalado. Ele conhece **uma função**.

---

## O contrato inteiro

```js
usuario(req) → { id, nome, ... } | null
```

Isso é tudo. O hospedeiro responde "quem é este visitante?" usando a **própria
sessão**; o resto é problema do chat.

| Campo | Obrigatório | Observação |
|---|---|---|
| `id` | **sim** | **estável**. Se mudar, a pessoa vira outra e perde o histórico |
| `nome` | **sim** | exibido para os colegas |
| `sobrenome` | não | |
| `email` | não | guardado **cifrado**; não é exibido nem buscável |
| `avatar` | não | URL da foto |
| `cargo` | não | aparece no perfil |
| `departamento` | não | é buscável |
| `papel` | não | `"admin"` ou `"membro"` (o padrão). Qualquer outro vira `membro` |
| `contexto` | não | separa os dados entre instalações (§22) |

Devolver `null` = visitante não logado. O chat simplesmente não aparece.

---

## O que o chat **não** faz no hospedeiro

Dito para não haver surpresa numa auditoria:

- não lê nem escreve no banco do site;
- não conhece o model `User` — só o objeto que `usuario()` devolve;
- não grava arquivo no site;
- não abre porta (continua escutando no loopback);
- não exige alterar tabela, migração ou rota existente.

---

## Como a identidade viaja

```
1. navegador  → GET /chat/passe          (rota do CONECTOR, no site)
2. conector   → chama usuario(req)
3. conector   → assina:  base64(corpo) + "." + HMAC-SHA256(corpo, SEGREDO)
                corpo = { sub, nome, papel, ctx, iat, exp: iat+60s, jti }
4. navegador  → POST /chat/entrar { passe }
5. chat       → confere assinatura, validade e ineditismo do jti
              → cria sessão PRÓPRIA (cookie HttpOnly)
```

**O segredo nunca vai ao navegador.** Ele mora em `/etc/lachat.env` dos dois
lados; o navegador só carrega o resultado assinado.

**O passe vale 60 s e uma vez só.** Interceptar não serve — o dono legítimo já
o usou, e o `jti` guardado recusa o segundo uso.

**A sessão do chat é independente.** O chat continua funcionando se o hospedeiro
reiniciar, e sair do chat não desloga a pessoa do sistema do cliente.

---

## Exemplos por tipo de hospedeiro

### Site do parque, com `/restrito` (Borda Tudo, Imobiliária, Kenósis)

```js
const chat = conectorChat({
  url: process.env.CHAT_URL,
  segredo: process.env.CHAT_SEGREDO_PASSE,
  contexto: "bordatudo",
  usuario(req) {
    const s = restrito.sessaoDe(req);     // a função que já existe
    if (!s) return null;
    return {
      id: String(s.usuarioId),
      nome: s.nome,
      papel: s.papel === "admin" || s.papel === "dono" ? "admin" : "membro",
    };
  },
});
```

### Site com `/admin` em SQLite (Forms Fitness, CW Mendes)

```js
usuario(req) {
  const sid = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || "")?.[1];
  const s = sid && sessoes.get(sid);
  return s ? { id: s.usuario, nome: s.nome, papel: "admin" } : null;
}
```

### Multi-empresa no mesmo chat

```js
usuario(req) {
  const s = sessaoDe(req);
  if (!s) return null;
  /* `contexto` isola: pessoas de empresas diferentes nunca se veem, nem por
     id adivinhado — a consulta filtra por contexto em todo lugar. */
  return { id: s.id, nome: s.nome, contexto: "empresa-" + s.empresaId };
}
```

---

## Eventos que o hospedeiro pode escutar

```js
document.querySelector("la-chat")
  .addEventListener("la-chat-nao-lidas", (e) => {
    document.title = e.detail.total ? `(${e.detail.total}) Painel` : "Painel";
  });
```

É o único acoplamento de saída do componente — e é um evento, que o site escuta
se quiser.

---

## Personalização visual (§50)

Variáveis CSS atravessam o Shadow DOM de propósito. É por elas que o hospedeiro
personaliza **sem tocar no código do módulo**:

```css
la-chat {
  --chat-primaria: #1e275f;         /* a cor do site do cliente */
  --chat-primaria-texto: #ffffff;
  --chat-raio: 10px;
  --chat-fonte: "Inter", system-ui, sans-serif;
}
```

O CSS do site **não vaza** para dentro do chat, e o do chat não vaza para fora.
O `index.html` do exemplo prova isso na prática: ele define
`button { font-family: "Times New Roman" !important }` e o botão do chat
continua com a fonte certa.

---

## Erros comuns na integração

| Erro | Consequência |
|---|---|
| `id` derivado do e-mail ou do nome | a pessoa troca de e-mail e **perde o histórico** |
| `id` diferente entre servidores | a mesma pessoa vira duas |
| `usuario()` que consulta banco a cada chamada | chamada a cada abertura de chat — use a sessão, que já está em memória |
| Esquecer `chat.conectarUpgrade(servidor)` | o chat funciona em tudo, **menos em tempo real** |
| `usuario()` que lança exceção | o conector registra e devolve 401 — o chat não aparece |
| Segredo diferente entre os lados | "Não foi possível abrir o chat" |
