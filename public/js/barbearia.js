/* Página individual da barbearia — fluxo de agendamento */
(function () {
  const slug = location.pathname.split('/').pop();
  let shop = null;
  let dias = [];
  let estado = {
    servicoId: null,
    profissionalId: null,
    data: null,
    hora: null,
    cupom: null,
    cupomInfo: null
  };
  let slotsCache = null;
  let ultimoAg = null;
  let pixTimer = null;

  const $ = (id) => document.getElementById(id);

  function esc(str) {
    return String(str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function formatarPreco(v) {
    return 'R$ ' + (Number(v) || 0).toFixed(2).replace('.', ',');
  }

  function mostrarToast(msg, tipo) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast show ' + (tipo || '');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => (t.className = 'toast'), 2600);
  }

  function apiError(err) {
    return (err && err.error) || 'Não foi possível completar a ação. Tente novamente.';
  }

  /* ---------------- Carregamento ---------------- */
  async function carregar() {
    try {
      const res = await fetch('/api/barbearias/' + encodeURIComponent(slug));
      if (!res.ok) throw new Error('not found');
      shop = await res.json();

      const cor = shop.cor_primaria || '#c9a227';
      document.documentElement.style.setProperty('--accent', cor);

      $('capa').style.backgroundImage = 'url(' + shop.capa + ')';
      $('avatar').style.backgroundImage = 'url(' + shop.imagem + ')';
      $('nome').textContent = shop.nome;
      $('tagline').textContent = shop.tagline;
      $('avaliacao').textContent = (shop.avaliacao_media != null ? Number(shop.avaliacao_media).toFixed(1) : Number(shop.avaliacao).toFixed(1));
      $('endereco').textContent = shop.endereco + ' — ' + shop.cidade;
      $('horarioTexto').textContent = shop.horario_texto;
      $('telefone').textContent = shop.telefone;

      const wa = shop.whatsapp ? 'https://wa.me/' + shop.whatsapp : '#';
      $('whatsBtn').href = wa;
      $('mobileWhatsBtn').href = wa;
      $('mobileBookingBar').classList.remove('hidden');
      $('instaBtn').href = shop.instagram ? 'https://instagram.com/' + shop.instagram.replace('@', '') : '#';

      document.title = 'Agendar | ' + shop.nome;

      renderServicos();
      renderProfissionais();
      renderAvaliacoes();
      await carregarDias();

      $('pageLoading').classList.add('hidden');
      $('shopContent').classList.remove('hidden');
    } catch (err) {
      $('pageLoading').classList.add('hidden');
      const div = document.createElement('div');
      div.className = 'page-error';
      div.innerHTML = '<i class="fa-solid fa-circle-exclamation"></i><h2>Barbearia não encontrada</h2><p>A barbearia pode estar inativa ou o endereço está incorreto.</p><br><a href="/" class="btn btn-gold">Voltar ao início</a>';
      document.body.appendChild(div);
    }
  }

  /* ---------------- Avaliações ---------------- */
  function renderAvaliacoes() {
    const lista = shop.avaliacoes || [];
    const box = $('avaliacoesBox');
    $('avaliacoesEmpty').style.display = lista.length ? 'none' : 'flex';
    if (!lista.length) return;
    const media = shop.avaliacao_total > 0 ? Number(shop.avaliacao_media).toFixed(1) : null;
    const header = media != null ? `
      <div class="av-resumo">
        <div class="av-media"><strong>${media}</strong><span>${shop.avaliacao_total || 0} avaliaçõe${(shop.avaliacao_total || 0) === 1 ? 's' : 's'}</span></div>
        <div class="av-media-stars">${estrelas(Number(media))}</div>
      </div>` : '';
    box.innerHTML = header + lista.map((a) => `
      <div class="av-item">
        <div class="av-head">
          <span class="av-name"><i class="fa-solid fa-user"></i> ${esc(a.nome)}</span>
          <span class="av-stars">${estrelas(a.nota)}</span>
        </div>
        <span class="av-date">${esc(String(a.criado_em || '').slice(0, 10).split('-').reverse().join('/'))}</span>
        ${a.comentario ? '<p class="av-com">' + esc(a.comentario) + '</p>' : ''}
      </div>
    `).join('');
  }

  function estrelas(n) {
    let html = '';
    for (let i = 1; i <= 5; i++) {
      html += '<i class="fa' + (i <= Math.round(n) ? 's' : 'r') + ' fa-star"></i>';
    }
    return html;
  }

  /* ---------------- Serviços ---------------- */
  function renderServicos() {
    $('servicosList').innerHTML = shop.servicos.map((s) => `
      <div class="sv-serv ${estado.servicoId === s.id ? 'selected' : ''}" data-id="${s.id}" data-duracao="${s.duracao}" data-preco="${s.preco}">
        <div class="sv-serv-icon"><i class="fa-solid fa-cut"></i></div>
        <div class="sv-serv-body">
          <div class="sv-serv-name">${esc(s.nome)}</div>
          <div class="sv-serv-desc">${esc(s.descricao)}</div>
        </div>
        <div class="sv-serv-meta">
          <div class="sv-serv-price">${formatarPreco(s.preco)}</div>
          <div class="sv-serv-dur"><i class="fa-regular fa-clock"></i> ${s.duracao} min</div>
        </div>
        <div class="sv-serv-check"><i class="fa-solid fa-check"></i></div>
      </div>
    `).join('');

    $('servicosList').querySelectorAll('.sv-serv').forEach((el) => {
      el.addEventListener('click', () => {
        estado.servicoId = Number(el.dataset.id);
        estado.hora = null;
        renderServicos();
        atualizarSlots();
        atualizarResumo();
      });
    });
  }

  /* ---------------- Profissionais ---------------- */
  function renderProfissionais() {
    const chips = [
      `<button class="sv-prof ${!estado.profissionalId ? 'selected' : ''}" data-id="">
        <span class="sv-prof-ini"><i class="fa-solid fa-users"></i></span> Qualquer profissional
      </button>`
    ].concat(shop.profissionais.map((p) => {
      const ini = p.nome.split(' ').map((n) => n[0]).slice(0, 2).join('').toUpperCase();
      return `<button class="sv-prof ${estado.profissionalId === p.id ? 'selected' : ''}" data-id="${p.id}">
        <span class="sv-prof-ini">${ini}</span> ${esc(p.nome)} <small>· ${esc(p.cargo)}</small>
      </button>`;
    })).join('');

    $('profissionaisList').innerHTML = chips;
    $('profissionaisList').querySelectorAll('.sv-prof').forEach((el) => {
      el.addEventListener('click', () => {
        estado.profissionalId = el.dataset.id ? Number(el.dataset.id) : null;
        estado.hora = null;
        renderProfissionais();
        atualizarSlots();
        atualizarResumo();
      });
    });
  }

  /* ---------------- Dias ---------------- */
  async function carregarDias() {
    const res = await fetch('/api/barbearias/' + encodeURIComponent(slug) + '/dias?dias=14');
    dias = await res.json();
    renderDias();

    const primeiroAberto = dias.find((d) => d.aberto);
    if (primeiroAberto) {
      estado.data = primeiroAberto.data;
      renderDias();
      atualizarSlots();
    }
  }

  function renderDias() {
    $('dateStrip').innerHTML = dias.map((d) => `
      <div class="sv-pill ${estado.data === d.data ? 'selected' : ''} ${d.aberto ? '' : 'closed'}" data-data="${d.data}" ${d.aberto ? '' : 'title="Fechado"'}>
        <div class="d">${d.hoje ? 'Hoje' : d.nome}</div>
        <div class="n">${d.dia_num}</div>
        <div class="m">${d.mes}</div>
      </div>
    `).join('');

    $('dateStrip').querySelectorAll('.sv-pill').forEach((el) => {
      el.addEventListener('click', () => {
        if (el.classList.contains('closed')) return;
        estado.data = el.dataset.data;
        estado.hora = null;
        renderDias();
        atualizarSlots();
        atualizarResumo();
      });
    });
  }

  /* ---------------- Horários ---------------- */
  async function atualizarSlots() {
    const timeGrid = $('timeGrid');
    const noSlots = $('noSlots');
    const btnFila = $('btnFila');
    timeGrid.innerHTML = '';
    noSlots.classList.remove('hidden');
    btnFila.classList.add('hidden');

    if (!estado.servicoId || !estado.data) {
      noSlots.innerHTML = '<i class="fa-solid fa-hand-point-left"></i>Selecione um serviço e uma data para ver os horários.';
      atualizarResumo();
      return;
    }

    const params = new URLSearchParams({ date: estado.data, servico_id: estado.servicoId });
    if (estado.profissionalId) params.set('profissional_id', estado.profissionalId);

    try {
      const res = await fetch('/api/barbearias/' + encodeURIComponent(slug) + '/horarios?' + params.toString());
      const data = await res.json();
      if (!res.ok) {
        noSlots.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i>' + apiError(data);
        return;
      }
      const slots = data.slots || [];
      if (!slots.length) {
        noSlots.innerHTML = '<i class="fa-solid fa-calendar-xmark"></i>Nenhum horário disponível nesta data. Tente outro dia ou entre na fila de espera.';
        btnFila.classList.remove('hidden');
        return;
      }
      noSlots.classList.add('hidden');
      timeGrid.innerHTML = slots.map((s) => `
        <button class="sv-slot ${estado.hora === s.hora ? 'selected' : ''}" data-hora="${s.hora}">${s.hora}</button>
      `).join('');

      timeGrid.querySelectorAll('.sv-slot').forEach((el) => {
        el.addEventListener('click', () => {
          estado.hora = el.dataset.hora;
          timeGrid.querySelectorAll('.sv-slot').forEach((b) => b.classList.remove('selected'));
          el.classList.add('selected');
          atualizarResumo();
        });
      });
    } catch (err) {
      noSlots.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i>Erro ao carregar horários.';
    }
  }

  /* ---------------- Cupom ---------------- */
  function calcularDesconto(preco) {
    if (!estado.cupomInfo) return null;
    const d = Number(estado.cupomInfo.desconto) || 0;
    const valor = estado.cupomInfo.tipo === 'percent' ? preco * (d / 100) : Math.min(d, preco);
    return { valor, total: Math.max(0, preco - valor) };
  }

  $('btnAplicarCupom').addEventListener('click', async () => {
    const codigo = $('cupomInput').value.trim();
    const msg = $('cupomMsg');
    msg.classList.add('hidden');
    if (!codigo) {
      estado.cupom = null;
      estado.cupomInfo = null;
      atualizarResumo();
      return;
    }
    const servico = estado.servicoId ? shop.servicos.find((s) => s.id === estado.servicoId) : null;
    const preco = servico ? servico.preco : 0;
    try {
      const res = await fetch('/api/barbearias/' + encodeURIComponent(slug) + '/cupom?codigo=' + encodeURIComponent(codigo) + '&preco=' + preco);
      const data = await res.json();
      if (!data.valido) {
        estado.cupom = null;
        estado.cupomInfo = null;
        msg.textContent = data.error || 'Cupom inválido.';
        msg.className = 'sv-cupom-msg err';
      } else {
        estado.cupom = codigo.toUpperCase();
        estado.cupomInfo = data;
        const desc = data.tipo === 'percent' ? data.desconto + '%' : formatarPreco(data.desconto);
        msg.innerHTML = '<i class="fa-solid fa-circle-check"></i> Cupom aplicado! Desconto de <strong>' + desc + '</strong>.';
        msg.className = 'sv-cupom-msg ok';
      }
      msg.classList.remove('hidden');
      atualizarResumo();
    } catch (err) {
      msg.textContent = 'Erro ao validar o cupom.';
      msg.className = 'sv-cupom-msg err';
      msg.classList.remove('hidden');
    }
  });

  /* ---------------- Resumo ---------------- */
  function atualizarResumo() {
    const card = $('summaryCard');
    if (!estado.servicoId) {
      card.innerHTML = '<div class="row"><span>Serviço</span><strong>—</strong></div>';
      return;
    }
    const servico = shop.servicos.find((s) => s.id === estado.servicoId);
    const prof = estado.profissionalId
      ? shop.profissionais.find((p) => p.id === estado.profissionalId)
      : null;
    const diaInfo = dias.find((d) => d.data === estado.data);
    const desc = calcularDesconto(servico.preco);

    card.innerHTML = `
      <div class="row"><span>Serviço</span><strong>${esc(servico.nome)}</strong></div>
      <div class="row"><span>Profissional</span><strong>${prof ? esc(prof.nome) : 'Qualquer'}</strong></div>
      <div class="row"><span>Data</span><strong>${diaInfo ? diaInfo.dia_num + ' ' + diaInfo.mes : '—'}${estado.hora ? ' às ' + estado.hora : ''}</strong></div>
      <div class="row"><span>Duração</span><strong>${servico.duracao} min</strong></div>
      ${desc ? `<div class="row"><span>Desconto</span><strong style="color:var(--green)">− ${formatarPreco(desc.valor)}</strong></div>` : ''}
      <div class="row total"><span>Total</span><strong>${desc ? formatarPreco(desc.total) : formatarPreco(servico.preco)}</strong></div>
    `;
  }

  /* ---------------- Envio ---------------- */
  $('bookingForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorBox = $('formError');
    errorBox.classList.add('hidden');

    if (!estado.servicoId) return mostrarErro('Selecione um serviço.');
    if (!estado.data) return mostrarErro('Selecione uma data.');
    if (!estado.hora) return mostrarErro('Selecione um horário.');

    const payload = {
      slug,
      servico_id: estado.servicoId,
      profissional_id: estado.profissionalId || null,
      nome_cliente: $('nomeCliente').value.trim(),
      telefone_cliente: $('telefoneCliente').value.trim(),
      email_cliente: $('emailCliente').value.trim(),
      cpf_cliente: $('cpfCliente').value.trim(),
      data: estado.data,
      hora: estado.hora,
      cupom: estado.cupom || ''
    };

    if (!payload.nome_cliente) return mostrarErro('Informe seu nome.');
    if (!payload.telefone_cliente) return mostrarErro('Informe seu WhatsApp.');

    const btn = $('submitBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Confirmando...';

    try {
      const res = await fetch('/api/agendamentos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-circle-check"></i> Confirmar agendamento';
        return mostrarErro(apiError(data));
      }
      exibirConfirmacao(data);
      $('bookingForm').reset();
      estado.cupom = null;
      estado.cupomInfo = null;
      $('cupomInput').value = '';
      $('cupomMsg').classList.add('hidden');
      atualizarResumo();
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-circle-check"></i> Confirmar agendamento';
    } catch (err) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-circle-check"></i> Confirmar agendamento';
      mostrarErro('Erro de conexão. Tente novamente.');
    }
  });

  function mostrarErro(msg) {
    const errorBox = $('formError');
    errorBox.textContent = msg;
    errorBox.classList.remove('hidden');
    window.scrollTo({ top: $('bookingForm').offsetTop - 140, behavior: 'smooth' });
  }

  function exibirConfirmacao(ag) {
    const servico = shop.servicos.find((s) => s.id === ag.servico_id);
    const dia = ag.data.split('-');
    const dataFormat = dia[2] + '/' + dia[1] + '/' + dia[0];
    const prof = ag.profissional_nome || 'A definir';

    $('confirmResumo').innerHTML = `
      <div class="row"><span>Barbearia</span><strong>${esc(shop.nome)}</strong></div>
      <div class="row"><span>Serviço</span><strong>${esc(ag.servico_nome)}</strong></div>
      <div class="row"><span>Profissional</span><strong>${esc(prof)}</strong></div>
      <div class="row"><span>Data</span><strong>${dataFormat} às ${ag.hora}</strong></div>
      ${ag.preco_original ? `<div class="row"><span>Valor original</span><strong style="text-decoration:line-through">${formatarPreco(ag.preco_original)}</strong></div><div class="row"><span>Desconto</span><strong style="color:var(--green)">− ${formatarPreco(ag.preco_original - ag.preco)}</strong></div>` : ''}
      <div class="row"><span>Total</span><strong>${formatarPreco(ag.preco)}</strong></div>
      <div class="row"><span>Nº agendamento</span><strong>#${String(ag.id).padStart(4, '0')}</strong></div>
    `;

    const pixBox = $('confirmPix');
    if (shop.pix_chave) {
      $('pixKey').textContent = shop.pix_chave;
      pixBox.classList.remove('hidden');
    } else {
      pixBox.classList.add('hidden');
    }

    const pixAsaas = $('confirmPixAsaas');
    if (shop.asaas_configurado) {
      pixAsaas.classList.remove('hidden');
      $('pixQrWrap').classList.add('hidden');
      $('pixConfirmado').classList.add('hidden');
      $('btnPagarPix').classList.remove('hidden');
      $('btnPagarPix').disabled = false;
      $('btnPagarPix').innerHTML = '<i class="fa-brands fa-pix"></i> Pagar com PIX';
      ultimoAg = ag;
    } else {
      pixAsaas.classList.add('hidden');
    }

    const avaliarLink = $('avaliarLink');
    if (ag.token) {
      avaliarLink.href = '/avaliar/' + ag.token;
      $('avaliarHint').classList.remove('hidden');
    } else {
      $('avaliarHint').classList.add('hidden');
    }

    const msg = encodeURIComponent(
      `Olá, ${shop.nome}! Agendei um horário pela plataforma:\n\n` +
      `Serviço: ${ag.servico_nome}\n` +
      `Data: ${dataFormat} às ${ag.hora}\n` +
      `Nº do agendamento: #${String(ag.id).padStart(4, '0')}\n\n` +
      `Meu nome: ${ag.nome_cliente}`
    );
    $('confirmWhats').href = shop.whatsapp ? 'https://wa.me/' + shop.whatsapp + '?text=' + msg : '#';
    $('confirmationModal').classList.remove('hidden');
  }

  $('confirmationModal').addEventListener('click', (e) => {
    if (e.target === $('confirmationModal')) {
      $('confirmationModal').classList.add('hidden');
      $('confirmationModal').querySelector('.modal').classList.remove('pix-ativo');
    }
  });

  /* ---------------- PIX via Asaas ---------------- */
  $('btnPagarPix').addEventListener('click', async () => {
    if (!ultimoAg) return;
    const btn = $('btnPagarPix');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Gerando pagamento...';
    try {
      const res = await fetch('/api/agendamentos/' + ultimoAg.id + '/pix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await res.json();
      if (!res.ok) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-brands fa-pix"></i> Pagar com PIX';
        mostrarToast(apiError(data), 'erro');
        return;
      }
      const p = data.pagamento;
      $('btnPagarPix').classList.add('hidden');
      $('pixQrWrap').classList.remove('hidden');
      $('pixStatusMsg').classList.add('hidden');
      $('confirmationModal').querySelector('.modal').classList.add('pix-ativo');
      if (p.pix_base64) {
        $('pixQrImg').src = 'data:image/png;base64,' + p.pix_base64;
      } else {
        $('pixQrImg').classList.add('hidden');
      }
      $('pixCopia').textContent = p.pix_copia_cola || '';
      if (p.status === 'confirmado') {
        $('pixConfirmado').classList.remove('hidden');
      } else {
        iniciarPollingPix(ultimoAg.token);
      }
    } catch (err) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-brands fa-pix"></i> Pagar com PIX';
      mostrarToast('Erro de conexão ao gerar o pagamento.', 'erro');
    }
  });

  $('btnCopiarPix').addEventListener('click', () => {
    const texto = $('pixCopia').textContent;
    if (!texto) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(texto).then(() => mostrarToast('Código PIX copiado!'));
    } else {
      const ta = document.createElement('textarea');
      ta.value = texto;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      mostrarToast('Código PIX copiado!');
    }
  });

  function iniciarPollingPix(token) {
    clearInterval(pixTimer);
    pixTimer = setInterval(async () => {
      try {
        const res = await fetch('/api/agendamentos/' + token + '/pix-status');
        if (!res.ok) return;
        const data = await res.json();
        if (data.pago === 1 || (data.pagamento && data.pagamento.status === 'confirmado')) {
          clearInterval(pixTimer);
          $('pixConfirmado').classList.remove('hidden');
        }
      } catch (e) {}
    }, 5000);
  }

  /* ---------------- Fila de espera ---------------- */
  $('btnFila').addEventListener('click', () => {
    $('filaError').classList.add('hidden');
    $('filaNome').value = $('nomeCliente').value || '';
    $('filaTelefone').value = $('telefoneCliente').value || '';
    $('filaData').min = new Date().toISOString().slice(0, 10);
    $('filaModal').classList.remove('hidden');
    $('filaNome').focus();
  });

  $('filaModal').addEventListener('click', (e) => {
    if (e.target === $('filaModal')) $('filaModal').classList.add('hidden');
  });

  $('filaForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = $('filaError');
    errBox.classList.add('hidden');
    const btn = $('filaSubmit');
    btn.disabled = true;
    try {
      const res = await fetch('/api/fila-espera', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug,
          servico_id: estado.servicoId || null,
          profissional_id: estado.profissionalId || null,
          nome_cliente: $('filaNome').value.trim(),
          telefone_cliente: $('filaTelefone').value.trim(),
          data_preferida: $('filaData').value || null
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(apiError(data));
      $('filaModal').classList.add('hidden');
      mostrarToast('Você entrou na fila de espera!', 'success');
    } catch (err) {
      errBox.textContent = apiError(err);
      errBox.classList.remove('hidden');
    } finally {
      btn.disabled = false;
    }
  });

  $('mobileAgendarBtn').addEventListener('click', () => {
    const card = document.querySelector('.sv-book');
    if (!card) return;
    const y = card.getBoundingClientRect().top + window.scrollY - 70;
    window.scrollTo({ top: Math.max(y, 0), behavior: 'smooth' });
  });

  carregar();
})();
