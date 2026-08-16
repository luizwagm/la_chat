# Instalar o LA Chat num site do gerador

Vale para BemEstarClinic, Borda Tudo, Forms Fitness, Imobiliária, Kenósis,
NYC, Óticas, Troféu, CW Mendes, Daniel's, Esatto — e para qualquer servidor
Node que use `node:http`.

São **duas linhas no `server.js`** mais um `<script>` no HTML.

---

## Antes de começar

O serviço do chat precisa estar rodando (ver [DEPLOYMENT.md](../docs/DEPLOYMENT.md)).
Anote o **endereço interno** dele e o **segredo do passe** — o mesmo valor vai
nos dois lados.

```bash
openssl rand -base64 32
```

---

## 1. Copie o conector

```bash
cp conector/lachat.js /var/www/projetos/BemEstarClinic/lachat.js
```

Um arquivo, sem dependência nenhuma além do Node. Ele **não lê o banco do
site**, **não grava nada** e **não abre porta**.

---

## 2. Duas linhas no `server.js` do site

```js
const conectorChat = require("./lachat");

const chat = conectorChat({
  url: process.env.CHAT_URL || "http://127.0.0.1:5197",
  segredo: process.env.CHAT_SEGREDO_PASSE,
  contexto: "bemestarclinic",          // separa os dados entre instalações

  /* ====================================================================
     O CONTRATO. É a única coisa que o site precisa ensinar ao chat.

     Devolva os dados de quem está logado, usando a SESSÃO QUE O SITE JÁ
     TEM. Devolva `null` para visitante — e aí o chat simplesmente não
     aparece para ele.

     O chat NUNCA vê o seu banco, o seu model de usuário ou a sua senha.
     ==================================================================== */
  usuario(req) {
    const s = sessaoDe(req);            // ← a função que o site já usa
    if (!s) return null;
    return {
      id: s.usuarioId,                  // obrigatório, e ESTÁVEL
      nome: s.nome,                     // obrigatório
      sobrenome: s.sobrenome,           // daqui para baixo, opcional
      email: s.email,
      avatar: s.foto,
      cargo: s.cargo,
      departamento: s.setor,
      papel: s.papel === "admin" ? "admin" : "membro",
    };
  },
});
```

Agora as duas linhas de verdade:

```js
const servidor = http.createServer(async (req, res) => {
  if (chat.rota(req, res)) return;      // ←←← LINHA 1: no TOPO do handler
  ...                                    // o resto do site, sem mudar nada
});

chat.conectarUpgrade(servidor);          // ←←← LINHA 2: o WebSocket
```

> **A LINHA 2 NÃO É OPCIONAL, e é a que mais se esquece.**
>
> `upgrade` é um evento separado do fluxo normal de requisição — ele não passa
> por `chat.rota()`. Sem ela o chat carrega, autentica, mostra as conversas e
> **nunca recebe mensagem em tempo real**. Nada aparece quebrado; o sintoma é
> "às vezes não chega".

---

## 3. Uma linha no HTML

Nos sites do gerador, dentro do molde (`src/molde-*.html`), antes de `</body>`:

```html
<script src="/chat/cliente.js" defer data-auto data-modo="drawer"></script>
```

O `data-auto` cria o botão flutuante 💬 com o contador de não lidas.

Quem quiser controlar onde o chat aparece omite o `data-auto` e usa o elemento
direto:

```html
<la-chat modo="fullpage"></la-chat>
```

| Atributo | Valores | Para quê |
|---|---|---|
| `modo` | `modal`, `drawer`, `fullpage` | como o chat aparece |
| `tema` | `claro`, `escuro` | força o tema (o padrão segue o sistema) |
| `base` | caminho | onde as rotas do chat vivem (padrão `/chat`) |

Personalizar as cores, sem tocar no código do módulo:

```css
la-chat { --chat-primaria: #1e275f; --chat-raio: 10px; }
```

---

## 4. O segredo, no serviço do site

```bash
# em /etc/bemestar.env — o MESMO valor de /etc/lachat.env
CHAT_URL=http://127.0.0.1:5197
CHAT_SEGREDO_PASSE=<os 32 bytes em base64>
```

E no `/etc/lachat.env` do chat, autorize a origem do site **e conte os saltos**:

```bash
CHAT_ORIGENS=https://bemestarclinic.com
CHAT_PROXIES=2
```

> **`CHAT_PROXIES=2`, e não 1.** Instalando pelo conector existem DOIS saltos
> até o chat: `nginx → site` e `site → chat`. Com 1, o chat enxerga o próprio
> conector e **todo visitante vira 127.0.0.1** — o limitador passa a contar a
> empresa inteira como um endereço só (uma pessoa errando a senha tranca todo
> mundo junto) e a auditoria grava o mesmo hash para todos. Nada quebra
> visivelmente. O serviço avisa no log quando detecta isso.

> Sem essa linha o chat recusa o WebSocket — **de propósito**. É ela que impede
> que qualquer site do mundo abra um socket usando o cookie do seu funcionário
> (*Cross-Site WebSocket Hijacking*). Vazia significa **recuse todo mundo**,
> nunca "aceite todo mundo".

---

## 5. Conferir

```bash
systemctl restart bemestar
curl -s https://bemestarclinic.com/chat/saude
```

Depois, logado no site:

```bash
curl -s https://bemestarclinic.com/chat/passe -H "Cookie: <o seu cookie>"
```

Tem de vir `{"passe":"...","validadeSegundos":60}`.

E a verificação completa, do lado do chat:

```bash
cd /var/www/projetos/LA-Chat && ./verificar.sh https://bemestarclinic.com
```

---

## Se algo não funcionar

| Sintoma | Causa quase certa |
|---|---|
| O botão 💬 não aparece | o `<script>` não entrou no molde, ou `usuario()` devolveu `null` |
| "Não foi possível abrir o chat" | segredo diferente entre os dois lados |
| Carrega, mas mensagem só chega ao apertar F5 | **falta a LINHA 2** (`chat.conectarUpgrade`) |
| Fica "Reconectando…" sem parar | falta o `map` de Upgrade no nginx, ou `proxy_read_timeout` no padrão de 60s |
| 503 nas rotas `/chat/*` | o serviço do chat está fora do ar — o site continua no ar, que é o esperado |
| Entra como a pessoa errada | `usuario()` está lendo a sessão errada, ou `id` não é estável |

Mais detalhes em [TROUBLESHOOTING.md](../docs/TROUBLESHOOTING.md).

---

## O que o conector NÃO faz

Dito para não haver surpresa numa auditoria:

- não lê nem escreve no banco do site;
- não grava arquivo nenhum no site;
- não abre porta nova (o chat continua escutando só no loopback);
- não envia nada para fora além do repasse que o próprio navegador pediu;
- não conhece o `User` do hospedeiro — só o objeto que `usuario()` devolve.
