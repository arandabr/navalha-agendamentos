/* Página /agendamentos — área do cliente */
(function () {
  const $ = (id) => document.getElementById(id);

  const STATUS = {
    pendente: 'Pendente',
    confirmado: 'Confirmado',
    em_atendimento: 'Em atendimento',
    concluido: 'Concluído',
    cancelado: 'Cancelado',
    ausente: 'Ausente'
  };

  function esc(str) {
    return String(str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fmtPreco(v) {
    return 'R$ ' + (Number(v) || 0).toFixed(2).replace('.', ',');
  }

  function fmtData(d) {
    const p = String(d || '').split('-');
    return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : d;
  }

  function mostrarToast(msg, tipo) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast show ' + (tipo || '');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => (t.className = 'toast'), 2600);
  }

  let telefone = '';
  let cancelandoId = null;

  function abrirCancelar(id) {
    cancelandoId = id;
    $('cancelModal').classList.remove('hidden');
    $('cancelInfo').textContent = 'Tem certeza que deseja cancelar o agendamento #' + String(id).padStart(4, '0') + '? Esta ação não pode ser desfeita.';
  }

  function fecharCancelar() {
    cancelandoId = null;
    $('cancelModal').classList.add('hidden');
  }

  $('cancelModal').addEventListener('click', (e) => {
    if (e.target === $('cancelModal')) fecharCancelar();
  });
  $('cancelVoltar').addEventListener('click', fecharCancelar);

  $('cancelConfirmar').addEventListener('click', async () => {
    const id = cancelandoId;
    fecharCancelar();
    try {
      const res = await fetch('/api/cliente/agendamentos/' + id + '/cancelar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telefone })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Não foi possível cancelar.');
      mostrarToast('Agendamento cancelado.', 'success');
      const res2 = await fetch('/api/cliente/acesso', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telefone })
      });
      const d2 = await res2.json();
      if (res2.ok) renderResultado(d2);
    } catch (er) {
      mostrarToast(er.message, 'error');
    }
  });

  $('clForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = $('clError');
    errBox.classList.add('hidden');
    telefone = $('clTel').value.trim();
    const btn = $('clBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Carregando...';
    try {
      const res = await fetch('/api/cliente/acesso', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telefone })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Não foi possível acessar.');
      $('clAcesso').classList.add('hidden');
      renderResultado(data);
      $('clResult').classList.remove('hidden');
    } catch (er) {
      errBox.textContent = er.message;
      errBox.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Acessar';
    }
  });

  $('clSair').addEventListener('click', () => {
    telefone = '';
    $('clResult').classList.add('hidden');
    $('clAcesso').classList.remove('hidden');
  });

  function renderResultado(d) {
    const fid = (d.fidelidade || []).filter((f) => f.config.ativo || (f.cliente && f.cliente.visitas > 0));
    $('clFidelidade').innerHTML = fid.length
      ? fid.map((f) => {
          const premio = f.config.premio_visitas || 10;
          const visitas = (f.cliente && f.cliente.visitas) || 0;
          const restante = Math.max(0, premio - visitas);
          const pct = Math.min(100, Math.round((visitas / premio) * 100));
          return `
            <div class="cl-fid">
              <div class="cl-fid-head">
                <strong>${esc(f.barbearia.nome)}</strong>
                <span>${visitas} de ${premio} visitas</span>
              </div>
              <div class="fid-bar"><div style="width:${pct}%"></div></div>
              <p class="cl-fid-text">${restante ? 'Faltam <strong>' + restante + '</strong> visita(s) para o prêmio!' : 'Prêmio atingido! Resgate seu serviço grátis na barbearia.'}</p>
            </div>`;
        }).join('')
      : '<p class="cl-empty">Ainda não há pontos de fidelidade para mostrar.</p>';

    const ags = d.agendamentos || [];
    $('clAgendamentos').innerHTML = ags.length
      ? ags.map((a) => {
          const cancela = ['pendente', 'confirmado', 'em_atendimento'].includes(a.status);
          return `
            <div class="cl-ag">
              <div class="cl-ag-head">
                <strong>${esc(a.barbearia_nome)}</strong>
                <span class="cl-ag-badges">${a.pago ? '<span class="status-badge status-pago">Pago via PIX</span>' : ''}<span class="status-badge status-${a.status}">${STATUS[a.status] || a.status}</span></span>
              </div>
              <div class="cl-ag-grid">
                <span><i class="fa-solid fa-scissors"></i> ${esc(a.servico_nome)}</span>
                <span><i class="fa-solid fa-user-tie"></i> ${esc(a.profissional_nome || 'A definir')}</span>
                <span><i class="fa-solid fa-calendar-day"></i> ${fmtData(a.data)} às ${a.hora}</span>
                <span><i class="fa-solid fa-tag"></i> ${a.preco_original ? '<s style="color:var(--text-faint)">' + fmtPreco(a.preco_original) + '</s> ' : ''}${fmtPreco(a.preco)}</span>
              </div>
              <p class="cl-ag-id">Nº agendamento: #${String(a.id).padStart(4, '0')}</p>
              ${cancela ? `<button class="btn btn-danger btn-sm" onclick="Cliente.cancelar(${a.id})"><i class="fa-solid fa-ban"></i> Cancelar agendamento</button>` : ''}
            </div>`;
        }).join('')
      : '<p class="cl-empty">Nenhum agendamento encontrado para este WhatsApp.</p>';
  }

  window.Cliente = {
    cancelar(id) {
      abrirCancelar(id);
    }
  };
})();
