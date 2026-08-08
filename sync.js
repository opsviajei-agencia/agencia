/* ============================================================
   Central da Agência — camada de sincronização (Supabase)
   ------------------------------------------------------------
   Este arquivo NÃO altera o index.html original.
   Ele substitui as 4 funções de armazenamento em tempo de
   execução, mantendo todo o resto do app funcionando igual.

   - Dados passam a viver no Supabase (multi-dispositivo)
   - localStorage vira cache offline
   - Uma cópia intacta do estado original fica guardada
   ============================================================ */
(function () {
  'use strict';

  var SUPA_URL = 'https://bdzrmdfoyazhihiminnl.supabase.co';
  var SUPA_KEY = 'sb_publishable_TMtZdr_wWuv75P79-m2ANA_DeR6jO_Q';

  var SK_EM = 'ag_emissoes_v3';
  var SK_CL = 'ag_clientes_v3';
  var BK_EM = 'ag_emissoes_backup_pre_supabase';
  var BK_CL = 'ag_clientes_backup_pre_supabase';

  /* ---------- 1. Cópia de segurança do estado original ---------- */
  /* Roda antes de qualquer gravação. Só copia uma vez, nunca sobrescreve. */
  try {
    if (localStorage.getItem(BK_EM) === null && localStorage.getItem(SK_EM) !== null) {
      localStorage.setItem(BK_EM, localStorage.getItem(SK_EM));
    }
    if (localStorage.getItem(BK_CL) === null && localStorage.getItem(SK_CL) !== null) {
      localStorage.setItem(BK_CL, localStorage.getItem(SK_CL));
    }
  } catch (e) { /* modo privado / storage cheio */ }

  var sb = window.supabase.createClient(SUPA_URL, SUPA_KEY);

  var CEM = [];   // cache de emissões
  var CCL = [];   // cache de clientes
  var fila = Promise.resolve();  // serializa as gravações

  /* ---------- 2. Interface: overlay de login + selo de status ---------- */
  var css = document.createElement('style');
  css.textContent = [
    '#sy-lock{position:fixed;inset:0;z-index:99999;background:#0f1419;display:flex;',
    'align-items:center;justify-content:center;font-family:system-ui,-apple-system,sans-serif}',
    '#sy-box{background:#fff;border-radius:14px;padding:34px 30px;width:340px;',
    'box-shadow:0 20px 60px rgba(0,0,0,.4)}',
    '#sy-box h2{margin:0 0 4px;font-size:19px;color:#111}',
    '#sy-box p{margin:0 0 20px;font-size:13px;color:#666}',
    '#sy-box input{width:100%;box-sizing:border-box;padding:11px 12px;margin-bottom:10px;',
    'border:1px solid #d5d9e0;border-radius:8px;font-size:14px}',
    '#sy-box button{width:100%;padding:11px;background:#378ADD;color:#fff;border:0;',
    'border-radius:8px;font-size:14px;font-weight:600;cursor:pointer}',
    '#sy-box button:disabled{opacity:.6;cursor:default}',
    '#sy-msg{font-size:12.5px;margin-top:12px;min-height:17px;text-align:center}',
    '#sy-pill{position:fixed;bottom:14px;right:14px;z-index:9999;font:500 11.5px system-ui;',
    'padding:6px 12px;border-radius:20px;background:#e8f5e9;color:#2e7d32;',
    'box-shadow:0 2px 8px rgba(0,0,0,.12);transition:.2s;cursor:default}',
    '#sy-pill.busy{background:#fff8e1;color:#f57c00}',
    '#sy-pill.err{background:#ffebee;color:#c62828;cursor:pointer}'
  ].join('');
  document.head.appendChild(css);

  var lock = document.createElement('div');
  lock.id = 'sy-lock';
  lock.innerHTML =
    '<div id="sy-box">' +
      '<h2>Central da Agência</h2>' +
      '<p>Entre para acessar seus dados</p>' +
      '<input id="sy-mail" type="email" placeholder="E-mail" autocomplete="username">' +
      '<input id="sy-pass" type="password" placeholder="Senha" autocomplete="current-password">' +
      '<button id="sy-go">Entrar</button>' +
      '<div id="sy-msg"></div>' +
    '</div>';
  document.addEventListener('DOMContentLoaded', function () {
    document.body.appendChild(lock);
    document.getElementById('sy-go').onclick = entrar;
    document.getElementById('sy-pass').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') entrar();
    });
    sb.auth.getSession().then(function (r) {
      if (r.data && r.data.session) iniciar();
    });
  });

  var pill;
  function status(txt, cls) {
    if (!pill) {
      pill = document.createElement('div');
      pill.id = 'sy-pill';
      document.body.appendChild(pill);
    }
    pill.textContent = txt;
    pill.className = cls || '';
  }

  function msg(t, cor) {
    var el = document.getElementById('sy-msg');
    if (el) { el.textContent = t; el.style.color = cor || '#c62828'; }
  }

  function entrar() {
    var btn = document.getElementById('sy-go');
    var mail = document.getElementById('sy-mail').value.trim();
    var pass = document.getElementById('sy-pass').value;
    if (!mail || !pass) { msg('Preencha e-mail e senha.'); return; }
    btn.disabled = true; msg('Entrando...', '#666');
    sb.auth.signInWithPassword({ email: mail, password: pass }).then(function (r) {
      if (r.error) { btn.disabled = false; msg('E-mail ou senha incorretos.'); return; }
      iniciar();
    });
  }

  /* ---------- 3. Carga inicial ---------- */
  function iniciar() {
    status('Carregando...', 'busy');
    Promise.all([
      sb.from('emissoes').select('id,dados'),
      sb.from('clientes').select('id,dados')
    ]).then(function (res) {
      if (res[0].error || res[1].error) {
        msg('Erro ao carregar. Tente de novo.');
        var b = document.getElementById('sy-go'); if (b) b.disabled = false;
        status('Erro de conexão', 'err');
        return;
      }
      CEM = (res[0].data || []).map(function (r) { return r.dados; });
      CCL = (res[1].data || []).map(function (r) { return r.dados; });
      // mantém a ordem original do app: mais recentes primeiro
      CEM.sort(function (a, b) { return (Number(b.id) || 0) - (Number(a.id) || 0); });

      instalar();
      if (lock && lock.parentNode) lock.parentNode.removeChild(lock);
      status('Sincronizado');
      repintar();
      ofereceImportacao();
    });
  }

  /* ---------- 4. Substituição das funções de armazenamento ---------- */
  function instalar() {
    window.loadEM = function () { return CEM; };
    window.loadCL = function () { return CCL; };
    window.saveEM = function (d) {
      CEM = d || [];
      try { localStorage.setItem(SK_EM, JSON.stringify(CEM)); } catch (e) {}
      enfileirar('emissoes', CEM, function (e) { return String(e.id); });
    };
    window.saveCL = function (d) {
      CCL = d || [];
      try { localStorage.setItem(SK_CL, JSON.stringify(CCL)); } catch (e) {}
      // clientes não têm id próprio no app — a chave é o nome
      enfileirar('clientes', CCL, function (c) { return String(c.nome || ''); });
    };
  }

  function enfileirar(tabela, lista, chave) {
    status('Salvando...', 'busy');
    fila = fila.then(function () { return empurrar(tabela, lista, chave); })
               .then(function () { status('Sincronizado'); })
               .catch(function () {
                 status('Offline — salvo no navegador', 'err');
               });
  }

  function empurrar(tabela, lista, chave) {
    var agora = new Date().toISOString();
    var linhas = lista
      .filter(function (x) { return x && chave(x); })
      .map(function (x) { return { id: chave(x), dados: x, atualizado: agora }; });

    var passo = linhas.length
      ? sb.from(tabela).upsert(linhas).then(check)
      : Promise.resolve();

    // remove no servidor o que foi excluído localmente
    return passo.then(function () {
      return sb.from(tabela).select('id').then(function (r) {
        if (r.error) throw r.error;
        var manter = {};
        linhas.forEach(function (l) { manter[l.id] = 1; });
        var apagar = (r.data || [])
          .map(function (x) { return x.id; })
          .filter(function (id) { return !manter[id]; });
        if (!apagar.length) return;
        return sb.from(tabela).delete().in('id', apagar).then(check);
      });
    });
  }

  function check(r) { if (r && r.error) throw r.error; return r; }

  /* ---------- 5. Importação única dos dados que já estão no navegador ---------- */
  function ofereceImportacao() {
    if (CEM.length || CCL.length) return;  // servidor já tem dados
    var em = ler(BK_EM) || ler(SK_EM) || [];
    var cl = ler(BK_CL) || ler(SK_CL) || [];
    if (!em.length && !cl.length) return;

    var ok = confirm(
      'Encontrei dados salvos neste navegador que ainda não estão na nuvem:\n\n' +
      '• ' + em.length + ' emissão(ões)\n' +
      '• ' + cl.length + ' cliente(s)\n\n' +
      'Deseja enviar tudo para o Supabase agora?\n\n' +
      '(A cópia local continua intacta de qualquer forma.)'
    );
    if (!ok) return;

    status('Importando...', 'busy');
    CEM = em; CCL = cl;
    Promise.all([
      empurrar('emissoes', em, function (e) { return String(e.id); }),
      empurrar('clientes', cl, function (c) { return String(c.nome || ''); })
    ]).then(function () {
      status('Sincronizado');
      repintar();
      alert('Importação concluída. Seus dados agora abrem em qualquer dispositivo.');
    }).catch(function () {
      status('Falha na importação', 'err');
      alert('A importação falhou, mas nada foi perdido. Seus dados locais continuam salvos.');
    });
  }

  function ler(k) {
    try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : null; }
    catch (e) { return null; }
  }

  /* ---------- 6. Redesenha as telas com os dados vindos do servidor ---------- */
  function repintar() {
    ['renderDash', 'renderEmissoes', 'renderClientes', 'renderFinanceiro', 'renderFornecedores']
      .forEach(function (fn) {
        try { if (typeof window[fn] === 'function') window[fn](); } catch (e) {}
      });
    try { if (typeof window.renderNotif === 'function') window.renderNotif('todas'); } catch (e) {}
  }

  /* ---------- 7. Sair ---------- */
  window.sairDaConta = function () {
    sb.auth.signOut().then(function () { location.reload(); });
  };
})();
