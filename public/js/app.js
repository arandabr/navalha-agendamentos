/* Página inicial — diretório de barbearias */
(function () {
  const grid = document.getElementById('shopGrid');
  const searchInput = document.getElementById('searchInput');
  const cidadeFilter = document.getElementById('cidadeFilter');
  const statShops = document.getElementById('statShops');
  let shops = [];
  let cidadeAtual = '';

  async function carregar() {
    try {
      const res = await fetch('/api/barbearias');
      shops = await res.json();
      preencherCidades();
      renderizar(shops);
      statShops.textContent = shops.length;
    } catch (err) {
      grid.innerHTML = '<div class="page-error" style="grid-column:1/-1"><i class="fa-solid fa-circle-exclamation"></i><h2>Erro ao carregar</h2><p>Não foi possível carregar as barbearias.</p></div>';
    }
  }

  function preencherCidades() {
    const cidades = [...new Set(shops.map((s) => s.cidade).filter(Boolean))].sort();
    cidadeFilter.innerHTML = '<option value="">Todas as cidades</option>' +
      cidades.map((c) => `<option value="${c.replace(/"/g, '&quot;')}">${c}</option>`).join('');
  }

  function formatarPreco(v) {
    return 'R$ ' + (Number(v) || 0).toFixed(2).replace('.', ',');
  }

  function renderizar(lista) {
    if (!lista.length) {
      grid.innerHTML = '<div class="page-error" style="grid-column:1/-1"><i class="fa-solid fa-magnifying-glass"></i><h2>Nenhum resultado</h2><p>Tente buscar por outro termo.</p></div>';
      return;
    }
    grid.innerHTML = lista.map((s) => `
      <article class="shop-card">
        <a href="/b/${s.slug}" class="shop-card-img">
          <img src="${s.imagem}" alt="${s.nome}" loading="lazy">
          <span class="shop-rating"><i class="fa-solid fa-star"></i> ${Number(s.avaliacao).toFixed(1)}</span>
        </a>
        <div class="shop-card-body">
          <a href="/b/${s.slug}"><h3>${s.nome}</h3></a>
          <p class="tagline">${s.tagline}</p>
          <div class="shop-meta">
            <span><i class="fa-solid fa-location-dot"></i>${s.cidade}</span>
            <span><i class="fa-solid fa-clock"></i>${s.horario_texto}</span>
          </div>
          <div class="shop-card-footer">
            <span class="shop-price"><strong>${formatarPreco(s.preco_min)}</strong> · ${s.servicos} serviços</span>
            <a href="/b/${s.slug}" class="btn btn-gold btn-sm"><i class="fa-solid fa-calendar-check"></i> Agendar</a>
          </div>
        </div>
      </article>
    `).join('');
  }

  window.filterShops = function () {
    const q = (searchInput.value || '').trim().toLowerCase();
    let filtrado = shops;
    if (cidadeAtual) filtrado = filtrado.filter((s) => s.cidade === cidadeAtual);
    if (q) filtrado = filtrado.filter((s) =>
      s.nome.toLowerCase().includes(q) || s.cidade.toLowerCase().includes(q) || s.tagline.toLowerCase().includes(q)
    );
    renderizar(filtrado);
  };

  searchInput.addEventListener('input', window.filterShops);
  cidadeFilter.addEventListener('change', () => {
    cidadeAtual = cidadeFilter.value;
    window.filterShops();
  });

  carregar();

  /* Menu mobile */
  const menuToggle = document.getElementById('menuToggle');
  const navMenu = document.getElementById('navMenu');
  menuToggle.addEventListener('click', () => navMenu.classList.toggle('open'));
  navMenu.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => navMenu.classList.remove('open')));

  /* Cadastro de barbearia */
  const cadastroOverlay = document.getElementById('cadastroOverlay');
  const cadastroForm = document.getElementById('cadastroForm');
  const cadastroError = document.getElementById('cadastroError');
  const cadastroSuccess = document.getElementById('cadastroSuccess');

  window.fecharCadastro = function () {
    cadastroOverlay.classList.add('hidden');
  };

  document.getElementById('btnCadastrarBarbearia').addEventListener('click', () => {
    cadastroError.classList.add('hidden');
    cadastroSuccess.classList.add('hidden');
    cadastroForm.classList.remove('hidden');
    cadastroOverlay.classList.remove('hidden');
    document.getElementById('cadNome').focus();
  });

  cadastroOverlay.addEventListener('click', (e) => {
    if (e.target === cadastroOverlay) window.fecharCadastro();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !cadastroOverlay.classList.contains('hidden')) window.fecharCadastro();
  });

  cadastroForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    cadastroError.classList.add('hidden');
    const btn = cadastroForm.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const res = await fetch('/api/cadastro-barbearia', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nome: document.getElementById('cadNome').value.trim(),
          cidade: document.getElementById('cadCidade').value.trim(),
          whatsapp: document.getElementById('cadWhatsapp').value.trim(),
          senha: document.getElementById('cadSenha').value
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Não foi possível enviar o cadastro.');
      document.getElementById('cadastroLink').textContent = location.origin + '/b/' + data.slug;
      cadastroForm.classList.add('hidden');
      cadastroSuccess.classList.remove('hidden');
    } catch (err) {
      cadastroError.textContent = err.message;
      cadastroError.classList.remove('hidden');
    } finally {
      btn.disabled = false;
    }
  });
})();
