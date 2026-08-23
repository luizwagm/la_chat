#!/usr/bin/env bash
# ==========================================================================
#  ensaiar.sh — roda o deploy INTEIRO sem servidor
#
#      ./ci/ensaiar.sh
#
#  ==========================================================================
#  POR QUE ISTO EXISTE
#
#  A primeira versão do `deploy.sh` foi entregue sem nunca ter rodado do começo
#  ao fim. O erro apareceu no servidor do cliente, num passo que só acontece lá
#  — e diagnosticar de longe custou uma ida e volta.
#
#  Aqui o script roda de verdade, num diretório temporário, com DUBLÊS de
#  `systemctl`, `nginx`, `sudo` e `curl`. O que se prova:
#
#    · o fluxo chega ao fim, na ordem certa;
#    · o arquivo de ambiente sai com as chaves e os caminhos da instância;
#    · duas instâncias convivem sem se pisar;
#    · `--atualizar-todas` DESCOBRE as instâncias existentes;
#    · reinstalar NÃO regenera a chave (o pior estrago possível);
#    · a migração cria o banco daquela instância.
#
#  O que ele NÃO prova, e é honesto dizer: que o systemd sobe o serviço e que a
#  porta responde. Isso só o servidor responde — por isso a instalação real
#  termina com `verificar.sh`.
# ==========================================================================
set -uo pipefail

AQUI="$(cd "$(dirname "$0")/.." && pwd)"
RAIZ="$(mktemp -d)"
export PATH="$RAIZ/bin:$PATH"
mkdir -p "$RAIZ/bin" "$RAIZ/etc/nginx/conf.d" "$RAIZ/etc/systemd/system" \
         "$RAIZ/var/www/projetos" "$RAIZ/var/lib/lachat"

ok=0; falha=0
verde()   { printf "  \033[32m✓\033[0m %s\n" "$1"; ok=$((ok+1)); }
vermelho(){ printf "  \033[31m✗\033[0m %s\n" "$1"; falha=$((falha+1)); }
secao()   { printf "\n  \033[1m%s\033[0m\n" "$1"; }

# --- dublês ---------------------------------------------------------------
for prog in systemctl nginx; do
  printf '#!/usr/bin/env bash\nexit 0\n' > "$RAIZ/bin/$prog"
done
printf '#!/usr/bin/env bash\necho 200\n' > "$RAIZ/bin/curl"
printf '#!/usr/bin/env bash\nexit 0\n' > "$RAIZ/bin/chown"
printf '#!/usr/bin/env bash\necho "[npm] $*" >/dev/null\nexit 0\n' > "$RAIZ/bin/npm"
# `sudo -u X -E cmd` e `sudo cmd`: descarta as opções e roda direto.
cat > "$RAIZ/bin/sudo" <<'FIM'
#!/usr/bin/env bash
while [ $# -gt 0 ]; do case "$1" in -u) shift 2;; -E) shift;; *) break;; esac; done
exec "$@"
FIM
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
chmod +x "$RAIZ"/bin/*

# --- o "servidor" ---------------------------------------------------------
DEST="$RAIZ/var/www/projetos/LA-Chat"
mkdir -p "$DEST"
cp -r "$AQUI/." "$DEST/" 2>/dev/null
rm -rf "$DEST/.git" "$DEST/dados"
[ -d "$AQUI/node_modules" ] && ln -sfn "$AQUI/node_modules" "$DEST/node_modules"

rodar() {
  ( cd "$DEST" && DESTINO="$DEST" ETC="$RAIZ/etc" UNIDADES="$RAIZ/etc/systemd/system" \
      DADOS_BASE="$RAIZ/var/lib/lachat" USUARIO="$(/usr/bin/id -un)" GRUPO="$(/usr/bin/id -gn)" \
      bash deploy.sh "$@" )
}

echo ""
echo "  LA Chat — ensaio do deploy"
echo "  ─────────────────────────────────────────────"

# ==========================================================================
secao "1. instalar a instância 'bemestar'"
# ==========================================================================
if rodar bemestar 6185 https://bemestarclinic.com >"$RAIZ/saida1" 2>&1; then
  verde "o deploy chegou ao fim"
else
  vermelho "o deploy falhou:"; sed 's/^/      /' "$RAIZ/saida1" | tail -20
fi

AMB="$RAIZ/etc/lachat-bemestar.env"
[ -f "$AMB" ] && verde "criou $AMB" || vermelho "NÃO criou o arquivo de ambiente"
grep -q "^PORT=6185$" "$AMB" 2>/dev/null && verde "porta 6185" || vermelho "porta errada"
grep -q "^CHAT_ORIGENS=https://bemestarclinic.com$" "$AMB" 2>/dev/null \
  && verde "origem do cliente" || vermelho "origem não gravada"

# O ENDEREÇO DO CONVITE. Sem CHAT_BASE o link de reunião sai apontando para
# 127.0.0.1 — e o defeito só aparece na mão de quem RECEBE o convite, que é
# a pessoa mais distante de quem poderia diagnosticá-lo.
grep -q "^CHAT_BASE=https://bemestarclinic.com$" "$AMB" 2>/dev/null \
  && verde "CHAT_BASE público — o link de reunião abre fora do servidor" \
  || vermelho "CHAT_BASE não gravado: o convite sairia com 127.0.0.1"

# O vídeo nasce DESLIGADO, com as instruções ao lado. Ligar sem TURN entrega
# um recurso que falha justamente em rede corporativa, que é onde o cliente
# vai testar.
grep -q "^# CHAT_VIDEO=1$" "$AMB" 2>/dev/null \
  && verde "vídeo desligado, com as instruções de como ligar" \
  || vermelho "o bloco de vídeo não foi escrito no ambiente"
grep -q "^CHAT_SQLITE=$RAIZ/var/lib/lachat/bemestar/chat.db$" "$AMB" 2>/dev/null \
  && verde "banco FORA da árvore do código" || vermelho "caminho do banco errado"
for chave in CHAT_SEGREDO_PASSE CHAT_SEGREDO_BUSCA CHAT_DADOS_CHAVE; do
  grep -q "^$chave=.\{20,\}" "$AMB" 2>/dev/null \
    && verde "$chave gerada" || vermelho "$chave ausente ou curta"
done
[ -f "$RAIZ/etc/systemd/system/lachat@.service" ] \
  && verde "unit de molde instalada" || vermelho "unit não instalada"
[ -f "$RAIZ/etc/nginx/conf.d/lachat-upgrade.conf" ] \
  && verde "map do Upgrade no nginx" || vermelho "map do Upgrade NÃO instalado"

# ==========================================================================
secao "2. o banco daquela instância"
# ==========================================================================
BD="$RAIZ/var/lib/lachat/bemestar/chat.db"
if [ -f "$BD" ]; then
  TAB="$(node "$AQUI/ci/contar-tabelas.js" "$BD" 2>/dev/null || echo 0)"
  [ "${TAB:-0}" -gt 5 ] && verde "chat.db criado com $TAB tabelas" \
                        || vermelho "chat.db existe mas só tem $TAB tabela(s)"
else
  vermelho "a migração não criou o banco"
fi

# ==========================================================================
secao "3. uma SEGUNDA instância, sem pisar na primeira"
# ==========================================================================
rodar bordatudo 6193 https://bordatudo.com.br >"$RAIZ/saida2" 2>&1
[ -f "$RAIZ/etc/lachat-bordatudo.env" ] && verde "segunda instância criada" \
  || { vermelho "segunda instância falhou:"; tail -10 "$RAIZ/saida2" | sed 's/^/      /'; }
[ -f "$RAIZ/var/lib/lachat/bordatudo/chat.db" ] \
  && verde "com banco PRÓPRIO" || vermelho "sem banco próprio"

P1="$(grep '^CHAT_DADOS_CHAVE=' "$AMB")"
P2="$(grep '^CHAT_DADOS_CHAVE=' "$RAIZ/etc/lachat-bordatudo.env")"
[ "$P1" != "$P2" ] && verde "chaves DIFERENTES entre as instâncias" \
                   || vermelho "as duas instâncias compartilham a chave (!!)"

# ==========================================================================
secao "4. --atualizar-todas descobre as instâncias"
# ==========================================================================
SAIDA="$(rodar --atualizar-todas 2>&1)"
echo "$SAIDA" | grep -q "Instância bemestar"  && verde "achou bemestar"  || vermelho "não achou bemestar"
echo "$SAIDA" | grep -q "Instância bordatudo" && verde "achou bordatudo" || vermelho "não achou bordatudo"

# ==========================================================================
secao "5. reinstalar NÃO regenera a chave"
# ==========================================================================
# É o pior estrago que este script poderia causar: uma chave nova torna
# ilegível todo o histórico de conversas daquele cliente.
ANTES="$(grep '^CHAT_DADOS_CHAVE=' "$AMB")"
rodar bemestar 6185 https://bemestarclinic.com >/dev/null 2>&1
DEPOIS="$(grep '^CHAT_DADOS_CHAVE=' "$AMB")"
[ "$ANTES" = "$DEPOIS" ] && verde "a chave foi preservada" \
                         || vermelho "A CHAVE MUDOU — isso apagaria o histórico"

# ==========================================================================
# ==========================================================================
secao "6. o verificar.sh sabe LER o ambiente que o deploy escreveu"
# ==========================================================================
# Uma instalação CORRETA acusada de estar pela metade custa mais que uma
# checagem ausente: manda a pessoa procurar defeito onde não há. Foi o que
# aconteceu com o padrão `^CHAT_BASE=K.*` — a barra invertida do \K comida
# pelo shell fez o padrão procurar a letra K, nunca casar, e o relatório
# acusar CHAT_BASE ausente numa instância onde ele estava configurado.
#
# A função é EXTRAÍDA do verificar.sh de verdade, e não copiada para cá: uma
# cópia divergiria do original exatamente no dia em que isso importasse.
AMB_TESTE="$RAIZ/etc/lachat-bemestar.env"
{
  echo "  CHAT_VIDEO=1"
  echo "export CHAT_TURN_SEGREDO=zzqa"
  echo "CHAT_STUN=\"stun:chat.exemplo:3478\""
  printf "CHAT_COM_CR=https://x.com\r\n"
} >> "$AMB_TESTE"

eval "$(sed -n '/^valor_de() {/,/^}/p' "$AQUI/verificar.sh")"
AMBIENTE_ARQ="$AMB_TESTE"

[ "$(valor_de CHAT_BASE)" = "https://bemestarclinic.com" ] \
  && verde "lê o CHAT_BASE que o deploy gravou" \
  || vermelho "NÃO lê CHAT_BASE — o relatório acusaria uma instalação correta"
[ "$(valor_de PORT)" = "6185" ] && verde "e a porta" || vermelho "não lê a porta"
[ "$(valor_de CHAT_VIDEO)" = "1" ] && verde "com espaço antes do nome" || vermelho "engasga com espaço antes"
[ "$(valor_de CHAT_TURN_SEGREDO)" = "zzqa" ] && verde "com export na frente" || vermelho "engasga com export"
[ "$(valor_de CHAT_STUN)" = "stun:chat.exemplo:3478" ] && verde "tirando as aspas" || vermelho "deixa as aspas no valor"
[ "$(valor_de CHAT_COM_CR)" = "https://x.com" ] && verde "tolerando fim de linha do Windows" || vermelho "engasga com CRLF"
[ -z "$(valor_de NAO_EXISTE)" ] && verde "e devolve vazio para o que não existe" || vermelho "inventa valor"

rm -rf "$RAIZ"
echo ""
echo "  ─────────────────────────────────────────────"
if [ "$falha" -gt 0 ]; then
  printf "  \033[31m✖ %d passaram, %d falharam\033[0m\n\n" "$ok" "$falha"
  exit 1
fi
printf "  \033[32m✔ %d/%d — o deploy roda do começo ao fim\033[0m\n\n" "$ok" "$ok"
