#!/usr/bin/env bash
# ==========================================================================
#  deploy.sh — instala ou atualiza o LA Chat num servidor
#
#      sudo ./deploy.sh                      instala/atualiza
#      sudo ./deploy.sh --so-atualizar       pula systemd e nginx
#
#  Variáveis (com padrões do parque):
#      DESTINO=/var/www/projetos/LA-Chat  USUARIO=deploy  GRUPO=deploy
#      PORTA=5197  AMBIENTE=/etc/lachat.env
# ==========================================================================
set -euo pipefail

DESTINO="${DESTINO:-/var/www/projetos/LA-Chat}"
USUARIO="${USUARIO:-deploy}"
GRUPO="${GRUPO:-deploy}"
PORTA="${PORTA:-5197}"
AMBIENTE="${AMBIENTE:-/etc/lachat.env}"
APP="lachat"
SO_ATUALIZAR=0

for a in "$@"; do [ "$a" = "--so-atualizar" ] && SO_ATUALIZAR=1; done

msg() { printf "\n  \033[1m%s\033[0m\n" "$1"; }
erro() { printf "\n  \033[31m✖ %s\033[0m\n\n" "$1"; exit 1; }

[ "$(id -u)" = "0" ] || erro "rode como root (sudo ./deploy.sh)"
command -v node >/dev/null || erro "node não encontrado"

NODE_MAIOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAIOR" -ge 20 ] || erro "o LA Chat exige Node >= 20 (achei $NODE_MAIOR)"

# ==========================================================================
msg "1. Segredos"
# ==========================================================================
# Gerados AQUI se o arquivo não existir, e nunca sobrescritos se existir.
# Regenerar `CHAT_DADOS_CHAVE` num servidor que já tem mensagens tornaria todo
# o histórico ilegível — é o pior estrago que este script poderia causar.
if [ ! -f "$AMBIENTE" ]; then
  msg "   criando $AMBIENTE"
  install -o root -g "$GRUPO" -m 640 /dev/null "$AMBIENTE"
  {
    echo "NODE_ENV=production"
    echo "PORT=$PORTA"
    echo "HOST=127.0.0.1"
    echo "CHAT_BANCO=sqlite"
    echo "# CONTE OS SALTOS ate o chat:"
    echo "#   navegador -> nginx -> chat                    = 1"
    echo "#   navegador -> nginx -> site (conector) -> chat = 2   <- arranjo A"
    echo "# Errado, o limitador trata a empresa inteira como um endereco so."
    echo "CHAT_PROXIES=2"
    echo "CHAT_SEGREDO_PASSE=$(openssl rand -base64 32)"
    echo "CHAT_SEGREDO_BUSCA=$(openssl rand -base64 32)"
    echo "CHAT_DADOS_CHAVE=$(openssl rand -base64 32)"
    echo "# OBRIGATÓRIO: os sites autorizados, separados por vírgula."
    echo "# Vazio = recusa todo mundo. Sem isto o serviço NÃO sobe."
    echo "CHAT_ORIGENS="
  } >> "$AMBIENTE"

  printf "\n  \033[33m!\033[0m Preencha CHAT_ORIGENS em %s antes de subir.\n" "$AMBIENTE"
  printf "    E copie CHAT_SEGREDO_PASSE para o /etc/<site>.env do hospedeiro.\n"
else
  msg "   $AMBIENTE já existe — preservado"
  chmod 640 "$AMBIENTE"
  chown "root:$GRUPO" "$AMBIENTE"
fi

# ==========================================================================
msg "2. Código"
# ==========================================================================
mkdir -p "$DESTINO/dados/arquivos"

if [ "$(realpath .)" != "$(realpath "$DESTINO")" ]; then
  msg "   copiando para $DESTINO"
  # `dados/` fica de fora: é onde vivem o banco e os anexos do cliente.
  rsync -a --delete \
    --exclude 'dados/' --exclude 'node_modules/' --exclude '.git/' \
    --exclude '.env' --exclude 'testes/saida/' \
    ./ "$DESTINO/"
fi

cd "$DESTINO"
msg "   npm ci"
sudo -u "$USUARIO" npm ci --omit=dev --no-audit --no-fund

# O código NÃO precisa ser gravável pelo serviço — e não sendo, uma falha na
# aplicação não consegue reescrever o próprio servidor.
chown -R root:"$GRUPO" "$DESTINO"
chmod -R g+rX,o-rwx "$DESTINO"
chown -R "$USUARIO:$GRUPO" "$DESTINO/dados"
chmod 750 "$DESTINO/dados"

# ==========================================================================
msg "3. Banco"
# ==========================================================================
set -a; . "$AMBIENTE"; set +a
sudo -u "$USUARIO" -E node src/infra/dados/migrar.js

if [ "$SO_ATUALIZAR" = "1" ]; then
  msg "4. Reiniciando"
  systemctl restart "$APP"
  sleep 2
  systemctl is-active --quiet "$APP" && msg "   ok" || erro "o serviço não subiu — journalctl -u $APP -n 50"
  exit 0
fi

# ==========================================================================
msg "4. systemd"
# ==========================================================================
sed -e "s#__DESTINO__#$DESTINO#g" \
    -e "s#__USUARIO__#$USUARIO#g" \
    -e "s#__GRUPO__#$GRUPO#g" \
    -e "s#__PORTA__#$PORTA#g" \
    nginx/lachat.service > "/etc/systemd/system/$APP.service"

systemctl daemon-reload
systemctl enable "$APP" >/dev/null

# ==========================================================================
msg "5. nginx — o map de Upgrade"
# ==========================================================================
# Este é o passo que, esquecido, faz o chat funcionar em tudo MENOS em tempo
# real — sem nada aparecer quebrado.
if [ -d /etc/nginx/conf.d ]; then
  cp nginx/lachat-upgrade.conf /etc/nginx/conf.d/
  if nginx -t 2>/dev/null; then
    systemctl reload nginx
    msg "   map de Upgrade instalado"
  else
    printf "  \033[31m✖\033[0m nginx -t falhou — o map NÃO foi ativado\n"
    nginx -t || true
  fi
else
  printf "  \033[33m!\033[0m /etc/nginx/conf.d não existe — instale o map à mão\n"
fi

# ==========================================================================
msg "6. Subir"
# ==========================================================================
systemctl restart "$APP"
sleep 2

if systemctl is-active --quiet "$APP"; then
  msg "   ativo"
else
  printf "  \033[31m✖\033[0m o serviço não subiu:\n\n"
  journalctl -u "$APP" -n 30 --no-pager
  exit 1
fi

echo ""
echo "  ─────────────────────────────────────────────"
echo "  LA Chat instalado em $DESTINO (porta $PORTA)"
echo ""
echo "  Falta:"
echo "    1. preencher CHAT_ORIGENS em $AMBIENTE"
echo "    2. copiar conector/lachat.js para a raiz do site"
echo "    3. as duas linhas no server.js do site (conector/INSTALAR.md)"
echo "    4. copiar CHAT_SEGREDO_PASSE para o /etc/<site>.env"
echo ""
echo "  Depois:  ./verificar.sh https://site-do-cliente.com"
echo ""
