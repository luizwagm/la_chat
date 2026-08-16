/* ==========================================================================
   repositorios/sessoes.js

   O TOKEN NUNCA É GRAVADO. Só o hash dele.

   O token do cookie é equivalente a uma senha: quem o tiver É a pessoa. Se ele
   estivesse no banco em claro, um backup vazado, um dump esquecido ou um
   SELECT de leitura entregariam sessões vivas — e o atacante entraria sem
   precisar de senha nenhuma, sem disparar nenhum alarme de login.

   Com o hash, o banco guarda algo que serve para CONFERIR e não para ENTRAR.

   POR QUE SHA-256 E NÃO scrypt
   Ao contrário de senha, o token é 32 bytes ALEATÓRIOS gerados por nós. Não há
   dicionário para atacar nem entropia baixa para compensar — força bruta sobre
   2^256 não acontece. E o hash é conferido a cada requisição do chat: um KDF
   lento (que é lento de propósito) transformaria cada requisição num custo de
   CPU, e uma rajada de requisições num ataque de negação de serviço contra o
   próprio servidor.
   ========================================================================== */
"use strict";

const crypto = require("node:crypto");
const { ulid } = require("../../../dominio/ids.js");
const { agora } = require("../banco.js");

const hashDoToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

function criar(Q) {
  return {
    hashDoToken,

    async abrir({ usuarioId, token, ipHash = "", agente = "", duracaoMs }) {
      const t = agora();
      const id = ulid();
      await Q.run(
        `INSERT INTO sessoes (id, usuario_id, token_hash, ip_hash, agente, criada_em, ultimo_uso, expira_em)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id, usuarioId, hashDoToken(token), ipHash,
        /* O agente é cortado em 200: o cabeçalho User-Agent é texto do cliente
           e pode vir com megabytes. Guardar sem teto é deixar o tamanho da
           tabela na mão de quem conecta. */
        String(agente).slice(0, 200), t, t, t + duracaoMs);
      return id;
    },

    /* Devolve a sessão E o usuário numa consulta só — é o caminho percorrido
       por TODA requisição autenticada, e duas idas ao banco aqui seriam duas
       idas ao banco em tudo que o chat faz.

       A situação da conta é conferida aqui dentro: bloquear alguém tem de
       valer na requisição SEGUINTE, e não só no próximo login. Se a checagem
       ficasse no login, bloquear uma pessoa que já está com o chat aberto não
       faria absolutamente nada. */
    async porToken(token) {
      if (!token) return null;
      const s = await Q.get(
        `SELECT s.id, s.usuario_id, s.expira_em, s.criada_em,
                u.contexto_id, u.nome, u.sobrenome, u.avatar, u.papel, u.situacao
           FROM sessoes s
           JOIN usuarios u ON u.id = s.usuario_id
          WHERE s.token_hash = ?`, hashDoToken(token));

      if (!s) return null;
      if (s.expira_em <= agora()) return null;
      if (s.situacao !== "ativa") return null;
      return s;
    },

    /* Renovação por ATIVIDADE, com escrita economizada.

       Gravar `ultimo_uso` a cada requisição significaria um UPDATE por
       mensagem, por rolagem, por batimento — escrita constante numa tabela
       quente para atualizar um campo que ninguém lê com precisão de segundo.
       Só grava quando passou tempo suficiente para importar. */
    async renovar(sessaoId, duracaoMs, minimoEntreEscritasMs = 60_000) {
      const t = agora();
      await Q.run(
        `UPDATE sessoes SET ultimo_uso = ?, expira_em = ?
          WHERE id = ? AND ultimo_uso < ?`,
        t, t + duracaoMs, sessaoId, t - minimoEntreEscritasMs);
    },

    async encerrar(token) {
      const r = await Q.run("DELETE FROM sessoes WHERE token_hash = ?", hashDoToken(token));
      return r.linhas > 0;
    },

    /* Usado ao bloquear alguém: tirar o acesso tem de derrubar o que já está
       aberto. Sem isto, bloquear uma conta só impediria o PRÓXIMO login, e a
       aba que já estava aberta continuaria conversando. */
    async encerrarDoUsuario(usuarioId) {
      const r = await Q.run("DELETE FROM sessoes WHERE usuario_id = ?", usuarioId);
      return r.linhas;
    },

    async doUsuario(usuarioId) {
      return Q.all(
        `SELECT id, ip_hash, agente, criada_em, ultimo_uso, expira_em
           FROM sessoes WHERE usuario_id = ? ORDER BY ultimo_uso DESC`, usuarioId);
    },

    /* ======================================================================
       PASSES JÁ USADOS — a trava de repetição

       O passe vale 60 s e vale UMA vez. Guardar o `jti` até ele expirar faz o
       segundo uso ser recusado: quem interceptar o passe em trânsito não
       consegue usá-lo, porque o dono legítimo já o usou.

       O INSERT é a própria trava: a chave primária arbitra a corrida de dois
       usos simultâneos. Um `SELECT` seguido de `INSERT` teria a janela entre
       os dois — e essa janela é exatamente o que o atacante procura.
       ====================================================================== */
    async marcarPasseUsado(jti, expiraEm) {
      try {
        await Q.run("INSERT INTO passes_usados (jti, expira_em) VALUES (?, ?)", jti, expiraEm);
        return true;
      } catch {
        return false;   // já estava lá: é repetição
      }
    },

    /* ======================================================================
       FAXINA — sessões e passes vencidos

       Sem ela as duas tabelas crescem para sempre num serviço que fica meses
       de pé. Não é só espaço: o índice de `token_hash` fica maior e a
       conferência de TODA requisição fica mais lenta com o tempo.
       ====================================================================== */
    async faxina() {
      const t = agora();
      const s = await Q.run("DELETE FROM sessoes WHERE expira_em < ?", t);
      const p = await Q.run("DELETE FROM passes_usados WHERE expira_em < ?", t);
      return { sessoes: s.linhas, passes: p.linhas };
    },
  };
}

module.exports = { criar, hashDoToken };
