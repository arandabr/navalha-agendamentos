/* Página /avaliar/:token — avaliação pós-atendimento */
(function () {
  const token = location.pathname.split('/').pop();
  let nota = 0;
  let ag = null;

  const $ = (id) => document.getElementById(id);

  function mostrarToast(msg, tipo) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast show ' + (tipo || '');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => (t.className = 'toast'), 2600);
  }

  async function carregar() {
    try {
      const res = await fetch('/api/agendamentos/' + encodeURIComponent(token));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Agendamento não encontrado.');
      ag = data;
      $('avBarbearia').textContent = ag.barbearia_nome;
      $('avServico').textContent = ag.servico_nome;

      if (ag.status !== 'concluido') {
        $('pageLoading').classList.add('hidden');
        $('avForm').classList.add('hidden');
        $('avError').classList.remove('hidden');
        $('avErrorTitle').textContent = 'Ainda não dá para avaliar';
        $('avErrorMsg').textContent = 'As avaliações são liberadas após a conclusão do atendimento. Volte mais tarde.';
        return;
      }

      $('avNome').value = ag.nome_cliente || '';
      $('pageLoading').classList.add('hidden');
      $('avForm').classList.remove('hidden');
    } catch (err) {
      $('pageLoading').classList.add('hidden');
      $('avError').classList.remove('hidden');
      $('avErrorTitle').textContent = 'Link inválido';
      $('avErrorMsg').textContent = err.message || 'Não foi possível localizar este agendamento.';
    }
  }

  const stars = Array.from(document.querySelectorAll('#avStars i'));
  function pintar(n) {
    stars.forEach((s, i) => {
      s.className = i < n ? 'fa-solid fa-star' : 'fa-regular fa-star';
    });
  }

  stars.forEach((s) => {
    s.addEventListener('mouseenter', () => pintar(Number(s.dataset.n)));
    s.addEventListener('click', () => {
      nota = Number(s.dataset.n);
      pintar(nota);
    });
  });
  document.getElementById('avStars').addEventListener('mouseleave', () => pintar(nota));

  document.getElementById('avaliacaoForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = $('avErrorBox');
    errBox.classList.add('hidden');
    if (!nota) {
      errBox.textContent = 'Selecione uma nota de 1 a 5 estrelas.';
      errBox.classList.remove('hidden');
      return;
    }
    const btn = $('avSubmit');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Enviando...';
    try {
      const res = await fetch('/api/avaliacoes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          nota,
          comentario: $('avComentario').value.trim(),
          nome: $('avNome').value.trim()
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Não foi possível enviar a avaliação.');
      $('avForm').classList.add('hidden');
      $('avOk').classList.remove('hidden');
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-star"></i> Enviar avaliação';
    }
  });

  carregar();
})();
