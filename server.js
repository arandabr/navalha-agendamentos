require('dotenv').config();
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');
const { q, g, r, trans, pool, verifyPassword, hashPassword, verifySenhaBarbearia } = db;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

const pgSession = require('connect-pg-simple')(session);
app.use(session({
  store: new pgSession({ pool, tableName: 'session', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'navalha-super-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 }
}));

app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));

/* Envolve handlers async para capturar erros no Express 4 */
const ah = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error('[erro]', e);
  if (!res.headersSent) res.status(500).json({ error: 'Erro interno do servidor.' });
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const DIAS_NOMES = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const DIAS_ABREV = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

function minutosDe(t) {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function formatHora(min) {
  const h = String(Math.floor(min / 60)).padStart(2, '0');
  const m = String(min % 60).padStart(2, '0');
  return h + ':' + m;
}

function dataLocalStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function somaDias(base, n) {
  const d = new Date(base);
  d.setDate(d.getDate() + n);
  return d;
}

function normalizarTel(t) {
  return String(t || '').replace(/\D/g, '');
}

function slugificar(texto) {
  return String(texto).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function slugValido(slug) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

function normalizarSlug(input) {
  let s = String(input || '').trim();
  if (/^https?:\/\//i.test(s)) {
    try { s = new URL(s).pathname; } catch (e) {}
  }
  return s
    .replace(/^\/?b\//, '')
    .replace(/^\//, '')
    .split(/[?#]/)[0]
    .replace(/\/+$/, '')
    .trim();
}

const getBarbeariaPublica = (slug) => g('SELECT * FROM barbearias WHERE slug = ? AND ativa = 1', [slug]);
const getBarbeariaAdmin = (id) => g('SELECT * FROM barbearias WHERE id = ?', [id]);
const getServico = (id) => g('SELECT * FROM servicos WHERE id = ?', [id]);

async function getProfissionais(bid, ativos = true) {
  const qSql = ativos
    ? 'SELECT * FROM profissionais WHERE barbearia_id = ? AND ativo = 1 ORDER BY nome'
    : 'SELECT * FROM profissionais WHERE barbearia_id = ? ORDER BY nome';
  return q(qSql, [bid]);
}

async function getHorariosConfig(bid) {
  const rows = await q('SELECT * FROM horarios_config WHERE barbearia_id = ?', [bid]);
  const map = {};
  for (const r of rows) map[r.dia_semana] = r;
  return map;
}

const getHorarioDia = (bid, diaSemana) => g('SELECT * FROM horarios_config WHERE barbearia_id = ? AND dia_semana = ?', [bid, diaSemana]);

const getBloqueiosDia = (bid, date) => q('SELECT * FROM bloqueios WHERE barbearia_id = ? AND data = ?', [bid, date]);

/* Conflito: verifica se dois intervalos [a1,b1) e [a2,b2) se sobrepõem */
function sobrepoe(a1, b1, a2, b2) {
  return a1 < b2 && a2 < b1;
}

async function calcularSlots(bid, date, duracao, profId) {
  const dia = new Date(date + 'T12:00:00').getDay();
  const conf = await getHorarioDia(bid, dia);
  if (!conf || !conf.abertura || !conf.fechamento) return [];

  const intervalo = conf.intervalo || 30;
  const a = minutosDe(conf.abertura);
  const f = minutosDe(conf.fechamento);
  const profs = await getProfissionais(bid);

  const appts = await q(`
    SELECT * FROM agendamentos
    WHERE barbearia_id = ? AND data = ? AND status != 'cancelado'
  `, [bid, date]);

  const slots = [];
  const agora = new Date();
  const hojeStr = dataLocalStr(agora);
  const agoraMin = agora.getHours() * 60 + agora.getMinutes();
  const bloqueios = await getBloqueiosDia(bid, date);
  for (let t = a; t + duracao <= f; t += intervalo) {
    if (date === hojeStr && t <= agoraMin) continue;
    const fim = t + duracao;
    const bloqueado = bloqueios.some((bl) => {
      if (bl.dia_inteiro) return true;
      const bi = minutosDe(bl.hora_inicio);
      const bf = minutosDe(bl.hora_fim);
      if (bi === null || bf === null || bf <= bi) return true;
      return sobrepoe(t, fim, bi, bf);
    });
    if (bloqueado) continue;
    const ocupados = new Set();
    for (const ap of appts) {
      const a1 = minutosDe(ap.hora);
      const b1 = a1 + ap.duracao;
      if (sobrepoe(t, fim, a1, b1)) ocupados.add(ap.profissional_id);
    }

    let livre;
    if (profId) {
      livre = !ocupados.has(Number(profId));
    } else if (profs.length === 0) {
      livre = ocupados.size === 0;
    } else {
      livre = ocupados.size < profs.length;
    }

    if (livre) {
      slots.push({ hora: formatHora(t), disponivel: true });
    }
  }
  return slots;
}

async function escolherProfissionalLivre(bid, date, duracao, profId, hora) {
  if (profId) {
    const p = await g('SELECT id FROM profissionais WHERE id = ? AND barbearia_id = ?', [profId, bid]);
    return p ? p.id : null;
  }
  const profs = await getProfissionais(bid);
  const appts = await q(`
    SELECT * FROM agendamentos
    WHERE barbearia_id = ? AND data = ? AND status != 'cancelado'
  `, [bid, date]);
  const t = minutosDe(hora);
  if (t === null) return null;
  for (const p of profs) {
    const ocupado = appts.some((ap) => {
      const a1 = minutosDe(ap.hora);
      const b1 = a1 + ap.duracao;
      return ap.profissional_id === p.id && sobrepoe(t, t + duracao, a1, b1);
    });
    if (!ocupado) return p.id;
  }
  return null;
}

function requireAuth(req, res, next) {
  if (req.session && (req.session.admin || req.session.barbearia)) return next();
  return res.status(401).json({ error: 'Não autenticado. Faça login no painel.' });
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  return res.status(403).json({ error: 'Acesso restrito ao administrador.' });
}

/* Verifica se a sessão (admin ou dono da barbearia) tem acesso à barbearia `id`. */
function sessaoPode(req, res, id) {
  if (req.session && req.session.admin) return true;
  if (req.session && req.session.barbearia && Number(req.session.barbearia.id) === Number(id)) return true;
  res.status(403).json({ error: 'Sem permissão para esta barbearia.' });
  return false;
}

/* Valida um cupom sem incrementar o uso (retorna o registro se válido) */
async function checarCupom(b, codigo) {
  const code = String(codigo || '').trim().toUpperCase();
  if (!code) return { valido: false, error: 'Informe o código do cupom.' };
  const c = await g('SELECT * FROM cupons WHERE barbearia_id = ? AND codigo = ?', [b.id, code]);
  if (!c) return { valido: false, error: 'Cupom não encontrado.' };
  if (!c.ativo) return { valido: false, error: 'Este cupom está inativo.' };
  if (c.validade && c.validade < dataLocalStr(new Date())) return { valido: false, error: 'Este cupom expirou.' };
  if (c.limite_uso > 0 && c.usos >= c.limite_uso) return { valido: false, error: 'Este cupom atingiu o limite de usos.' };
  return { valido: true, cupom: c };
}

/* Aplica o cupom sobre um preço e registra o uso (ou retorna erro). */
async function aplicarCupom(b, codigo, preco) {
  if (!codigo) return { preco, cupom_id: null, preco_original: null };
  const rCup = await checarCupom(b, codigo);
  if (!rCup.valido) return { error: rCup.error };
  const c = rCup.cupom;
  const desc = c.tipo === 'percent'
    ? preco * (Number(c.desconto) / 100)
    : Math.min(Number(c.desconto), preco);
  const precoFinal = Math.max(0, preco - desc);
  await r('UPDATE cupons SET usos = usos + 1 WHERE id = ?', [c.id]);
  return {
    preco: precoFinal,
    cupom_id: c.id,
    preco_original: preco,
    cupom_codigo: c.codigo,
    cupom_tipo: c.tipo,
    cupom_desconto: c.desconto
  };
}

/* Fidelidade: +1 visita quando um atendimento é concluído. */
async function somarVisitaFidelidade(bid, nome, telefone) {
  const tel = normalizarTel(telefone);
  if (!tel) return;
  const existe = await g('SELECT * FROM fidelidade WHERE barbearia_id = ? AND telefone = ?', [bid, tel]);
  if (existe) {
    await r('UPDATE fidelidade SET visitas = visitas + 1, nome = ? WHERE id = ?', [String(nome || existe.nome).trim() || existe.nome, existe.id]);
  } else {
    await r('INSERT INTO fidelidade (barbearia_id, telefone, nome, visitas) VALUES (?, ?, ?, 1)', [bid, tel, String(nome || '').trim() || 'Cliente']);
  }
}

/* ------------------------------------------------------------------ */
/* Asaas (PIX)                                                         */
/* ------------------------------------------------------------------ */

const ASAAS_URLS = {
  sandbox: 'https://sandbox.asaas.com/api/v3',
  production: 'https://www.asaas.com/api/v3'
};
const asaasKey = (b) => (b && b.asaas_api_key) || process.env.ASAAS_API_KEY || '';
const asaasModeEfetivo = (b) => (b && b.asaas_api_key && b.asaas_mode) ? b.asaas_mode : (process.env.ASAAS_MODE || 'sandbox');
const asaasBase = (b) => ASAAS_URLS[asaasModeEfetivo(b) === 'production' ? 'production' : 'sandbox'];

async function criarCobrancaPix(b, ag) {
  const valor = Number(ag.preco) || 0;
  if (valor <= 0) throw new Error('Valor inválido para o pagamento.');
  const res = await fetch(asaasBase(b) + '/payments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', access_token: asaasKey(b) },
    body: JSON.stringify({
      billingType: 'PIX',
      customer: {
        name: ag.nome_cliente || 'Cliente',
        email: ag.email_cliente || '',
        phone: ag.telefone_cliente || '',
        cpfCnpj: String(ag.cpf_cliente || '').replace(/\D/g, '')
      },
      value: valor,
      dueDate: ag.data,
      description: 'Agendamento #' + String(ag.id).padStart(4, '0') + ' - ' + ag.servico_nome,
      externalReference: String(ag.id)
    })
  });
  const data = await res.json();
  if (!res.ok || !data.id) {
    const msg = data.errors ? data.errors.map((e) => e.description).join('; ') : 'Falha ao criar cobrança PIX.';
    throw new Error(msg);
  }
  let qrRes = await fetch(asaasBase(b) + '/payments/' + data.id + '/pixQrCode', {
    headers: { access_token: asaasKey(b) }
  });
  let qrData = await qrRes.json();
  for (let i = 0; i < 3 && !(qrData.encodedImage && qrData.payload); i++) {
    await new Promise((r) => setTimeout(r, 800));
    qrRes = await fetch(asaasBase(b) + '/payments/' + data.id + '/pixQrCode', {
      headers: { access_token: asaasKey(b) }
    });
    qrData = await qrRes.json();
  }
  return {
    asaas_payment_id: data.id,
    status: data.status,
    valor,
    pix_base64: String(qrData.encodedImage || '').replace(/^data:image\/png;base64,/, ''),
    pix_copia_cola: qrData.payload || ''
  };
}

async function processarWebhookAsaas(evento, payment) {
  if (!payment || !payment.id) return;
  const pag = await g('SELECT * FROM pagamentos WHERE asaas_payment_id = ?', [String(payment.id)]);
  if (!pag) return;
  if (evento === 'PAYMENT_RECEIVED' || evento === 'PAYMENT_CONFIRMED') {
    await r("UPDATE pagamentos SET status = 'confirmado' WHERE id = ?", [pag.id]);
    await r("UPDATE agendamentos SET pago = 1, status = CASE WHEN status = 'pendente' THEN 'confirmado' ELSE status END WHERE id = ?", [pag.agendamento_id]);
    await creditarSaldoBarbearia(pag);
  } else if (evento === 'PAYMENT_REFUNDED' || evento === 'PAYMENT_DELETED') {
    await r("UPDATE pagamentos SET status = 'cancelado' WHERE id = ?", [pag.id]);
    await r('UPDATE agendamentos SET pago = 0 WHERE id = ?', [pag.agendamento_id]);
    await debitarSaldoBarbearia(pag);
  } else if (evento === 'PAYMENT_OVERDUE') {
    await r("UPDATE pagamentos SET status = 'expirado' WHERE id = ?", [pag.id]);
  }
}

async function creditarSaldoBarbearia(pag) {
  if (!pag || pag.saldo_creditado) return;
  const barb = await g('SELECT * FROM barbearias WHERE id = ?', [pag.barbearia_id]);
  if (!barb) return;
  const percent = Number(barb.asaas_split_percent) || 0;
  const valorBarbearia = percent > 0 ? (Number(pag.valor) || 0) * percent / 100 : 0;
  if (valorBarbearia <= 0) {
    await r('UPDATE pagamentos SET saldo_creditado = 1 WHERE id = ?', [pag.id]);
    return;
  }
  await trans(async (ctx) => {
    await ctx.r('UPDATE pagamentos SET saldo_creditado = 1 WHERE id = ?', [pag.id]);
    await ctx.r('UPDATE barbearias SET saldo = saldo + ? WHERE id = ?', [valorBarbearia, pag.barbearia_id]);
  });
}

async function debitarSaldoBarbearia(pag) {
  if (!pag || !pag.saldo_creditado) return;
  const barb = await g('SELECT * FROM barbearias WHERE id = ?', [pag.barbearia_id]);
  if (!barb) return;
  const percent = Number(barb.asaas_split_percent) || 0;
  const valorBarbearia = percent > 0 ? (Number(pag.valor) || 0) * percent / 100 : 0;
  if (valorBarbearia <= 0) {
    await r('UPDATE pagamentos SET saldo_creditado = 0 WHERE id = ?', [pag.id]);
    return;
  }
  await trans(async (ctx) => {
    await ctx.r('UPDATE pagamentos SET saldo_creditado = 0 WHERE id = ?', [pag.id]);
    await ctx.r('UPDATE barbearias SET saldo = GREATEST(0, saldo - ?) WHERE id = ?', [valorBarbearia, pag.barbearia_id]);
  });
}

function inferirTipoPix(chave) {
  const c = String(chave || '').replace(/[\s.-]/g, '');
  if (!c) return '';
  if (/^\d{11}$/.test(c)) return 'CPF';
  if (/^\d{14}$/.test(c)) return 'CNPJ';
  if (/^\d{10,11}$/.test(c)) return 'PHONE';
  if (c.includes('@')) return 'EMAIL';
  return 'EVP';
}

async function transferirSaque(b, valor, chavePix) {
  const valorFmt = Math.round((Number(valor) || 0) * 100) / 100;
  if (valorFmt <= 0) throw new Error('Valor inválido para o saque.');
  const tipo = inferirTipoPix(chavePix);
  if (!tipo) throw new Error('Chave PIX de destino inválida.');
  const res = await fetch(asaasBase(b) + '/transfers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', access_token: asaasKey(b) },
    body: JSON.stringify({
      value: valorFmt,
      operationType: 'PIX',
      pixAddressKey: String(chavePix || '').trim(),
      pixAddressKeyType: tipo,
      description: 'Saque barbearia #' + String(b.id).padStart(4, '0')
    })
  });
  const data = await res.json();
  if (!res.ok || !data.id) {
    const msg = data.errors ? data.errors.map((e) => e.description).join('; ') : 'Falha ao criar transferência.';
    throw new Error(msg);
  }
  return data;
}

/* ------------------------------------------------------------------ */
/* Páginas                                                             */
/* ------------------------------------------------------------------ */

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/b/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'barbearia.html')));
app.get('/avaliar/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'avaliacao.html')));
app.get('/agendamentos', (req, res) => res.sendFile(path.join(__dirname, 'public', 'cliente.html')));
app.get('/minha-conta', (req, res) => res.redirect('/agendamentos'));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

/* ------------------------------------------------------------------ */
/* API Pública                                                         */
/* ------------------------------------------------------------------ */

app.get('/api/barbearias', ah(async (req, res) => {
  const rows = await q(`
    SELECT b.id, b.slug, b.nome, b.tagline, b.cidade, b.imagem, b.avaliacao,
           b.cor_primaria, b.horario_texto,
           (SELECT COUNT(*) FROM servicos s WHERE s.barbearia_id = b.id AND s.ativo = 1) AS servicos,
           (SELECT MIN(preco) FROM servicos s WHERE s.barbearia_id = b.id AND s.ativo = 1) AS preco_min
    FROM barbearias b
    WHERE b.ativa = 1
    ORDER BY b.nome
  `);
  res.json(rows);
}));

app.get('/api/barbearias/:slug', ah(async (req, res) => {
  const b = await getBarbeariaPublica(req.params.slug);
  if (!b) return res.status(404).json({ error: 'Barbearia não encontrada.' });

  const servicos = await q('SELECT * FROM servicos WHERE barbearia_id = ? AND ativo = 1 ORDER BY preco', [b.id]);
  const profissionais = await getProfissionais(b.id);
  const horarios = await getHorariosConfig(b.id);
  const avaliacoes = await q(`
    SELECT nota, comentario, nome, criado_em FROM avaliacoes
    WHERE barbearia_id = ? AND comentario != ''
    ORDER BY criado_em DESC LIMIT 20
  `, [b.id]);
  const media = await g('SELECT COALESCE(AVG(nota), 0) AS media, COUNT(*)::int AS total FROM avaliacoes WHERE barbearia_id = ?', [b.id]);

  const horariosArray = Array.from({ length: 7 }, (_, i) => ({
    dia_semana: i,
    nome: DIAS_NOMES[i],
    aberto: !!(horarios[i] && horarios[i].abertura),
    abertura: horarios[i] ? horarios[i].abertura : '',
    fechamento: horarios[i] ? horarios[i].fechamento : ''
  }));

  const publico = { ...b };
  delete publico.senha_hash;
  delete publico.senha_salt;
  delete publico.asaas_api_key;
  publico.asaas_configurado = !!asaasKey(b);
  res.json({ ...publico, servicos, profissionais, horarios: horariosArray, avaliacoes, avaliacao_media: media.media, avaliacao_total: media.total });
}));

/* Cadastro público de barbearia (sem login) — fica inativa até aprovação no painel */
app.post('/api/cadastro-barbearia', ah(async (req, res) => {
  const nome = String(req.body.nome || '').trim();
  if (!nome) return res.status(400).json({ error: 'Informe o nome da barbearia.' });
  const senha = String(req.body.senha || '');
  if (senha.length < 4) return res.status(400).json({ error: 'Crie uma senha de acesso ao painel com pelo menos 4 caracteres.' });

  let slug = slugificar(nome);
  if (!slugValido(slug)) slug = 'barbearia-' + Date.now().toString(36);
  let s = slug;
  let n = 2;
  while (await g('SELECT id FROM barbearias WHERE slug = ?', [s])) {
    s = `${slug}-${n}`;
    n++;
  }

  const { salt, hash } = hashPassword(senha);
  const info = await r(`
    INSERT INTO barbearias (slug, nome, tagline, descricao, endereco, cidade, telefone, whatsapp, email, instagram, imagem, capa, cor_primaria, horario_texto, ativa, senha_salt, senha_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `, [
    s, nome, '', '', '', String(req.body.cidade || '').trim(), '',
    String(req.body.whatsapp || '').trim(), '', '', '', '', '#c9a227', '', 0, salt, hash
  ]);
  const bid = info.lastID;

  for (let i = 0; i < 7; i++) {
    await r('INSERT INTO horarios_config (barbearia_id, dia_semana, abertura, fechamento, intervalo) VALUES (?, ?, ?, ?, ?)',
      [bid, i, i === 0 ? '' : '10:00', i === 0 ? '' : '20:00', 30]);
  }

  res.status(201).json({ id: bid, slug: s, nome, cidade: String(req.body.cidade || '').trim(), ativa: 0 });
}));

app.get('/api/barbearias/:slug/dias', ah(async (req, res) => {
  const b = await getBarbeariaPublica(req.params.slug);
  if (!b) return res.status(404).json({ error: 'Barbearia não encontrada.' });

  const hoje = new Date();
  const total = Math.min(parseInt(req.query.dias) || 14, 30);
  const out = [];
  for (let i = 0; i < total; i++) {
    const d = somaDias(hoje, i);
    const ds = dataLocalStr(d);
    const conf = await getHorarioDia(b.id, d.getDay());
    const bloqueioDiaInteiro = await g(
      'SELECT id FROM bloqueios WHERE barbearia_id = ? AND data = ? AND dia_inteiro = 1',
      [b.id, ds]
    );
    out.push({
      data: ds,
      dia_semana: d.getDay(),
      nome: DIAS_ABREV[d.getDay()],
      dia_num: String(d.getDate()).padStart(2, '0'),
      mes: ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'][d.getMonth()],
      aberto: !!(conf && conf.abertura) && !bloqueioDiaInteiro,
      hoje: i === 0
    });
  }
  res.json(out);
}));

app.get('/api/barbearias/:slug/horarios', ah(async (req, res) => {
  const b = await getBarbeariaPublica(req.params.slug);
  if (!b) return res.status(404).json({ error: 'Barbearia não encontrada.' });

  const { date, servico_id } = req.query;
  const profId = req.query.profissional_id || null;
  if (!date) return res.status(400).json({ error: 'Informe a data.' });

  const servico = servico_id ? await getServico(servico_id) : null;
  const duracao = servico ? servico.duracao : 30;

  if (servico_id && servico && servico.barbearia_id !== b.id) {
    return res.status(400).json({ error: 'Serviço inválido para esta barbearia.' });
  }

  const slots = await calcularSlots(b.id, date, duracao, profId);
  res.json({ data: date, duracao, slots });
}));

app.post('/api/agendamentos', ah(async (req, res) => {
  const {
    slug, servico_id, profissional_id, nome_cliente, telefone_cliente,
    email_cliente, cpf_cliente, data, hora, observacao
  } = req.body;

  const b = await getBarbeariaPublica(slug);
  if (!b) return res.status(404).json({ error: 'Barbearia não encontrada.' });

  const servico = await getServico(servico_id);
  if (!servico || servico.barbearia_id !== b.id || !servico.ativo) {
    return res.status(400).json({ error: 'Serviço inválido.' });
  }
  if (profissional_id) {
    const p = await g('SELECT * FROM profissionais WHERE id = ? AND barbearia_id = ?', [profissional_id, b.id]);
    if (!p || !p.ativo) return res.status(400).json({ error: 'Profissional inválido.' });
  }
  if (!nome_cliente || !telefone_cliente || !data || !hora) {
    return res.status(400).json({ error: 'Preencha nome, telefone, data e hora.' });
  }

  const dia = new Date(data + 'T12:00:00').getDay();
  const conf = await getHorarioDia(b.id, dia);
  const t = minutosDe(hora);
  if (!conf || !conf.abertura || !conf.fechamento) {
    return res.status(400).json({ error: 'Barbearia fechada nesta data.' });
  }
  if (t < minutosDe(conf.abertura) || t + servico.duracao > minutosDe(conf.fechamento)) {
    return res.status(400).json({ error: 'Horário fora do expediente.' });
  }

  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const dataObj = new Date(data + 'T12:00:00');
  if (dataObj < hoje) {
    return res.status(400).json({ error: 'Não é possível agendar em datas passadas.' });
  }

  const slots = await calcularSlots(b.id, data, servico.duracao, profissional_id || null);
  if (!slots.some((s) => s.hora === hora)) {
    return res.status(409).json({ error: 'Horário indisponível. Escolha outro.' });
  }

  const profEscolhido = await escolherProfissionalLivre(b.id, data, servico.duracao, profissional_id || null, hora);

  const cupom = await aplicarCupom(b, req.body.cupom, servico.preco);
  if (cupom.error) return res.status(400).json({ error: cupom.error });

  const token = crypto.randomBytes(12).toString('hex');
  await r(`
    INSERT INTO agendamentos
    (barbearia_id, profissional_id, servico_id, nome_cliente, telefone_cliente,
     email_cliente, cpf_cliente, data, hora, duracao, preco, preco_original, cupom_id, status, observacao, token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendente', ?, ?)
  `, [
    b.id, profEscolhido, servico.id, nome_cliente, telefone_cliente,
    email_cliente, cpf_cliente || '', data, hora, servico.duracao, cupom.preco, cupom.preco_original, cupom.cupom_id,
    observacao || '', token
  ]);

  const novo = await g(`
    SELECT ag.*, s.nome AS servico_nome, p.nome AS profissional_nome, b.nome AS barbearia_nome
    FROM agendamentos ag
    JOIN servicos s ON s.id = ag.servico_id
    LEFT JOIN profissionais p ON p.id = ag.profissional_id
    JOIN barbearias b ON b.id = ag.barbearia_id
    WHERE ag.token = ?
  `, [token]);

  res.status(201).json(novo);
}));

app.get('/api/agendamentos/:token', ah(async (req, res) => {
  const row = await g(`
    SELECT ag.*, s.nome AS servico_nome, p.nome AS profissional_nome, b.nome AS barbearia_nome
    FROM agendamentos ag
    JOIN servicos s ON s.id = ag.servico_id
    LEFT JOIN profissionais p ON p.id = ag.profissional_id
    JOIN barbearias b ON b.id = ag.barbearia_id
    WHERE ag.token = ?
  `, [req.params.token]);
  if (!row) return res.status(404).json({ error: 'Agendamento não encontrado.' });
  res.json(row);
}));

/* PIX: cria cobrança Asaas para um agendamento (público) */
app.post('/api/agendamentos/:id/pix', ah(async (req, res) => {
  const ag = await g(`
    SELECT ag.*, b.asaas_api_key, b.asaas_mode, b.asaas_wallet_id, b.asaas_split_percent, b.nome AS barbearia_nome, s.nome AS servico_nome
    FROM agendamentos ag
    JOIN barbearias b ON b.id = ag.barbearia_id
    JOIN servicos s ON s.id = ag.servico_id
    WHERE ag.id = ?
  `, [req.params.id]);
  if (!ag) return res.status(404).json({ error: 'Agendamento não encontrado.' });
  if (ag.status === 'cancelado') return res.status(400).json({ error: 'Agendamento cancelado.' });
  if (ag.pago) return res.json({ pagamento: { status: 'confirmado', valor: ag.preco } });
  if (!asaasKey(ag)) return res.status(400).json({ error: 'PIX ainda não configurado para esta barbearia.' });

  let pag = await g('SELECT * FROM pagamentos WHERE agendamento_id = ? ORDER BY id DESC', [ag.id]);
  if (!pag || pag.status === 'expirado') {
    const criado = await criarCobrancaPix(ag, ag);
    const info = await r(`
      INSERT INTO pagamentos (agendamento_id, barbearia_id, asaas_payment_id, valor, status, pix_base64, pix_copia_cola)
      VALUES (?, ?, ?, ?, 'pendente', ?, ?)
      RETURNING id
    `, [ag.id, ag.barbearia_id, criado.asaas_payment_id, criado.valor, criado.pix_base64, criado.pix_copia_cola]);
    pag = await g('SELECT * FROM pagamentos WHERE id = ?', [info.lastID]);
  }
  res.json({
    pagamento: {
      id: pag.id,
      status: pag.status,
      valor: pag.valor,
      pix_base64: pag.pix_base64,
      pix_copia_cola: pag.pix_copia_cola
    }
  });
}));

app.get('/api/agendamentos/:token/pix-status', ah(async (req, res) => {
  const ag = await g('SELECT * FROM agendamentos WHERE token = ?', [req.params.token]);
  if (!ag) return res.status(404).json({ error: 'Agendamento não encontrado.' });
  const pag = await g('SELECT * FROM pagamentos WHERE agendamento_id = ? ORDER BY id DESC', [ag.id]);
  res.json({ pago: ag.pago === 1, status: ag.status, pagamento: pag ? { status: pag.status } : null });
}));

/* Webhook do Asaas (confirmação de pagamento) */
app.post('/api/webhooks/asaas', (req, res) => {
  const evento = req.body.event;
  const payment = req.body.payment || req.body;
  processarWebhookAsaas(evento, payment).catch((e) => console.error('[webhook]', e.message));
  res.json({ ok: true });
});

/* Avaliação pós-atendimento (cliente usa o token do agendamento) */
app.post('/api/avaliacoes', ah(async (req, res) => {
  const { token, nota, comentario, nome } = req.body;
  const ag = await g('SELECT * FROM agendamentos WHERE token = ?', [token]);
  if (!ag) return res.status(404).json({ error: 'Agendamento não encontrado.' });
  if (ag.status !== 'concluido') return res.status(400).json({ error: 'Só é possível avaliar após a conclusão do atendimento.' });
  const n = Math.max(1, Math.min(5, Math.round(Number(nota) || 5)));
  await r('INSERT INTO avaliacoes (barbearia_id, agendamento_id, nome, nota, comentario) VALUES (?, ?, ?, ?, ?)',
    [ag.barbearia_id, ag.id, String(nome || '').trim() || 'Cliente', n, String(comentario || '').trim()]);
  res.status(201).json({ ok: true });
}));

/* Fila de espera (público) */
app.post('/api/fila-espera', ah(async (req, res) => {
  const b = await getBarbeariaPublica(req.body.slug);
  if (!b) return res.status(404).json({ error: 'Barbearia não encontrada.' });
  const nome_cliente = String(req.body.nome_cliente || '').trim();
  const telefone_cliente = String(req.body.telefone_cliente || '').trim();
  if (!nome_cliente || !telefone_cliente) {
    return res.status(400).json({ error: 'Informe nome e WhatsApp.' });
  }
  let servico_id = null;
  if (req.body.servico_id) {
    const sv = await getServico(req.body.servico_id);
    if (sv && sv.barbearia_id === b.id) servico_id = sv.id;
  }
  const info = await r(`
    INSERT INTO fila_espera (barbearia_id, servico_id, profissional_id, nome_cliente, telefone_cliente, data_preferida, observacao)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [b.id, servico_id, req.body.profissional_id || null, nome_cliente, telefone_cliente,
    String(req.body.data_preferida || '').trim(), String(req.body.observacao || '').trim()]);
  res.status(201).json({ ok: true, id: info.lastID });
}));

/* Validação pública de cupom (não consome o uso) */
app.get('/api/barbearias/:slug/cupom', ah(async (req, res) => {
  const b = await getBarbeariaPublica(req.params.slug);
  if (!b) return res.status(404).json({ error: 'Barbearia não encontrada.' });
  const rCup = await checarCupom(b, req.query.codigo);
  if (!rCup.valido) return res.json({ valido: false, error: rCup.error });
  const c = rCup.cupom;
  const preco = Number(req.query.preco) || 0;
  const desc = preco
    ? (c.tipo === 'percent' ? preco * (Number(c.desconto) / 100) : Math.min(Number(c.desconto), preco))
    : 0;
  res.json({ valido: true, tipo: c.tipo, desconto: c.desconto, preco_final: preco ? Math.max(0, preco - desc) : null });
}));

/* ------------------------------------------------------------------ */
/* API Cliente — Área do cliente                                       */
/* ------------------------------------------------------------------ */

app.post('/api/cliente/acesso', ah(async (req, res) => {
  const tel = normalizarTel(req.body.telefone);
  if (!tel || tel.length < 10) {
    return res.status(400).json({ error: 'Informe seu WhatsApp com DDD para acessar.' });
  }
  const combina = (t) => t === tel || (t.length >= 10 && (t.endsWith(tel) || tel.endsWith(t)));

  const ags = await q(`
    SELECT ag.*, s.nome AS servico_nome, p.nome AS profissional_nome,
           b.nome AS barbearia_nome, b.slug AS barbearia_slug, b.whatsapp AS barbearia_whatsapp
    FROM agendamentos ag
    JOIN servicos s ON s.id = ag.servico_id
    LEFT JOIN profissionais p ON p.id = ag.profissional_id
    JOIN barbearias b ON b.id = ag.barbearia_id
    ORDER BY ag.data DESC, ag.hora DESC
  `);
  const meus = ags.filter((a) => combina(normalizarTel(a.telefone_cliente)));

  const shops = [...new Set(meus.map((a) => a.barbearia_id))];
  const fidelidade = [];
  for (const bid of shops) {
    const shop = await g('SELECT id, nome, slug FROM barbearias WHERE id = ?', [bid]);
    const config = await g('SELECT * FROM fidelidade_config WHERE barbearia_id = ?', [bid]) || { barbearia_id: bid, ativo: 0, premio_visitas: 10 };
    const rows = await q('SELECT * FROM fidelidade WHERE barbearia_id = ?', [bid]);
    const cli = rows.find((x) => combina(normalizarTel(x.telefone))) || { visitas: 0, premios_resgatados: 0 };
    fidelidade.push({ barbearia: shop, config, cliente: cli });
  }

  if (!meus.length && !fidelidade.length) {
    return res.status(404).json({ error: 'Nenhum agendamento encontrado para este WhatsApp.' });
  }
  res.json({ agendamentos: meus, fidelidade });
}));

app.post('/api/cliente/agendamentos/:id/cancelar', ah(async (req, res) => {
  const a = await g('SELECT * FROM agendamentos WHERE id = ?', [req.params.id]);
  if (!a) return res.status(404).json({ error: 'Agendamento não encontrado.' });
  if (normalizarTel(a.telefone_cliente) !== normalizarTel(req.body.telefone)) {
    return res.status(403).json({ error: 'Este agendamento não pertence a este WhatsApp.' });
  }
  if (a.status === 'concluido') return res.status(400).json({ error: 'Não é possível cancelar um atendimento já concluído.' });
  if (a.status === 'cancelado') return res.status(400).json({ error: 'Este agendamento já está cancelado.' });
  await r("UPDATE agendamentos SET status = 'cancelado', motivo_cancelamento = 'Cancelado pelo cliente' WHERE id = ?", [a.id]);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ */
/* API Admin — Autenticação                                            */
/* ------------------------------------------------------------------ */

app.post('/api/admin/login', ah(async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Informe usuário e senha.' });
  if (await verifyPassword(username, password)) {
    const admin = await g('SELECT id, username, nome FROM admin WHERE username = ?', [username]);
    req.session.admin = admin;
    return res.json({ ok: true, admin });
  }
  res.status(401).json({ error: 'Usuário ou senha inválidos.' });
}));

app.post('/api/admin/login-barbearia', ah(async (req, res) => {
  const slug = normalizarSlug(req.body.slug);
  const senha = String(req.body.senha || '');
  const b = await g('SELECT * FROM barbearias WHERE slug = ?', [slug]);
  if (!b) return res.status(401).json({ error: 'Barbearia não encontrada. Verifique o link da página.' });
  if (!await verifySenhaBarbearia(b, senha)) return res.status(401).json({ error: 'Senha incorreta.' });
  req.session.barbearia = { id: b.id, nome: b.nome, slug: b.slug };
  return res.json({ ok: true, barbearia: { id: b.id, nome: b.nome, slug: b.slug, ativa: b.ativa } });
}));

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/admin/me', ah(async (req, res) => {
  if (req.session && req.session.admin) return res.json({ admin: req.session.admin });
  if (req.session && req.session.barbearia) {
    const b = await g('SELECT id, nome, slug, ativa FROM barbearias WHERE id = ?', [req.session.barbearia.id]);
    if (b) return res.json({ barbearia: { id: b.id, nome: b.nome, slug: b.slug, ativa: b.ativa } });
    req.session.destroy(() => {});
    return res.json({ admin: null });
  }
  res.json({ admin: null });
}));

/* ------------------------------------------------------------------ */
/* API Admin — Barbearias                                              */
/* ------------------------------------------------------------------ */

app.get('/api/admin/barbearias', requireAuth, ah(async (req, res) => {
  let rows;
  if (req.session.admin) {
    rows = await q(`
      SELECT b.*,
        (SELECT COUNT(*) FROM agendamentos a WHERE a.barbearia_id = b.id AND a.data = CURRENT_DATE::text) AS agendamentos_hoje
      FROM barbearias b ORDER BY b.nome
    `);
  } else {
    rows = await q(`
      SELECT b.*,
        (SELECT COUNT(*) FROM agendamentos a WHERE a.barbearia_id = b.id AND a.data = CURRENT_DATE::text) AS agendamentos_hoje
      FROM barbearias b WHERE b.id = ? ORDER BY b.nome
    `, [req.session.barbearia.id]);
  }
  res.json(rows.map((b) => { const x = { ...b }; delete x.senha_hash; delete x.senha_salt; delete x.asaas_api_key; return x; }));
}));

app.get('/api/admin/barbearias/:id', requireAuth, ah(async (req, res) => {
  const b = await getBarbeariaAdmin(req.params.id);
  if (!b) return res.status(404).json({ error: 'Barbearia não encontrada.' });
  if (!sessaoPode(req, res, b.id)) return;
  const servicos = await q('SELECT * FROM servicos WHERE barbearia_id = ? ORDER BY preco', [b.id]);
  const profissionais = await q('SELECT * FROM profissionais WHERE barbearia_id = ? ORDER BY nome', [b.id]);
  const horarios = await getHorariosConfig(b.id);
  const horariosArray = Array.from({ length: 7 }, (_, i) => ({
    dia_semana: i,
    nome: DIAS_NOMES[i],
    abreviado: DIAS_ABREV[i],
    abertura: horarios[i] ? horarios[i].abertura : '',
    fechamento: horarios[i] ? horarios[i].fechamento : '',
    intervalo: horarios[i] ? horarios[i].intervalo : 30
  }));
  const x = { ...b, servicos, profissionais, horarios: horariosArray };
  delete x.senha_hash;
  delete x.senha_salt;
  delete x.asaas_api_key;
  res.json(x);
}));

/* Verifica se um slug está disponível (ou pertence ao próprio registro) */
app.get('/api/admin/slug-disponivel', requireAuth, ah(async (req, res) => {
  const slug = slugificar(req.query.slug || '');
  const exclude = req.query.exclude ? Number(req.query.exclude) : null;
  if (!slug) return res.json({ disponivel: false, valido: false, sugerido: '' });
  const existe = await g(
    exclude ? 'SELECT id FROM barbearias WHERE slug = ? AND id != ?' : 'SELECT id FROM barbearias WHERE slug = ?',
    exclude ? [slug, exclude] : [slug]
  );
  res.json({
    valido: slugValido(slug),
    disponivel: !existe,
    normalizado: slug
  });
}));

app.post('/api/admin/barbearias', requireAdmin, ah(async (req, res) => {
  const { nome, slug, cidade, ativa } = req.body;
  if (!nome) return res.status(400).json({ error: 'Informe o nome da barbearia.' });

  const s = slugificar(slug || nome);
  if (!slugValido(s)) return res.status(400).json({ error: 'O slug só pode conter letras minúsculas, números e hífens.' });
  if (await g('SELECT id FROM barbearias WHERE slug = ?', [s])) {
    return res.status(409).json({ error: 'Este link já está em uso por outra barbearia. Escolha outro slug.' });
  }

  const info = await r(`
    INSERT INTO barbearias (slug, nome, tagline, descricao, endereco, cidade, telefone, whatsapp, email, instagram, imagem, capa, cor_primaria, horario_texto, ativa)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `, [
    s, nome, req.body.tagline || '', req.body.descricao || '', req.body.endereco || '',
    cidade || '', req.body.telefone || '', req.body.whatsapp || '', req.body.email || '',
    req.body.instagram || '', req.body.imagem || '', req.body.capa || '',
    req.body.cor_primaria || '#c9a227', req.body.horario_texto || '', ativa ? 1 : 0
  ]);
  const bid = info.lastID;

  for (let i = 0; i < 7; i++) {
    await r('INSERT INTO horarios_config (barbearia_id, dia_semana, abertura, fechamento, intervalo) VALUES (?, ?, ?, ?, ?)',
      [bid, i, i === 0 ? '' : '10:00', i === 0 ? '' : '20:00', 30]);
  }

  res.status(201).json(await g('SELECT * FROM barbearias WHERE id = ?', [bid]));
}));

app.put('/api/admin/barbearias/:id', requireAuth, ah(async (req, res) => {
  const b = await getBarbeariaAdmin(req.params.id);
  if (!b) return res.status(404).json({ error: 'Barbearia não encontrada.' });
  if (!sessaoPode(req, res, b.id)) return;

  const ehDono = !!(req.session && req.session.barbearia);
  if (req.body.slug !== undefined) {
    req.body.slug = slugificar(req.body.slug);
    if (!slugValido(req.body.slug)) {
      return res.status(400).json({ error: 'O slug só pode conter letras minúsculas, números e hífens.' });
    }
    const duplicado = await g('SELECT id FROM barbearias WHERE slug = ? AND id != ?', [req.body.slug, req.params.id]);
    if (duplicado) return res.status(409).json({ error: 'Este link já está em uso por outra barbearia.' });
  }

  const campos = ['nome', 'slug', 'tagline', 'descricao', 'endereco', 'cidade', 'telefone',
    'whatsapp', 'email', 'instagram', 'imagem', 'capa', 'cor_primaria', 'horario_texto', 'pix_chave'];
  const camposAdmin = ['asaas_api_key', 'asaas_mode', 'asaas_wallet_id', 'asaas_split_percent'];
  if (!ehDono) campos.push(...camposAdmin, 'avaliacao');
  const updates = [];
  const valores = [];
  for (const c of campos) {
    if (req.body[c] !== undefined) {
      updates.push(`${c} = ?`);
      valores.push(req.body[c]);
    }
  }
  if (!ehDono && req.body.ativa !== undefined) {
    updates.push('ativa = ?');
    valores.push(req.body.ativa ? 1 : 0);
  }
  if (req.body.senha && String(req.body.senha).length >= 4) {
    const { salt, hash } = hashPassword(String(req.body.senha));
    updates.push('senha_salt = ?', 'senha_hash = ?');
    valores.push(salt, hash);
  }
  if (!updates.length) return res.status(400).json({ error: 'Nada para atualizar.' });

  valores.push(req.params.id);
  await r(`UPDATE barbearias SET ${updates.join(', ')} WHERE id = ?`, valores);
  const x = await g('SELECT * FROM barbearias WHERE id = ?', [req.params.id]);
  delete x.senha_hash;
  delete x.senha_salt;
  delete x.asaas_api_key;
  res.json(x);
}));

app.delete('/api/admin/barbearias/:id', requireAdmin, ah(async (req, res) => {
  await r('DELETE FROM barbearias WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ */
/* API Admin — Saldo e Saques                                          */
/* ------------------------------------------------------------------ */

/* Lista saques de uma barbearia (admin ou dono) */
app.get('/api/admin/barbearias/:id/saques', requireAuth, ah(async (req, res) => {
  const b = await getBarbeariaAdmin(req.params.id);
  if (!b) return res.status(404).json({ error: 'Barbearia não encontrada.' });
  if (!sessaoPode(req, res, b.id)) return;
  const saques = await q('SELECT * FROM saques WHERE barbearia_id = ? ORDER BY id DESC', [b.id]);
  res.json({ saldo: Number(b.saldo) || 0, saques });
}));

/* Cria um pedido de saque (admin ou dono) */
app.post('/api/admin/barbearias/:id/saques', requireAuth, ah(async (req, res) => {
  const b = await getBarbeariaAdmin(req.params.id);
  if (!b) return res.status(404).json({ error: 'Barbearia não encontrada.' });
  if (!sessaoPode(req, res, b.id)) return;
  const valor = Math.round((Number(req.body.valor) || 0) * 100) / 100;
  const chavePix = String(req.body.pix_chave || '').trim();
  if (valor <= 0) return res.status(400).json({ error: 'Informe um valor válido para o saque.' });
  if (!chavePix) return res.status(400).json({ error: 'Informe a chave PIX de destino.' });
  if ((Number(b.saldo) || 0) < valor) return res.status(400).json({ error: 'Saldo insuficiente para o saque.' });
  const solicitadoPor = (req.session && req.session.barbearia) ? 'barbearia' : 'admin';
  const info = await r(
    "INSERT INTO saques (barbearia_id, valor, status, pix_chave, solicitado_por) VALUES (?, ?, 'pendente', ?, ?) RETURNING id",
    [b.id, valor, chavePix, solicitadoPor]
  );
  res.status(201).json(await g('SELECT * FROM saques WHERE id = ?', [info.lastID]));
}));

/* Processa um saque: executa a transferência PIX no Asaas (apenas admin) */
app.post('/api/admin/saques/:id/processar', requireAdmin, ah(async (req, res) => {
  const saque = await g('SELECT * FROM saques WHERE id = ?', [req.params.id]);
  if (!saque) return res.status(404).json({ error: 'Saque não encontrado.' });
  if (saque.status !== 'pendente') return res.status(400).json({ error: 'Este saque já foi processado.' });
  const b = await getBarbeariaAdmin(saque.barbearia_id);
  if (!b) return res.status(404).json({ error: 'Barbearia não encontrada.' });
  if ((Number(b.saldo) || 0) < Number(saque.valor)) return res.status(400).json({ error: 'Saldo insuficiente para este saque.' });
  try {
    const transfer = await transferirSaque(b, saque.valor, saque.pix_chave);
    await trans(async (ctx) => {
      await ctx.r(
        "UPDATE saques SET status = 'concluido', asaas_transfer_id = ?, concluido_em = now() WHERE id = ?",
        [transfer.id, saque.id]
      );
      await ctx.r('UPDATE barbearias SET saldo = GREATEST(0, saldo - ?) WHERE id = ?', [saque.valor, b.id]);
    });
    res.json({ ok: true, saque: await g('SELECT * FROM saques WHERE id = ?', [saque.id]) });
  } catch (e) {
    res.status(502).json({ error: 'Falha na transferência: ' + e.message });
  }
}));

/* Cancela um saque pendente (admin ou dono) */
app.post('/api/admin/saques/:id/cancelar', requireAuth, ah(async (req, res) => {
  const saque = await g('SELECT * FROM saques WHERE id = ?', [req.params.id]);
  if (!saque) return res.status(404).json({ error: 'Saque não encontrado.' });
  if (saque.status !== 'pendente') return res.status(400).json({ error: 'Apenas saques pendentes podem ser cancelados.' });
  if (!sessaoPode(req, res, saque.barbearia_id)) return;
  await r("UPDATE saques SET status = 'cancelado' WHERE id = ?", [saque.id]);
  res.json({ ok: true });
}));

/* Lista todos os saques (apenas admin) */
app.get('/api/admin/saques', requireAdmin, ah(async (req, res) => {
  const rows = await q(`
    SELECT s.*, b.nome AS barbearia_nome, b.slug AS barbearia_slug
    FROM saques s JOIN barbearias b ON b.id = s.barbearia_id
    ORDER BY s.id DESC
  `);
  res.json(rows);
}));

/* ------------------------------------------------------------------ */
/* API Admin — Serviços                                                */
/* ------------------------------------------------------------------ */

app.get('/api/admin/servicos', requireAuth, ah(async (req, res) => {
  const bid = Number(req.query.barbearia_id);
  if (!sessaoPode(req, res, bid)) return;
  const rows = await q('SELECT * FROM servicos WHERE barbearia_id = ? ORDER BY preco', [bid]);
  res.json(rows);
}));

app.post('/api/admin/servicos', requireAuth, ah(async (req, res) => {
  const { barbearia_id, nome, preco, duracao } = req.body;
  if (!sessaoPode(req, res, Number(barbearia_id))) return;
  if (!barbearia_id || !nome) return res.status(400).json({ error: 'Informe a barbearia e o nome do serviço.' });
  const info = await r('INSERT INTO servicos (barbearia_id, nome, descricao, preco, duracao) VALUES (?, ?, ?, ?, ?) RETURNING id',
    [barbearia_id, nome, req.body.descricao || '', Number(preco) || 0, Number(duracao) || 30]);
  res.status(201).json(await g('SELECT * FROM servicos WHERE id = ?', [info.lastID]));
}));

app.put('/api/admin/servicos/:id', requireAuth, ah(async (req, res) => {
  const s = await g('SELECT * FROM servicos WHERE id = ?', [req.params.id]);
  if (!s) return res.status(404).json({ error: 'Serviço não encontrado.' });
  if (!sessaoPode(req, res, s.barbearia_id)) return;
  const campos = ['nome', 'descricao', 'preco', 'duracao'];
  const updates = [];
  const valores = [];
  for (const c of campos) {
    if (req.body[c] !== undefined) {
      updates.push(`${c} = ?`);
      valores.push(c === 'preco' || c === 'duracao' ? Number(req.body[c]) : req.body[c]);
    }
  }
  if (req.body.ativo !== undefined) { updates.push('ativo = ?'); valores.push(req.body.ativo ? 1 : 0); }
  if (!updates.length) return res.status(400).json({ error: 'Nada para atualizar.' });
  valores.push(req.params.id);
  await r(`UPDATE servicos SET ${updates.join(', ')} WHERE id = ?`, valores);
  res.json(await g('SELECT * FROM servicos WHERE id = ?', [req.params.id]));
}));

app.delete('/api/admin/servicos/:id', requireAuth, ah(async (req, res) => {
  const s = await g('SELECT * FROM servicos WHERE id = ?', [req.params.id]);
  if (!s) return res.status(404).json({ error: 'Serviço não encontrado.' });
  if (!sessaoPode(req, res, s.barbearia_id)) return;
  await r('DELETE FROM servicos WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ */
/* API Admin — Profissionais                                           */
/* ------------------------------------------------------------------ */

app.get('/api/admin/profissionais', requireAuth, ah(async (req, res) => {
  const bid = Number(req.query.barbearia_id);
  if (!sessaoPode(req, res, bid)) return;
  const rows = await q('SELECT * FROM profissionais WHERE barbearia_id = ? ORDER BY nome', [bid]);
  res.json(rows);
}));

app.post('/api/admin/profissionais', requireAuth, ah(async (req, res) => {
  const { barbearia_id, nome } = req.body;
  if (!sessaoPode(req, res, Number(barbearia_id))) return;
  if (!barbearia_id || !nome) return res.status(400).json({ error: 'Informe a barbearia e o nome.' });
  const info = await r('INSERT INTO profissionais (barbearia_id, nome, cargo, foto) VALUES (?, ?, ?, ?) RETURNING id',
    [barbearia_id, nome, req.body.cargo || '', req.body.foto || '']);
  res.status(201).json(await g('SELECT * FROM profissionais WHERE id = ?', [info.lastID]));
}));

app.put('/api/admin/profissionais/:id', requireAuth, ah(async (req, res) => {
  const p = await g('SELECT * FROM profissionais WHERE id = ?', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Profissional não encontrado.' });
  if (!sessaoPode(req, res, p.barbearia_id)) return;
  const campos = ['nome', 'cargo', 'foto'];
  const updates = [];
  const valores = [];
  for (const c of campos) {
    if (req.body[c] !== undefined) { updates.push(`${c} = ?`); valores.push(req.body[c]); }
  }
  if (req.body.ativo !== undefined) { updates.push('ativo = ?'); valores.push(req.body.ativo ? 1 : 0); }
  if (!updates.length) return res.status(400).json({ error: 'Nada para atualizar.' });
  valores.push(req.params.id);
  await r(`UPDATE profissionais SET ${updates.join(', ')} WHERE id = ?`, valores);
  res.json(await g('SELECT * FROM profissionais WHERE id = ?', [req.params.id]));
}));

app.delete('/api/admin/profissionais/:id', requireAuth, ah(async (req, res) => {
  const p = await g('SELECT * FROM profissionais WHERE id = ?', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Profissional não encontrado.' });
  if (!sessaoPode(req, res, p.barbearia_id)) return;
  await r('DELETE FROM profissionais WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ */
/* API Admin — Horários                                                */
/* ------------------------------------------------------------------ */

app.put('/api/admin/horarios', requireAuth, ah(async (req, res) => {
  const { barbearia_id, horarios } = req.body;
  if (!sessaoPode(req, res, Number(barbearia_id))) return;
  if (!barbearia_id || !Array.isArray(horarios)) {
    return res.status(400).json({ error: 'Dados inválidos.' });
  }
  await trans(async (t) => {
    for (const h of horarios) {
      const aberto = !!h.aberto;
      await t.r(`
        INSERT INTO horarios_config (barbearia_id, dia_semana, abertura, fechamento, intervalo)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(barbearia_id, dia_semana) DO UPDATE SET
          abertura = EXCLUDED.abertura,
          fechamento = EXCLUDED.fechamento,
          intervalo = EXCLUDED.intervalo
      `, [barbearia_id, h.dia_semana, aberto ? h.abertura : '', aberto ? h.fechamento : '', Number(h.intervalo) || 30]);
    }
  });
  res.json({ ok: true, horarios: await getHorariosConfig(barbearia_id) });
}));

/* ------------------------------------------------------------------ */
/* API Admin — Agendamentos                                            */
/* ------------------------------------------------------------------ */

app.get('/api/admin/agendamentos', requireAuth, ah(async (req, res) => {
  const { barbearia_id, data, status } = req.query;
  if (!sessaoPode(req, res, Number(barbearia_id))) return;
  const where = ['1=1'];
  const params = [];
  if (barbearia_id) { where.push('ag.barbearia_id = ?'); params.push(barbearia_id); }
  if (data) { where.push('ag.data = ?'); params.push(data); }
  if (status) { where.push('ag.status = ?'); params.push(status); }

  const rows = await q(`
    SELECT ag.*, s.nome AS servico_nome, p.nome AS profissional_nome
    FROM agendamentos ag
    JOIN servicos s ON s.id = ag.servico_id
    LEFT JOIN profissionais p ON p.id = ag.profissional_id
    WHERE ${where.join(' AND ')}
    ORDER BY ag.data ASC, ag.hora ASC
  `, params);
  res.json(rows);
}));

app.post('/api/admin/agendamentos', requireAuth, ah(async (req, res) => {
  const { barbearia_id, servico_id, profissional_id, nome_cliente, telefone_cliente, data, hora } = req.body;
  if (!sessaoPode(req, res, Number(barbearia_id))) return;
  if (!barbearia_id || !servico_id || !nome_cliente || !telefone_cliente || !data || !hora) {
    return res.status(400).json({ error: 'Preencha todos os campos obrigatórios.' });
  }
  const servico = await getServico(servico_id);
  if (!servico || servico.barbearia_id !== Number(barbearia_id)) return res.status(400).json({ error: 'Serviço inválido.' });

  const slots = await calcularSlots(barbearia_id, data, servico.duracao, profissional_id || null);
  if (!slots.some((s) => s.hora === hora)) {
    return res.status(409).json({ error: 'Horário indisponível.' });
  }
  const profEscolhido = await escolherProfissionalLivre(barbearia_id, data, servico.duracao, profissional_id || null, hora);
  const token = crypto.randomBytes(12).toString('hex');
  const info = await r(`
    INSERT INTO agendamentos
    (barbearia_id, profissional_id, servico_id, nome_cliente, telefone_cliente, email_cliente, cpf_cliente,
     data, hora, duracao, preco, status, observacao, token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `, [
    barbearia_id, profEscolhido, servico.id, nome_cliente, telefone_cliente, req.body.email_cliente || '', req.body.cpf_cliente || '',
    data, hora, servico.duracao, servico.preco, req.body.status || 'confirmado', req.body.observacao || '', token
  ]);
  res.status(201).json(await g('SELECT * FROM agendamentos WHERE id = ?', [info.lastID]));
}));

app.patch('/api/admin/agendamentos/:id', requireAuth, ah(async (req, res) => {
  const a = await g('SELECT * FROM agendamentos WHERE id = ?', [req.params.id]);
  if (!a) return res.status(404).json({ error: 'Agendamento não encontrado.' });
  if (!sessaoPode(req, res, a.barbearia_id)) return;
  const statusPermitidos = ['pendente', 'confirmado', 'em_atendimento', 'concluido', 'cancelado', 'ausente'];
  const updates = [];
  const valores = [];
  if (req.body.status !== undefined) {
    if (!statusPermitidos.includes(req.body.status)) {
      return res.status(400).json({ error: 'Status inválido.' });
    }
    updates.push('status = ?');
    valores.push(req.body.status);
    if (req.body.status === 'cancelado' && req.body.motivo !== undefined) {
      updates.push('motivo_cancelamento = ?');
      valores.push(String(req.body.motivo || ''));
    }
    if (req.body.status === 'concluido' && a.status !== 'concluido') {
      await somarVisitaFidelidade(a.barbearia_id, a.nome_cliente, a.telefone_cliente);
    }
  }
  for (const c of ['nome_cliente', 'telefone_cliente', 'email_cliente', 'observacao', 'hora', 'data']) {
    if (req.body[c] !== undefined) { updates.push(`${c} = ?`); valores.push(req.body[c]); }
  }
  if (!updates.length) return res.status(400).json({ error: 'Nada para atualizar.' });
  valores.push(req.params.id);
  await r(`UPDATE agendamentos SET ${updates.join(', ')} WHERE id = ?`, valores);
  res.json(await g('SELECT * FROM agendamentos WHERE id = ?', [req.params.id]));
}));

app.delete('/api/admin/agendamentos/:id', requireAuth, ah(async (req, res) => {
  const a = await g('SELECT * FROM agendamentos WHERE id = ?', [req.params.id]);
  if (!a) return res.status(404).json({ error: 'Agendamento não encontrado.' });
  if (!sessaoPode(req, res, a.barbearia_id)) return;
  await r('DELETE FROM agendamentos WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

/* Exportação CSV dos agendamentos */
app.get('/api/admin/agendamentos.csv', requireAuth, ah(async (req, res) => {
  const { barbearia_id, data, status, de, ate } = req.query;
  if (!sessaoPode(req, res, Number(barbearia_id))) return;
  const where = ['1=1'];
  const params = [];
  if (barbearia_id) { where.push('ag.barbearia_id = ?'); params.push(barbearia_id); }
  if (data) { where.push('ag.data = ?'); params.push(data); }
  if (de) { where.push('ag.data >= ?'); params.push(de); }
  if (ate) { where.push('ag.data <= ?'); params.push(ate); }
  if (status) { where.push('ag.status = ?'); params.push(status); }
  const rows = await q(`
    SELECT ag.*, s.nome AS servico_nome, p.nome AS profissional_nome
    FROM agendamentos ag
    JOIN servicos s ON s.id = ag.servico_id
    LEFT JOIN profissionais p ON p.id = ag.profissional_id
    WHERE ${where.join(' AND ')}
    ORDER BY ag.data ASC, ag.hora ASC
  `, params);

  const linha = (arr) => arr.map((v) => {
    const s = String(v === null || v === undefined ? '' : v);
    return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(';');

  const csv = '\ufeff' + [
    linha(['#', 'Cliente', 'Telefone', 'E-mail', 'Serviço', 'Profissional', 'Data', 'Hora', 'Duração', 'Valor', 'Status', 'Observação']),
    ...rows.map((x) => linha([x.id, x.nome_cliente, x.telefone_cliente, x.email_cliente, x.servico_nome, x.profissional_nome || '', x.data, x.hora, x.duracao, (Number(x.preco) || 0).toFixed(2), x.status, x.observacao]))
  ].join('\n');

  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="agendamentos.csv"');
  res.send(csv);
}));

/* Backup do banco (admin) — dump JSON (Postgres não tem arquivo para baixar) */
app.get('/api/admin/backup', requireAdmin, ah(async (req, res) => {
  const tabelas = ['admin', 'barbearias', 'servicos', 'profissionais', 'horarios_config', 'agendamentos',
    'avaliacoes', 'bloqueios', 'fila_espera', 'cupons', 'fidelidade_config', 'fidelidade', 'lembretes_config', 'pagamentos'];
  const data = {};
  for (const t of tabelas) data[t] = await q(`SELECT * FROM ${t}`);
  res.set('Content-Type', 'application/json');
  res.set('Content-Disposition', 'attachment; filename="navalha-backup-' + dataLocalStr(new Date()) + '.json"');
  res.send(JSON.stringify(data, null, 2));
}));

/* ------------------------------------------------------------------ */
/* API Admin — Estatísticas                                            */
/* ------------------------------------------------------------------ */

app.get('/api/admin/estatisticas', requireAuth, ah(async (req, res) => {
  const { barbearia_id } = req.query;
  if (!sessaoPode(req, res, Number(barbearia_id))) return;
  if (!barbearia_id) return res.status(400).json({ error: 'Informe a barbearia.' });
  const hoje = dataLocalStr(new Date());

  const count = async (sql, ...p) => (await g(sql, p)).c;

  const hojeCount = await count(
    "SELECT COUNT(*)::int AS c FROM agendamentos WHERE barbearia_id = ? AND data = ? AND status != 'cancelado'",
    barbearia_id, hoje
  );
  const pendentesCount = await count(
    "SELECT COUNT(*)::int AS c FROM agendamentos WHERE barbearia_id = ? AND data = ? AND status = 'pendente'",
    barbearia_id, hoje
  );
  const totalMesCount = await count(
    "SELECT COUNT(*)::int AS c FROM agendamentos WHERE barbearia_id = ? AND substring(data from 1 for 7) = to_char(now(), 'YYYY-MM') AND status != 'cancelado'",
    barbearia_id
  );
  const receitaMes = await g(`
    SELECT COALESCE(SUM(preco), 0) AS total FROM agendamentos
    WHERE barbearia_id = ? AND substring(data from 1 for 7) = to_char(now(), 'YYYY-MM') AND status = 'concluido'
  `, [barbearia_id]);
  const clientesCount = await g(`
    SELECT COUNT(DISTINCT nome_cliente)::int AS c FROM agendamentos WHERE barbearia_id = ?
  `, [barbearia_id]);

  const proximos = await q(`
    SELECT ag.*, s.nome AS servico_nome, p.nome AS profissional_nome
    FROM agendamentos ag
    JOIN servicos s ON s.id = ag.servico_id
    LEFT JOIN profissionais p ON p.id = ag.profissional_id
    WHERE ag.barbearia_id = ? AND ag.status IN ('pendente', 'confirmado')
      AND (ag.data > ? OR (ag.data = ? AND ag.hora >= to_char(now(), 'HH24:MI')))
    ORDER BY ag.data ASC, ag.hora ASC LIMIT 8
  `, [barbearia_id, hoje, hoje]);

  const semana = [];
  for (let i = 6; i >= 0; i--) {
    const d = dataLocalStr(somaDias(new Date(), -i));
    const c = await count("SELECT COUNT(*)::int AS c FROM agendamentos WHERE barbearia_id = ? AND data = ? AND status != 'cancelado'", barbearia_id, d);
    semana.push({ data: d, dia: DIAS_ABREV[new Date(d + 'T12:00:00').getDay()], total: c });
  }

  res.json({
    hoje: hojeCount,
    pendentes: pendentesCount,
    total_mes: totalMesCount,
    receita_mes: receitaMes.total,
    clientes: clientesCount.c,
    proximos,
    semana
  });
}));

/* ------------------------------------------------------------------ */
/* API Admin — Agenda visual                                           */
/* ------------------------------------------------------------------ */

app.get('/api/admin/agenda', requireAuth, ah(async (req, res) => {
  const { barbearia_id, data } = req.query;
  if (!sessaoPode(req, res, Number(barbearia_id))) return;
  if (!data) return res.status(400).json({ error: 'Informe a data.' });
  const dia = new Date(data + 'T12:00:00').getDay();
  const conf = await getHorarioDia(Number(barbearia_id), dia);
  const profissionais = await getProfissionais(Number(barbearia_id));
  const agendamentos = await q(`
    SELECT ag.*, s.nome AS servico_nome, p.nome AS profissional_nome
    FROM agendamentos ag
    JOIN servicos s ON s.id = ag.servico_id
    LEFT JOIN profissionais p ON p.id = ag.profissional_id
    WHERE ag.barbearia_id = ? AND ag.data = ?
    ORDER BY ag.hora ASC
  `, [barbearia_id, data]);
  const bloqueios = await getBloqueiosDia(Number(barbearia_id), data);
  res.json({
    data,
    aberto: !!(conf && conf.abertura),
    abertura: conf ? conf.abertura : '',
    fechamento: conf ? conf.fechamento : '',
    intervalo: conf ? (conf.intervalo || 30) : 30,
    profissionais,
    agendamentos,
    bloqueios
  });
}));

/* ------------------------------------------------------------------ */
/* API Admin — Bloqueios / folgas                                      */
/* ------------------------------------------------------------------ */

app.get('/api/admin/bloqueios', requireAuth, ah(async (req, res) => {
  const { barbearia_id, de, ate } = req.query;
  if (!sessaoPode(req, res, Number(barbearia_id))) return;
  let sql = 'SELECT * FROM bloqueios WHERE barbearia_id = ?';
  const params = [barbearia_id];
  if (de) { sql += ' AND data >= ?'; params.push(de); }
  if (ate) { sql += ' AND data <= ?'; params.push(ate); }
  sql += ' ORDER BY data ASC, hora_inicio ASC';
  res.json(await q(sql, params));
}));

app.post('/api/admin/bloqueios', requireAuth, ah(async (req, res) => {
  const { barbearia_id, data, hora_inicio, hora_fim, motivo, dia_inteiro } = req.body;
  if (!sessaoPode(req, res, Number(barbearia_id))) return;
  if (!data) return res.status(400).json({ error: 'Informe a data.' });
  const info = await r(`
    INSERT INTO bloqueios (barbearia_id, data, hora_inicio, hora_fim, motivo, dia_inteiro)
    VALUES (?, ?, ?, ?, ?, ?)
    RETURNING id
  `, [barbearia_id, data, hora_inicio || '', hora_fim || '', String(motivo || '').trim(), dia_inteiro ? 1 : 0]);
  res.status(201).json(await g('SELECT * FROM bloqueios WHERE id = ?', [info.lastID]));
}));

app.delete('/api/admin/bloqueios/:id', requireAuth, ah(async (req, res) => {
  const bl = await g('SELECT * FROM bloqueios WHERE id = ?', [req.params.id]);
  if (!bl) return res.status(404).json({ error: 'Bloqueio não encontrado.' });
  if (!sessaoPode(req, res, bl.barbearia_id)) return;
  await r('DELETE FROM bloqueios WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ */
/* API Admin — Fila de espera                                          */
/* ------------------------------------------------------------------ */

app.get('/api/admin/fila', requireAuth, ah(async (req, res) => {
  const { barbearia_id, status } = req.query;
  if (!sessaoPode(req, res, Number(barbearia_id))) return;
  let sql = `
    SELECT f.*, s.nome AS servico_nome, p.nome AS profissional_nome
    FROM fila_espera f
    LEFT JOIN servicos s ON s.id = f.servico_id
    LEFT JOIN profissionais p ON p.id = f.profissional_id
    WHERE f.barbearia_id = ?
  `;
  const params = [barbearia_id];
  if (status) { sql += ' AND f.status = ?'; params.push(status); }
  sql += ' ORDER BY f.criado_em DESC';
  res.json(await q(sql, params));
}));

app.patch('/api/admin/fila/:id', requireAuth, ah(async (req, res) => {
  const f = await g('SELECT * FROM fila_espera WHERE id = ?', [req.params.id]);
  if (!f) return res.status(404).json({ error: 'Entrada não encontrada.' });
  if (!sessaoPode(req, res, f.barbearia_id)) return;
  if (req.body.status && ['aguardando', 'agendado', 'descartado', 'contatado'].includes(req.body.status)) {
    await r('UPDATE fila_espera SET status = ? WHERE id = ?', [req.body.status, req.params.id]);
  }
  res.json(await g('SELECT * FROM fila_espera WHERE id = ?', [req.params.id]));
}));

app.delete('/api/admin/fila/:id', requireAuth, ah(async (req, res) => {
  const f = await g('SELECT * FROM fila_espera WHERE id = ?', [req.params.id]);
  if (!f) return res.status(404).json({ error: 'Entrada não encontrada.' });
  if (!sessaoPode(req, res, f.barbearia_id)) return;
  await r('DELETE FROM fila_espera WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ */
/* API Admin — Cupons de desconto                                      */
/* ------------------------------------------------------------------ */

app.get('/api/admin/cupons', requireAuth, ah(async (req, res) => {
  const bid = Number(req.query.barbearia_id);
  if (!sessaoPode(req, res, bid)) return;
  const rows = await q('SELECT * FROM cupons WHERE barbearia_id = ? ORDER BY criado_em DESC', [bid]);
  res.json(rows);
}));

app.post('/api/admin/cupons', requireAuth, ah(async (req, res) => {
  const bid = Number(req.body.barbearia_id);
  if (!sessaoPode(req, res, bid)) return;
  const codigo = String(req.body.codigo || '').trim().toUpperCase();
  if (!codigo) return res.status(400).json({ error: 'Informe o código do cupom.' });
  const desconto = Number(req.body.desconto) || 0;
  if (desconto <= 0) return res.status(400).json({ error: 'Informe o valor do desconto.' });
  if (req.body.tipo !== 'valor') req.body.tipo = 'percent';
  if (await g('SELECT id FROM cupons WHERE barbearia_id = ? AND codigo = ?', [bid, codigo])) {
    return res.status(409).json({ error: 'Já existe um cupom com este código.' });
  }
  const info = await r(`
    INSERT INTO cupons (barbearia_id, codigo, tipo, desconto, validade, limite_uso, ativo)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `, [bid, codigo, req.body.tipo, desconto,
    String(req.body.validade || '').trim(), Number(req.body.limite_uso) || 0, req.body.ativo ? 1 : 0]);
  res.status(201).json(await g('SELECT * FROM cupons WHERE id = ?', [info.lastID]));
}));

app.put('/api/admin/cupons/:id', requireAuth, ah(async (req, res) => {
  const c = await g('SELECT * FROM cupons WHERE id = ?', [req.params.id]);
  if (!c) return res.status(404).json({ error: 'Cupom não encontrado.' });
  if (!sessaoPode(req, res, c.barbearia_id)) return;
  const updates = [];
  const valores = [];
  if (req.body.codigo !== undefined) {
    const codigo = String(req.body.codigo).trim().toUpperCase();
    if (!codigo) return res.status(400).json({ error: 'Informe o código do cupom.' });
    if (await g('SELECT id FROM cupons WHERE barbearia_id = ? AND codigo = ? AND id != ?', [c.barbearia_id, codigo, c.id])) {
      return res.status(409).json({ error: 'Já existe um cupom com este código.' });
    }
    updates.push('codigo = ?'); valores.push(codigo);
  }
  if (req.body.tipo !== undefined) { updates.push('tipo = ?'); valores.push(req.body.tipo === 'valor' ? 'valor' : 'percent'); }
  if (req.body.desconto !== undefined) {
    const d = Number(req.body.desconto) || 0;
    if (d <= 0) return res.status(400).json({ error: 'Informe o valor do desconto.' });
    updates.push('desconto = ?'); valores.push(d);
  }
  if (req.body.validade !== undefined) { updates.push('validade = ?'); valores.push(String(req.body.validade).trim()); }
  if (req.body.limite_uso !== undefined) { updates.push('limite_uso = ?'); valores.push(Number(req.body.limite_uso) || 0); }
  if (req.body.ativo !== undefined) { updates.push('ativo = ?'); valores.push(req.body.ativo ? 1 : 0); }
  if (!updates.length) return res.status(400).json({ error: 'Nada para atualizar.' });
  valores.push(req.params.id);
  await r(`UPDATE cupons SET ${updates.join(', ')} WHERE id = ?`, valores);
  res.json(await g('SELECT * FROM cupons WHERE id = ?', [req.params.id]));
}));

app.delete('/api/admin/cupons/:id', requireAuth, ah(async (req, res) => {
  const c = await g('SELECT * FROM cupons WHERE id = ?', [req.params.id]);
  if (!c) return res.status(404).json({ error: 'Cupom não encontrado.' });
  if (!sessaoPode(req, res, c.barbearia_id)) return;
  await r('DELETE FROM cupons WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ */
/* API Admin — Fidelidade                                              */
/* ------------------------------------------------------------------ */

app.get('/api/admin/fidelidade', requireAuth, ah(async (req, res) => {
  const bid = Number(req.query.barbearia_id);
  if (!sessaoPode(req, res, bid)) return;
  const config = await g('SELECT * FROM fidelidade_config WHERE barbearia_id = ?', [bid])
    || { barbearia_id: bid, ativo: 0, premio_visitas: 10 };
  const clientes = await q('SELECT * FROM fidelidade WHERE barbearia_id = ? ORDER BY visitas DESC, nome ASC', [bid]);
  res.json({ config, clientes });
}));

app.put('/api/admin/fidelidade', requireAuth, ah(async (req, res) => {
  const bid = Number(req.body.barbearia_id);
  if (!sessaoPode(req, res, bid)) return;
  if (!bid) return res.status(400).json({ error: 'Informe a barbearia.' });
  const premio = Math.max(1, Number(req.body.premio_visitas) || 10);
  await r(`
    INSERT INTO fidelidade_config (barbearia_id, ativo, premio_visitas)
    VALUES (?, ?, ?)
    ON CONFLICT(barbearia_id) DO UPDATE SET ativo = EXCLUDED.ativo, premio_visitas = EXCLUDED.premio_visitas
  `, [bid, req.body.ativo ? 1 : 0, premio]);
  res.json(await g('SELECT * FROM fidelidade_config WHERE barbearia_id = ?', [bid]));
}));

app.post('/api/admin/fidelidade/:id/somar', requireAuth, ah(async (req, res) => {
  const f = await g('SELECT * FROM fidelidade WHERE id = ?', [req.params.id]);
  if (!f) return res.status(404).json({ error: 'Cliente não encontrado.' });
  if (!sessaoPode(req, res, f.barbearia_id)) return;
  await r('UPDATE fidelidade SET visitas = visitas + 1 WHERE id = ?', [req.params.id]);
  res.json(await g('SELECT * FROM fidelidade WHERE id = ?', [req.params.id]));
}));

/* ------------------------------------------------------------------ */
/* API Admin — Lembretes automáticos                                   */
/* ------------------------------------------------------------------ */

app.get('/api/admin/lembretes', requireAuth, ah(async (req, res) => {
  const bid = Number(req.query.barbearia_id);
  if (!sessaoPode(req, res, bid)) return;
  const config = await g('SELECT * FROM lembretes_config WHERE barbearia_id = ?', [bid])
    || { barbearia_id: bid, ativo: 0, horas_antes: 24 };
  const pendentes = await q(`
    SELECT ag.*, s.nome AS servico_nome, p.nome AS profissional_nome
    FROM agendamentos ag
    JOIN servicos s ON s.id = ag.servico_id
    LEFT JOIN profissionais p ON p.id = ag.profissional_id
    WHERE ag.barbearia_id = ?
      AND ag.status IN ('pendente', 'confirmado')
      AND ag.lembrete_enviado = 0
      AND (ag.data || ' ' || ag.hora)::timestamp BETWEEN now() AND now() + make_interval(hours => ?)
    ORDER BY ag.data ASC, ag.hora ASC
  `, [bid, config.horas_antes || 24]);
  res.json({ config, pendentes });
}));

app.put('/api/admin/lembretes', requireAuth, ah(async (req, res) => {
  const bid = Number(req.body.barbearia_id);
  if (!sessaoPode(req, res, bid)) return;
  if (!bid) return res.status(400).json({ error: 'Informe a barbearia.' });
  const horas = Math.max(1, Number(req.body.horas_antes) || 24);
  await r(`
    INSERT INTO lembretes_config (barbearia_id, ativo, horas_antes)
    VALUES (?, ?, ?)
    ON CONFLICT(barbearia_id) DO UPDATE SET ativo = EXCLUDED.ativo, horas_antes = EXCLUDED.horas_antes
  `, [bid, req.body.ativo ? 1 : 0, horas]);
  res.json(await g('SELECT * FROM lembretes_config WHERE barbearia_id = ?', [bid]));
}));

app.post('/api/admin/lembretes/:id/marcar', requireAuth, ah(async (req, res) => {
  const a = await g('SELECT * FROM agendamentos WHERE id = ?', [req.params.id]);
  if (!a) return res.status(404).json({ error: 'Agendamento não encontrado.' });
  if (!sessaoPode(req, res, a.barbearia_id)) return;
  await r('UPDATE agendamentos SET lembrete_enviado = 1 WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ */
/* API Admin — Relatórios financeiros                                  */
/* ------------------------------------------------------------------ */

app.get('/api/admin/relatorios', requireAuth, ah(async (req, res) => {
  const { barbearia_id, de, ate } = req.query;
  if (!sessaoPode(req, res, Number(barbearia_id))) return;
  if (!de || !ate) return res.status(400).json({ error: 'Informe o período (de e até).' });

  const whereAg = 'barbearia_id = ? AND data BETWEEN ? AND ?';
  const totalAg = await g(`SELECT COUNT(*)::int AS c FROM agendamentos WHERE ${whereAg} AND status != 'cancelado'`, [barbearia_id, de, ate]);
  const concluidos = await g(`SELECT COUNT(*)::int AS c, COALESCE(SUM(preco), 0) AS receita FROM agendamentos WHERE ${whereAg} AND status = 'concluido'`, [barbearia_id, de, ate]);
  const confirmados = await g(`SELECT COUNT(*)::int AS c, COALESCE(SUM(preco), 0) AS receita FROM agendamentos WHERE ${whereAg} AND status = 'confirmado'`, [barbearia_id, de, ate]);
  const cancelados = await g(`SELECT COUNT(*)::int AS c FROM agendamentos WHERE ${whereAg} AND status IN ('cancelado', 'ausente')`, [barbearia_id, de, ate]);

  const porServico = await q(`
    SELECT s.nome, COUNT(*)::int AS qtd, COALESCE(SUM(ag.preco), 0) AS receita
    FROM agendamentos ag JOIN servicos s ON s.id = ag.servico_id
    WHERE ag.barbearia_id = ? AND ag.data BETWEEN ? AND ? AND ag.status NOT IN ('cancelado', 'ausente')
    GROUP BY s.id ORDER BY receita DESC
  `, [barbearia_id, de, ate]);

  const porProfissional = await q(`
    SELECT COALESCE(p.nome, 'A definir') AS nome, COUNT(*)::int AS qtd, COALESCE(SUM(ag.preco), 0) AS receita
    FROM agendamentos ag LEFT JOIN profissionais p ON p.id = ag.profissional_id
    WHERE ag.barbearia_id = ? AND ag.data BETWEEN ? AND ? AND ag.status NOT IN ('cancelado', 'ausente')
    GROUP BY ag.profissional_id ORDER BY receita DESC
  `, [barbearia_id, de, ate]);

  const porDia = await q(`
    SELECT ag.data, COUNT(*)::int AS qtd, COALESCE(SUM(CASE WHEN ag.status = 'concluido' THEN ag.preco ELSE 0 END), 0) AS receita
    FROM agendamentos ag
    WHERE ag.barbearia_id = ? AND ag.data BETWEEN ? AND ? AND ag.status != 'cancelado'
    GROUP BY ag.data ORDER BY ag.data ASC
  `, [barbearia_id, de, ate]);

  const pendentes = await q(`
    SELECT ag.*, s.nome AS servico_nome, p.nome AS profissional_nome
    FROM agendamentos ag
    JOIN servicos s ON s.id = ag.servico_id
    LEFT JOIN profissionais p ON p.id = ag.profissional_id
    WHERE ag.barbearia_id = ? AND ag.data BETWEEN ? AND ? AND ag.status IN ('pendente', 'confirmado')
    ORDER BY ag.data ASC, ag.hora ASC
  `, [barbearia_id, de, ate]);

  res.json({
    periodo: { de, ate },
    total_agendamentos: totalAg.c,
    concluidos: { qtd: concluidos.c, receita: concluidos.receita },
    confirmados: { qtd: confirmados.c, receita: confirmados.receita },
    cancelados: cancelados.c,
    ticket_medio: concluidos.c ? concluidos.receita / concluidos.c : 0,
    por_servico: porServico,
    por_profissional: porProfissional,
    por_dia: porDia,
    pendentes
  });
}));

/* ------------------------------------------------------------------ */
/* Erro global (fallback)                                              */
/* ------------------------------------------------------------------ */

app.use((req, res) => {
  res.status(404).json({ error: 'Rota não encontrada.' });
});

/* ------------------------------------------------------------------ */
/* Inicialização                                                       */
/* ------------------------------------------------------------------ */

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n  ✂️  Navalha Agendamentos rodando!`);
    console.log(`  ────────────────────────────────────────────`);
    console.log(`  Site:       http://localhost:${PORT}`);
    console.log(`  Painel:     http://localhost:${PORT}/admin`);
    console.log(`  Conta:      http://localhost:${PORT}/agendamentos\n`);
  });
}

module.exports = app;
