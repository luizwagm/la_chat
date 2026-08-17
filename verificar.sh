#!/usr/bin/env bash
# ==========================================================================
#  verificar.sh — confere a instalação ANTES de o cliente reclamar
#
#      ./verificar.sh bemestar            confere a instância bemestar
#      ./verificar.sh bemestar https://bemestarclinic.com   e o lado de fora
#
#  A INSTÂNCIA é obrigatória desde a 0.5.0: cada projeto tem processo, banco e
#  chaves próprios, e conferir "o chat" sem dizer qual não quer dizer nada.
#
#  Cada checagem aqui existe por causa de um defeito que ACONTECE, e que é
#  difícil de diagnosticar depois. A lista não é genérica.
# ==========================================================================
set -uo pipefail

INSTANCIA="${1:-}"
if [ -z "$INSTANCIA" ]; then
  echo ""
  echo "  uso: ./verificar.sh <instancia> [url-publica]"
  echo ""
  echo "  instâncias instaladas:"
  for a in /etc/lachat-*.env; do [ -e "$a" ] || continue
    n="$(basename "$a" .env)"; n="${n#lachat-}"
    echo "    $n  (porta $(grep -oP '^PORT=\K\d+' "$a" 2>/dev/null))"
  done
  echo ""
  exit 1
fi
AMBIENTE_ARQ="${AMBIENTE_ARQ:-/etc/lachat-$INSTANCIA.env}"
SERVICO="lachat@$INSTANCIA"
PORTA_INST="$(grep -oP '^PORT=\K\d+' "$AMBIENTE_ARQ" 2>/dev/null || echo 5197)"

# ==========================================================================
#  DOIS ALVOS, e eles não se substituem
#
#  LOCAL  — 127.0.0.1 na porta da instância. Responde "o serviço está de pé?".
#  FORA   — a URL pública. Responde "o nginx e o conector estão no caminho?".
#
#  Na primeira versão, passar a URL pública TROCAVA o alvo local: quando o
#  externo falhava, o relatório dizia que o serviço não respondia — e o serviço
#  estava perfeitamente de pé. Diagnóstico invertido é pior que diagnóstico
#  nenhum, porque manda mexer no lugar errado.
# ==========================================================================
LOCAL="http://127.0.0.1:$PORTA_INST"
PREFIXO="${CHAT_PREFIXO:-/chat}"          # dentro do serviço, sempre /chat

# ==========================================================================
#  O CAMINHO PÚBLICO NÃO É `/chat`
#
#  Com o conector, o chat mora DENTRO do site — no BemEstarClinic, em
#  `/restrito/chat`, porque o cookie da gestão tem `Path=/restrito`. Conferir
#  `https://site/chat/saude` devolve 404 e acusa um problema que não existe.
#
#  Aceita os dois jeitos:
#      ./verificar.sh bemestar https://bemestarclinic.com
#      ./verificar.sh bemestar https://bemestarclinic.com/restrito/chat
# ==========================================================================
FORA="${2:-}"
if [ -n "$FORA" ]; then
  FORA="${FORA%/}"
  case "$FORA" in
    */chat) : ;;                                   # já veio com o caminho
    *) FORA="$FORA${CHAT_PREFIXO_PUBLICO:-/restrito/chat}" ;;
  esac
fi

ok=0; aviso=0; erro=0
verde()   { printf "  \033[32m✓\033[0m %s\n" "$1"; ok=$((ok+1)); }
amarelo() { printf "  \033[33m!\033[0m %s\n" "$1"; aviso=$((aviso+1)); }
vermelho(){ printf "  \033[31m✗\033[0m %s\n" "$1"; erro=$((erro+1)); }
secao()   { printf "\n  \033[1m%s\033[0m\n" "$1"; }

echo ""
echo "  LA Chat — verificação"
echo "  ─────────────────────────────────────────────"
echo "  Instância: $INSTANCIA   Local: $LOCAL$PREFIXO"
[ -n "$FORA" ] && echo "  Fora:      $FORA"

# ==========================================================================
secao "1. O serviço responde (aqui dentro)"
# ==========================================================================
SAUDE="$(curl -fsS --max-time 8 "$LOCAL$PREFIXO/saude" 2>/dev/null || true)"
if [ -z "$SAUDE" ]; then
  vermelho "o chat não respondeu em $LOCAL$PREFIXO/saude"
  echo "        systemctl status $SERVICO --no-pager | tail -20"
  echo "        journalctl -u $SERVICO -n 50 --no-pager"
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
  if journalctl -u $SERVICO --since "24 hours ago" --no-pager 2>/dev/null | grep -q 'CHAT_PROXIES parece ERRADO'; then
    vermelho "o serviço JÁ DETECTOU CHAT_PROXIES errado nas últimas 24h"
    echo "        journalctl -u $SERVICO | grep -A12 'CHAT_PROXIES parece ERRADO'"
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
    verde "o map de Upgrade está carregado"
  else
    vermelho "o map de Upgrade NÃO está carregado"
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
if [ -z "$FORA" ]; then
  amarelo "sem URL pública — a verificação externa foi pulada"
  echo "        ./verificar.sh $INSTANCIA https://site-do-cliente.com"
elif [ "${FORA#https://}" = "$FORA" ]; then
  amarelo "o alvo externo não é HTTPS — pulado"
  echo "        Em produção o chat EXIGE HTTPS: sem ele o cookie não leva"
  echo "        a marca Secure e o navegador recusa WebSocket seguro."
else
  CODIGO="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 10 "$FORA/saude" 2>/dev/null || echo '000')"
  case "$CODIGO" in
    200) verde "o chat responde em $FORA/saude" ;;
    404) vermelho "404 em $FORA/saude — o site não está repassando este caminho"
         echo "        O conector está instalado e com o prefixo certo no server.js?"
         echo "        Se o chat está montado em outro caminho, informe-o:"
         echo "        ./verificar.sh $INSTANCIA https://site.com/o/caminho/chat" ;;
    502|503) vermelho "$CODIGO — o site respondeu, mas não alcançou o chat"
         echo "        CHAT_URL no /etc/<site>.env aponta para a porta $PORTA_INST?" ;;
    *)   vermelho "o chat NÃO responde por HTTPS (código $CODIGO)" ;;
  esac

  # O aperto de mão do WebSocket, sem bilhete, TEM de ser recusado com 401 —
  # e não com 404, que indicaria que o nginx não está repassando o /ws.
  WS="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 \
        -H "Connection: Upgrade" -H "Upgrade: websocket" \
        -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
        "$FORA/ws" 2>/dev/null || echo '000')"
  case "$WS" in
    401) verde "o /ws recusa conexão sem bilhete (401) — é o esperado" ;;
    404) vermelho "o /ws devolveu 404 — o nginx não está repassando o WebSocket"
         echo "        falta o bloco 'location $(printf '%s' "${FORA#https://*/}" | sed 's|^|/|')/ws' no conf do SITE" ;;
    000) vermelho "o /ws não respondeu" ;;
    *)   amarelo "o /ws respondeu $WS (esperado 401)" ;;
  esac
fi

# ==========================================================================
echo ""
echo "  ─────────────────────────────────────────────"
printf "  %d ok · %d avisos · %d erros\n\n" "$ok" "$aviso" "$erro"
[ "$erro" -gt 0 ] && exit 1
exit 0
