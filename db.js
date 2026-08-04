const { Pool } = require('pg');
const crypto = require('crypto');

require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

/* Converte placeholders ? do SQLite para $n do Postgres */
function pgSql(sql) {
  if (!sql.includes('?')) return sql;
  let n = 0;
  return sql.replace(/\?/g, () => '$' + (++n));
}

/* Helpers async (substituem better-sqlite3) */
async function q(sql, params = []) {
  const r = await pool.query(pgSql(sql), params);
  return r.rows;
}
async function g(sql, params = []) {
  const r = await pool.query(pgSql(sql), params);
  return r.rows[0] || null;
}
async function r(sql, params = []) {
  const res = await pool.query(pgSql(sql), params);
  return { lastID: res.rows && res.rows[0] ? res.rows[0].id : null, changes: res.rowCount, rows: res.rows };
}
async function trans(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await fn({
      q: (sql, params = []) => client.query(pgSql(sql), params).then((x) => x.rows),
      g: (sql, params = []) => client.query(pgSql(sql), params).then((x) => x.rows[0] || null),
      r: (sql, params = []) => client.query(pgSql(sql), params).then((x) => ({ lastID: x.rows && x.rows[0] ? x.rows[0].id : null, changes: x.rowCount, rows: x.rows }))
    });
    await client.query('COMMIT');
    return res;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function migrar() {
  const tabelas = [
    `CREATE TABLE IF NOT EXISTS admin (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      salt TEXT NOT NULL,
      hash TEXT NOT NULL,
      nome TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS barbearias (
      id SERIAL PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      nome TEXT NOT NULL,
      tagline TEXT DEFAULT '',
      descricao TEXT DEFAULT '',
      endereco TEXT DEFAULT '',
      cidade TEXT DEFAULT '',
      telefone TEXT DEFAULT '',
      whatsapp TEXT DEFAULT '',
      email TEXT DEFAULT '',
      instagram TEXT DEFAULT '',
      imagem TEXT DEFAULT '',
      capa TEXT DEFAULT '',
      cor_primaria TEXT DEFAULT '#c9a227',
      horario_texto TEXT DEFAULT '',
      avaliacao REAL DEFAULT 4.9,
      pix_chave TEXT DEFAULT '',
      senha_salt TEXT DEFAULT '',
      senha_hash TEXT DEFAULT '',
      asaas_api_key TEXT DEFAULT '',
      asaas_mode TEXT DEFAULT 'sandbox',
      asaas_wallet_id TEXT DEFAULT '',
      asaas_split_percent REAL DEFAULT 0,
      saldo REAL NOT NULL DEFAULT 0,
      ativa INTEGER DEFAULT 1,
      criado_em TIMESTAMPTZ DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS servicos (
      id SERIAL PRIMARY KEY,
      barbearia_id INTEGER NOT NULL REFERENCES barbearias(id) ON DELETE CASCADE,
      nome TEXT NOT NULL,
      descricao TEXT DEFAULT '',
      preco REAL NOT NULL DEFAULT 0,
      duracao INTEGER NOT NULL DEFAULT 30,
      ativo INTEGER DEFAULT 1
    )`,
    `CREATE TABLE IF NOT EXISTS profissionais (
      id SERIAL PRIMARY KEY,
      barbearia_id INTEGER NOT NULL REFERENCES barbearias(id) ON DELETE CASCADE,
      nome TEXT NOT NULL,
      cargo TEXT DEFAULT '',
      foto TEXT DEFAULT '',
      ativo INTEGER DEFAULT 1
    )`,
    `CREATE TABLE IF NOT EXISTS horarios_config (
      id SERIAL PRIMARY KEY,
      barbearia_id INTEGER NOT NULL REFERENCES barbearias(id) ON DELETE CASCADE,
      dia_semana INTEGER NOT NULL,
      abertura TEXT DEFAULT '',
      fechamento TEXT DEFAULT '',
      intervalo INTEGER DEFAULT 30,
      UNIQUE (barbearia_id, dia_semana)
    )`,
    `CREATE TABLE IF NOT EXISTS agendamentos (
      id SERIAL PRIMARY KEY,
      barbearia_id INTEGER NOT NULL REFERENCES barbearias(id) ON DELETE CASCADE,
      profissional_id INTEGER REFERENCES profissionais(id) ON DELETE SET NULL,
      servico_id INTEGER NOT NULL REFERENCES servicos(id),
      nome_cliente TEXT NOT NULL,
      telefone_cliente TEXT NOT NULL,
      email_cliente TEXT DEFAULT '',
      cpf_cliente TEXT DEFAULT '',
      data TEXT NOT NULL,
      hora TEXT NOT NULL,
      duracao INTEGER NOT NULL DEFAULT 30,
      preco REAL NOT NULL DEFAULT 0,
      preco_original REAL,
      cupom_id INTEGER,
      lembrete_enviado INTEGER DEFAULT 0,
      pago INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pendente',
      observacao TEXT DEFAULT '',
      token TEXT DEFAULT '',
      motivo_cancelamento TEXT DEFAULT '',
      criado_em TIMESTAMPTZ DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS avaliacoes (
      id SERIAL PRIMARY KEY,
      barbearia_id INTEGER NOT NULL REFERENCES barbearias(id) ON DELETE CASCADE,
      agendamento_id INTEGER REFERENCES agendamentos(id) ON DELETE SET NULL,
      nome TEXT DEFAULT '',
      nota INTEGER NOT NULL DEFAULT 5,
      comentario TEXT DEFAULT '',
      criado_em TIMESTAMPTZ DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS bloqueios (
      id SERIAL PRIMARY KEY,
      barbearia_id INTEGER NOT NULL REFERENCES barbearias(id) ON DELETE CASCADE,
      data TEXT NOT NULL,
      hora_inicio TEXT DEFAULT '',
      hora_fim TEXT DEFAULT '',
      motivo TEXT DEFAULT '',
      dia_inteiro INTEGER DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS fila_espera (
      id SERIAL PRIMARY KEY,
      barbearia_id INTEGER NOT NULL REFERENCES barbearias(id) ON DELETE CASCADE,
      servico_id INTEGER REFERENCES servicos(id) ON DELETE SET NULL,
      profissional_id INTEGER REFERENCES profissionais(id) ON DELETE SET NULL,
      nome_cliente TEXT NOT NULL,
      telefone_cliente TEXT NOT NULL,
      data_preferida TEXT DEFAULT '',
      observacao TEXT DEFAULT '',
      status TEXT DEFAULT 'aguardando',
      criado_em TIMESTAMPTZ DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS cupons (
      id SERIAL PRIMARY KEY,
      barbearia_id INTEGER NOT NULL REFERENCES barbearias(id) ON DELETE CASCADE,
      codigo TEXT NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'percent',
      desconto REAL NOT NULL DEFAULT 0,
      validade TEXT DEFAULT '',
      limite_uso INTEGER NOT NULL DEFAULT 0,
      usos INTEGER NOT NULL DEFAULT 0,
      ativo INTEGER DEFAULT 1,
      criado_em TIMESTAMPTZ DEFAULT now(),
      UNIQUE (barbearia_id, codigo)
    )`,
    `CREATE TABLE IF NOT EXISTS fidelidade_config (
      barbearia_id INTEGER PRIMARY KEY REFERENCES barbearias(id) ON DELETE CASCADE,
      ativo INTEGER DEFAULT 0,
      premio_visitas INTEGER DEFAULT 10
    )`,
    `CREATE TABLE IF NOT EXISTS fidelidade (
      id SERIAL PRIMARY KEY,
      barbearia_id INTEGER NOT NULL REFERENCES barbearias(id) ON DELETE CASCADE,
      telefone TEXT NOT NULL,
      nome TEXT DEFAULT '',
      visitas INTEGER NOT NULL DEFAULT 0,
      premios_resgatados INTEGER NOT NULL DEFAULT 0,
      criado_em TIMESTAMPTZ DEFAULT now(),
      UNIQUE (barbearia_id, telefone)
    )`,
    `CREATE TABLE IF NOT EXISTS lembretes_config (
      barbearia_id INTEGER PRIMARY KEY REFERENCES barbearias(id) ON DELETE CASCADE,
      ativo INTEGER DEFAULT 0,
      horas_antes INTEGER DEFAULT 24
    )`,
    `CREATE TABLE IF NOT EXISTS pagamentos (
      id SERIAL PRIMARY KEY,
      agendamento_id INTEGER NOT NULL REFERENCES agendamentos(id) ON DELETE CASCADE,
      barbearia_id INTEGER NOT NULL REFERENCES barbearias(id) ON DELETE CASCADE,
      asaas_payment_id TEXT,
      valor REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pendente',
      pix_base64 TEXT DEFAULT '',
      pix_copia_cola TEXT DEFAULT '',
      saldo_creditado INTEGER NOT NULL DEFAULT 0,
      criado_em TIMESTAMPTZ DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS saques (
      id SERIAL PRIMARY KEY,
      barbearia_id INTEGER NOT NULL REFERENCES barbearias(id) ON DELETE CASCADE,
      valor REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pendente',
      pix_chave TEXT DEFAULT '',
      asaas_transfer_id TEXT,
      solicitado_por TEXT DEFAULT 'admin',
      criado_em TIMESTAMPTZ DEFAULT now(),
      concluido_em TIMESTAMPTZ
    )`
  ];
  for (const t of tabelas) await pool.query(t);

  const colsBarb = await q(`SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'barbearias'`);
  const barbCols = colsBarb.map((c) => c.name);
  if (!barbCols.includes('pix_chave')) await pool.query(`ALTER TABLE barbearias ADD COLUMN pix_chave TEXT DEFAULT ''`);
  if (!barbCols.includes('senha_salt')) await pool.query(`ALTER TABLE barbearias ADD COLUMN senha_salt TEXT DEFAULT ''`);
  if (!barbCols.includes('senha_hash')) await pool.query(`ALTER TABLE barbearias ADD COLUMN senha_hash TEXT DEFAULT ''`);
  if (!barbCols.includes('asaas_api_key')) await pool.query(`ALTER TABLE barbearias ADD COLUMN asaas_api_key TEXT DEFAULT ''`);
  if (!barbCols.includes('asaas_mode')) await pool.query(`ALTER TABLE barbearias ADD COLUMN asaas_mode TEXT DEFAULT 'sandbox'`);
  if (!barbCols.includes('asaas_wallet_id')) await pool.query(`ALTER TABLE barbearias ADD COLUMN asaas_wallet_id TEXT DEFAULT ''`);
  if (!barbCols.includes('asaas_split_percent')) await pool.query(`ALTER TABLE barbearias ADD COLUMN asaas_split_percent REAL DEFAULT 0`);
  if (!barbCols.includes('saldo')) await pool.query(`ALTER TABLE barbearias ADD COLUMN saldo REAL NOT NULL DEFAULT 0`);

  const colsAg = await q(`SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'agendamentos'`);
  const agendaCols = colsAg.map((c) => c.name);
  if (!agendaCols.includes('motivo_cancelamento')) await pool.query(`ALTER TABLE agendamentos ADD COLUMN motivo_cancelamento TEXT DEFAULT ''`);
  if (!agendaCols.includes('preco_original')) await pool.query(`ALTER TABLE agendamentos ADD COLUMN preco_original REAL`);
  if (!agendaCols.includes('cupom_id')) await pool.query(`ALTER TABLE agendamentos ADD COLUMN cupom_id INTEGER`);
  if (!agendaCols.includes('lembrete_enviado')) await pool.query(`ALTER TABLE agendamentos ADD COLUMN lembrete_enviado INTEGER DEFAULT 0`);
  if (!agendaCols.includes('pago')) await pool.query(`ALTER TABLE agendamentos ADD COLUMN pago INTEGER DEFAULT 0`);
  if (!agendaCols.includes('cpf_cliente')) await pool.query(`ALTER TABLE agendamentos ADD COLUMN cpf_cliente TEXT DEFAULT ''`);

  const colsPag = await q(`SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'pagamentos'`);
  const pagCols = colsPag.map((c) => c.name);
  if (!pagCols.includes('saldo_creditado')) await pool.query(`ALTER TABLE pagamentos ADD COLUMN saldo_creditado INTEGER NOT NULL DEFAULT 0`);
}

const HASH_SALT = process.env.ADMIN_SALT || 'navalha-seed-salt';

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.pbkdf2Sync(password, s, 10000, 64, 'sha512').toString('hex');
  return { salt: s, hash: h };
}

async function seedAdmin() {
  const exists = await g('SELECT COUNT(*)::int AS c FROM admin');
  if (!exists.c) {
    const { salt, hash } = hashPassword(process.env.ADMIN_PASSWORD || 'Zehd48@rede3', process.env.ADMIN_SALT);
    await r('INSERT INTO admin (username, salt, hash, nome) VALUES ($1, $2, $3, $4)', ['admin', salt, hash, 'Administrador']);
    console.log('[seed] Admin criado -> usuário: admin / senha: ' + (process.env.ADMIN_PASSWORD || 'Zehd48@rede3'));
  }
}

async function hasData() {
  const row = await g('SELECT COUNT(*)::int AS c FROM barbearias');
  return row.c > 0;
}

async function seedBarbearias() {
  if (await hasData()) return;

  const diasSemana = [0, 1, 2, 3, 4, 5, 6];
  const barbearias = [
    {
      slug: 'navalha-de-ouro',
      nome: 'Navalha de Ouro',
      tagline: 'Tradição, estilo e navalha afiada no coração da cidade.',
      descricao: 'A Navalha de Ouro é referência em corte clássico e moderno. Atendimento premium, ambiente climatizado, cerveja gelada e os melhores barbeiros da região. Aqui, o seu estilo é levado a sério.',
      endereco: 'Av. Paulista, 1000 - Bela Vista',
      cidade: 'São Paulo - SP',
      telefone: '(11) 3456-7890',
      whatsapp: '5511998765432',
      email: 'contato@navalhadeouro.com.br',
      instagram: '@navalhadeouro',
      imagem: 'https://images.unsplash.com/photo-1503951914875-452162b0f3f1?w=800&q=80',
      capa: 'https://images.unsplash.com/photo-1622286342621-4bd786c2447c?w=1600&q=80',
      cor_primaria: '#c9a227',
      horario_texto: 'Ter a Sáb 9h às 20h',
      avaliacao: 4.9,
      servicos: [
        ['Corte Clássico', 'Corte de cabelo tradicional com tesoura e máquina, finalização com produtos.', 50, 30],
        ['Corte + Barba', 'Corte completo e barba feita à navalha com toalha quente.', 80, 60],
        ['Barba Completa', 'Barba modelada, toalha quente, navalha e hidratação pós-barba.', 55, 45],
        ['Sobrancelha', 'Desenho e alinhamento da sobrancelha com pinça ou navalha.', 20, 15],
        ['Pezinho', 'Acabamento do corte com máquina de precisão.', 15, 15],
        ['Combo Prestige', 'Corte, barba, sobrancelha e hidratação capilar completa.', 120, 90]
      ],
      profissionais: [
        ['Marcos Silva', 'Fundador / Barbeiro Master'],
        ['Ricardo Almeida', 'Barbeiro Sênior'],
        ['Thiago Nunes', 'Barbeiro']
      ]
    },
    {
      slug: 'barba-e-cia',
      nome: 'Barba & Cia',
      tagline: 'Experiência urbana com um toque de elegância.',
      descricao: 'Barba & Cia é a barbearia do estilo de vida urbano. Espaço moderno, música boa, café fresco e profissionais que dominam as tendências. Perfeita para quem vive na cidade e cuida da imagem com personalidade.',
      endereco: 'Rua Augusta, 500 - Consolação',
      cidade: 'São Paulo - SP',
      telefone: '(11) 2345-6789',
      whatsapp: '5511987654321',
      email: 'contato@barbaeciabr.com',
      instagram: '@barbaeciabr',
      imagem: 'https://images.unsplash.com/photo-1599351431202-1e0f0137899a?w=800&q=80',
      capa: 'https://images.unsplash.com/photo-1585747860715-2ba37e788b70?w=1600&q=80',
      cor_primaria: '#e5484d',
      horario_texto: 'Seg a Sáb 10h às 21h',
      avaliacao: 4.8,
      servicos: [
        ['Corte Moderno', 'Corte na régua, degradê e finalização com pomadas premium.', 60, 45],
        ['Barba na Navalha', 'Barba alinhada com navalha e toalha quente.', 50, 40],
        ['Hidratação Capilar', 'Tratamento capilar profundo com produtos profissionais.', 70, 45],
        ['Kids até 10 anos', 'Corte especial para os pequenos, com paciência e capricho.', 35, 30],
        ['Corte + Hidratação', 'Combo corte e hidratação para renovar o visual.', 110, 75],
        ['Platinado', 'Descoloração e tonalização platinada completa.', 180, 120]
      ],
      profissionais: [
        ['André Costa', 'Barbeiro Estilista'],
        ['Bruno Martins', 'Barbeiro'],
        ['Felipe Souza', 'Colorista']
      ]
    },
    {
      slug: 'clube-da-navalha',
      nome: 'Clube da Navalha',
      tagline: 'Mais que um corte, uma experiência de clube.',
      descricao: 'No Clube da Navalha você encontra o espírito dos antigos barbeiros ingleses. Ambiente premium, atendimento impecável, sinuca, whisky e o ritual do toalha quente. Um verdadeiro clube para cavalheiros.',
      endereco: 'Rua Oscar Freire, 300 - Jardins',
      cidade: 'São Paulo - SP',
      telefone: '(11) 3456-1234',
      whatsapp: '5511912345678',
      email: 'contato@clubedanavalha.com',
      instagram: '@clubedanavalha',
      imagem: 'https://images.unsplash.com/photo-1621605815971-fbc98d665033?w=800&q=80',
      capa: 'https://images.unsplash.com/photo-1521714161819-155a868cce2c?w=1600&q=80',
      cor_primaria: '#3d9be9',
      horario_texto: 'Qua a Dom 11h às 22h',
      avaliacao: 5.0,
      servicos: [
        ['Corte Executivo', 'Corte executivo com estilo clássico inglês.', 70, 45],
        ['Ritual Barba + Toalha', 'Ritual completo de barba com toalha quente e óleos essenciais.', 65, 50],
        ['Corte + Ritual', 'Corte executivo e ritual de barba completo.', 120, 90],
        ['Camuflagem de Grisalho', 'Aplicação de tonalizante para camuflar fios brancos.', 90, 60],
        ['Tratamento Premium', 'Hidratação capilar profunda com máscara de queratina.', 85, 50],
        ['Experimental', 'Corte e barba à navalha tradicional dos mestres ingleses.', 150, 120]
      ],
      profissionais: [
        ['Carlos Eduardo', 'Mestre Barbeiro'],
        ['Gustavo Lima', 'Barbeiro Sênior'],
        ['Henrique Dias', 'Barbeiro']
      ]
    }
  ];

  for (const b of barbearias) {
    const info = await r(`
      INSERT INTO barbearias
      (slug, nome, tagline, descricao, endereco, cidade, telefone, whatsapp, email, instagram, imagem, capa, cor_primaria, horario_texto, avaliacao)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING id
    `, [b.slug, b.nome, b.tagline, b.descricao, b.endereco, b.cidade, b.telefone, b.whatsapp,
      b.email, b.instagram, b.imagem, b.capa, b.cor_primaria, b.horario_texto, b.avaliacao]);
    const bid = info.lastID;

    for (const s of b.servicos) {
      await r('INSERT INTO servicos (barbearia_id, nome, descricao, preco, duracao) VALUES ($1, $2, $3, $4, $5)',
        [bid, s[0], s[1], s[2], s[3]]);
    }
    for (const p of b.profissionais) {
      await r('INSERT INTO profissionais (barbearia_id, nome, cargo) VALUES ($1, $2, $3)', [bid, p[0], p[1]]);
    }

    for (const d of diasSemana) {
      if (d === 0) {
        await r('INSERT INTO horarios_config (barbearia_id, dia_semana, abertura, fechamento, intervalo) VALUES ($1, $2, $3, $4, $5)',
          [bid, d, '', '', 30]);
      } else {
        const aberto = d === 6 ? '09:00' : '10:00';
        const fecha = d === 6 ? '18:00' : '20:00';
        await r('INSERT INTO horarios_config (barbearia_id, dia_semana, abertura, fechamento, intervalo) VALUES ($1, $2, $3, $4, $5)',
          [bid, d, aberto, fecha, 30]);
      }
    }

    const servs = await q('SELECT id, preco, duracao FROM servicos WHERE barbearia_id = $1', [bid]);
    const profs = await q('SELECT id FROM profissionais WHERE barbearia_id = $1', [bid]);

    const agendaData = new Date();
    let dataStr = '';
    for (let i = 1; i <= 7; i++) {
      const d = new Date(agendaData);
      d.setDate(d.getDate() + i);
      const conf = await g('SELECT abertura FROM horarios_config WHERE barbearia_id = $1 AND dia_semana = $2', [bid, d.getDay()]);
      if (conf && conf.abertura) {
        dataStr = dataLocalStr(d);
        break;
      }
    }
    if (!dataStr) dataStr = dataLocalStr(agendaData);

    const quant = 1 + (Math.floor(Math.random() * 100) % 3);
    for (let i = 0; i < quant; i++) {
      const serv = servs[i % servs.length];
      const prof = profs[i % profs.length];
      const hora = 10 + (i * 2);
      await r(`
        INSERT INTO agendamentos
        (barbearia_id, profissional_id, servico_id, nome_cliente, telefone_cliente, email_cliente, data, hora, duracao, preco, status, token)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `, [bid, prof.id, serv.id,
        ['João Pedro', 'Lucas Ferreira', 'Pedro Henrique', 'Rafael Gomes', 'Caio Martins'][i],
        '1198765' + String(1000 + i).slice(0, 4),
        'cliente' + (i + 1) + '@email.com',
        dataStr,
        String(hora).padStart(2, '0') + ':00',
        serv.duracao, serv.preco,
        i === 0 ? 'confirmado' : 'pendente',
        crypto.randomBytes(8).toString('hex')]);
    }
  }
  console.log('[seed] Barbearias demo criadas com sucesso.');
}

function dataLocalStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function verifyPassword(username, password) {
  const row = await g('SELECT * FROM admin WHERE username = $1', [username]);
  if (!row) return false;
  const h = crypto.pbkdf2Sync(password, row.salt, 10000, 64, 'sha512').toString('hex');
  return h === row.hash;
}

async function verifySenhaBarbearia(barbearia, senha) {
  if (!barbearia || !barbearia.senha_hash) return false;
  const h = crypto.pbkdf2Sync(String(senha || ''), barbearia.senha_salt, 10000, 64, 'sha512').toString('hex');
  return h === barbearia.senha_hash;
}

async function init() {
  await migrar();
  await seedAdmin();
  await seedBarbearias();
}

init().catch((e) => {
  console.error('[db] Falha na inicialização:', e.message);
});

module.exports = { q, g, r, trans, pool, verifyPassword, verifySenhaBarbearia, hashPassword, init };
