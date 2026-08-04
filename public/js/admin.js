/* Painel administrativo — lógica completa */
(function () {
  const $ = (id) => document.getElementById(id);
  const state = { barbeariaId: null, barbearias: [], view: 'dashboard', dono: false, agendaData: null };

  const STATUS = {
    pendente: { label: 'Pendente', icon: 'fa-clock' },
    confirmado: { label: 'Confirmado', icon: 'fa-circle-check' },
    em_atendimento: { label: 'Em atendimento', icon: 'fa-user-clock' },
    concluido: { label: 'Concluído', icon: 'fa-check-double' },
    cancelado: { label: 'Cancelado', icon: 'fa-ban' },
    ausente: { label: 'Ausente', icon: 'fa-user-slash' }
  };

  function esc(str) {
    return String(str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function slugificar(texto) {
    return String(texto).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  }

  async function verificarSlug(slug, excludeId) {
    try {
      const q = '/api/admin/slug-disponivel?slug=' + encodeURIComponent(slug) + (excludeId ? '&exclude=' + excludeId : '');
      return await api(q);
    } catch { return null; }
  }

  async function checarSlug(campoStatus, slug, excludeId) {
    const el = campoStatus;
    if (!el) return;
    if (!slug) { el.textContent = ''; el.className = 'slug-status'; return; }
    const r = await verificarSlug(slug, excludeId);
    if (!r) { el.textContent = ''; el.className = 'slug-status'; return; }
    if (!r.valido) {
      el.textContent = 'Use apenas letras minúsculas, números e hífens (ex.: barbearia-central).';
      el.className = 'slug-status slug-err';
    } else if (!r.disponivel) {
      el.textContent = 'Este link já está em uso. Escolha outro.';
      el.className = 'slug-status slug-err';
    } else {
      el.textContent = 'Link disponível.';
      el.className = 'slug-status slug-ok';
    }
  }

  function fmtPreco(v) {
    return 'R$ ' + (Number(v) || 0).toFixed(2).replace('.', ',');
  }

  function fmtData(d) {
    if (!d) return '';
    const p = String(d).split('-');
    return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : d;
  }

  function toast(msg, tipo) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast show ' + (tipo || '');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => (t.className = 'toast'), 2600);
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'Erro na requisição.'), { data });
    return data;
  }

  function modal(html) {
    $('modalBox').innerHTML = html;
    $('modalOverlay').classList.remove('hidden');
  }
  function fecharModal() { $('modalOverlay').classList.add('hidden'); }

  /* ================= AUTH ================= */
  async function init() {
    try {
      const r = await api('/api/admin/me');
      if (r.admin) {
        entrarAdmin(r.admin);
      } else if (r.barbearia) {
        entrarDono(r.barbearia);
      } else {
        $('loginScreen').classList.remove('hidden');
      }
    } catch { $('loginScreen').classList.remove('hidden'); }
  }

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('loginError');
    err.classList.add('hidden');
    const ident = $('loginUser').value.trim();
    const senha = $('loginPass').value;
    try {
      if (ident.toLowerCase() === 'admin') {
        const r = await api('/api/admin/login', {
          method: 'POST',
          body: JSON.stringify({ username: ident, password: senha })
        });
        entrarAdmin(r.admin);
      } else {
        const r = await api('/api/admin/login-barbearia', {
          method: 'POST',
          body: JSON.stringify({ slug: ident, senha })
        });
        entrarDono(r.barbearia);
      }
    } catch (er) {
      err.textContent = er.message;
      err.classList.remove('hidden');
    }
  });

  function entrarAdmin(admin) {
    $('adminName').textContent = admin.nome || admin.username;
    $('loginScreen').classList.add('hidden');
    $('adminApp').classList.remove('hidden');
    carregarBarbearias();
  }

  function entrarDono(b) {
    state.dono = true;
    $('adminName').textContent = b.nome;
    $('loginScreen').classList.add('hidden');
    $('adminApp').classList.remove('hidden');
    document.querySelectorAll('.admin-only').forEach((el) => el.classList.add('hidden'));
    $('barbeariaSelect').classList.add('hidden');
    state.barbearias = [{ id: Number(b.id), nome: b.nome, slug: b.slug }];
    state.barbeariaId = Number(b.id);
    $('pageTitle').textContent = b.nome;
    carregarView(state.view);
  }

  $('btnLogout').addEventListener('click', async () => {
    await api('/api/admin/logout', { method: 'POST' });
    location.reload();
  });

  /* ================= BARBEARIAS (switch) ================= */
  async function carregarBarbearias() {
    try {
      state.barbearias = await api('/api/admin/barbearias');
      const sel = $('barbeariaSelect');
      sel.innerHTML = state.barbearias.map((b) => `<option value="${b.id}">${esc(b.nome)}</option>`).join('');
      const salvo = localStorage.getItem('admin_barbearia_id');
      const escolha = state.barbearias.find((b) => String(b.id) === salvo) || state.barbearias[0];
      if (escolha) {
        sel.value = escolha.id;
        selecionarBarbearia(escolha.id);
      }
    } catch (er) {
      toast(er.message, 'error');
    }
  }

  $('barbeariaSelect').addEventListener('change', (e) => selecionarBarbearia(Number(e.target.value)));

  function selecionarBarbearia(id) {
    state.barbeariaId = id;
    localStorage.setItem('admin_barbearia_id', id);
    const b = state.barbearias.find((x) => x.id === id);
    $('pageTitle').textContent = b ? b.nome : 'Painel';
    carregarView(state.view);
  }

  /* ================= NAVEGAÇÃO ================= */
  document.querySelectorAll('.nav-item').forEach((el) => {
    el.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
      el.classList.add('active');
      mudarView(el.dataset.view);
      $('sidebar').classList.remove('open');
    });
  });
  $('menuToggle').addEventListener('click', () => $('sidebar').classList.toggle('open'));

  const TITULOS = {
    dashboard: 'Dashboard',
    agenda: 'Agenda',
    agendamentos: 'Agendamentos',
    fila: 'Fila de espera',
    relatorios: 'Relatórios',
    servicos: 'Serviços',
    profissionais: 'Profissionais',
    horarios: 'Horários',
    cupons: 'Cupons',
    fidelidade: 'Fidelidade',
    lembretes: 'Lembretes',
    barbearia: 'Minha barbearia',
    barbearias: 'Todas as barbearias'
  };

  function mudarView(view) {
    state.view = view;
    document.querySelectorAll('.view').forEach((s) => s.classList.add('hidden'));
    $('view-' + view).classList.remove('hidden');
    carregarView(view);
  }

  function carregarView(view) {
    if (!state.barbeariaId) return;
    $('pageTitle').textContent = TITULOS[view];
    if (view === 'dashboard') carregarDashboard();
    if (view === 'agenda') carregarAgenda();
    if (view === 'agendamentos') carregarAgendamentos();
    if (view === 'fila') carregarFila();
    if (view === 'relatorios') carregarRelatorios();
    if (view === 'servicos') carregarServicos();
    if (view === 'profissionais') carregarProfissionais();
    if (view === 'horarios') carregarHorarios();
    if (view === 'cupons') carregarCupons();
    if (view === 'fidelidade') carregarFidelidade();
    if (view === 'lembretes') carregarLembretes();
    if (view === 'barbearia') carregarFormBarbearia();
    if (view === 'barbearias') carregarTodasBarbearias();
  }

  /* ================= DASHBOARD ================= */
  async function carregarDashboard() {
    try {
      const d = await api('/api/admin/estatisticas?barbearia_id=' + state.barbeariaId);
      $('stHoje').textContent = d.hoje;
      $('stPendentes').textContent = d.pendentes;
      $('stMes').textContent = d.total_mes;
      $('stReceita').textContent = fmtPreco(d.receita_mes);
      $('stClientes').textContent = d.clientes;

      const max = Math.max(...d.semana.map((s) => s.total), 1);
      if (!d.semana.reduce((a, s) => a + s.total, 0)) {
        $('weekChart').innerHTML = '<div class="chart-empty"><i class="fa-solid fa-chart-simple"></i><span>Sem agendamentos nos últimos 7 dias</span></div>';
      } else {
        $('weekChart').innerHTML = d.semana.map((s) => `
          <div class="chart-col">
            <div class="chart-bar" style="height:${(s.total / max) * 100}%" title="${s.total} agendamentos">
              <span>${s.total}</span>
            </div>
            <div class="chart-label">${s.dia}</div>
          </div>
        `).join('');
      }

      $('proximosList').innerHTML = d.proximos.length ? d.proximos.map((a) => `
        <div class="list-item">
          <div class="avatar">${esc((a.nome_cliente || '?').split(' ').map((n) => n[0]).slice(0, 2).join('').toUpperCase())}</div>
          <div class="info">
            <strong>${esc(a.nome_cliente)}</strong>
            <span>${esc(a.servico_nome)} ${a.profissional_nome ? '· ' + esc(a.profissional_nome) : ''}</span>
          </div>
          <div class="when">${fmtData(a.data)}<br>${a.hora}</div>
        </div>
      `).join('') : '<div class="empty-list">Nenhum agendamento futuro.</div>';
    } catch (er) { toast(er.message, 'error'); }
  }

  /* ================= AGENDAMENTOS ================= */
  $('filtroData').value = '';
  $('filtroData').addEventListener('change', carregarAgendamentos);
  $('filtroStatus').addEventListener('change', carregarAgendamentos);

  async function carregarAgendamentos() {
    const params = new URLSearchParams({ barbearia_id: state.barbeariaId });
    if ($('filtroData').value) params.set('data', $('filtroData').value);
    if ($('filtroStatus').value) params.set('status', $('filtroStatus').value);
    try {
      const lista = await api('/api/admin/agendamentos?' + params.toString());
      $('agendamentosBody').innerHTML = lista.length ? lista.map((a) => `
        <tr>
          <td>#${String(a.id).padStart(4, '0')}</td>
          <td><strong>${esc(a.nome_cliente)}</strong><br><span style="color:var(--text-faint);font-size:.78rem">${esc(a.telefone_cliente)}</span></td>
          <td>${esc(a.servico_nome)}</td>
          <td>${esc(a.profissional_nome || '—')}</td>
          <td>${fmtData(a.data)}</td>
          <td>${a.hora}</td>
          <td>${a.preco_original ? '<span style="text-decoration:line-through;color:var(--text-faint)">' + fmtPreco(a.preco_original) + '</span> ' : ''}${fmtPreco(a.preco)}</td>
          <td><span class="status-badge status-${a.status}"><i class="fa-solid ${STATUS[a.status].icon}"></i> ${STATUS[a.status].label}</span>${a.pago ? '<span class="status-badge status-pago"><i class="fa-solid fa-check"></i> Pago</span>' : ''}</td>
          <td class="td-actions">${acoesAgendamento(a)}</td>
        </tr>
      `).join('') : '<tr><td colspan="9" class="empty-list">Nenhum agendamento encontrado.</td></tr>';
    } catch (er) { toast(er.message, 'error'); }
  }

  function acoesAgendamento(a) {
    let botoes = '';
    if (a.status === 'pendente') botoes += `<button class="btn btn-blue btn-sm" title="Confirmar" onclick="AdminAcoes.confirmar(${a.id})"><i class="fa-solid fa-check"></i> Confirmar</button>`;
    if (a.status === 'pendente' || a.status === 'confirmado') botoes += `<button class="btn btn-gold btn-sm" title="Em atendimento" onclick="AdminAcoes.atender(${a.id})"><i class="fa-solid fa-user-clock"></i></button>`;
    if (a.status === 'pendente' || a.status === 'confirmado' || a.status === 'em_atendimento') botoes += `<button class="btn btn-green btn-sm" title="Concluir" onclick="AdminAcoes.concluir(${a.id})"><i class="fa-solid fa-check-double"></i></button>`;
    if (a.status === 'pendente' || a.status === 'confirmado' || a.status === 'em_atendimento') botoes += `<button class="btn btn-orange btn-sm" title="Não compareceu" onclick="AdminAcoes.ausente(${a.id})"><i class="fa-solid fa-user-slash"></i></button>`;
    if (a.status === 'pendente' || a.status === 'confirmado' || a.status === 'em_atendimento') botoes += `<button class="btn btn-danger btn-sm" title="Cancelar" onclick="AdminAcoes.cancelar(${a.id})"><i class="fa-solid fa-ban"></i></button>`;
    if (a.telefone_cliente) botoes += `<a class="btn btn-whats btn-sm" title="Lembrete no WhatsApp" target="_blank" rel="noopener" href="${whatsLembreteUrl(a)}"><i class="fa-brands fa-whatsapp"></i></a>`;
    botoes += `<button class="btn btn-ghost btn-sm" title="PIX" onclick="AdminAcoes.pix(${a.id})"><i class="fa-solid fa-qrcode"></i></button>`;
    botoes += `<button class="btn btn-ghost btn-sm" onclick="AdminAcoes.excluir(${a.id})"><i class="fa-solid fa-trash"></i></button>`;
    return botoes;
  }

  function whatsLembreteUrl(a) {
    const tel = String(a.telefone_cliente || '').replace(/\D/g, '');
    const msg = encodeURIComponent(
      `Olá ${a.nome_cliente}! Lembrete do seu agendamento na barbearia:\n\n` +
      `Serviço: ${a.servico_nome || ''}\n` +
      `Data: ${fmtData(a.data)} às ${a.hora}\n` +
      `Nº: #${String(a.id).padStart(4, '0')}\n\n` +
      `Qualquer dúvida, é só chamar!`
    );
    return 'https://wa.me/55' + tel + '?text=' + msg;
  }

  window.AdminAcoes = {
    async confirmar(id) { await mudarStatus(id, 'confirmado'); },
    async atender(id) { await mudarStatus(id, 'em_atendimento'); },
    async concluir(id) { await mudarStatus(id, 'concluido'); },
    async ausente(id) { await mudarStatus(id, 'ausente'); },
    cancelar(id) { cancelarComMotivo(id); },
    excluir(id) {
      modal(`
        <h3>Excluir agendamento</h3>
        <p class="confirm-text">Tem certeza que deseja excluir o agendamento <strong>#${String(id).padStart(4, '0')}</strong>? Esta ação não pode ser desfeita.</p>
        <div class="modal-actions">
          <button class="btn btn-ghost" onclick="AdminModal.fechar()">Cancelar</button>
          <button class="btn btn-danger" id="btnConfExcluir">Excluir</button>
        </div>
      `);
      $('btnConfExcluir').addEventListener('click', async () => {
        await api('/api/admin/agendamentos/' + id, { method: 'DELETE' });
        fecharModal();
        toast('Agendamento excluído.', 'success');
        recarregarAtual();
      });
    },
    async pix(id) {
      try {
        const a = await api('/api/admin/agendamentos?barbearia_id=' + state.barbeariaId + '&_all=1');
        const item = a.find((x) => x.id === id);
        if (!item) return toast('Agendamento não encontrado.', 'error');
        const b = await api('/api/admin/barbearias/' + state.barbeariaId);
        if (!b.pix_chave) return toast('Configure a chave PIX em "Minha barbearia" primeiro.', 'error');
        abrirPixModal(b, item);
      } catch (er) { toast(er.message, 'error'); }
    }
  };

  function cancelarComMotivo(id) {
    modal(`
      <h3>Cancelar agendamento #${String(id).padStart(4, '0')}</h3>
      <form id="formCancel">
        <div class="form-group"><label>Motivo do cancelamento</label>
          <select id="canMotivo" class="form-control">
            <option value="">Selecione (opcional)</option>
            <option>Cliente desistiu</option>
            <option>Cliente não respondeu</option>
            <option>Imprevisto da barbearia</option>
            <option>Falta de profissional</option>
          </select>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" onclick="AdminModal.fechar()">Voltar</button>
          <button type="submit" class="btn btn-danger">Cancelar agendamento</button>
        </div>
      </form>
    `);
    $('formCancel').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/api/admin/agendamentos/' + id, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'cancelado', motivo: $('canMotivo').value })
        });
        fecharModal();
        toast('Agendamento cancelado.', 'success');
        recarregarAtual();
      } catch (er) { toast(er.message, 'error'); }
    });
  }

  function abrirPixModal(b, item) {
    modal(`
      <h3>PIX — #${String(item.id).padStart(4, '0')}</h3>
      <p class="confirm-text">${esc(item.nome_cliente)} · ${fmtData(item.data)} ${item.hora} · ${fmtPreco(item.preco)}</p>
      <div class="pix-box">
        <p class="pix-key">${esc(b.pix_chave)}</p>
      </div>
      <p class="slug-note">Realize o PIX para a chave acima e envie o comprovante no WhatsApp da barbearia.</p>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="AdminModal.fechar()">Fechar</button>
      </div>
    `);
  }

  function recarregarAtual() {
    if (state.view === 'agendamentos') carregarAgendamentos();
    else if (state.view === 'agenda') carregarAgenda();
    else if (state.view === 'dashboard') carregarDashboard();
  }

  async function mudarStatus(id, status) {
    try {
      await api('/api/admin/agendamentos/' + id, { method: 'PATCH', body: JSON.stringify({ status }) });
      toast('Status atualizado para ' + STATUS[status].label + '.', 'success');
      recarregarAtual();
    } catch (er) { toast(er.message, 'error'); }
  }

  async function abrirModalNovoAgendamento(prefill = {}) {
    try {
      const [servicos, profissionais] = await Promise.all([
        api('/api/admin/servicos?barbearia_id=' + state.barbeariaId),
        api('/api/admin/profissionais?barbearia_id=' + state.barbeariaId)
      ]);
      modal(`
        <h3>Novo agendamento</h3>
        <form id="formNovoAg">
          <div class="form-group"><label>Cliente *</label><input type="text" id="naCliente" class="form-control" value="${esc(prefill.nome_cliente || '')}" required></div>
          <div class="form-group"><label>WhatsApp *</label><input type="text" id="naTel" class="form-control" value="${esc(prefill.telefone_cliente || '')}" required></div>
          <div class="form-group"><label>Serviço *</label>
            <select id="naServico" class="form-control" required>${servicos.map((s) => `<option value="${s.id}" ${prefill.servico_id === s.id ? 'selected' : ''}>${esc(s.nome)} — ${fmtPreco(s.preco)}</option>`).join('')}</select>
          </div>
          <div class="form-group"><label>Profissional</label>
            <select id="naProf" class="form-control"><option value="">Qualquer</option>${profissionais.map((p) => `<option value="${p.id}" ${prefill.profissional_id === p.id ? 'selected' : ''}>${esc(p.nome)}</option>`).join('')}</select>
          </div>
          <div class="form-row-3">
            <div class="form-group"><label>Data *</label><input type="date" id="naData" class="form-control" value="${esc(prefill.data || '')}" required></div>
            <div class="form-group"><label>Hora *</label><input type="time" id="naHora" class="form-control" value="${esc(prefill.hora || '')}" required></div>
            <div class="form-group"><label>Status</label>
              <select id="naStatus" class="form-control"><option value="confirmado">Confirmado</option><option value="pendente">Pendente</option><option value="em_atendimento">Em atendimento</option></select>
            </div>
          </div>
          <div class="form-group"><label>Observação</label><textarea id="naObs" class="form-control">${esc(prefill.observacao || '')}</textarea></div>
          <div class="modal-actions">
            <button type="button" class="btn btn-ghost" onclick="AdminModal.fechar()">Cancelar</button>
            <button type="submit" class="btn btn-gold">Salvar</button>
          </div>
        </form>
      `);
      $('formNovoAg').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await api('/api/admin/agendamentos', {
            method: 'POST',
            body: JSON.stringify({
              barbearia_id: state.barbeariaId,
              servico_id: Number($('naServico').value),
              profissional_id: $('naProf').value ? Number($('naProf').value) : null,
              nome_cliente: $('naCliente').value.trim(),
              telefone_cliente: $('naTel').value.trim(),
              data: $('naData').value,
              hora: $('naHora').value,
              status: $('naStatus').value,
              observacao: $('naObs').value.trim()
            })
          });
          if (prefill.filaId) {
            await api('/api/admin/fila/' + prefill.filaId, { method: 'PATCH', body: JSON.stringify({ status: 'agendado' }) });
          }
          fecharModal();
          toast('Agendamento criado!', 'success');
          if (prefill.filaId) carregarFila();
          carregarAgendamentos();
          carregarAgenda();
        } catch (er) { toast(er.message, 'error'); }
      });
    } catch (er) { toast(er.message, 'error'); }
  }

  $('btnNovoAgendamento').addEventListener('click', () => abrirModalNovoAgendamento());

  /* ================= AGENDA VISUAL ================= */
  function hojeStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function minutosDe(t) {
    if (!t) return null;
    const [h, m] = String(t).split(':').map(Number);
    return h * 60 + m;
  }
  function formatHora(min) {
    return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
  }

  $('agendaData').value = hojeStr();
  $('btnAgendaHoje').addEventListener('click', () => { $('agendaData').value = hojeStr(); carregarAgenda(); });
  $('btnAgendaVoltar').addEventListener('click', () => { mudarData(-1); });
  $('btnAgendaAvancar').addEventListener('click', () => { mudarData(1); });
  $('agendaData').addEventListener('change', carregarAgenda);
  $('btnBloquearDia').addEventListener('click', () => abrirBloqueio($('agendaData').value));

  function mudarData(n) {
    const [y, m, d] = $('agendaData').value.split('-').map(Number);
    const dt = new Date(y, m - 1, d + n);
    $('agendaData').value = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
    carregarAgenda();
  }

  async function carregarAgenda() {
    const data = $('agendaData').value || hojeStr();
    $('agendaData').value = data;
    const el = $('agendaGrid');
    el.innerHTML = '<div class="ag-loading"><i class="fa-solid fa-circle-notch fa-spin"></i> Carregando agenda...</div>';
    try {
      const ag = await api('/api/admin/agenda?barbearia_id=' + state.barbeariaId + '&data=' + data);
      state._agendaAppts = ag.agendamentos;
      renderAgenda(ag);
    } catch (er) {
      el.innerHTML = '<div class="empty-list">' + esc(er.message) + '</div>';
    }
  }

  function fmtDataLonga(dataStr) {
    const [y, m, d] = dataStr.split('-').map(Number);
    const dias = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
    const meses = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
    const dt = new Date(y, m - 1, d);
    return dias[dt.getDay()] + ', ' + d + ' de ' + meses[m - 1] + ' de ' + y;
  }

  function renderAgenda(ag) {
    const el = $('agendaGrid');
    $('agendaSub').textContent = fmtDataLonga(ag.data) + (ag.aberto ? ' · ' + ag.abertura + ' às ' + ag.fechamento : ' · Barbearia fechada nesta data');
    if (!ag.aberto) {
      el.innerHTML = '<div class="ag-fechado"><i class="fa-solid fa-door-closed"></i> Barbearia fechada nesta data.</div>';
      return;
    }
    const a = minutosDe(ag.abertura);
    const f = minutosDe(ag.fechamento);
    const intervalo = Number(ag.intervalo) || 30;
    const ROW = 44;
    const nSlots = Math.round((f - a) / intervalo);
    const profs = ag.profissionais.length ? ag.profissionais : [{ id: null, nome: 'Geral' }];

    let html = '<div class="ag-head"><div class="ag-time-head">Horário</div>' +
      profs.map((p) => `<div class="ag-col-head">${esc(p.nome)}</div>`).join('') + '</div>';

    html += '<div class="agenda-grid">';
    html += '<div class="ag-time-col">';
    for (let i = 0; i < nSlots; i++) html += `<div class="ag-time" style="height:${ROW}px">${formatHora(a + i * intervalo)}</div>`;
    html += '</div>';

    profs.forEach((p) => {
      const pkey = p.id === null ? '' : String(p.id);
      html += `<div class="ag-col" style="--rows:${nSlots};--rowh:${ROW}px">`;
      for (let i = 0; i < nSlots; i++) {
        html += `<div class="ag-cell" data-hora="${formatHora(a + i * intervalo)}" data-prof="${pkey}"></div>`;
      }
      (state._agendaAppts || []).filter((x) => String(x.profissional_id || '') === pkey).forEach((x) => {
        const t = minutosDe(x.hora);
        const top = ((t - a) / intervalo) * ROW;
        const h = (x.duracao / intervalo) * ROW - 4;
        html += `<div class="ag-appt status-${x.status}" style="top:${Math.max(top, 0)}px;height:${Math.max(h, 18)}px" onclick="AdminAgenda.ver(${x.id})">
          <strong>${esc(x.nome_cliente)}</strong><span>${esc(x.servico_nome)} · ${x.hora}</span>
        </div>`;
      });
      html += '</div>';
    });

    (ag.bloqueios || []).forEach((bl) => {
      let top = 0, h = nSlots * ROW;
      if (!bl.dia_inteiro) {
        const bi = minutosDe(bl.hora_inicio), bf = minutosDe(bl.hora_fim);
        if (bi !== null && bf !== null && bf > bi) { top = ((bi - a) / intervalo) * ROW; h = ((bf - bi) / intervalo) * ROW; }
      }
      html += `<div class="ag-block-strip" style="top:${Math.max(top, 0)}px;height:${Math.max(h, 18)}px" title="${esc(bl.motivo || 'Bloqueado')}"><i class="fa-solid fa-lock"></i> ${esc(bl.motivo || 'Bloqueado')}</div>`;
    });

    html += '</div>';
    el.innerHTML = html;

    el.querySelectorAll('.ag-cell').forEach((cell) => {
      cell.addEventListener('click', () => {
        abrirModalNovoAgendamento({
          data: ag.data,
          hora: cell.dataset.hora,
          profissional_id: cell.dataset.prof ? Number(cell.dataset.prof) : null
        });
      });
    });
  }

  window.AdminAgenda = {
    async ver(id) {
      const a = (state._agendaAppts || []).find((x) => x.id === id);
      if (!a) return toast('Agendamento não encontrado.', 'error');
      modal(`
        <h3>#${String(a.id).padStart(4, '0')} — ${esc(a.nome_cliente)}</h3>
        <div class="resumo">
          <div class="row"><span>Serviço</span><strong>${esc(a.servico_nome)}</strong></div>
          <div class="row"><span>Profissional</span><strong>${esc(a.profissional_nome || 'A definir')}</strong></div>
          <div class="row"><span>Data</span><strong>${fmtData(a.data)} às ${a.hora}</strong></div>
          <div class="row"><span>Valor</span><strong>${fmtPreco(a.preco)}</strong></div>
          <div class="row"><span>Status</span><strong><span class="status-badge status-${a.status}">${STATUS[a.status].label}</span></strong></div>
          ${a.motivo_cancelamento ? `<div class="row"><span>Motivo</span><strong>${esc(a.motivo_cancelamento)}</strong></div>` : ''}
        </div>
        <div class="modal-actions ag-modal-actions">
          ${a.status === 'pendente' ? `<button class="btn btn-blue btn-sm" onclick="AdminAcoes.confirmar(${a.id});AdminModal.fechar()"><i class="fa-solid fa-check"></i> Confirmar</button>` : ''}
          ${(a.status === 'pendente' || a.status === 'confirmado') ? `<button class="btn btn-gold btn-sm" onclick="AdminAcoes.atender(${a.id});AdminModal.fechar()"><i class="fa-solid fa-user-clock"></i> Atender</button>` : ''}
          ${(a.status === 'pendente' || a.status === 'confirmado' || a.status === 'em_atendimento') ? `<button class="btn btn-green btn-sm" onclick="AdminAcoes.concluir(${a.id});AdminModal.fechar()"><i class="fa-solid fa-check-double"></i> Concluir</button>` : ''}
          ${(a.status === 'pendente' || a.status === 'confirmado' || a.status === 'em_atendimento') ? `<button class="btn btn-danger btn-sm" onclick="AdminAcoes.cancelar(${a.id});AdminModal.fechar()"><i class="fa-solid fa-ban"></i> Cancelar</button>` : ''}
          ${a.telefone_cliente ? `<a class="btn btn-whats btn-sm" target="_blank" rel="noopener" href="${whatsLembreteUrl(a)}"><i class="fa-brands fa-whatsapp"></i> Lembrete</a>` : ''}
          <button class="btn btn-ghost btn-sm" onclick="AdminModal.fechar()">Fechar</button>
        </div>
      `);
    }
  };

  /* ================= BLOQUEIOS ================= */
  async function carregarBloqueios() {
    try {
      const lista = await api('/api/admin/bloqueios?barbearia_id=' + state.barbeariaId);
      $('bloqueiosBody').innerHTML = lista.length ? lista.map((b) => `
        <tr>
          <td>${fmtData(b.data)}</td>
          <td>${b.dia_inteiro ? 'Dia inteiro' : (b.hora_inicio + ' às ' + b.hora_fim)}</td>
          <td style="color:var(--text-dim)">${esc(b.motivo || '—')}</td>
          <td class="td-actions"><button class="btn btn-danger btn-sm" onclick="AdminBloqueios.remover(${b.id})"><i class="fa-solid fa-trash"></i></button></td>
        </tr>
      `).join('') : '<tr><td colspan="4" class="empty-list">Nenhum bloqueio.</td></tr>';
    } catch (er) { toast(er.message, 'error'); }
  }

  $('btnNovoBloqueio').addEventListener('click', () => abrirBloqueio());

  function abrirBloqueio(dataPadrao) {
    modal(`
      <h3>Novo bloqueio / folga</h3>
      <form id="formBloqueio">
        <div class="form-group"><label>Data *</label><input type="date" id="blData" class="form-control" value="${esc(dataPadrao || '')}" required></div>
        <div class="form-group"><label class="switch" style="margin-top:8px"><input type="checkbox" id="blDiaInteiro" checked><span class="slider"></span><span>Dia inteiro</span></label></div>
        <div class="form-row-2">
          <div class="form-group"><label>De</label><input type="time" id="blInicio" class="form-control"></div>
          <div class="form-group"><label>Até</label><input type="time" id="blFim" class="form-control"></div>
        </div>
        <div class="form-group"><label>Motivo</label><input type="text" id="blMotivo" class="form-control" placeholder="Folga, feriado, manutenção..."></div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" onclick="AdminModal.fechar()">Cancelar</button>
          <button type="submit" class="btn btn-gold">Salvar</button>
        </div>
      </form>
    `);
    $('formBloqueio').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/api/admin/bloqueios', {
          method: 'POST',
          body: JSON.stringify({
            barbearia_id: state.barbeariaId,
            data: $('blData').value,
            dia_inteiro: $('blDiaInteiro').checked ? 1 : 0,
            hora_inicio: $('blInicio').value,
            hora_fim: $('blFim').value,
            motivo: $('blMotivo').value.trim()
          })
        });
        fecharModal();
        toast('Bloqueio salvo!', 'success');
        carregarBloqueios();
        carregarAgenda();
      } catch (er) { toast(er.message, 'error'); }
    });
  }

  window.AdminBloqueios = {
    async remover(id) {
      await api('/api/admin/bloqueios/' + id, { method: 'DELETE' });
      toast('Bloqueio removido.', 'success');
      carregarBloqueios();
      carregarAgenda();
    }
  };

  /* ================= FILA DE ESPERA ================= */
  $('filaStatus').addEventListener('change', carregarFila);

  function waLinkCliente(nome, tel, texto) {
    const digits = String(tel || '').replace(/\D/g, '');
    const msg = encodeURIComponent(texto);
    return 'https://wa.me/55' + digits + '?text=' + msg;
  }

  async function carregarFila() {
    const params = new URLSearchParams({ barbearia_id: state.barbeariaId });
    if ($('filaStatus').value) params.set('status', $('filaStatus').value);
    try {
      const lista = await api('/api/admin/fila?' + params.toString());
      $('filaBody').innerHTML = lista.length ? lista.map((f) => `
        <tr>
          <td><strong>${esc(f.nome_cliente)}</strong></td>
          <td>${esc(f.telefone_cliente)}</td>
          <td>${esc(f.servico_nome || '—')}</td>
          <td>${f.data_preferida ? fmtData(f.data_preferida) : '—'}</td>
          <td><span class="status-badge ${f.status === 'agendado' ? 'status-concluido' : f.status === 'descartado' ? 'status-cancelado' : 'status-pendente'}">${esc(f.status)}</span></td>
          <td class="td-actions">
            ${(f.status === 'aguardando' || f.status === 'contatado') ? `<button class="btn btn-gold btn-sm" onclick="AdminFila.agendar(${f.id})"><i class="fa-solid fa-calendar-plus"></i> Agendar</button>` : ''}
            ${f.status === 'aguardando' ? `<button class="btn btn-blue btn-sm" onclick="AdminFila.contatar(${f.id})"><i class="fa-solid fa-phone"></i></button>` : ''}
            ${f.telefone_cliente ? `<a class="btn btn-whats btn-sm" title="Chamar no WhatsApp" target="_blank" rel="noopener" href="${waLinkCliente(f.nome_cliente, f.telefone_cliente, 'Olá ' + f.nome_cliente + '! Sua barbearia entrou em contato: um horário ficou livre. Quer agendar?')}"><i class="fa-brands fa-whatsapp"></i></a>` : ''}
            <button class="btn btn-danger btn-sm" title="Descartar" onclick="AdminFila.descartar(${f.id})"><i class="fa-solid fa-xmark"></i></button>
          </td>
        </tr>
      `).join('') : '<tr><td colspan="6" class="empty-list">Nenhum cliente na fila.</td></tr>';
    } catch (er) { toast(er.message, 'error'); }
  }

  window.AdminFila = {
    async agendar(id) {
      try {
        const lista = await api('/api/admin/fila?barbearia_id=' + state.barbeariaId);
        const f = lista.find((x) => x.id === id);
        if (!f) return toast('Entrada não encontrada.', 'error');
        abrirModalNovoAgendamento({
          nome_cliente: f.nome_cliente,
          telefone_cliente: f.telefone_cliente,
          servico_id: f.servico_id || undefined,
          data: f.data_preferida || undefined,
          filaId: id
        });
      } catch (er) { toast(er.message, 'error'); }
    },
    async contatar(id) {
      await api('/api/admin/fila/' + id, { method: 'PATCH', body: JSON.stringify({ status: 'contatado' }) });
      carregarFila();
    },
    descartar(id) {
      modal(`
        <h3>Descartar da fila</h3>
        <p class="confirm-text">Remover este cliente da fila de espera?</p>
        <div class="modal-actions">
          <button class="btn btn-ghost" onclick="AdminModal.fechar()">Cancelar</button>
          <button class="btn btn-danger" id="btnDescFila">Descartar</button>
        </div>
      `);
      $('btnDescFila').addEventListener('click', async () => {
        await api('/api/admin/fila/' + id, { method: 'DELETE' });
        fecharModal();
        carregarFila();
      });
    }
  };

  /* ================= RELATÓRIOS ================= */
  $('btnRelGerar').addEventListener('click', carregarRelatorios);
  $('btnRelCsv').addEventListener('click', () => {
    const de = $('relDe').value, ate = $('relAte').value;
    window.open('/api/admin/agendamentos.csv?barbearia_id=' + state.barbeariaId + '&de=' + de + '&ate=' + ate, '_blank');
  });

  function tabelaRel(rows, cols) {
    if (!rows.length) return '<tr><td colspan="' + cols.length + '" class="empty-list">Sem dados no período.</td></tr>';
    return rows.map((x) => {
      const celulas = cols.map((c) => {
        if (c === 'receita') return fmtPreco(x[c]);
        return esc(x[c]);
      });
      return '<tr>' + celulas.map((c) => `<td>${c}</td>`).join('') + '</tr>';
    }).join('');
  }

  async function carregarRelatorios() {
    if (!$('relDe').value) {
      const d = new Date();
      $('relDe').value = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-01';
      $('relAte').value = hojeStr();
    }
    const de = $('relDe').value, ate = $('relAte').value;
    try {
      const r = await api('/api/admin/relatorios?barbearia_id=' + state.barbeariaId + '&de=' + de + '&ate=' + ate);
      $('relStats').innerHTML = `
        <div class="stat-card"><i class="fa-solid fa-calendar-day stat-icon gold"></i><div><span>Agendamentos</span><strong>${r.total_agendamentos}</strong></div></div>
        <div class="stat-card"><i class="fa-solid fa-check-double stat-icon green"></i><div><span>Concluídos</span><strong>${r.concluidos.qtd}</strong></div></div>
        <div class="stat-card"><i class="fa-solid fa-sack-dollar stat-icon green"></i><div><span>Receita concluída</span><strong>${fmtPreco(r.concluidos.receita)}</strong></div></div>
        <div class="stat-card"><i class="fa-solid fa-tag stat-icon blue"></i><div><span>Ticket médio</span><strong>${fmtPreco(r.ticket_medio)}</strong></div></div>
        <div class="stat-card"><i class="fa-solid fa-ban stat-icon red"></i><div><span>Cancelados</span><strong>${r.cancelados}</strong></div></div>
      `;
      $('relServicoBody').innerHTML = tabelaRel(r.por_servico, ['nome', 'qtd', 'receita']);
      $('relProfBody').innerHTML = tabelaRel(r.por_profissional, ['nome', 'qtd', 'receita']);
      $('relDiaBody').innerHTML = r.por_dia.length ? r.por_dia.map((x) => `<tr><td>${fmtData(x.data)}</td><td>${x.qtd}</td><td>${fmtPreco(x.receita)}</td></tr>`).join('') : '<tr><td colspan="3" class="empty-list">Sem dados no período.</td></tr>';
      $('relPendBody').innerHTML = r.pendentes.length ? r.pendentes.map((a) => `
        <tr><td>#${String(a.id).padStart(4, '0')}</td><td>${esc(a.nome_cliente)}</td><td>${esc(a.servico_nome)}</td><td>${fmtData(a.data)}</td><td>${a.hora}</td><td>${fmtPreco(a.preco)}</td><td><span class="status-badge status-${a.status}">${STATUS[a.status].label}</span></td></tr>
      `).join('') : '<tr><td colspan="7" class="empty-list">Nenhum pendente no período.</td></tr>';
    } catch (er) { toast(er.message, 'error'); }
  }

  /* ================= CSV + BACKUP ================= */
  $('btnExportCsv').addEventListener('click', () => {
    const params = new URLSearchParams({ barbearia_id: state.barbeariaId });
    if ($('filtroData').value) params.set('data', $('filtroData').value);
    if ($('filtroStatus').value) params.set('status', $('filtroStatus').value);
    window.open('/api/admin/agendamentos.csv?' + params.toString(), '_blank');
  });
  $('btnBackup').addEventListener('click', () => window.open('/api/admin/backup', '_blank'));

  /* ================= SERVIÇOS ================= */
  async function carregarServicos() {
    try {
      const lista = await api('/api/admin/servicos?barbearia_id=' + state.barbeariaId);
      $('servicosBody').innerHTML = lista.length ? lista.map((s) => `
        <tr>
          <td><strong>${esc(s.nome)}</strong></td>
          <td style="color:var(--text-dim);max-width:260px">${esc(s.descricao)}</td>
          <td>${s.duracao} min</td>
          <td><strong style="color:var(--gold)">${fmtPreco(s.preco)}</strong></td>
          <td><span class="status-badge ${s.ativo ? 'status-concluido' : 'status-cancelado'}">${s.ativo ? 'Ativo' : 'Inativo'}</span></td>
          <td class="td-actions">
            <button class="btn btn-ghost btn-sm" onclick="AdminServicos.editar(${s.id})"><i class="fa-solid fa-pen"></i></button>
            <button class="btn btn-danger btn-sm" onclick="AdminServicos.excluir(${s.id})"><i class="fa-solid fa-trash"></i></button>
          </td>
        </tr>
      `).join('') : '<tr><td colspan="6" class="empty-list">Nenhum serviço cadastrado.</td></tr>';
    } catch (er) { toast(er.message, 'error'); }
  }

  $('btnNovoServico').addEventListener('click', () => formularioServico());

  function formularioServico(s) {
    modal(`
      <h3>${s ? 'Editar serviço' : 'Novo serviço'}</h3>
      <form id="formServico">
        <div class="form-group"><label>Nome *</label><input type="text" id="svNome" class="form-control" value="${s ? esc(s.nome) : ''}" required></div>
        <div class="form-group"><label>Descrição</label><textarea id="svDesc" class="form-control">${s ? esc(s.descricao) : ''}</textarea></div>
        <div class="form-row-3">
          <div class="form-group"><label>Preço (R$) *</label><input type="number" id="svPreco" class="form-control" step="0.01" min="0" value="${s ? s.preco : ''}" required></div>
          <div class="form-group"><label>Duração (min) *</label><input type="number" id="svDur" class="form-control" min="5" step="5" value="${s ? s.duracao : 30}" required></div>
          <div class="form-group"><label>Ativo</label><label class="switch" style="margin-top:8px"><input type="checkbox" id="svAtivo" ${!s || s.ativo ? 'checked' : ''}><span class="slider"></span></label></div>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" onclick="AdminModal.fechar()">Cancelar</button>
          <button type="submit" class="btn btn-gold">Salvar</button>
        </div>
      </form>
    `);
    $('formServico').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = {
        nome: $('svNome').value.trim(),
        descricao: $('svDesc').value.trim(),
        preco: Number($('svPreco').value),
        duracao: Number($('svDur').value),
        ativo: $('svAtivo').checked ? 1 : 0
      };
      try {
        if (s) await api('/api/admin/servicos/' + s.id, { method: 'PUT', body: JSON.stringify(body) });
        else await api('/api/admin/servicos', { method: 'POST', body: JSON.stringify({ barbearia_id: state.barbeariaId, ...body }) });
        fecharModal();
        toast('Serviço salvo!', 'success');
        carregarServicos();
      } catch (er) { toast(er.message, 'error'); }
    });
  }

  window.AdminServicos = {
    editar(id) {
      const s = JSON.parse(sessionStorage.getItem('_servicos_' + state.barbeariaId)) || [];
      const item = s.find((x) => x.id === id);
      if (item) formularioServico(item);
    },
    excluir(id) {
      modal(`
        <h3>Excluir serviço</h3>
        <p class="confirm-warn"><i class="fa-solid fa-triangle-exclamation"></i> Excluir um serviço pode afetar agendamentos antigos vinculados a ele.</p>
        <div class="modal-actions">
          <button class="btn btn-ghost" onclick="AdminModal.fechar()">Cancelar</button>
          <button class="btn btn-danger" id="btnConfServ">Excluir</button>
        </div>
      `);
      $('btnConfServ').addEventListener('click', async () => {
        await api('/api/admin/servicos/' + id, { method: 'DELETE' });
        fecharModal();
        toast('Serviço excluído.', 'success');
        carregarServicos();
      });
    }
  };

  /* Cache para o formulário de edição */
  async function carregarServicosComCache() {
    const lista = await api('/api/admin/servicos?barbearia_id=' + state.barbeariaId);
    sessionStorage.setItem('_servicos_' + state.barbeariaId, JSON.stringify(lista));
    return lista;
  }
  const _carregarServicos = carregarServicos;
  carregarServicos = async function () {
    await carregarServicosComCache().catch(() => []);
    return _carregarServicos();
  };

  /* ================= PROFISSIONAIS ================= */
  async function carregarProfissionais() {
    try {
      const lista = await api('/api/admin/profissionais?barbearia_id=' + state.barbeariaId);
      $('profissionaisBody').innerHTML = lista.length ? lista.map((p) => `
        <tr>
          <td><strong>${esc(p.nome)}</strong></td>
          <td style="color:var(--text-dim)">${esc(p.cargo || '—')}</td>
          <td><span class="status-badge ${p.ativo ? 'status-concluido' : 'status-cancelado'}">${p.ativo ? 'Ativo' : 'Inativo'}</span></td>
          <td class="td-actions">
            <button class="btn btn-ghost btn-sm" onclick="AdminProfs.editar(${p.id})"><i class="fa-solid fa-pen"></i></button>
            <button class="btn btn-danger btn-sm" onclick="AdminProfs.excluir(${p.id})"><i class="fa-solid fa-trash"></i></button>
          </td>
        </tr>
      `).join('') : '<tr><td colspan="4" class="empty-list">Nenhum profissional cadastrado.</td></tr>';
    } catch (er) { toast(er.message, 'error'); }
  }

  $('btnNovoProfissional').addEventListener('click', () => formularioProfissional());

  function formularioProfissional(p) {
    modal(`
      <h3>${p ? 'Editar profissional' : 'Novo profissional'}</h3>
      <form id="formProf">
        <div class="form-group"><label>Nome *</label><input type="text" id="pfNome" class="form-control" value="${p ? esc(p.nome) : ''}" required></div>
        <div class="form-group"><label>Cargo</label><input type="text" id="pfCargo" class="form-control" value="${p ? esc(p.cargo) : ''}" placeholder="Barbeiro Sênior"></div>
        <div class="form-group"><label>Ativo</label><label class="switch"><input type="checkbox" id="pfAtivo" ${!p || p.ativo ? 'checked' : ''}><span class="slider"></span></label></div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" onclick="AdminModal.fechar()">Cancelar</button>
          <button type="submit" class="btn btn-gold">Salvar</button>
        </div>
      </form>
    `);
    $('formProf').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = { nome: $('pfNome').value.trim(), cargo: $('pfCargo').value.trim(), ativo: $('pfAtivo').checked ? 1 : 0 };
      try {
        if (p) await api('/api/admin/profissionais/' + p.id, { method: 'PUT', body: JSON.stringify(body) });
        else await api('/api/admin/profissionais', { method: 'POST', body: JSON.stringify({ barbearia_id: state.barbeariaId, ...body }) });
        fecharModal();
        toast('Profissional salvo!', 'success');
        carregarProfissionais();
      } catch (er) { toast(er.message, 'error'); }
    });
  }

  window.AdminProfs = {
    editar(id) {
      const s = JSON.parse(sessionStorage.getItem('_profs_' + state.barbeariaId)) || [];
      const item = s.find((x) => x.id === id);
      if (item) formularioProfissional(item);
    },
    excluir(id) {
      modal(`
        <h3>Excluir profissional</h3>
        <p class="confirm-text">Tem certeza que deseja excluir este profissional?</p>
        <div class="modal-actions">
          <button class="btn btn-ghost" onclick="AdminModal.fechar()">Cancelar</button>
          <button class="btn btn-danger" id="btnConfProf">Excluir</button>
        </div>
      `);
      $('btnConfProf').addEventListener('click', async () => {
        await api('/api/admin/profissionais/' + id, { method: 'DELETE' });
        fecharModal();
        toast('Profissional excluído.', 'success');
        carregarProfissionais();
      });
    }
  };

  async function carregarProfsComCache() {
    const lista = await api('/api/admin/profissionais?barbearia_id=' + state.barbeariaId);
    sessionStorage.setItem('_profs_' + state.barbeariaId, JSON.stringify(lista));
    return lista;
  }
  const _carregarProfissionais = carregarProfissionais;
  carregarProfissionais = async function () {
    await carregarProfsComCache().catch(() => []);
    return _carregarProfissionais();
  };

  /* ================= HORÁRIOS ================= */
  async function carregarHorarios() {
    try {
      const b = await api('/api/admin/barbearias/' + state.barbeariaId);
      $('horariosList').innerHTML = b.horarios.map((h) => `
        <div class="horario-row ${h.abertura ? '' : 'closed-row'}" data-dia="${h.dia_semana}">
          <div class="horario-day">
            <label class="switch"><input type="checkbox" class="hr-aberto" ${h.abertura ? 'checked' : ''}><span class="slider"></span></label>
            <span class="hr-day-name">${h.nome}</span>
            <button type="button" class="hr-trash" title="Desativar dia" aria-label="Desativar ${h.nome}"><i class="fa-solid fa-trash-can"></i></button>
          </div>
          <div class="form-group hr-field"><label>Abertura</label><input type="time" class="form-control hr-abertura" value="${h.abertura}" ${h.abertura ? '' : 'disabled'}></div>
          <div class="form-group hr-field"><label>Fechamento</label><input type="time" class="form-control hr-fechamento" value="${h.fechamento}" ${h.abertura ? '' : 'disabled'}></div>
          <div class="form-group hr-field"><label>Intervalo (min)</label><select class="form-control hr-intervalo" ${h.abertura ? '' : 'disabled'}>
            ${[15, 20, 30, 45, 60].map((n) => `<option value="${n}" ${h.intervalo === n ? 'selected' : ''}>${n} min</option>`).join('')}
          </select></div>
        </div>
      `).join('');

      document.querySelectorAll('.horario-row .hr-aberto').forEach((cb) => {
        cb.addEventListener('change', () => AdminHorarios.toggle(cb.closest('.horario-row').dataset.dia));
      });
      document.querySelectorAll('.horario-row .hr-trash').forEach((btn) => {
        btn.addEventListener('click', () => {
          const row = btn.closest('.horario-row');
          const cb = row.querySelector('.hr-aberto');
          if (cb.checked) {
            cb.checked = false;
            AdminHorarios.toggle(row.dataset.dia);
          }
        });
      });
      carregarBloqueios();
    } catch (er) { toast(er.message, 'error'); }
  }

  window.AdminHorarios = {
    toggle(dia) {
      const row = document.querySelector('.horario-row[data-dia="' + dia + '"]');
      if (!row) return;
      const aberto = row.querySelector('.hr-aberto').checked;
      row.classList.toggle('closed-row', !aberto);
      row.querySelectorAll('.hr-abertura, .hr-fechamento, .hr-intervalo').forEach((el) => (el.disabled = !aberto));
    }
  };

  $('btnSalvarHorarios').addEventListener('click', async () => {
    const horarios = Array.from(document.querySelectorAll('.horario-row')).map((row) => ({
      dia_semana: Number(row.dataset.dia),
      aberto: row.querySelector('.hr-aberto').checked,
      abertura: row.querySelector('.hr-abertura').value,
      fechamento: row.querySelector('.hr-fechamento').value,
      intervalo: Number(row.querySelector('.hr-intervalo').value)
    }));
    try {
      await api('/api/admin/horarios', {
        method: 'PUT',
        body: JSON.stringify({ barbearia_id: state.barbeariaId, horarios })
      });
      toast('Horários salvos!', 'success');
    } catch (er) { toast(er.message, 'error'); }
  });

  /* ================= MINHA BARBEARIA ================= */
  async function carregarFormBarbearia() {
    try {
      const b = await api('/api/admin/barbearias/' + state.barbeariaId);
      $('bbNome').value = b.nome;
      $('bbSlug').value = b.slug;
      $('bbAvaliacao').value = b.avaliacao;
      $('bbTagline').value = b.tagline;
      $('bbDescricao').value = b.descricao;
      $('bbEndereco').value = b.endereco;
      $('bbCidade').value = b.cidade;
      $('bbHorarioTexto').value = b.horario_texto;
      $('bbTelefone').value = b.telefone;
      $('bbWhatsapp').value = b.whatsapp;
      $('bbEmail').value = b.email;
      $('bbInstagram').value = b.instagram;
      $('bbImagem').value = b.imagem;
      $('bbCapa').value = b.capa;
      $('bbPix').value = b.pix_chave || '';
      $('bbWalletId').value = b.asaas_wallet_id || '';
      $('bbSplitPercent').value = b.asaas_split_percent || '';
      $('bbCor').value = b.cor_primaria || '#c9a227';
      $('bbSlugAcesso').textContent = b.slug || '';
      $('bbAtiva').checked = !!b.ativa;
      if (state.dono) {
        $('bbAtiva').disabled = true;
        $('bbDonoInfo').classList.add('hidden');
        $('bbSplitRow').classList.add('hidden');
      } else {
        $('bbDonoInfo').classList.remove('hidden');
        $('bbSplitRow').classList.remove('hidden');
      }
      $('bbSlugFull').textContent = location.origin + '/b/' + (slugificar(b.slug) || '');
      checarSlug($('bbSlugStatus'), b.slug, b.id);
      if (!$('bbSlug')._listener) {
        $('bbSlug')._listener = true;
        $('bbSlug').addEventListener('input', (e) => {
          const s = slugificar(e.target.value);
          $('bbSlugFull').textContent = location.origin + '/b/' + (s || '');
          checarSlug($('bbSlugStatus'), s, b.id);
        });
      }
    } catch (er) { toast(er.message, 'error'); }
  }

  $('barbeariaForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      nome: $('bbNome').value.trim(),
      slug: $('bbSlug').value.trim(),
      avaliacao: Number($('bbAvaliacao').value) || 0,
      tagline: $('bbTagline').value.trim(),
      descricao: $('bbDescricao').value.trim(),
      endereco: $('bbEndereco').value.trim(),
      cidade: $('bbCidade').value.trim(),
      horario_texto: $('bbHorarioTexto').value.trim(),
      telefone: $('bbTelefone').value.trim(),
      whatsapp: $('bbWhatsapp').value.trim(),
      email: $('bbEmail').value.trim(),
      instagram: $('bbInstagram').value.trim(),
      imagem: $('bbImagem').value.trim(),
      capa: $('bbCapa').value.trim(),
      pix_chave: $('bbPix').value.trim(),
      asaas_wallet_id: $('bbWalletId').value.trim(),
      asaas_split_percent: Number($('bbSplitPercent').value) || 0,
      cor_primaria: $('bbCor').value,
      ativa: $('bbAtiva').checked ? 1 : 0
    };
    const senha = $('bbSenha').value;
    if (senha) body.senha = senha;
    try {
      await api('/api/admin/barbearias/' + state.barbeariaId, { method: 'PUT', body: JSON.stringify(body) });
      $('bbSenha').value = '';
      toast('Barbearia atualizada!', 'success');
      carregarBarbearias();
    } catch (er) { toast(er.message, 'error'); }
  });

  /* ================= TODAS AS BARBEARIAS ================= */
  async function carregarTodasBarbearias() {
    try {
      const lista = await api('/api/admin/barbearias');
      $('todasBarbeariasBody').innerHTML = lista.map((b) => `
        <tr>
          <td><strong>${esc(b.nome)}</strong> ${b.id === state.barbeariaId ? '<span class="status-badge status-confirmado">atual</span>' : ''}</td>
          <td style="color:var(--text-dim)">${esc(b.cidade)}</td>
          <td><code style="color:var(--gold)">/b/${esc(b.slug)}</code></td>
          <td>${b.agendamentos_hoje}</td>
          <td><span class="status-badge ${b.ativa ? 'status-concluido' : 'status-cancelado'}">${b.ativa ? 'Ativa' : 'Inativa'}</span></td>
          <td class="td-actions">
            <button class="btn btn-ghost btn-sm" onclick="window.open('/b/${esc(b.slug)}','_blank')"><i class="fa-solid fa-globe"></i> Ver página</button>
            <button class="btn btn-blue btn-sm" onclick="AdminBarbearias.gerenciar(${b.id})"><i class="fa-solid fa-right-to-bracket"></i> Gerenciar</button>
            <button class="btn btn-danger btn-sm" onclick="AdminBarbearias.excluir(${b.id})"><i class="fa-solid fa-trash"></i></button>
          </td>
        </tr>
      `).join('');
    } catch (er) { toast(er.message, 'error'); }
  }

  window.AdminBarbearias = {
    gerenciar(id) {
      $('barbeariaSelect').value = id;
      selecionarBarbearia(id);
      mudarView('dashboard');
      toast('Agora gerenciando a barbearia selecionada.', 'success');
    },
    excluir(id) {
      if (id === state.barbeariaId) return toast('Selecione outra barbearia antes de excluir a atual.', 'error');
      modal(`
        <h3>Excluir barbearia</h3>
        <p class="confirm-warn"><i class="fa-solid fa-triangle-exclamation"></i> Esta ação excluirá também todos os serviços, profissionais, horários e agendamentos desta barbearia.</p>
        <div class="modal-actions">
          <button class="btn btn-ghost" onclick="AdminModal.fechar()">Cancelar</button>
          <button class="btn btn-danger" id="btnConfBarb">Excluir</button>
        </div>
      `);
      $('btnConfBarb').addEventListener('click', async () => {
        await api('/api/admin/barbearias/' + id, { method: 'DELETE' });
        fecharModal();
        toast('Barbearia excluída.', 'success');
        carregarBarbearias();
      });
    }
  };

  $('btnNovaBarbearia').addEventListener('click', () => {
    modal(`
      <h3>Nova barbearia</h3>
      <p class="confirm-text" style="margin-top:-10px">Cadastre a barbearia e gere o link individual (slug) da página dela.</p>
      <form id="formNovaBarb">
        <div class="form-group"><label>Nome *</label><input type="text" id="nbNome" class="form-control" required placeholder="Ex.: Barbearia Central"></div>
        <div class="form-group">
          <label>Link individual da página</label>
          <div class="slug-input">
            <span class="slug-prefix">/b/</span>
            <input type="text" id="nbSlug" class="form-control" placeholder="barbearia-central" autocomplete="off">
          </div>
          <p class="slug-preview"><i class="fa-solid fa-link"></i> ${location.origin}<span id="nbSlugFull"></span></p>
          <p class="slug-status" id="nbSlugStatus"></p>
        </div>
        <div class="form-group"><label>Cidade</label><input type="text" id="nbCidade" class="form-control" placeholder="São Paulo - SP"></div>
        <div class="form-group"><label>Ativa no site</label><label class="switch"><input type="checkbox" id="nbAtiva" checked><span class="slider"></span></label></div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" onclick="AdminModal.fechar()">Cancelar</button>
          <button type="submit" class="btn btn-gold">Criar barbearia</button>
        </div>
      </form>
    `);

    const nomeInput = $('nbNome');
    const slugInput = $('nbSlug');
    let auto = true;

    nomeInput.addEventListener('input', () => {
      if (auto) { slugInput.value = slugificar(nomeInput.value); atualizarPreview(); }
    });
    slugInput.addEventListener('input', () => {
      auto = slugInput.value === slugificar(nomeInput.value);
      atualizarPreview();
    });

    function atualizarPreview() {
      const s = slugificar(slugInput.value);
      $('nbSlugFull').textContent = s ? '/b/' + s : '/b/';
      checarSlug($('nbSlugStatus'), s);
    }

    $('formNovaBarb').addEventListener('submit', async (e) => {
      e.preventDefault();
      const s = slugificar($('nbSlug').value.trim());
      if (!s) return toast('Informe um link para a página.', 'error');
      try {
        const nova = await api('/api/admin/barbearias', {
          method: 'POST',
          body: JSON.stringify({
            nome: $('nbNome').value.trim(),
            slug: s,
            cidade: $('nbCidade').value.trim(),
            ativa: $('nbAtiva').checked
          })
        });

        const link = location.origin + '/b/' + nova.slug;
        modal(`
          <h3>Barbearia criada!</h3>
          <div class="check-icon-sm"><i class="fa-solid fa-check"></i></div>
          <p class="confirm-text">O link individual da página da barbearia é:</p>
          <div class="link-box">
            <span>/${esc(nova.slug)}</span>
            <button class="btn btn-ghost btn-sm" id="btnCopyLink" type="button"><i class="fa-solid fa-copy"></i> Copiar</button>
          </div>
          <p class="slug-note">Compartilhe este link para os clientes agendarem online.</p>
          <div class="modal-actions">
            <button class="btn btn-ghost" onclick="AdminModal.fechar()">Continuar</button>
            <a href="/b/${esc(nova.slug)}" class="btn btn-gold" target="_blank" rel="noopener"><i class="fa-solid fa-globe"></i> Ver página</a>
          </div>
        `);
        $('btnCopyLink').addEventListener('click', () => {
          navigator.clipboard.writeText(link).then(() => toast('Link copiado!', 'success'));
        });

        await carregarBarbearias();
        $('barbeariaSelect').value = nova.id;
        selecionarBarbearia(nova.id);
        mudarView('barbearia');
      } catch (er) { toast(er.message, 'error'); }
    });
  });

  /* ================= CUPONS ================= */
  async function carregarCupons() {
    try {
      const lista = await api('/api/admin/cupons?barbearia_id=' + state.barbeariaId);
      $('cuponsBody').innerHTML = lista.length ? lista.map((c) => {
        const desc = c.tipo === 'percent' ? c.desconto + '%' : fmtPreco(c.desconto);
        return `
          <tr>
            <td><code style="color:var(--gold);font-weight:700">${esc(c.codigo)}</code></td>
            <td><strong>${desc}</strong></td>
            <td style="color:var(--text-dim)">${c.validade ? fmtData(c.validade) : '—'}</td>
            <td>${c.usos}${c.limite_uso > 0 ? ' / ' + c.limite_uso : ''}</td>
            <td><span class="status-badge ${c.ativo ? 'status-concluido' : 'status-cancelado'}">${c.ativo ? 'Ativo' : 'Inativo'}</span></td>
            <td class="td-actions">
              <button class="btn btn-ghost btn-sm" onclick="AdminCupons.editar(${c.id})"><i class="fa-solid fa-pen"></i></button>
              <button class="btn btn-danger btn-sm" onclick="AdminCupons.excluir(${c.id})"><i class="fa-solid fa-trash"></i></button>
            </td>
          </tr>`;
      }).join('') : '<tr><td colspan="6" class="empty-list">Nenhum cupom criado.</td></tr>';
    } catch (er) { toast(er.message, 'error'); }
  }

  $('btnNovoCupom').addEventListener('click', () => formularioCupom());

  function formularioCupom(c) {
    modal(`
      <h3>${c ? 'Editar cupom' : 'Novo cupom'}</h3>
      <form id="formCupom">
        <div class="form-row-2">
          <div class="form-group"><label>Código *</label><input type="text" id="cpCodigo" class="form-control" value="${c ? esc(c.codigo) : ''}" placeholder="Ex.: NAVALHA10" style="text-transform:uppercase" required></div>
          <div class="form-group"><label>Tipo</label>
            <select id="cpTipo" class="form-control">
              <option value="percent" ${!c || c.tipo === 'percent' ? 'selected' : ''}>Percentual (%)</option>
              <option value="valor" ${c && c.tipo === 'valor' ? 'selected' : ''}>Valor fixo (R$)</option>
            </select>
          </div>
        </div>
        <div class="form-row-3">
          <div class="form-group"><label>Desconto *</label><input type="number" id="cpDesconto" class="form-control" step="0.01" min="0.01" value="${c ? c.desconto : ''}" required></div>
          <div class="form-group"><label>Validade</label><input type="date" id="cpValidade" class="form-control" value="${c && c.validade ? c.validade : ''}"></div>
          <div class="form-group"><label>Limite de usos</label><input type="number" id="cpLimite" class="form-control" min="0" value="${c && c.limite_uso ? c.limite_uso : ''}" placeholder="0 = ilimitado"></div>
        </div>
        <div class="form-group"><label class="switch" style="margin-top:8px"><input type="checkbox" id="cpAtivo" ${!c || c.ativo ? 'checked' : ''}><span class="slider"></span><span>Cupom ativo</span></label></div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" onclick="AdminModal.fechar()">Cancelar</button>
          <button type="submit" class="btn btn-gold">Salvar</button>
        </div>
      </form>
    `);
    $('formCupom').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = {
        codigo: $('cpCodigo').value.trim(),
        tipo: $('cpTipo').value,
        desconto: Number($('cpDesconto').value),
        validade: $('cpValidade').value,
        limite_uso: Number($('cpLimite').value) || 0,
        ativo: $('cpAtivo').checked
      };
      try {
        if (c) await api('/api/admin/cupons/' + c.id, { method: 'PUT', body: JSON.stringify(body) });
        else await api('/api/admin/cupons', { method: 'POST', body: JSON.stringify({ barbearia_id: state.barbeariaId, ...body }) });
        fecharModal();
        toast('Cupom salvo!', 'success');
        carregarCupons();
      } catch (er) { toast(er.message, 'error'); }
    });
  }

  window.AdminCupons = {
    editar(id) {
      modal(`<div class="empty-list">Carregando...</div>`);
      api('/api/admin/cupons?barbearia_id=' + state.barbeariaId).then((lista) => {
        const item = lista.find((x) => x.id === id);
        if (item) formularioCupom(item);
      }).catch((er) => toast(er.message, 'error'));
    },
    excluir(id) {
      modal(`
        <h3>Excluir cupom</h3>
        <p class="confirm-text">Excluir este cupom? Ele não poderá mais ser usado em novos agendamentos.</p>
        <div class="modal-actions">
          <button class="btn btn-ghost" onclick="AdminModal.fechar()">Cancelar</button>
          <button class="btn btn-danger" id="btnConfCupom">Excluir</button>
        </div>
      `);
      $('btnConfCupom').addEventListener('click', async () => {
        await api('/api/admin/cupons/' + id, { method: 'DELETE' });
        fecharModal();
        toast('Cupom excluído.', 'success');
        carregarCupons();
      });
    }
  };

  /* ================= FIDELIDADE ================= */
  async function carregarFidelidade() {
    try {
      const d = await api('/api/admin/fidelidade?barbearia_id=' + state.barbeariaId);
      $('fdAtiva').checked = !!d.config.ativo;
      $('fdPremio').value = d.config.premio_visitas || 10;
      const premio = d.config.premio_visitas || 10;
      $('fidelidadeBody').innerHTML = d.clientes.length ? d.clientes.map((f) => {
        const restante = Math.max(0, premio - f.visitas);
        const pct = Math.min(100, Math.round((f.visitas / premio) * 100));
        return `
          <tr>
            <td><strong>${esc(f.nome)}</strong></td>
            <td style="color:var(--text-dim)">${esc(f.telefone)}</td>
            <td><strong>${f.visitas}</strong> de ${premio}</td>
            <td style="min-width:150px">
              <div class="fid-bar"><div style="width:${pct}%"></div></div>
              <span class="fid-rest">${restante ? 'Faltam ' + restante + (restante === 1 ? ' visita' : ' visitas') : 'Prêmio atingido!'}</span>
            </td>
            <td class="td-actions">
              <button class="btn btn-green btn-sm" title="Adicionar visita manual" onclick="AdminFidelidade.somar(${f.id})"><i class="fa-solid fa-plus"></i></button>
            </td>
          </tr>`;
      }).join('') : '<tr><td colspan="5" class="empty-list">Nenhum cliente fidelizado ainda. Os pontos são acumulados automaticamente quando um atendimento é concluído.</td></tr>';
    } catch (er) { toast(er.message, 'error'); }
  }

  $('fidelidadeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/admin/fidelidade', {
        method: 'PUT',
        body: JSON.stringify({
          barbearia_id: state.barbeariaId,
          ativo: $('fdAtiva').checked,
          premio_visitas: Number($('fdPremio').value) || 10
        })
      });
      toast('Configuração de fidelidade salva!', 'success');
      carregarFidelidade();
    } catch (er) { toast(er.message, 'error'); }
  });

  window.AdminFidelidade = {
    async somar(id) {
      await api('/api/admin/fidelidade/' + id + '/somar', { method: 'POST' });
      toast('Visita adicionada!', 'success');
      carregarFidelidade();
    }
  };

  /* ================= LEMBRETES ================= */
  async function carregarLembretes() {
    try {
      const d = await api('/api/admin/lembretes?barbearia_id=' + state.barbeariaId);
      $('lbAtiva').checked = !!d.config.ativo;
      $('lbHoras').value = d.config.horas_antes || 24;
      const pendentes = d.pendentes || [];
      $('lembretesBody').innerHTML = pendentes.length ? pendentes.map((a) => `
        <tr>
          <td><strong>${esc(a.nome_cliente)}</strong><br><span style="color:var(--text-faint);font-size:.78rem">${esc(a.telefone_cliente)}</span></td>
          <td>${esc(a.servico_nome)}</td>
          <td>${fmtData(a.data)}</td>
          <td>${a.hora}</td>
          <td class="td-actions">
            <a class="btn btn-whats btn-sm" target="_blank" rel="noopener" href="${whatsLembreteUrl(a)}"><i class="fa-brands fa-whatsapp"></i> Enviar</a>
            <button class="btn btn-ghost btn-sm" onclick="AdminLembretes.marcar(${a.id})"><i class="fa-solid fa-check"></i> Lembrado</button>
          </td>
        </tr>
      `).join('') : '<tr><td colspan="5" class="empty-list">Nenhum agendamento pendente de lembrete no momento.</td></tr>';
    } catch (er) { toast(er.message, 'error'); }
  }

  $('lembretesForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/admin/lembretes', {
        method: 'PUT',
        body: JSON.stringify({
          barbearia_id: state.barbeariaId,
          ativo: $('lbAtiva').checked,
          horas_antes: Number($('lbHoras').value) || 24
        })
      });
      toast('Configuração de lembretes salva!', 'success');
      carregarLembretes();
    } catch (er) { toast(er.message, 'error'); }
  });

  window.AdminLembretes = {
    async marcar(id) {
      await api('/api/admin/lembretes/' + id + '/marcar', { method: 'POST' });
      toast('Lembrete marcado como enviado.', 'success');
      carregarLembretes();
    }
  };

  window.AdminModal = { fechar: fecharModal };
  $('modalOverlay').addEventListener('click', (e) => {
    if (e.target === $('modalOverlay')) fecharModal();
  });

  init();
})();
