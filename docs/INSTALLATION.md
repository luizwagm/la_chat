# INSTALLATION.md — os dois arranjos

Antes de instalar, escolha o arranjo. A escolha muda a postura de segurança, e
tratá-los como se fossem um só é como se ganha uma instalação insegura por
descuido.

---

## Arranjo A — atrás do hospedeiro (**recomendado**)

```
navegador → https://site-do-cliente.com/chat/... → conector → chat (loopback)
```

O conector do site repassa as rotas `/chat/*`. Para o navegador, **tudo
acontece na mesma origem do site**.

**O que se ganha:**

| | |
|---|---|
| `SameSite=Strict` no cookie | a proteção mais forte contra CSRF, **de graça** |
| Nenhum CORS | não há requisição entre sites |
| Nenhum subdomínio, nenhum certificado novo | menos peças, menos a errar |
| O chat cair não derruba o site | o repasse falha sozinho, com 503 educado |

**Requisitos:** o hospedeiro tem de ser Node com `node:http` — que é o caso de
todos os sites do parque.

Passo a passo: **[../conector/INSTALAR.md](../conector/INSTALAR.md)**.

---

## Arranjo B — subdomínio próprio

```
navegador → https://chat.empresa.com/chat/...   (site em https://empresa.com)
```

Agora é requisição **entre sites**. `SameSite=Strict` faria o cookie nunca ser
enviado e o chat simplesmente não funcionaria. É preciso:

```bash
CHAT_ENTRE_SITES=1      # liga SameSite=None; Secure
CHAT_ORIGENS=https://empresa.com,https://outra.empresa.com
```

E aí **CSRF volta a ser possível** — a defesa passa a depender inteiramente do
token de dupla submissão e da lista de origens, que no arranjo A eram reforço.

**Use B quando:** o hospedeiro não é Node, ou vários sites diferentes
compartilham **um** chat.

Modelo de nginx: [`../nginx/chat.exemplo.conf`](../nginx/chat.exemplo.conf).

---

## Passo a passo (o serviço do chat)

### 1. Código e dependências

```bash
cd /var/www/projetos
git clone <repo> LA-Chat && cd LA-Chat
npm ci --omit=dev
```

### 2. Segredos — **um valor por chave**

```bash
install -o root -g deploy -m 640 /dev/null /etc/lachat.env

for v in CHAT_SEGREDO_PASSE CHAT_SEGREDO_BUSCA CHAT_DADOS_CHAVE; do
  echo "$v=$(openssl rand -base64 32)" >> /etc/lachat.env
done

cat >> /etc/lachat.env <<'FIM'
CHAT_ORIGENS=https://site-do-cliente.com
CHAT_BANCO=sqlite
# CONTE OS SALTOS até o chat:
#   navegador -> nginx -> chat                       = 1
#   navegador -> nginx -> site (conector) -> chat    = 2   <- ARRANJO A
CHAT_PROXIES=2
NODE_ENV=production
FIM
```

> **O valor certo para o arranjo A é 2.** Com 1, o chat enxerga o conector e
> todo visitante vira `127.0.0.1`: o limitador conta a empresa inteira como um
> endereço só e a auditoria grava o mesmo hash para todos. Nada quebra
> visivelmente — por isso o serviço passou a avisar no log quando detecta o
> sintoma, e o `verificar.sh` confere.

> **Nunca reaproveite o mesmo valor nos três.** Eles protegem coisas diferentes
> e precisam poder ser trocados em separado — reaproveitar faz um vazamento
> entregar as três capacidades de uma vez. O `verificar.sh` confere isso.

> **`CHAT_DADOS_CHAVE` é o histórico.** Perdê-la é perder todas as mensagens.
> Guarde-a junto do backup, mas **nunca dentro dele** — senão o backup cifrado
> carrega a própria chave, e a cifragem deixa de proteger.

### 3. Banco

```bash
sudo -u deploy env $(cat /etc/lachat.env | xargs) npm run migrar
npm run migrar:status
```

### 4. Serviço

```bash
sed -e 's#__DESTINO__#/var/www/projetos/LA-Chat#g' \
    -e 's#__USUARIO__#deploy#g' -e 's#__GRUPO__#deploy#g' \
    -e 's#__PORTA__#5197#g' nginx/lachat.service \
  > /etc/systemd/system/lachat.service

systemctl daemon-reload
systemctl enable --now lachat
systemctl status lachat --no-pager
```

### 5. nginx — **o passo que mais se esquece**

```bash
cp nginx/lachat-upgrade.conf /etc/nginx/conf.d/
nginx -t && systemctl reload nginx
```

> Sem o `map` de Upgrade, o chat carrega, autentica, mostra as conversas e
> **nunca recebe mensagem em tempo real**. Nada aparece quebrado. O sintoma é
> "às vezes não chega", que é o pior tipo de defeito para diagnosticar.

No **arranjo A** o `map` basta — o repasse é do conector. No **arranjo B**,
instale também o bloco de site.

### 6. Conferir

```bash
./verificar.sh https://site-do-cliente.com
```

---

## Conferência final

- [ ] `systemctl status lachat` ativo
- [ ] `/etc/lachat.env` com modo **640** e dono `root:deploy`
- [ ] os três segredos **diferentes** entre si
- [ ] `CHAT_ORIGENS` preenchida (vazia = recusa todo mundo)
- [ ] `CHAT_PROXIES` bate com o número real de proxies
- [ ] `map` de Upgrade em `/etc/nginx/conf.d/`
- [ ] `proxy_read_timeout` alongado (o padrão de 60 s derruba o socket)
- [ ] o conector instalado no site, com **as duas linhas**
- [ ] `CHAT_SEGREDO_PASSE` idêntico nos dois lados
- [ ] `./verificar.sh` sem erros
- [ ] duas janelas anônimas conversando de verdade

---

## Atualizar

```bash
git pull && npm ci --omit=dev && npm run migrar
systemctl restart lachat
```

O cliente (`publico/la-chat.js`) é servido com `no-cache` + ETag: a correção
chega no próximo carregamento de página, sem ninguém recopiar arquivo nenhum
para os sites hospedeiros.

**Não use `pkill node` para reiniciar.** Todos os projetos deste parque rodam
`node server.js` com o mesmo usuário — `pkill` derrubaria os sites vizinhos. Já
aconteceu. Use `systemctl restart lachat`.
