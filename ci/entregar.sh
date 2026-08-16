#!/usr/bin/env bash
# ==========================================================================
#  entregar.sh — o ÚNICO comando que a chave do GitHub consegue executar
#
#  Instalar no servidor:
#      mkdir -p ~/bin && cp ci/entregar.sh ~/bin/entregar-lachat
#      chmod 755 ~/bin/entregar-lachat
#
#  E no ~/.ssh/authorized_keys, a chave da entrega entra assim:
#      restrict,command="/home/deploy/bin/entregar-lachat" ssh-ed25519 AAAA... entrega-lachat
#
#  POR QUE O `command=` É A PEÇA MAIS IMPORTANTE DESTE ARQUIVO
#
#  Uma chave SSH comum dá SHELL. Guardada como segredo no GitHub, ela vira uma
#  porta para o servidor inteiro na mão de quem tiver acesso ao repositório —
#  incluindo qualquer Action de terceiro que alguém adicione ao workflow.
#
#  Com `command=`, o servidor IGNORA o que o cliente pedir e roda só isto. O
#  `restrict` desliga túnel, encaminhamento de agente e terminal.
#
#  E aqui isso pesa MAIS que num site: o banco do chat guarda as conversas da
#  equipe da clínica, cifradas com uma chave que vive no mesmo servidor.
#
#  Testar antes de confiar (deve mostrar a entrega, nunca um shell):
#      ssh -i chave deploy@servidor "cat /etc/shadow"
# ==========================================================================
set -uo pipefail

PROJETO="${PROJETO:-/var/www/projetos/LA-Chat}"
TRAVA="/tmp/entregar-lachat.lock"

cd "$PROJETO" || { echo "entregar: $PROJETO não existe"; exit 1; }

logger -t entrega-lachat "pedido de entrega de ${SSH_CLIENT%% *}"

# ------------------------------------------------------------------ trava
# Dois pushes seguidos disparam duas entregas ao mesmo tempo, e as duas mexem
# no mesmo banco e no mesmo serviço.
exec 9>"$TRAVA"
if ! flock -w 600 9; then
  echo "entregar: outra entrega está rodando há mais de 10 minutos — desisti"
  exit 1
fi

echo "=== entrega do LA Chat iniciada em $(date '+%d/%m/%Y %H:%M:%S') ==="

# ==========================================================================
#  1. CÓDIGO
#
#  `dados/` NÃO está no repositório (banco, anexos e contadores vivem só aqui),
#  e é por isso que um `git pull` é seguro: ele não tem como encostar neles.
#  O `--ff-only` recusa merge automático — se a árvore do servidor divergiu,
#  eu quero saber, não quero um merge inventado no meio de uma entrega.
# ==========================================================================
ANTES="$(git rev-parse --short HEAD 2>/dev/null || echo '?')"

git fetch --quiet origin main || { echo "entregar: falhou o fetch"; exit 1; }
if ! git merge --ff-only origin/main; then
  echo "entregar: a árvore do servidor divergiu da main — resolva à mão."
  exit 1
fi

DEPOIS="$(git rev-parse --short HEAD)"
echo "código: $ANTES → $DEPOIS"

# ==========================================================================
#  2. DEPENDÊNCIAS — uma vez, porque o código é um só
# ==========================================================================
npm ci --omit=dev --no-audit --no-fund || { echo "entregar: npm ci falhou"; exit 1; }

# A unit é MOLDE (`lachat@.service`): atualizá-la aqui é o que faz uma mudança
# de contenção do systemd alcançar todas as instâncias.
if ! cmp -s nginx/lachat@.service /etc/systemd/system/lachat@.service; then
  echo "unit do systemd mudou — atualizando"
  sudo /usr/bin/cp nginx/lachat@.service /etc/systemd/system/lachat@.service
  sudo /usr/bin/systemctl daemon-reload
fi

# ==========================================================================
#  3. CADA INSTÂNCIA — migração e restart, uma a uma
#
#  As instâncias são descobertas pelos ARQUIVOS DE AMBIENTE, e não por uma
#  lista aqui dentro: lista em script desatualiza, e a instância esquecida
#  seria justamente a que fica sem a correção — em silêncio, até um cliente
#  reclamar.
#
#  Uma que falhe NÃO impede as outras de atualizar: o cliente B não fica sem
#  correção porque o A tem um problema. Mas a entrega termina vermelha.
# ==========================================================================
falhas=0
achou=0

for amb in /etc/lachat-*.env; do
  [ -e "$amb" ] || continue
  inst="$(basename "$amb" .env)"; inst="${inst#lachat-}"
  achou=1
  echo "── instância $inst"

  # Subshell: cada instância tem SUAS chaves e SEU banco, e uma não pode
  # herdar o ambiente da anterior.
  if ! ( set -a; . "$amb"; set +a; node src/infra/dados/migrar.js ); then
    echo "   ✖ migração falhou"; falhas=$((falhas+1)); continue
  fi

  sudo /usr/bin/systemctl restart "lachat@$inst.service"
  sleep 2

  if ! sudo /usr/bin/systemctl is-active --quiet "lachat@$inst.service"; then
    echo "   ✖ não subiu — journalctl -u lachat@$inst -n 50"
    falhas=$((falhas+1)); continue
  fi

  # Prova de vida PELA PORTA, e não só pelo systemd: "active" diz que o
  # processo existe, não que ele responde.
  porta="$(grep -oP '^PORT=\K\d+' "$amb" || echo 0)"
  codigo="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$porta/chat/saude" || echo 000)"
  if [ "$codigo" = "200" ]; then
    echo "   ✔ ativa na porta $porta"
  else
    echo "   ✖ não respondeu na porta $porta (HTTP $codigo)"
    falhas=$((falhas+1))
  fi
done

if [ "$achou" = "0" ]; then
  echo "entregar: nenhuma instância instalada (/etc/lachat-*.env vazio)"
  exit 1
fi

# ==========================================================================
#  4. O CONECTOR NOS SITES — CONFERIR, e NÃO instalar
#
#  Aqui mora a decisão mais importante deste arquivo, e ela é contraintuitiva.
#
#  Seria tentador rodar `instalar-em.js --todos` agora: o conector de todos os
#  sites ficaria atualizado num passo. E QUEBRARIA O DEPLOY DELES.
#
#  Cada site é um repositório git, e o `lachat.js` está COMMITADO nele — tem de
#  estar, senão um clone novo não sobe (o `require("./lachat")` acontece no
#  boot). Sobrescrever o arquivo aqui deixaria a árvore do site suja, e o
#  `git pull` da entrega seguinte pararia com "local changes would be
#  overwritten".
#
#  Então a atualização do conector viaja pelo caminho certo: o workflow do
#  LA-Chat commita o arquivo novo NO REPOSITÓRIO de cada site, o portão de
#  testes daquele site roda, e a entrega dele leva o conector junto.
#
#  O que sobra para cá é o AVISO: dizer quem ficou para trás.
# ==========================================================================
if [ -f instalar-em.js ]; then
  echo "--- conector nos sites ---"
  node instalar-em.js --todos --conferir || true   # sai 1 quando há atraso
fi

echo "=== entrega concluída em $(date '+%d/%m/%Y %H:%M:%S') ==="
exit "$falhas"
