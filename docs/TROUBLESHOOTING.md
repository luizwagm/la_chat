# TROUBLESHOOTING.md — sintoma → causa

Comece sempre por aqui:

```bash
./verificar.sh https://site-do-cliente.com
journalctl -u lachat -n 80 --no-pager
```

E quando precisar de detalhe técnico nos logs (ele é escondido de propósito):

```bash
systemctl set-environment CHAT_DEBUG=1 && systemctl restart lachat
```

---

## O chat não aparece

| Verifique | Como |
|---|---|
| O `<script>` entrou no HTML? | veja o código-fonte da página |
| O script carregou? | aba Rede: `/chat/cliente.js` deve dar **200** |
| `usuario()` devolveu alguém? | `curl -s https://site/chat/passe -H "Cookie: <seu cookie>"` |

Se `/chat/passe` devolve **401**, o site não reconheceu a sessão — o problema
está na função `usuario()` do conector, não no chat.

---

## "Não foi possível abrir o chat"

Quase sempre: **`CHAT_SEGREDO_PASSE` diferente entre os dois lados.**

```bash
grep CHAT_SEGREDO_PASSE /etc/lachat.env /etc/site-do-cliente.env
```

Os dois valores têm de ser **idênticos**, byte a byte. Cuidado com aspas e com
quebra de linha colada no fim.

Outras causas, na ordem: relógio dos servidores dessincronizado em mais de 60 s
(`timedatectl`), ou o passe sendo cacheado em algum lugar (ele sai com
`no-store`; um proxy que ignore isso o transformaria num passe reutilizável — e
o segundo uso é recusado, o que aparece como "já foi usado").

---

## Carrega, mas a mensagem só chega ao apertar F5

**O tempo real não está funcionando.** Em ordem de probabilidade:

### 1. Falta `chat.conectarUpgrade(servidor)` no site

A causa número um. `upgrade` é um evento **separado** do fluxo de requisição —
ele não passa por `chat.rota()`. Sem essa linha, tudo funciona menos o socket.

### 2. Falta o `map` de Upgrade no nginx

```bash
nginx -T | grep -c conexao_upgrade      # tem de ser > 0
```

Use **`nginx -T`**, não `nginx -t`. O `-t` só valida a sintaxe; o `-T` mostra o
que o nginx **realmente carregou** — é a única forma de descobrir que o arquivo
que você editou não está sendo incluído. Já aconteceu neste parque: `nginx -t`
aprovou um bloco que o nginx nem carregava.

```bash
cp nginx/lachat-upgrade.conf /etc/nginx/conf.d/ && nginx -t && systemctl reload nginx
```

### 3. Confirme direto no aperto de mão

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  https://site-do-cliente.com/chat/ws
```

| Resposta | Significa |
|---|---|
| **401** | correto — o `/ws` existe e recusa sem bilhete |
| **404** | o nginx (ou o conector) não está repassando o `/ws` |
| **200** | algo está respondendo no lugar do chat |

---

## Fica "Reconectando…" sem parar

**`proxy_read_timeout` no padrão de 60 s.** O socket fica minutos sem tráfego
quando ninguém digita; com 60 s, o nginx o derruba em silêncio e o cliente
reconecta a cada minuto.

```nginx
location /chat/ws {
    proxy_read_timeout 7d;
    proxy_send_timeout 7d;
    proxy_buffering off;
}
```

Outras causas: `CHAT_ORIGENS` sem a origem exata do site (confira protocolo e
porta — `https://site.com` ≠ `http://site.com`), ou o serviço reiniciando em
laço (`journalctl -u lachat`).

---

## "Origem não autorizada" / o socket é recusado com 403

```bash
grep CHAT_ORIGENS /etc/lachat.env
```

A origem tem de bater **exatamente**: protocolo, domínio e porta. `www.site.com`
e `site.com` são origens diferentes — inclua as duas se o site atende pelas duas.

---

## O limitador está travando gente demais

Sintoma: várias pessoas do mesmo escritório levando **429** ao entrar.

Causa quase certa: **`CHAT_PROXIES` errado para mais**. O chat está lendo o IP
do proxy em vez do IP de cada pessoa, e todo mundo vira o mesmo endereço.

```bash
grep CHAT_PROXIES /etc/lachat.env       # com nginx local, é 1
```

Errar para **menos** é pior e mais silencioso: reabre a falsificação de IP, e o
atacante escolhe qual endereço o limitador pune.

---

## Mensagens antigas aparecem como `[protegido]`

**`CHAT_DADOS_CHAVE` mudou.** O conteúdo continua lá, cifrado com a chave
anterior.

Se você ainda a tem:

```bash
echo "CHAT_DADOS_CHAVE_ANTERIOR=<a chave antiga>" >> /etc/lachat.env
systemctl restart lachat
```

O sistema volta a **ler** o que foi escrito com ela, e continua **escrevendo**
com a atual.

Se a chave se perdeu: **o conteúdo é irrecuperável**. É o comportamento
desejado num backup vazado — e o motivo de a chave precisar ser guardada junto
do backup, mas nunca dentro dele.

---

## A busca não acha uma mensagem que existe

Por ordem:

1. **Só casa palavra inteira.** Não há busca por prefixo nem por trecho — é a
   limitação declarada do índice cego. `orça` não acha `orçamento`.
2. **Palavras com menos de 3 letras e palavras muito comuns** (`de`, `que`,
   `com`) não entram no índice. A tela mostra "Procurando por: …" com as
   palavras que sobraram.
3. **Mensagem apagada some da busca** — de propósito.
4. **`CHAT_SEGREDO_BUSCA` mudou.** Os tokens gravados foram derivados da chave
   antiga e nunca mais vão casar. Não há como reindexar sem decifrar tudo e
   regravar; se precisar trocar essa chave, faça um script de reindexação antes.

---

## O serviço não sobe

```bash
systemctl status lachat --no-pager
journalctl -u lachat -n 50 --no-pager
```

| Mensagem | Causa |
|---|---|
| `✖ LA Chat não pode subir. Falta configuração obrigatória` | leia a lista — ela diz exatamente qual variável falta e como gerá-la |
| `status=5/TRAP`, `core-dump` | **`MemoryDenyWriteExecute` na unit.** Ele mata o V8. Remova a linha |
| `EADDRINUSE` | outro processo na 5197 — `ss -lptn 'sport = :5197'` |
| `ERR_DLOPEN_FAILED` / `invalid ELF header` | `better-sqlite3` compilado para outro Node. `npm rebuild better-sqlite3` |
| `o pacote 'pg' não está instalado` | `npm ci --omit=dev` |

---

## O upload falha

| Sintoma | Causa |
|---|---|
| Página de erro do **nginx**, não do chat | `client_max_body_size` menor que o teto de anexo. Ponha 12m |
| "este tipo de arquivo não é aceito" | não está na lista branca (`CHAT_TIPOS`), ou a extensão é perigosa |
| "o conteúdo do arquivo não corresponde ao tipo informado" | os bytes não batem com o MIME declarado. Costuma ser arquivo renomeado |
| "o conteúdo do arquivo é um programa" | é executável de verdade |
| Trava perto do fim em rede ruim | `proxy_read_timeout` curto no `location /chat/` |

O motivo real de cada recusa fica na **auditoria**, não na tela:

```sql
SELECT criado_em, detalhe FROM auditoria WHERE evento='ARQUIVO_RECUSADO'
 ORDER BY criado_em DESC LIMIT 20;
```

---

## Presença errada

| Sintoma | Causa |
|---|---|
| Pessoa "online" que saiu há horas | o batimento não está chegando — quase sempre `proxy_read_timeout` ou o `map` |
| Status piscando | duas abas abrindo e fechando; a carência de 30 s deve absorver. Se persistir, veja `CHAT_CARENCIA_MS` |
| Todo mundo offline | o socket não conecta — vá para "Fica Reconectando…" |

---

## Diagnóstico rápido

```bash
curl -s http://127.0.0.1:5197/chat/saude          # o serviço está de pé?
ss -lptn 'sport = :5197'                          # quem está na porta
journalctl -u lachat --since "10 min ago"         # o que ele disse
nginx -T | grep -A8 'location /chat/ws'           # o que o nginx carregou
./verificar.sh https://site-do-cliente.com        # tudo de uma vez
```

**Nunca use `pkill node` para reiniciar.** Todos os projetos deste parque rodam
`node server.js` com o mesmo usuário — `pkill` derrubaria os sites vizinhos. Já
aconteceu. Use `systemctl restart lachat`.
