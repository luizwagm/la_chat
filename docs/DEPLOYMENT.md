# DEPLOYMENT.md

Instalação passo a passo: **[INSTALLATION.md](INSTALLATION.md)**.
Este arquivo trata do que roda **depois** da primeira subida.

---

## As duas armadilhas que custam uma tarde

### 1. `MemoryDenyWriteExecute` mata o Node

Ele proíbe o processo de tornar executável uma página de memória que ele mesmo
escreveu — que é **exatamente** o que o V8 faz para compilar JavaScript.

O Node não avisa: derruba o processo com `V8_Fatal`, e o systemd registra
`status=5/TRAP`, `core-dump`. Pior: a queda **não é na partida** — vem quando o
compilador sobe a primeira função de nível, alguns segundos depois. Parece erro
de rede ou de banco.

A unit deste projeto já não tem a linha. **Não a acrescente** "para endurecer".

### 2. `nginx -t` aprova bloco que o nginx não carrega

O `-t` valida a **sintaxe**. Ele não diz se o arquivo está sendo **incluído**
(link ausente em `sites-enabled`, `include` que não casa com o nome).

Use sempre:

```bash
nginx -T | grep -A8 'location /chat/ws'
```

---

## Atualizar

```bash
cd /var/www/projetos/LA-Chat
git pull
npm ci --omit=dev
npm run migrar
systemctl restart lachat
./verificar.sh https://site-do-cliente.com
```

O reinício derruba os sockets abertos; os clientes reconectam sozinhos, com
recuo exponencial **e ruído** — o ruído é o que impede que toda a empresa
reconecte no mesmo milissegundo e derrube o serviço que acabou de subir.

**As sessões sobrevivem ao deploy** (ficam no banco, com o token em hash).
Ninguém precisa entrar de novo.

**Nunca `pkill node`.** Todos os projetos do parque rodam `node server.js` com o
mesmo usuário — `pkill` derrubaria os sites vizinhos. Já aconteceu neste parque.

---

## Backup

Três coisas, e as três importam:

```bash
#!/usr/bin/env bash
set -euo pipefail
DESTINO=/var/backups/lachat/$(date +%F)
mkdir -p "$DESTINO"

# 1. o banco — com a API do SQLite, NUNCA com `cp`.
#    Copiar o arquivo com o WAL ativo produz um backup silenciosamente
#    corrompido: o `.db` é copiado sem as escritas que ainda estão no `-wal`.
sqlite3 /var/www/projetos/LA-Chat/dados/chat.db ".backup '$DESTINO/chat.db'"
#    (com CHAT_BANCO=pg:  pg_dump -Fc lachat > "$DESTINO/lachat.dump")

# 2. os anexos
tar czf "$DESTINO/arquivos.tgz" -C /var/www/projetos/LA-Chat/dados arquivos

# 3. a CHAVE — em outro lugar. Ver abaixo.
```

> **A `CHAT_DADOS_CHAVE` não vai dentro do backup.**
>
> Sem ela, restaurar devolve um banco íntegro em que todo o conteúdo sai
> `[protegido]`. Com ela **dentro** do backup, o backup cifrado carrega a
> própria chave — e a cifragem deixa de proteger exatamente no cenário para o
> qual ela existe (o arquivo vazado).
>
> Guarde-a em gerenciador de senhas ou cofre, e **teste a restauração** antes de
> precisar dela.

---

## Observabilidade (§44)

### Health check

```bash
curl -s http://127.0.0.1:5197/chat/saude
{"ok":true,"versao":"0.1.0","banco":"ok","storage":"ok","realtime":"ok"}
```

Ele diz se cada peça responde e **nada além disso**: sem versão de biblioteca,
sem caminho de arquivo, sem nome de banco, sem contagem de usuários. Health
check detalhado é reconhecimento gratuito para quem procura alvo.

Devolve **503** quando alguma peça falha — é o que um monitor externo precisa.

### Logs

```bash
journalctl -u lachat -f
journalctl -u lachat --since "1 hour ago" | grep '✖'
```

O detalhe técnico é **escondido por padrão** (§57). Para ligá-lo:

```bash
systemctl set-environment CHAT_DEBUG=1 && systemctl restart lachat
# e desligue depois: systemctl unset-environment CHAT_DEBUG
```

### Auditoria

```sql
SELECT evento, COUNT(*) FROM auditoria
 WHERE criado_em > (strftime('%s','now') - 86400) * 1000
 GROUP BY evento ORDER BY 2 DESC;
```

Sinais que merecem atenção:

| Evento em volume | O que investigar |
|---|---|
| `PASSE_RECUSADO` | segredo divergente entre os lados, ou alguém tentando forjar |
| `ORIGEM_RECUSADA` | `CHAT_ORIGENS` incompleta, ou tentativa de CSWSH |
| `ARQUIVO_RECUSADO` | uploads maliciosos, ou lista branca apertada demais |
| `LIMITE_ATINGIDO` | `CHAT_PROXIES` errado para mais (todos viram o mesmo IP) |

### Integração com o LA Sentinela

O chat pode ser monitorado como qualquer outro site do parque: copie
`lasentinela.js` para a raiz e conte as requisições no topo do handler. O chat
**não** traz o conector embutido — quem instala decide se quer.

---

## Retenção (§34)

```bash
CHAT_RETENCAO_DIAS=0      # padrão: guardar para sempre
CHAT_AUDIT_DIAS=365
```

A retenção de mensagens vem **desligada** de propósito: apagar histórico é
decisão do cliente, com implicação jurídica, e nunca deve acontecer por padrão
do software. Ligá-la exige decisão escrita — e validação por profissional
competente.

---

## Escalar

Enquanto for **um processo**, funciona: presença e fan-out vivem na memória
dele.

Para dois ou mais:

1. `CHAT_BANCO=pg` (o SQLite não serve a múltiplos processos escrevendo);
2. implementar `Transporte.publicar()` sobre `LISTEN`/`NOTIFY` do PostgreSQL —
   o ponto de extensão está isolado ali, e nada acima dele muda;
3. `ip_hash` no balanceador não é necessário: o bilhete e a sessão vivem no
   banco, então qualquer processo atende qualquer conexão.

O que **já** está pronto para esse dia: `seq` vindo do banco, presença por
`expira_em`, sessões persistidas, e nenhum estado de negócio na memória.

---

## Portas do parque

`5180`–`5197` estão em uso. O chat é a **5197**. Confira antes de instalar um
segundo chat na mesma máquina:

```bash
ss -lptn | grep -E ':51[89][0-9]'
```
