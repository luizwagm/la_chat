#!/usr/bin/env bash
# ==========================================================================
#  verificar.sh — confere a instalação ANTES de o cliente reclamar
#
#      ./verificar.sh                     confere o serviço local
#      ./verificar.sh https://chat.x.com  confere também pelo lado de fora
#
#  Cada checagem aqui existe por causa de um defeito que ACONTECE, e que é
#  difícil de diagnosticar depois. A lista não é genérica.
# ==========================================================================
set -uo pipefail

BASE="${1:-http://127.0.0.1:${PORT:-5197}}"
PREFIXO="${CHAT_PREFIXO:-/chat}"
AMBIENTE_ARQ="${AMBIENTE_ARQ:-/etc/lachat.env}"

ok=0; aviso=0; erro=0
verde()   { printf "  \033[32m✓\033[0m %s\n" "$1"; ok=$((ok+1)); }
amarelo() { printf "  \033[33m!\033[0m %s\n" "$1"; aviso=$((aviso+1)); }
vermelho(){ printf "  \033[31m✗\033[0m %s\n" "$1"; erro=$((erro+1)); }
secao()   { printf "\n  \033[1m%s\033[0m\n" "$1"; }

echo ""
echo "  LA Chat — verificação"
echo "  ─────────────────────────────────────────────"
echo "  Alvo: $BASE$PREFIXO"

# ==========================================================================
secao "1. O serviço responde"
# ==========================================================================
SAUDE="$(curl -fsS --max-time 8 "$BASE$PREFIXO/saude" 2>/dev/null || true)"
if [ -z "$SAUDE" ]; then
  vermelho "o chat não respondeu em $BASE$PREFIXO/saude"
  echo "        systemctl status lachat --no-pager | tail -20"
  echo "        journalctl -u lachat -n 50 --no-pager"
else
  verde "responde"
  case "$SAUDE" in
    *'"banco":"ok"*'|*'"banco":"ok"'*) verde "banco ok" ;;
    *) vermelho "banco NÃO está ok — $SAUDE" ;;
  esac
  case "$SAUDE" in
    *'"storage":"ok"'*) verde "storage ok" ;;
    *) vermelho "storage NÃO está ok — a pasta de anexos existe e é gravável?" ;;
  esac
fi

# ==========================================================================
secao "2. Segredos"
# ==========================================================================
if [ -f "$AMBIENTE_ARQ" ]; then
  MODO="$(stat -c '%a' "$AMBIENTE_ARQ" 2>/dev/null || echo '???')"
  DONO="$(stat -c '%U:%G' "$AMBIENTE_ARQ" 2>/dev/null || echo '?')"
  if [ "$MODO" = "640" ] || [ "$MODO" = "600" ]; then
    verde "$AMBIENTE_ARQ com modo $MODO ($DONO)"
  else
    vermelho "$AMBIENTE_ARQ está com modo $MODO — deveria ser 640"
    echo "        chmod 640 $AMBIENTE_ARQ"
  fi

  for chave in CHAT_SEGREDO_PASSE CHAT_SEGREDO_BUSCA CHAT_DADOS_CHAVE CHAT_ORIGENS; do
    if grep -q "^${chave}=." "$AMBIENTE_ARQ" 2>/dev/null; then
      verde "$chave definida"
    else
      vermelho "$chave AUSENTE ou vazia em $AMBIENTE_ARQ"
    fi
  done

  # Os três segredos precisam ser DIFERENTES. Reaproveitar um valor faz um
  # vazamento entregar as três capacidades de uma vez.
  DISTINTOS="$(grep -E '^CHAT_(SEGREDO_PASSE|SEGREDO_BUSCA|DADOS_CHAVE)=' "$AMBIENTE_ARQ" 2>/dev/null \
    | cut -d= -f2- | sort -u | wc -l)"
  if [ "$DISTINTOS" = "3" ]; then
    verde "os três segredos são diferentes entre si"
  else
    vermelho "há segredos REPETIDOS — gere um valor por chave (openssl rand -base64 32)"
  fi
else
  amarelo "$AMBIENTE_ARQ não existe (normal em desenvolvimento; obrigatório em produção)"
fi

# ==========================================================================
secao "3. Proxies confiáveis — a leitura do IP"
# ==========================================================================
# Ler o PRIMEIRO item de X-Forwarded-For é ler texto do atacante. O número
# precisa bater com quantos proxies existem de verdade na frente.
PROXIES="$(grep -E '^CHAT_PROXIES=' "$AMBIENTE_ARQ" 2>/dev/null | cut -d= -f2- || echo '')"

# Descobre o arranjo pelo que está instalado: se algum site do parque tem o
# conector na raiz, o caminho normal é nginx -> site -> chat, que são 2 saltos.
COM_CONECTOR=0
for d in /var/www/projetos/*/lachat.js; do [ -f "$d" ] && COM_CONECTOR=1 && break; done

if [ -z "$PROXIES" ]; then
  amarelo "CHAT_PROXIES não definida (o padrão é 1)"
elif [ "$PROXIES" = "0" ]; then
  amarelo "CHAT_PROXIES=0 — o chat IGNORA X-Forwarded-For. Certo só se NÃO houver proxy."
elif [ "$COM_CONECTOR" = "1" ] && [ "$PROXIES" = "1" ]; then
  vermelho "CHAT_PROXIES=1 com o CONECTOR instalado — provavelmente ERRADO (deveria ser 2)"
  echo "        navegador -> nginx -> site (conector) -> chat  são DOIS saltos."
  echo "        Com 1, todo visitante vira 127.0.0.1: o limitador tranca a"
  echo "        empresa inteira junto e a auditoria grava o mesmo hash para todos."
elif [ "$COM_CONECTOR" = "1" ] && [ "$PROXIES" = "2" ]; then
  verde "CHAT_PROXIES=2 (arranjo A: nginx -> site -> chat)"
elif [ "$PROXIES" = "1" ]; then
  verde "CHAT_PROXIES=1 (nginx direto no chat)"
else
  amarelo "CHAT_PROXIES=$PROXIES — confirme que há mesmo $PROXIES saltos na frente."
fi

# A prova definitiva: o próprio serviço avisa no log quando o IP resolvido de
# um visitante sai como loopback, que em produção nunca acontece de verdade.
if command -v journalctl >/dev/null 2>&1; then
  if journalctl -u lachat --since "24 hours ago" --no-pager 2>/dev/null | grep -q 'CHAT_PROXIES parece ERRADO'; then
    vermelho "o serviço JÁ DETECTOU CHAT_PROXIES errado nas últimas 24h"
    echo "        journalctl -u lachat | grep -A12 'CHAT_PROXIES parece ERRADO'"
  fi
fi

# ==========================================================================
secao "4. nginx — o que o WebSocket exige"
# ==========================================================================
if command -v nginx >/dev/null 2>&1; then
  # `-T` e não `-t`: o `-t` só valida a sintaxe. O `-T` mostra o que o nginx
  # REALMENTE carregou — é a única forma de flagrar um arquivo que você editou
  # e que não está sendo incluído.
  CONF="$(nginx -T 2>/dev/null || true)"

  if echo "$CONF" | grep -q 'conexao_upgrade\|connection_upgrade'; then
    verde "o `map` de Upgrade está carregado"
  else
    vermelho "o `map` de Upgrade NÃO está carregado"
    echo "        cp nginx/lachat-upgrade.conf /etc/nginx/conf.d/ && nginx -s reload"
    echo "        SEM isto o chat carrega e autentica, mas NUNCA recebe mensagem"
    echo "        em tempo real — e nada aparece quebrado."
  fi

  if echo "$CONF" | grep -q 'proxy_read_timeout *7d\|proxy_read_timeout *[0-9]*[dh]'; then
    verde "proxy_read_timeout alongado para o WebSocket"
  else
    amarelo "proxy_read_timeout parece estar no padrão (60s)"
    echo "        O socket fica minutos sem tráfego quando ninguém digita."
    echo "        Com 60s, o nginx o derruba e o chat fica 'reconectando' sem parar."
  fi

  if echo "$CONF" | grep -q 'http2 on\|listen .*443 .*http2'; then
    verde "HTTP/2 ligado"
  else
    amarelo "HTTP/2 não detectado (recomendado, não obrigatório para WebSocket)"
  fi
else
  amarelo "nginx não encontrado nesta máquina"
fi

# ==========================================================================
secao "5. Fim de linha dos scripts"
# ==========================================================================
# Um `.sh` com CRLF falha com uma mensagem que não menciona o `\r`.
CRLF=0
for f in ./*.sh ./ci/*.sh; do
  [ -f "$f" ] || continue
  if head -c 4000 "$f" | grep -q $'\r'; then
    vermelho "$f está com CRLF — converta: sed -i 's/\r$//' $f"
    CRLF=1
  fi
done
[ "$CRLF" = "0" ] && verde "os scripts estão com LF"

# ==========================================================================
secao "6. Pelo lado de fora"
# ==========================================================================
if [ "${BASE#https://}" != "$BASE" ]; then
  CODIGO="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 10 "$BASE$PREFIXO/saude" 2>/dev/null || echo '000')"
  [ "$CODIGO" = "200" ] && verde "o chat responde por HTTPS ($CODIGO)" \
                        || vermelho "o chat NÃO responde por HTTPS (código $CODIGO)"

  # O aperto de mão do WebSocket, sem bilhete, TEM de ser recusado com 401 —
  # e não com 404, que indicaria que o nginx não está repassando o /ws.
  WS="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 \
        -H "Connection: Upgrade" -H "Upgrade: websocket" \
        -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
        "$BASE$PREFIXO/ws" 2>/dev/null || echo '000')"
  case "$WS" in
    401) verde "o /ws recusa conexão sem bilhete (401) — é o esperado" ;;
    404) vermelho "o /ws devolveu 404 — o nginx não está repassando o WebSocket" ;;
    000) vermelho "o /ws não respondeu" ;;
    *)   amarelo "o /ws respondeu $WS (esperado 401)" ;;
  esac
else
  amarelo "alvo não é HTTPS — a verificação externa foi pulada"
  echo "        Em produção o chat EXIGE HTTPS: sem ele o cookie não leva"
  echo "        a marca Secure e o navegador recusa WebSocket seguro."
fi

# ==========================================================================
echo ""
echo "  ─────────────────────────────────────────────"
printf "  %d ok · %d avisos · %d erros\n\n" "$ok" "$aviso" "$erro"
[ "$erro" -gt 0 ] && exit 1
exit 0
