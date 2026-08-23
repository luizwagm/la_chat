#!/usr/bin/env bash
# ==========================================================================
#  ensaiar-relay.sh — roda o `criar-relay.sh` INTEIRO sem servidor
#
#      ./ci/ensaiar-relay.sh
#
#  ==========================================================================
#  POR QUE ISTO EXISTE
#
#  O relay é a peça mais sensível do vídeo: é ele que recebe credencial de todo
#  portador de um link de reunião. Um `denied-peer-ip` que não foi escrito, um
#  `no-cli` esquecido, um gancho de renovação ausente — nada disso dá erro na
#  hora. Dá erro meses depois, no servidor de um cliente.
#
#  Aqui o script roda de verdade, num diretório temporário, com DUBLÊS de
#  `certbot`, `nginx`, `systemctl`, `apt-get`, `ufw` e `dig`. O que se prova:
#
#    · o fluxo chega ao fim, na ordem certa;
#    · o `turnserver.conf` sai com TODAS as travas de rede;
#    · o segredo é gerado uma vez e PRESERVADO na segunda execução;
#    · o gancho de renovação é escrito e é executável;
#    · o vhost serve a ACME e mais nada.
#
#  A mesma razão do `ci/ensaiar.sh`, e a mesma lição: a primeira versão do
#  `deploy.sh` foi entregue sem nunca ter rodado do começo ao fim.
# ==========================================================================
set -uo pipefail

AQUI="$(cd "$(dirname "$0")/.." && pwd)"
RAIZ="$(mktemp -d)"
export PATH="$RAIZ/bin:$PATH"
mkdir -p "$RAIZ/bin" "$RAIZ/etc/nginx/sites-available" "$RAIZ/etc/nginx/sites-enabled" \
         "$RAIZ/etc/default" "$RAIZ/etc/letsencrypt" "$RAIZ/var/www/html" \
         "$RAIZ/var/log/nginx"

ok=0; falha=0
verde()   { printf "  \033[32m✓\033[0m %s\n" "$1"; ok=$((ok+1)); }
vermelho(){ printf "  \033[31m✗\033[0m %s\n" "$1"; falha=$((falha+1)); }
secao()   { printf "\n  \033[1m%s\033[0m\n" "$1"; }

# --- dublês ---------------------------------------------------------------
for prog in systemctl nginx ufw usermod groupadd chgrp turnserver; do
  printf '#!/usr/bin/env bash\nexit 0\n' > "$RAIZ/bin/$prog"
done

# `dig +short <tipo> <dominio>` → devolve sempre o IP do "servidor".
printf '#!/usr/bin/env bash\necho 203.0.113.10\n' > "$RAIZ/bin/dig"
# `curl ... ifconfig.me` → o mesmo IP. E `ip` não devolve nada (sem NAT).
printf '#!/usr/bin/env bash\necho 203.0.113.10\n' > "$RAIZ/bin/curl"
printf '#!/usr/bin/env bash\nexit 0\n' > "$RAIZ/bin/ip"

# O certbot só cria a árvore de arquivos que ele criaria.
cat > "$RAIZ/bin/certbot" <<FIM
#!/usr/bin/env bash
if [ "\${1:-}" = "renew" ]; then exit 0; fi
d=""
while [ \$# -gt 0 ]; do case "\$1" in -d) d="\$2"; shift 2;; *) shift;; esac; done
mkdir -p "$RAIZ/etc/letsencrypt/live/\$d" "$RAIZ/etc/letsencrypt/archive/\$d"
: > "$RAIZ/etc/letsencrypt/live/\$d/fullchain.pem"
: > "$RAIZ/etc/letsencrypt/live/\$d/privkey.pem"
exit 0
FIM

printf '#!/usr/bin/env bash\nexit 0\n' > "$RAIZ/bin/apt-get"
# `ss` finge que o coturn está escutando.
printf '#!/usr/bin/env bash\necho "udp UNCONN 0 0 0.0.0.0:3478 0.0.0.0:*"\necho "tcp LISTEN 0 0 0.0.0.0:5349 0.0.0.0:*"\n' > "$RAIZ/bin/ss"
# Finge root sem ser root.
cat > "$RAIZ/bin/id" <<'FIM'
#!/usr/bin/env bash
[ "${1:-}" = "-u" ] && { echo 0; exit 0; }
exec /usr/bin/id "$@"
FIM
# `install -o X -g Y -m M /dev/null ARQUIVO` → só cria o arquivo.
cat > "$RAIZ/bin/install" <<'FIM'
#!/usr/bin/env bash
for a in "$@"; do alvo="$a"; done
: > "$alvo"
FIM
# `getent group ssl-cert` → não existe, força o groupadd.
printf '#!/usr/bin/env bash\nexit 2\n' > "$RAIZ/bin/getent"
chmod +x "$RAIZ"/bin/*

DOMINIO="chat.zzqa.exemplo"

rodar() {
  ( cd "$AQUI" && \
    ETC="$RAIZ/etc" WEBROOT="$RAIZ/var/www/html" LE="$RAIZ/etc/letsencrypt" \
    LOGS="$RAIZ/var/log" \
    bash criar-relay.sh "$DOMINIO" "qa@exemplo.com" )
}

printf "\n  \033[1mEnsaio do criar-relay.sh\033[0m\n"
printf "  sandbox: %s\n" "$RAIZ"

# ==========================================================================
secao "1. a primeira instalação"
# ==========================================================================
SAIDA="$(rodar 2>&1)"
CODIGO=$?
if [ "$CODIGO" -eq 0 ]; then verde "o script chegou ao fim"
else vermelho "o script falhou (código $CODIGO)"; echo "$SAIDA" | tail -20 | sed 's/^/       /'; fi

CONF="$RAIZ/etc/turnserver.conf"
[ -f "$CONF" ] && verde "criou $CONF" || vermelho "NÃO criou o turnserver.conf"

# ==========================================================================
secao "2. as travas de rede — o coração deste ensaio"
# ==========================================================================
# Sem elas, quem tem um convite de reunião alcança a rede interna do servidor,
# onde escutam TODOS os outros sites do parque.
for regra in no-loopback-peers no-multicast-peers no-cli use-auth-secret fingerprint; do
  grep -q "^$regra" "$CONF" 2>/dev/null && verde "$regra" || vermelho "$regra AUSENTE"
done

NEG=$(grep -c '^denied-peer-ip' "$CONF" 2>/dev/null || echo 0)
[ "$NEG" -ge 8 ] && verde "$NEG faixas privadas negadas" \
                 || vermelho "só $NEG faixas negadas (esperava 8+)"

grep -q '^denied-peer-ip=10\.' "$CONF" 2>/dev/null && verde "a faixa 10/8" || vermelho "faltou a 10/8"
grep -q '^denied-peer-ip=192\.168' "$CONF" 2>/dev/null && verde "a faixa 192.168/16" || vermelho "faltou a 192.168/16"
grep -q '^denied-peer-ip=fc00' "$CONF" 2>/dev/null && verde "as privadas de IPv6 (fc00::/7)" \
  || vermelho "faltou IPv6 — o buraco reabre inteiro numa máquina com IPv6"

grep -q "^external-ip=203.0.113.10" "$CONF" 2>/dev/null && verde "external-ip descoberto" \
  || vermelho "external-ip errado ou ausente"
grep -q "^realm=$DOMINIO" "$CONF" 2>/dev/null && verde "realm do domínio" || vermelho "realm ausente"

# Segredo fixo é o erro clássico do coturn: a credencial vai para o navegador.
grep -q '^user=' "$CONF" 2>/dev/null && vermelho "há usuário FIXO no conf — a credencial vazaria para sempre" \
  || verde "nenhum usuário fixo (só credencial temporária)"

# ==========================================================================
secao "3. o segredo"
# ==========================================================================
SEG_ARQ="$RAIZ/etc/lachat-relay.env"
[ -f "$SEG_ARQ" ] && verde "guardou o segredo em $(basename "$SEG_ARQ")" || vermelho "não guardou o segredo"
SEGREDO1="$(grep -oP '^CHAT_TURN_SEGREDO=\K.*' "$SEG_ARQ" 2>/dev/null)"
[ ${#SEGREDO1} -ge 40 ] && verde "com 32 bytes em base64" || vermelho "segredo curto demais: ${#SEGREDO1}"

CONF_SEG="$(grep -oP '^static-auth-secret=\K.*' "$CONF" 2>/dev/null)"
[ "$CONF_SEG" = "$SEGREDO1" ] && verde "e o coturn usa EXATAMENTE o mesmo" \
  || vermelho "o segredo do coturn não bate com o guardado — o vídeo não conectaria"

# ==========================================================================
secao "4. o gancho de renovação — a armadilha de 90 dias"
# ==========================================================================
HOOK="$RAIZ/etc/letsencrypt/renewal-hooks/deploy/10-coturn.sh"
[ -f "$HOOK" ] && verde "o gancho foi instalado" || vermelho "SEM gancho: em 90 dias o relay serviria certificado vencido"
[ -x "$HOOK" ] && verde "e é executável" || vermelho "o gancho não é executável — o certbot o ignoraria"
grep -q 'systemctl restart coturn' "$HOOK" 2>/dev/null && verde "e reinicia o coturn" \
  || vermelho "o gancho não reinicia o coturn"

# ==========================================================================
secao "5. o vhost serve a ACME, e mais nada"
# ==========================================================================
VHOST="$RAIZ/etc/nginx/sites-available/$DOMINIO"
[ -f "$VHOST" ] && verde "criou o vhost" || vermelho "não criou o vhost"
grep -q 'acme-challenge' "$VHOST" 2>/dev/null && verde "com o caminho da ACME" || vermelho "sem o caminho da ACME"
grep -q 'return 404' "$VHOST" 2>/dev/null && verde "e 404 para todo o resto" \
  || vermelho "o vhost responde algo além da ACME"
grep -q 'proxy_pass' "$VHOST" 2>/dev/null && vermelho "o vhost repassa para alguma aplicação — não deveria" \
  || verde "não repassa para lugar nenhum"
# `-e` e nao `-L`: no Git Bash do Windows, onde este ensaio as vezes roda,
# `ln -sf` COPIA em vez de criar link simbolico. O que importa provar e que o
# vhost foi HABILITADO — e no servidor, que e Linux, o link e link.
[ -e "$RAIZ/etc/nginx/sites-enabled/$DOMINIO" ] && verde "e está em sites-enabled" \
  || vermelho "não foi ligado em sites-enabled"

# ==========================================================================
secao "6. rodar de novo NÃO regenera o segredo"
# ==========================================================================
# Regenerar derrubaria o vídeo de todos os clientes ao mesmo tempo, com um erro
# que o navegador reporta como "falha de rede".
rodar >/dev/null 2>&1
SEGREDO2="$(grep -oP '^CHAT_TURN_SEGREDO=\K.*' "$SEG_ARQ" 2>/dev/null)"
[ "$SEGREDO1" = "$SEGREDO2" ] && verde "o segredo foi preservado" \
  || vermelho "o segredo MUDOU — derrubaria o vídeo de todos os clientes"

CONF_SEG2="$(grep -oP '^static-auth-secret=\K.*' "$CONF" 2>/dev/null)"
[ "$CONF_SEG2" = "$SEGREDO1" ] && verde "e o coturn continua com ele" || vermelho "o coturn ficou com outro segredo"

# ==========================================================================
rm -rf "$RAIZ"
printf "\n  ─────────────────────────────────────────────\n"
if [ "$falha" -eq 0 ]; then
  printf "  \033[32m✔ %d/%d — o relay é instalável do começo ao fim\033[0m\n\n" "$ok" "$((ok+falha))"
  exit 0
fi
printf "  \033[31m✖ %d de %d falharam\033[0m\n\n" "$falha" "$((ok+falha))"
exit 1
