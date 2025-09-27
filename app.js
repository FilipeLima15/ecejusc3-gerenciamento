/* app.js - Versão modificada para Firebase Realtime Database.
   Substitui localStorage por funções assíncronas de leitura e escrita no Firebase.
*/

// Cole suas credenciais do Firebase aqui. Você as encontra no seu Firebase Console.
const firebaseConfig = {
apiKey: "AIzaSyCjF10zeV41Aj4XNb48_gFv8GTGyihTHFc",
authDomain: "sistema-folga-prova.firebaseapp.com",
databaseURL: "https://sistema-folga-prova-default-rtdb.firebaseio.com",
projectId: "sistema-folga-prova",
storageBucket: "sistema-folga-prova.firebasestorage.app",
messagingSenderId: "689006902259",
appId: "1:689006902259:web:a26916edebf510c2a37086"
};

// Inicializa o Firebase
const app = firebase.initializeApp(firebaseConfig);
const database = firebase.database();

// Usaremos um nó específico para o estado da aplicação para não tocar na raiz '/'
const ROOT_DB_PATH = '/appState';


// ----------------- Helpers -----------------
function uuid(){ return 'id-' + Math.random().toString(36).slice(2,9); }
function nowISO(){ return new Date().toISOString().slice(0,10); }
function timestamp(){ return new Date().toISOString(); }
function escapeHtml(s){ return String(s||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>', '&gt;'); }
// Função para download de blob (agora movida para o contexto do Manager)
function downloadBlob(txt, filename, mimeType='application/json'){ const blob = new Blob([txt], { type: mimeType }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url); }

// Novo helper para formatar a data (dd/mm/aaaa)
function formatDate(isoString) {
    if (!isoString) return new Date().toLocaleDateString('pt-BR');
    try {
        const d = new Date(isoString);
        return d.toLocaleDateString('pt-BR');
    } catch (e) {
        return new Date().toLocaleDateString('pt-BR');
    }
}

// ----------------- Storage / Sample -----------------
function defaultPowersFor(role){
  if(role === 'super') return { create_intern:true, edit_user:true, delete_user:true, reset_password:true, delegate_admins:true, manage_hours:true, manage_provas:true };
  if(role === 'admin') return { create_intern:true, edit_user:true, delete_user:true, reset_password:true, delegate_admins:false, manage_hours:true, manage_provas:false };
  return { manage_hours:false, manage_provas:false };
}

function sampleData(){
  const now = timestamp();
  const interns = [];
  for(let i=1;i<=2;i++){
    interns.push({ id: 'intern-'+i, name: `Estagiário ${i}`, dates: [], hoursEntries: [], auditLog: [] });
  }
  const users = [];
  // ALTERAÇÃO 1: Senha do admin principal mudada para Admin123#admin123
  users.push({ id: uuid(), username: 'admin', name: 'Administrador Principal', password: 'Admin123#admin123', role: 'super', powers: defaultPowersFor('super'), selfPasswordChange: true, createdAt: now });
  interns.forEach((it, idx)=>{
    users.push({ id: uuid(), username: 'est'+(idx+1), password: 'senha123', role: 'intern', internId: it.id, powers: defaultPowersFor('intern'), selfPasswordChange: true, createdAt: now });
  });
  const pendingRegistrations = [];
  const trash = [];
  return { users, interns, meta: { created: now, provaBlockDays: 0, trashRetentionDays: 10 }, pendingRegistrations, trash };
}

// Funções de salvamento e carregamento agora usam o Firebase
async function load(){
  try {
    // lê sempre do nó único definido
    const snapshot = await database.ref(ROOT_DB_PATH).once('value');
    const data = snapshot.val();
    if(!data) {
      console.warn("Nenhum dado encontrado em " + ROOT_DB_PATH + ". Retornando estrutura vazia (não será gravado automaticamente).");
      return {
        users: [],
        interns: [],
        meta: { created: timestamp(), provaBlockDays: 0, trashRetentionDays: 10 },
        pendingRegistrations: [],
        trash: []
      };
    }

    // normaliza metadata mínima
    const parsed = data;
    parsed.meta = parsed.meta || {};
    if(typeof parsed.meta.provaBlockDays === 'undefined') parsed.meta.provaBlockDays = 0;
    if(typeof parsed.meta.trashRetentionDays === 'undefined') parsed.meta.trashRetentionDays = 10;
    // CORREÇÃO APLICADA: Garante que `dates` seja sempre um array ao carregar os dados.
    parsed.interns = (parsed.interns || []).map(i => Object.assign({ dates: [], hoursEntries:[], auditLog:[] }, i));
    parsed.pendingRegistrations = parsed.pendingRegistrations || [];
    parsed.trash = parsed.trash || [];
    const fallbackDate = parsed.meta.created || timestamp();

    // Corrige o mapeamento de users (removendo o ".u" inválido)
    parsed.users = (parsed.users || []).map(u => ({
      id: u.id || uuid(),
      username: u.username,
      name: u.name || (u.role !== 'intern' ? u.username : undefined),
      password: u.password || 'senha123',
      role: u.role || 'intern',
      internId: u.internId || null,
      powers: u.powers || defaultPowersFor(u.role || 'intern'),
      selfPasswordChange: (typeof u.selfPasswordChange === 'undefined') ? true : !!u.selfPasswordChange,
      createdAt: u.createdAt || fallbackDate
    }));

    return parsed;
  } catch (e) {
    console.error("Erro ao carregar dados do Firebase:", e);
    return {
      users: [],
      interns: [],
      meta: { created: timestamp(), provaBlockDays: 0, trashRetentionDays: 10 },
      pendingRegistrations: [],
      trash: []
    };
  }
}

// Salva apenas no nó ROOT_DB_PATH — única definição de save()
async function save(stateObj){
  if(!stateObj || typeof stateObj !== 'object'){
    console.warn('Refusing to save invalid state:', stateObj);
    return false;
  }
  try {
    await database.ref(ROOT_DB_PATH).set(stateObj);
    return true;
  } catch (e) {
    console.error("Erro ao salvar dados no Firebase:", e);
    return false;
  }
}

// ----------------- App State -----------------
let state = null; // será carregado assincronamente
const root = document.getElementById('root');
let session = null;
let userFilter = 'all';

// initApp: carrega o estado. Se vazio, usa sampleData localmente mas NÃO grava automaticamente.
async function initApp(){
  state = await load();

  // se o banco estava vazio, deixamos sampleData em memória — NÃO gravamos automaticamente
  if ((state.users || []).length === 0 && (state.interns || []).length === 0) {
    console.log("Banco vazio — inicializando com sampleData em memória. Nenhum dado foi gravado automaticamente no Firebase.");
    state = sampleData(); // apenas para permitir testes locais / login inicial

    // Se você quiser **gravar** o sample data automaticamente apenas na primeira execução,
    // descomente a linha abaixo. CUIDADO: isso grava no Firebase. COMENTAR PARA DESATIVAR
    await save(state);
  }

  render();
  cleanupRejectedRegistrations();
}

// Utilities
function findUserByIntern(internId){ return state.users.find(u=>u.internId===internId); }
function findInternById(id){ return (state.interns || []).find(i=>i.id===id); }
function hasPower(user, power){ if(!user) return false; if(user.role==='super') return true; return !!(user.powers && user.powers[power]); }

// ----------------- Modal helper -----------------
function showModal(innerHtml, options={}){
  const backdrop = document.createElement('div'); backdrop.className = 'modal-backdrop';
  const modal = document.createElement('div'); modal.className = 'modal';
  modal.innerHTML = innerHtml;
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  function close(){ if(backdrop.parentNode) backdrop.remove(); if(options.onClose) options.onClose(); }
  const onKey = (e)=>{ if(e.key==='Escape') close(); };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', (ev)=>{ if(ev.target === backdrop && options.allowBackdropClose !== false) close(); });
  return { backdrop, modal, close, cleanup: ()=>{ document.removeEventListener('keydown', onKey); } };
}

// ----------------- Render router -----------------
function render(){
  if (!state) { // Mostra um estado de "carregando" enquanto espera o Firebase
    root.innerHTML = '<h2>Carregando...</h2>';
    return;
  }

  if(!session) return renderLogin();
  const user = (state.users || []).find(u=>u.id===session.userId);
  if(!user){
    session=null;
    return renderLogin();
  }
  if(user.role==='intern') return renderIntern(user);
  return renderManager(user);
}

// ----------------- LOGIN -----------------
function renderLogin(){
  root.innerHTML = '';
  // Remove a classe 'app' do root temporariamente para permitir o layout de tela cheia do login
  root.className = 'login-screen';
  
  // Adiciona a classe 'login-card' que será estilizada no CSS
  const card = document.createElement('div'); card.className='login-card';
  card.innerHTML = `
    <h2>Entrar</h2>

    <div class="login-input-group">
      <input id="inpUser" placeholder="Usuário" class="input-modern" />
      <div class="password-wrapper">
        <input id="inpPass" placeholder="Senha" type="password" class="input-modern" />
        <span class="password-toggle-icon" id="toggleLoginPass">🔒</span>
      </div>
      <div class="login-buttons">
        <button class="button" id="btnLogin">Entrar</button>
        <button class="button ghost" id="btnNewUserLogin">Novo usuário</button>
        <button class="button ghost small" id="btnForgotPass">Esqueci a senha</button>
      </div>
    </div>
  `;
  root.appendChild(card);

  document.getElementById('btnLogin').addEventListener('click', async ()=>{
    const u = document.getElementById('inpUser').value.trim();
    const p = document.getElementById('inpPass').value;
    const user = (state.users || []).find(x=>x.username === u && x.password === p);
    if(!user) return alert('Usuário ou senha inválidos');
    session = { userId: user.id };
    // Reverte para a classe 'app' após o login
    root.className = 'app'; 
    await save(state);
    render();
  });

  // Botão "Novo usuário"
  document.getElementById('btnNewUserLogin').addEventListener('click', showPreRegistrationModal);

  // NOVO: Botão "Esqueci a senha"
  document.getElementById('btnForgotPass').addEventListener('click', showForgotPasswordModal);

  // Toggle password visibility
  const toggleLoginPass = document.getElementById('toggleLoginPass');
  const inpPass = document.getElementById('inpPass');
  
  // A lógica de posicionamento foi movida para o CSS, apenas a função é necessária
  toggleLoginPass.addEventListener('click', () => {
      const type = inpPass.getAttribute('type') === 'password' ? 'text' : 'password';
      inpPass.setAttribute('type', type);
      toggleLoginPass.textContent = type === 'password' ? '🔒' : '🔓';
  });
}

// NOVO: Modal "Esqueci a senha"
function showForgotPasswordModal() {
    const html = `
        <div style="padding: 10px;">
            <h3 style="margin-top: 0;">Redefinição de Senha</h3>
            <p>Prezado(a), tendo em vista que esqueceu a senha, entre em contato com 
            <strong style="text-decoration: underline;">supervisor</strong> do setor e peça para ele redefinir.</p>
            <div style="display:flex;justify-content:flex-end;margin-top: 15px;">
                <button class="button" id="btnUnderstood">Entendido</button>
            </div>
        </div>
    `;
    const m = showModal(html, { allowBackdropClose: true });
    
    // Configura o evento para fechar o modal
    m.modal.querySelector('#btnUnderstood').addEventListener('click', () => { 
        m.close(); 
        m.cleanup(); 
    });
}

// NOVO: Modal "Folga Bloqueada"
function showProvaBloqueadaModal() {
    const html = `
        <div style="padding: 10px;">
            <h3 style="margin-top: 0; color: var(--danger);">Folga Bloqueada</h3>
            <p>Prezado(a) estagiário(a), a data que escolheu está bloqueada, tendo em vista o prazo determinado pela supervisão. 
            Caso tenha interesse na folga-prova nessa data, <strong style="color:var(--danger); text-decoration: underline;">entrar em contato com a supervisão</strong>.</p>
            <div style="display:flex;justify-content:flex-end;margin-top: 15px;">
                <button class="button" id="btnUnderstood">Entendido</button>
            </div>
        </div>
    `;
    const m = showModal(html, { allowBackdropClose: true });
    m.modal.querySelector('#btnUnderstood').addEventListener('click', () => { 
        m.close(); 
        m.cleanup(); 
    });
}


// Novo: Modal de pré-cadastro para estagiários
function showPreRegistrationModal(){
  const html = `
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div>
        <h3>PRÉ-CADASTRO</h3>
        <div class="muted small">Seu cadastro será analisado pelo supervisor ou Gabriel, entre em contato com eles.</div>
      </div>
      <button id="closePreReg" class="button ghost">Cancelar</button>
    </div>
    <form id="formPreReg" style="margin-top:10px;display:flex;flex-direction:column;gap:10px">
      <label><span class="small-muted">Tipo</span><input value="Estagiário" disabled class="input" /></label>
      <label><span class="small-muted">Nome completo do estagiário</span><input id="preRegName" required/></label>
      <label><span class="small-muted">Usuário (matrícula: ex. e710021)</span><input id="preRegUser" required/></label>
      <label style="position:relative;"><span class="small-muted">Senha</span>
        <input type="password" id="preRegPass" required style="padding-right: 36px;"/>
        <span class="password-toggle-icon" id="togglePreRegPass1">🔒</span>
      </label>
      <label style="position:relative;"><span class="small-muted">Confirmar senha</span>
        <input type="password" id="preRegPassConfirm" required style="padding-right: 36px;"/>
        <span class="password-toggle-icon" id="togglePreRegPass2">🔒</span>
      </label>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button type="submit" class="button">Enviar pré-cadastro</button>
      </div>
    </form>
  `;
  const m = showModal(html);
  m.modal.querySelector('#closePreReg').addEventListener('click', ()=> { m.close(); m.cleanup(); });

  const togglePreRegPass1 = m.modal.querySelector('#togglePreRegPass1');
  const preRegPass = m.modal.querySelector('#preRegPass');
  // A lógica de posicionamento foi movida para o CSS
  togglePreRegPass1.addEventListener('click', () => {
      const type = preRegPass.getAttribute('type') === 'password' ? 'text' : 'password';
      preRegPass.setAttribute('type', type);
      togglePreRegPass1.textContent = type === 'password' ? '🔒️' : '🔓';
  });

  const togglePreRegPass2 = m.modal.querySelector('#togglePreRegPass2');
  const preRegPassConfirm = m.modal.querySelector('#preRegPassConfirm');
  // A lógica de posicionamento foi movida para o CSS
  togglePreRegPass2.addEventListener('click', () => {
      const type = preRegPassConfirm.getAttribute('type') === 'password' ? 'text' : 'password';
      preRegPassConfirm.setAttribute('type', type);
      togglePreRegPass2.textContent = type === 'password' ? '🔒' : '🔓';
  });

  m.modal.querySelector('#formPreReg').addEventListener('submit', async (ev)=> {
    ev.preventDefault();
    const name = m.modal.querySelector('#preRegName').value.trim();
    const user = m.modal.querySelector('#preRegUser').value.trim();
    const pass = m.modal.querySelector('#preRegPass').value;
    const passConfirm = m.modal.querySelector('#preRegPassConfirm').value;

    if(!name || !user || !pass || !passConfirm) return alert('Por favor, preencha todos os campos.');
    if(pass !== passConfirm) return alert('As senhas não coincidem.');

    // Validação da matrícula
    const matriculaRegex = /^e\d{6}$/;
    if (!matriculaRegex.test(user)) {
      alert('Inserir sua matrícula com a letra "e" seguida de 6 números (ex: e710021).');
      return;
    }

    const newPreReg = {
      id: uuid(),
      name,
      username: user,
      password: pass,
      createdAt: timestamp(),
      status: 'pending'
    };

    state.pendingRegistrations.push(newPreReg);
    await save(state);
    alert('Pré-cadastro enviado com sucesso! Aguarde a aprovação do supervisor.');
    m.close(); m.cleanup();
  });
}

// NOVO: Modal de alteração de senha (Administrador)
function showChangePwdModalManager(user){
  const html = `
    <div style="display:flex;justify-content:space-between;align-items:center"><h3>Alterar minha senha</h3><button id="closeP" class="button ghost">Fechar</button></div>
    <form id="formPwd" style="margin-top:8px;display:flex;flex-direction:column;gap:8px">
      <label style="position:relative;"><span class="small-muted">Senha atual</span>
        <input type="password" id="curPwd" required style="padding-right: 36px;"/>
        <span class="password-toggle-icon" id="toggleCurPwd">🔒️</span>
      </label>
      <label style="position:relative;"><span class="small-muted">Nova senha</span>
        <input type="password" id="newPwd" required style="padding-right: 36px;"/>
        <span class="password-toggle-icon" id="toggleNewPwd">🔒️</span>
      </label>
      <div style="display:flex;justify-content:flex-end;gap:8px"><button type="submit" class="button">Alterar</button></div>
    </form>
  `;
  const m = showModal(html);
  m.modal.querySelector('#closeP').addEventListener('click', ()=> { m.close(); m.cleanup(); });

  const toggleCurPwd = m.modal.querySelector('#toggleCurPwd');
  const curPwd = m.modal.querySelector('#curPwd');
  toggleCurPwd.style.position = 'absolute';
  toggleCurPwd.style.right = '10px';
  toggleCurPwd.style.top = '50%';
  toggleCurPwd.style.transform = 'translateY(-50%)';
  toggleCurPwd.style.cursor = 'pointer';
  toggleCurPwd.addEventListener('click', () => {
      const type = curPwd.getAttribute('type') === 'password' ? 'text' : 'password';
      curPwd.setAttribute('type', type);
      toggleCurPwd.textContent = type === 'password' ? '🔒' : '🔓';
  });

  const toggleNewPwd = m.modal.querySelector('#toggleNewPwd');
  const newPwd = m.modal.querySelector('#newPwd');
  toggleNewPwd.style.position = 'absolute';
  toggleNewPwd.style.right = '10px';
  toggleNewPwd.style.top = '50%';
  toggleNewPwd.style.transform = 'translateY(-50%)';
  toggleNewPwd.style.cursor = 'pointer';
  toggleNewPwd.addEventListener('click', () => {
      const type = newPwd.getAttribute('type') === 'password' ? 'text' : 'password';
      newPwd.setAttribute('type', type);
      toggleNewPwd.textContent = type === 'password' ? '🔒' : '🔓';
  });

  m.modal.querySelector('#formPwd').addEventListener('submit', async (ev)=> {
    ev.preventDefault();
    const cur = m.modal.querySelector('#curPwd').value;
    const np = m.modal.querySelector('#newPwd').value;
    const u = (state.users || []).find(x=>x.id===session.userId);
    if(!u) return alert('Usuário não encontrado');
    if(u.password !== cur) return alert('Senha atual incorreta');
    if(!np) return alert('Senha nova inválida');
    u.password = np;
    await save(state);
    alert('Senha alterada');
    m.close();
    m.cleanup();
  });
}


// ----------------- INTERN VIEW -----------------
function calcHoursSummary(intern){
  const arr = intern.hoursEntries || [];
  const bank = arr.filter(e=>e.hours>0).reduce((s,e)=>s+e.hours,0);
  const neg = arr.filter(e=>e.hours<0 && !e.compensated).reduce((s,e)=>s + Math.abs(e.hours),0);
  return { bank, negative: neg, net: bank - neg };
}
function formatHours(h){ return Number(h).toLocaleString('pt-BR',{maximumFractionDigits:2}); }

function renderIntern(user){
  const intern = findInternById(user.internId);
  root.innerHTML = '';
  root.className = 'app';
  const card = document.createElement('div'); card.className='card';
  card.style.maxWidth = '1150px';
  card.style.margin = '28px auto';
  card.style.padding = '20px';

  const totals = calcHoursSummary(intern);
  const totalsHtml = totals.net >= 0
    ? `<div class="total-pill"><div class="small-muted">Banco de horas</div><div class="num">${formatHours(totals.net)} h</div></div>`
    : `<div class="total-pill"><div class="small-muted">Horas negativas</div><div class="num" style="color:var(--danger)">${formatHours(Math.abs(totals.net))} h</div></div>`;

  card.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div>
        <h2>${escapeHtml(intern?.name || user.username)}</h2>
        <div class="muted small">Área do estagiário — insira folgas-prova e veja calendário/horas.</div>
      </div>
      <div style="display:flex;gap:10px;align-items:center">
        <button class="button ghost" id="btnLogout">Sair</button>
        <button class="button" id="btnExportSelf">Exportar</button>
        ${ user.selfPasswordChange ? '<button class="button ghost" id="btnChangePwdSelf">Alterar senha</button>' : '' }
      </div>
    </div>

    <hr style="margin:12px 0"/>

    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
      <div style="min-width:320px">
        <div class="small-muted">Adicionar folga-prova</div>
        <div style="display:flex;flex-direction:column;gap:8px;margin-top:6px">
            <input type="date" id="inpMyProva" class="input" />
            <input type="text" id="inpMyProvaLink" class="input" placeholder="Link da prova (opcional)" />
            <button class="button alt" id="btnAddMyProva">Adicionar</button>
        </div>
        <div id="provaMsg" class="small-muted" style="margin-top:6px"></div>
      </div>

      <div style="margin-left:auto" id="totalsArea">${totalsHtml}</div>
    </div>

    <div style="margin-top:12px;display:flex;gap:16px;flex-direction:column">
      <div id="calendarWrap" class="card" style="padding:12px"></div>

      <div class="card" style="padding:12px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <h3>Histórico de lançamentos</h3>
            <div class="muted small">Banco / Negativas</div>
          </div>
          <div>
            ${ hasPower(state.users.find(u=>u.id===session.userId),'manage_hours') ? '<button class="button" id="btnAddEntry">Lançar horas (admin)</button>' : '' }
          </div>
        </div>
        <div id="entriesList" style="margin-top:10px"></div>
      </div>
    </div>
  `;
  root.appendChild(card);

  // default date input to today
  document.getElementById('inpMyProva').value = nowISO();

  // Add prova: check blockDays
  document.getElementById('btnAddMyProva').addEventListener('click', async ()=>{
    const d = document.getElementById('inpMyProva').value;
    const link = document.getElementById('inpMyProvaLink').value;
    if(!d) return alert('Escolha uma data');
    const blockDays = Number(state.meta.provaBlockDays || 0);
    const today = new Date(); today.setHours(0,0,0,0);
    const allowedFrom = new Date(today.getTime() + (blockDays+1)*24*60*60*1000);
    const selected = new Date(d + 'T00:00:00');
    const allowedDate = new Date(allowedFrom.getFullYear(), allowedFrom.getMonth(), allowedFrom.getDate());
    
    // Substitui a mensagem inline pelo modal
    if(selected.getTime() <= allowedDate.getTime()){
      showProvaBloqueadaModal();
      return;
    }
    
    // CORREÇÃO APLICADA: Garante que `intern.dates` é um array antes de adicionar uma nova data.
    intern.dates = intern.dates || [];
    if(!intern.dates.some(p => p.date === d)) {
        intern.dates.push({ date: d, link: link });
    }

    await save(state); 
    // Limpa os campos após adicionar
    document.getElementById('inpMyProva').value = nowISO();
    document.getElementById('inpMyProvaLink').value = '';
    render();
  });

  document.getElementById('btnLogout').addEventListener('click', ()=>{ session=null; render(); });
  document.getElementById('btnExportSelf').addEventListener('click', ()=>{ downloadBlob(JSON.stringify({ intern, user }, null, 2), `${(intern.name||user.username).replaceAll(' ','_')}_dados.json`); });

  // change password (self)
  if(user.selfPasswordChange){
    document.getElementById('btnChangePwdSelf').addEventListener('click', ()=> {
      const html = `
        <div style="display:flex;justify-content:space-between;align-items:center"><h3>Alterar minha senha</h3><button id="closeP" class="button ghost">Fechar</button></div>
        <form id="formPwd" style="margin-top:8px;display:flex;flex-direction:column;gap:8px">
          <label style="position:relative;"><span class="small-muted">Senha atual</span>
            <input type="password" id="curPwd" required style="padding-right: 36px;"/>
            <span class="password-toggle-icon" id="toggleCurPwd">🔒️</span>
          </label>
          <label style="position:relative;"><span class="small-muted">Nova senha</span>
            <input type="password" id="newPwd" required style="padding-right: 36px;"/>
            <span class="password-toggle-icon" id="toggleNewPwd">🔒️</span>
          </label>
          <div style="display:flex;justify-content:flex-end;gap:8px"><button type="submit" class="button">Alterar</button></div>
        </form>
      `;
      const m = showModal(html);
      m.modal.querySelector('#closeP').addEventListener('click', ()=> { m.close(); m.cleanup(); });

      const toggleCurPwd = m.modal.querySelector('#toggleCurPwd');
      const curPwd = m.modal.querySelector('#curPwd');
      toggleCurPwd.style.position = 'absolute';
      toggleCurPwd.style.right = '10px';
      toggleCurPwd.style.top = '50%';
      toggleCurPwd.style.transform = 'translateY(-50%)';
      toggleCurPwd.style.cursor = 'pointer';
      toggleCurPwd.addEventListener('click', () => {
          const type = curPwd.getAttribute('type') === 'password' ? 'text' : 'password';
          curPwd.setAttribute('type', type);
          toggleCurPwd.textContent = type === 'password' ? '🔒' : '🔓';
      });

      const toggleNewPwd = m.modal.querySelector('#toggleNewPwd');
      const newPwd = m.modal.querySelector('#newPwd');
      toggleNewPwd.style.position = 'absolute';
      toggleNewPwd.style.right = '10px';
      toggleNewPwd.style.top = '50%';
      toggleNewPwd.style.transform = 'translateY(-50%)';
      toggleNewPwd.style.cursor = 'pointer';
      toggleNewPwd.addEventListener('click', () => {
          const type = newPwd.getAttribute('type') === 'password' ? 'text' : 'password';
          newPwd.setAttribute('type', type);
          toggleNewPwd.textContent = type === 'password' ? '🔒' : '🔓';
      });

      m.modal.querySelector('#formPwd').addEventListener('submit', async (ev)=> {
        ev.preventDefault();
        const cur = m.modal.querySelector('#curPwd').value;
        const np = m.modal.querySelector('#newPwd').value;
        const u = (state.users || []).find(x=>x.id===session.userId);
        if(!u) return alert('Usuário não encontrado');
        if(u.password !== cur) return alert('Senha atual incorreta');
        if(!np) return alert('Senha nova inválida');
        u.password = np;
        await save(state);
        alert('Senha alterada');
        m.close();
        m.cleanup();
      });
    });
  }

  // calendar with month navigation: render initial month and provide prev/next
  let viewing = new Date();
  function renderCalendar(){
    renderCalendarForIntern(intern, viewing);
  }
  renderCalendar();
  renderEntriesList(intern);

  const addBtn = document.getElementById('btnAddEntry');
  if(addBtn) addBtn.addEventListener('click', ()=> showHourEntryForm(intern.id));
}

// ----------------- Calendar renderer (for a given viewing Date) -----------------
function renderCalendarForIntern(intern, viewing){
  const wrap = document.getElementById('calendarWrap');
  const monthStart = new Date(viewing.getFullYear(), viewing.getMonth(), 1);
  const label = monthStart.toLocaleString('pt-BR',{month:'long', year:'numeric'});
  wrap.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <div><strong>Calendário</strong></div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="button ghost" id="prevMonth">&lt;</button>
        <div class="small-muted" id="monthLabel">${label}</div>
        <button class="button ghost" id="nextMonth">&gt;</button>
      </div>
    </div>
    <div class="calendar" style="grid-template-columns:repeat(7,1fr);font-weight:700;color:var(--muted)">
      <div>Dom</div><div>Seg</div><div>Ter</div><div>Qua</div><div>Qui</div><div>Sex</div><div>Sáb</div>
    </div>
    <div id="monthGrid" class="calendar" style="margin-top:10px"></div>
  `;
  const grid = document.getElementById('monthGrid');
  grid.innerHTML = '';
  const firstDay = new Date(viewing.getFullYear(), viewing.getMonth(), 1).getDay();
  const daysInMonth = new Date(viewing.getFullYear(), viewing.getMonth()+1, 0).getDate();

  for(let i=0;i<firstDay;i++){
    const blank = document.createElement('div'); blank.className='day'; blank.style.visibility='hidden'; blank.innerHTML='&nbsp;'; grid.appendChild(blank);
  }
  for(let d=1; d<=daysInMonth; d++){
    const date = new Date(viewing.getFullYear(), viewing.getMonth(), d);
    const iso = date.toISOString().slice(0,10);
    const dayEl = document.createElement('div'); dayEl.className='day';
    dayEl.innerHTML = `<div class="date">${d}</div>`;
    
    const prova = (intern.dates || []).find(p => p.date === iso);
    if(prova){
      const pill = document.createElement('div'); pill.className='tag bank'; pill.textContent = 'Folga-prova';
      const currentUser = (state.users || []).find(u=>u.id===session.userId);
      if(currentUser && currentUser.role === 'intern' && currentUser.internId === intern.id){
        const rem = document.createElement('button'); rem.className='button ghost'; rem.textContent='🗑️';
        // Ajuste no wrapper para aplicar o espaçamento do CSS
        const wrapper = document.createElement('div'); wrapper.className='wrapper'; // Adicionado
        rem.addEventListener('click', async (ev)=>{ ev.stopPropagation(); if(confirm('Remover sua folga-prova nesta data?')){ intern.dates = intern.dates.filter(x=>x.date !== iso); await save(state); render(); }});
        
        wrapper.appendChild(pill); wrapper.appendChild(rem);
        dayEl.appendChild(wrapper);
      } else {
        dayEl.appendChild(pill);
      }
    }
    ((intern.hoursEntries) || []).filter(e=>e.date===iso).forEach(e=>{
      const tag = document.createElement('div'); tag.className = 'tag ' + (e.hours>0 ? 'bank' : 'neg'); tag.textContent = `${e.hours>0?'+':''}${e.hours}h`;
      dayEl.appendChild(tag);
    });
    dayEl.addEventListener('click', ()=> openDayDetails(intern, iso));
    grid.appendChild(dayEl);
  }

  document.getElementById('prevMonth').addEventListener('click', ()=>{
    viewing.setMonth(viewing.getMonth()-1);
    renderCalendarForIntern(intern, viewing);
  });
  document.getElementById('nextMonth').addEventListener('click', ()=>{
    viewing.setMonth(viewing.getMonth()+1);
    renderCalendarForIntern(intern, viewing);
  });
}

// ----------------- Day details modal -----------------
function openDayDetails(intern, iso){
  const provas = (intern.dates || []).filter(p=>p.date===iso);
  const entries = (intern.hoursEntries || []).filter(e=>e.date===iso);
  const htmlParts = [];
  htmlParts.push(`<div style="display:flex;justify-content:space-between;align-items:center"><h3>Detalhes — ${iso}</h3><button id="closeD" class="button ghost">Fechar</button></div>`);
  htmlParts.push('<div style="margin-top:8px">');
  htmlParts.push('<h4>Folgas-prova</h4>');
  if(provas.length===0) htmlParts.push('<div class="muted small">Nenhuma folga-prova nesta data</div>');
  else provas.forEach(p=> htmlParts.push(`<div class="row"><div>${p.date} • <span class="small-muted">Folga-prova registrada</span></div> ${p.link ? `<a href="${p.link}" target="_blank" class="button ghost">Ver prova</a>` : ''}</div>`));
  htmlParts.push('<hr/>');
  htmlParts.push('<h4>Lançamentos</h4>');
  if(entries.length===0) htmlParts.push('<div class="muted small">Nenhum lançamento</div>');
  else entries.forEach(e=>{
    const currentUser = (state.users || []).find(u => u.id === session.userId);
    const canManageHours = hasPower(currentUser, 'manage_hours');
    
    const actions = canManageHours
      ? `<div style="display:flex;gap:6px;"><button class="button ghost" data-edit="${e.id}">Editar</button><button class="button" data-delete="${e.id}">Excluir</button></div>`
      : '';
    const compensation = e.hours < 0 && canManageHours
      ? (e.compensated
        ? `<button class="button ghost" data-uncomp="${e.id}">Desfazer comp.</button>`
        : `<button class="button" data-comp="${e.id}">Marcar comp.</button>`)
      : '';

    htmlParts.push(`
      <div class="row" style="flex-direction:column;align-items:flex-start;gap:8px;">
        <div style="display:flex;justify-content:space-between;align-items:center;width:100%">
          <div style="font-weight:700;">${e.date} • ${e.hours > 0 ? '+' : ''}${e.hours}h ${e.type === 'bank' ? '(Banco)' : '(Negativa)'} ${e.compensated ? '• Compensado' : ''}</div>
          <div style="display:flex;gap:6px">${actions}</div>
        </div>
        <div class="small-muted" style="margin-left:8px;">${escapeHtml(e.reason || 'Sem justificativa')}</div>
        <div class="audit" style="margin-left:8px;">Criado por: ${escapeHtml(e.createdByName || '—')} em ${e.createdAt ? new Date(e.createdAt).toLocaleString() : ''}${e.lastModifiedBy ? ' • Alterado por: '+escapeHtml(e.lastModifiedBy) : ''}${e.compensatedBy ? ' • Compensado por: '+escapeHtml(e.compensatedBy)+' em '+(e.compensatedAt? new Date(e.compensatedAt).toLocaleString(): '') : ''}</div>
        ${compensation ? `<div style="margin-top:8px;">${compensation}</div>` : ''}
      </div>
    `);
  });
  htmlParts.push('</div>');

  const m = showModal(htmlParts.join(''), { allowBackdropClose:true });
  m.modal.querySelector('#closeD').addEventListener('click', ()=> { m.close(); m.cleanup(); });

  m.modal.querySelectorAll('[data-delete]').forEach(btn=> btn.addEventListener('click', async ()=>{
    const id = btn.getAttribute('data-delete');
    if(!confirm('Excluir lançamento?')) return;
    const entry = (intern.hoursEntries || []).find(x=>x.id===id);
    const manager = (state.users || []).find(u=>u.id===session.userId);
    if(entry){
      intern.auditLog = intern.auditLog || [];
      intern.auditLog.push({ id: uuid(), action:'delete_entry', byUserId: manager.id, byUserName: manager.username, at: timestamp(), details: `Excluído lançamento ${entry.id} (${entry.hours}h ${entry.type})` });
      intern.hoursEntries = intern.hoursEntries.filter(x=>x.id!==id);
      await save(state);
      m.close();
      m.cleanup();
      render();
    }
  }));

  m.modal.querySelectorAll('[data-comp]').forEach(btn=> btn.addEventListener('click', async ()=>{
    const id = btn.getAttribute('data-comp');
    markCompensated(intern.id, id, true);
    const manager = (state.users || []).find(u=>u.id===session.userId);
    intern.auditLog = intern.auditLog || [];
    intern.auditLog.push({ id: uuid(), action:'compensated', byUserId: manager.id, byUserName: manager.username, at: timestamp(), details: `Compensou lançamento ${id}` });
    await save(state);
    m.close();
    m.cleanup();
    render();
  }));

  m.modal.querySelectorAll('[data-uncomp]').forEach(btn=> btn.addEventListener('click', async ()=>{
    const id = btn.getAttribute('data-uncomp');
    markCompensated(intern.id, id, false);
    const manager = (state.users || []).find(u=>u.id===session.userId);
    intern.auditLog = intern.auditLog || [];
    intern.auditLog.push({ id: uuid(), action:'uncompensated', byUserId: manager.id, byUserName: manager.username, at: timestamp(), details: `Desfez compensação de ${id}` });
    await save(state);
    m.close();
    m.cleanup();
    render();
  }));

  m.modal.querySelectorAll('[data-edit]').forEach(btn=> btn.addEventListener('click', ()=>{
    const id = btn.getAttribute('data-edit');
    m.close();
    m.cleanup();
    showHourEntryForm(intern.id, id);
  }));
}

// ----------------- Entries list -----------------
function renderEntriesList(intern){
  const list = document.getElementById('entriesList'); if(!list) return;
  list.innerHTML = '';
  const arr = ((intern.hoursEntries) || []).slice().sort((a,b)=> b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  if(arr.length===0){ list.innerHTML = '<div class="muted">Nenhum lançamento</div>'; return; }
  arr.forEach(e=>{
    const row = document.createElement('div'); row.className='row';
    const currentUser = (state.users || []).find(u => u.id === session.userId);
    const left = document.createElement('div');
    left.innerHTML = `<div style="font-weight:700">${e.date} — ${e.hours>0?'+':''}${e.hours}h ${e.type==='bank'?'(Banco)':'(Negativa)'} ${e.compensated? '• Compensado':''}</div><div class="small-muted">${escapeHtml(e.reason||'')}</div><div class="audit">Criado por: ${escapeHtml(e.createdByName||'—')} em ${e.createdAt? new Date(e.createdAt).toLocaleString() : ''}</div>`;
    const right = document.createElement('div');
    if(hasPower(currentUser,'manage_hours')){
      const btnEdit = document.createElement('button'); btnEdit.className='button ghost'; btnEdit.textContent='Editar'; btnEdit.addEventListener('click', ()=> showHourEntryForm(intern.id, e.id));
      const btnDel = document.createElement('button'); btnDel.className='button'; btnDel.textContent='Excluir'; btnDel.addEventListener('click', async ()=> { if(confirm('Excluir lançamento?')){ const manager = (state.users || []).find(u=>u.id===session.userId); intern.auditLog = intern.auditLog || []; intern.auditLog.push({ id: uuid(), action:'delete_entry', byUserId: manager.id, byUserName: manager.username, at: timestamp(), details: `Excluído lançamento ${e.id} (${e.hours}h ${e.type})` }); intern.hoursEntries = intern.hoursEntries.filter(x=>x.id!==e.id); await save(state); render(); }});
      right.appendChild(btnEdit); right.appendChild(btnDel);
      if(e.hours<0){
        const btnComp = document.createElement('button'); btnComp.className = e.compensated ? 'button ghost' : 'button'; btnComp.textContent = e.compensated ? 'Desfazer comp.' : 'Marcar compensado';
        btnComp.addEventListener('click', async ()=> { markCompensated(intern.id,e.id, !e.compensated); const manager = (state.users || []).find(u=>u.id===session.userId); intern.auditLog = intern.auditLog || []; intern.auditLog.push({ id: uuid(), action: e.compensated ? 'uncompensated' : 'compensated', byUserId: manager.id, byUserName: manager.username, at: timestamp(), details: `${e.compensated ? 'Desfez compensação' : 'Compensou'} lançamento ${e.id}` }); await save(state); render(); });
        right.appendChild(btnComp);
      }
    }
    row.appendChild(left); row.appendChild(right); list.appendChild(row);
  });
}

// ----------------- Hour entry modal (create/edit) -----------------
function showHourEntryForm(internId, entryId){
  const intern = findInternById(internId);
  if(!intern) return;
  const isEdit = !!entryId;
  const existing = isEdit ? ((intern.hoursEntries) || []).find(e=>e.id===entryId) : null;
  const currentManager = (state.users || []).find(u=>u.id===session.userId);
  if(!hasPower(currentManager,'manage_hours')) return alert('Sem permissão para gerenciar horas.');
  const html = `
    <div style="display:flex;justify-content:space-between;align-items:center"><h3>${isEdit ? 'Editar' : 'Lançar'} horas — ${escapeHtml(intern.name)}</h3><button id="closeH" class="button ghost">Fechar</button></div>
    <form id="formHours" style="margin-top:10px;display:flex;flex-direction:column;gap:8px">
      <label><span class="small-muted">Data</span><input type="date" id="h_date" value="${existing?existing.date:nowISO()}" required /></label>
      <label><span class="small-muted">Tipo</span>
        <select id="h_type"><option value="bank">Banco (crédito)</option><option value="negative">Negativa (falta)</option></select>
      </label>
      <label><span class="small-muted">Quantidade de horas (número)</span><input id="h_hours" value="${existing?Math.abs(existing.hours):8}" type="number" min="0.25" step="0.25" required /></label>
      <label><span class="small-muted">Justificativa / observações</span><textarea id="h_reason" rows="3">${existing?escapeHtml(existing.reason||''):''}</textarea></label>
      <label><input type="checkbox" id="h_comp" ${existing && existing.compensated ? 'checked' : ''}/> Marcar como compensado (aplica-se a negativas)</label>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button type="submit" class="button">${isEdit ? 'Salvar' : 'Lançar'}</button>
      </div>
    </form>
  `;
  const m = showModal(html);
  const modal = m.modal;
  modal.querySelector('#closeH').addEventListener('click', ()=> { m.close(); m.cleanup(); });
  if(existing) modal.querySelector('#h_type').value = existing.type;
  modal.querySelector('#formHours').addEventListener('submit', async (ev)=> {
    ev.preventDefault();
    const date = modal.querySelector('#h_date').value;
    const type = modal.querySelector('#h_type').value;
    const hoursRaw = modal.querySelector('#h_hours').value;
    const hoursNum = Number(hoursRaw);
    if(!date || !hoursNum || isNaN(hoursNum) || hoursNum<=0) return alert('Dados inválidos');
    const reason = modal.querySelector('#h_reason').value || '';
    const comp = !!modal.querySelector('#h_comp').checked;
    const manager = (state.users || []).find(u=>u.id===session.userId);
    if(isEdit && existing){
      existing.date = date;
      existing.type = type;
      existing.hours = type==='bank' ? hoursNum : -hoursNum;
      existing.reason = reason;
      existing.lastModifiedBy = manager.username;
      existing.lastModifiedAt = timestamp();
      existing.compensated = comp;
      await save(state);
      intern.auditLog = intern.auditLog || [];
      intern.auditLog.push({ id: uuid(), action:'edit_entry', byUserId: manager.id, byUserName: manager.username, at: timestamp(), details: `Editou lançamento ${existing.id}` });
    } else {
      const entry = { id: uuid(), date, type, hours: type==='bank'? hoursNum : -hoursNum, reason, compensated: comp, createdById: manager.id, createdByName: manager.username, createdAt: timestamp() };
      intern.hoursEntries = intern.hoursEntries || [];
      intern.hoursEntries.push(entry);
      intern.auditLog = intern.auditLog || [];
      intern.auditLog.push({ id: uuid(), action:'create_entry', byUserId: manager.id, byUserName: manager.username, at: timestamp(), details: `Criou lançamento ${entry.id} (${entry.hours}h ${entry.type})` });
    }
    await save(state);
    m.close();
    m.cleanup();
    render();
  });
}

// ----------------- Mark compensated -----------------
async function markCompensated(internId, entryId, flag){
  const intern = findInternById(internId);
  if(!intern) return;
  const entry = ((intern.hoursEntries) || []).find(e=>e.id===entryId);
  if(!entry) return;
  entry.compensated = !!flag;
  if(flag){
    entry.compensatedBy = ((state.users || []).find(u=>u.id===session.userId) || {}).username;
    entry.compensatedAt = timestamp();
  } else {
    entry.compensatedBy = null;
    entry.compensatedAt = null;
  }
  await save(state);
}

// ----------------- MANAGER PANEL -----------------
let adminViewingDate = new Date();
let adminProvasView = 'list'; // 'list' or 'calendar'

function renderManager(user){
  root.innerHTML = '';
  root.className = 'app-grid';
  
  // Calcula a contagem de pendências
  const pendingCount = (state.pendingRegistrations || []).length;
  const pendingClass = pendingCount > 0 ? 'has-pending' : '';

  // Adicionando a nova seção de pré-cadastros ao layout do painel
  root.innerHTML = `
    <aside class="sidebar-nav">
      <div style="font-weight: bold; font-size: 1.2rem; color: var(--accent);">
        Painel de Gestão
      </div>
      <div class="muted small">Usuário: ${escapeHtml(user.username)} • ${escapeHtml(user.role)}</div>
      
      ${user.role === 'admin' && user.selfPasswordChange ? 
        `<button class="button ghost" id="btnChangePwdMgr" style="width: 100%; margin: 8px 0;">Alterar Senha</button><hr style="border-color: #eee; margin: 8px 0;">` : 
        `<hr style="border-color: #eee; margin: 8px 0;">`
      }

      <div class="sidebar-item active" data-section="geral">
        <span>Geral</span>
      </div>
      <div class="sidebar-item" data-section="provas">
        <span>Folgas-prova</span>
      </div>
      <div class="sidebar-item" data-section="relatorios">
        <span>Relatórios de Horas</span>
      </div>
      <div class="sidebar-item ${pendingClass}" data-section="pendentes">
        <span>Pré-cadastros Pendentes</span>
        <span id="pending-count-badge" class="badge" style="display: ${pendingCount > 0 ? 'inline-block' : 'none'};">${pendingCount}</span>
      </div>
      <div class="sidebar-item" data-section="configuracoes">
        <span>Configurações</span>
      </div>
      
      ${user.role === 'super' ? `
      <div class="sidebar-item" id="btnSidebarBackup">
        <span>Backup</span>
      </div>
      ` : ''}

      <div class="sidebar-item" data-section="lixeira">
        <span>Lixeira</span>
      </div>
      <div style="margin-top: auto;">
        <button class="button ghost" id="btnLogoutMgr">Sair</button>
      </div>
    </aside>
    <main class="main-content">
      <div id="geral" class="content-section active">
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <h3>Usuários</h3>
            <div style="display:flex;flex-direction:column;gap:8px;">
              <button id="btnNewUser" class="button ghost">Novo usuário</button>
              <button id="btnBulkImport" class="button alt">Criar em lote</button>
            </div>
          </div>
          <div style="margin-top:12px;display:flex;flex-direction:column;gap:8px">
             <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap">
                <div id="userFilterButtons" style="display:flex;gap:8px;align-items:center;">
                   <button class="button" id="filterAll" data-filter="all">Todos</button>
                   <button class="button ghost" id="filterIntern" data-filter="intern">Estagiário</button>
                   <button class="button ghost" id="filterAdmin" data-filter="admin">Admin</button>
                </div>
                <button id="btnDeleteSelectedUsers" class="button danger" disabled>Excluir selecionados</button>
             </div>
             <input id="searchMgmt" placeholder="Pesquisar por nome, usuário ou ID" />
             <div class="muted small">Total de usuários: <span id="totalUsers"></span></div>
             <div class="list" id="usersList" style="margin-top:10px"></div>
          </div>
        </div>

        <div class="card" style="margin-top:12px">
            <h3>Pesquisa de Estagiários</h3>
            <div class="muted small">Pesquise por estagiário — lista dinâmica. Clique para abrir detalhes.</div>
            <div style="margin-top:8px;position:relative">
                <input id="mgrNameSearch" placeholder="Pesquisar por nome do estagiário" autocomplete="off" />
                <div id="mgrNameDropdown" class="dropdown" style="position:absolute;left:0;right:0;z-index:30;display:none;background:#fff;border:1px solid #eee;max-height:220px;overflow:auto"></div>
            </div>
            <div id="mgrResults" style="margin-top:12px"></div>
        </div>
      </div>

      <div id="provas" class="content-section">
          <div class="card">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <h3>Folgas-prova</h3>
                <div style="display: flex; gap: 8px;">
                    <button id="toggleProvasListView" class="button">Lista</button>
                    <button id="toggleProvasCalendarView" class="button ghost">Calendário</button>
                </div>
              </div>
              <div id="provasListSection" style="margin-top: 12px;" class="content-section active">
                  <div class="muted small">Exibe apenas estagiários que têm folga-prova cadastrada na data escolhida.</div>
                  <div style="display:flex;gap:8px;margin-top:8px;align-items:center">
                      <input type="date" id="mgrFilterDate" />
                      <button class="button" id="btnApplyFilter">Buscar</button>
                      <button class="button ghost" id="btnClearDateFilter">Limpar</button>
                  </div>
                  <div id="provasResults" style="margin-top:12px"></div>
              </div>
              <div id="provasCalendarSection" style="margin-top: 12px; display: none;">
                  <div id="adminCalendarWrap" class="card" style="padding:12px"></div>
              </div>
          </div>
      </div>
      
      <div id="relatorios" class="content-section">
        <div class="card">
          <h3>Relatórios de Horas</h3>
          <div class="muted small">Saldo líquido por estagiário (banco - negativas não compensadas)</div>
          <div id="reportsArea" style="margin-top:8px"></div>
        </div>
      </div>

      <div id="pendentes" class="content-section">
        <div class="card">
          <h3>Pré-cadastros Pendentes</h3>
          <div class="muted small">Aprove ou recuse solicitações de novos estagiários.</div>
          <div id="pendingList" style="margin-top:10px"></div>
        </div>
      </div>

      <div id="configuracoes" class="content-section">
        <div class="card">
          <h3>Configurações</h3>
          <div class="small-muted">Bloqueio para marcação de folgas-prova (dias)</div>
          <div class="settings-row">
            <select id="cfgBlockDays">${ new Array(31).fill(0).map((_,i)=>`<option value="${i}">${i} dias</option>`).join('') }</select>
            <button class="button" id="btnSaveConfig">Salvar</button>
          </div>
          <hr style="margin: 12px 0"/>
          <div class="small-muted">Opções de Importação/Exportação</div>
          <div style="display:flex;gap:8px;margin-top:8px">
            <div class="muted small">Use a seção 'Backup' no menu lateral para gerenciar os dados.</div>
          </div>
        </div>
      </div>
      
      <div id="backup" class="content-section">
        <div class="card">
          <h3>Backup</h3>
          <div class="muted small">Use o botão 'Backup' no menu lateral para gerenciar os dados.</div>
          <div style="margin-top: 10px;">
              <button class="button" id="btnOpenBackupModal">Abrir Opções de Backup</button>
          </div>
        </div>
      </div>
      <div id="lixeira" class="content-section">
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <h3>Lixeira</h3>
            <div style="display:flex;gap:8px;">
              <button id="btnRestoreSelected" class="button ghost">Restaurar selecionados</button>
              <button id="btnRestoreAll" class="button alt">Restaurar tudo</button>
              <button id="btnEmptyTrash" class="button danger">Esvaziar lixeira</button>
            </div>
          </div>
          <div class="muted small">Pré-cadastros recusados. Serão removidos após o período de retenção.</div>
          <div class="settings-row">
            <div class="small-muted">Período de retenção:</div>
            <select id="cfgTrashRetention">${ new Array(30).fill(0).map((_,i)=>`<option value="${i+1}">${i+1} dia(s)</option>`).join('') }</select>
            <button class="button" id="btnSaveRetention">Salvar</button>
          </div>
          <div id="trashList" style="margin-top:10px;"></div>
        </div>
      </div>
    </main>
    
    <input type="file" id="fileMgmt" style="display:none" accept="application/json" />
    <input type="file" id="fileBulkImport" style="display:none" accept=".csv, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.ms-excel" />
    `;
  
  // ********** NOVO: Lógica de Filtro de Usuários **********
  document.querySelectorAll('#userFilterButtons button').forEach(button => {
    button.addEventListener('click', (e) => {
      userFilter = e.currentTarget.dataset.filter;
      
      // Atualiza o estilo dos botões
      document.querySelectorAll('#userFilterButtons button').forEach(btn => {
        if (btn.dataset.filter === userFilter) {
          btn.classList.remove('ghost');
        } else {
          btn.classList.add('ghost');
        }
      });
      
      renderUsersList();
    });
  });
  // ********************************************************

  // ********** NOVO: Lógica para Alterar Senha Admin **********
  const btnChangePwdMgr = document.getElementById('btnChangePwdMgr');
  if (btnChangePwdMgr) {
      btnChangePwdMgr.addEventListener('click', () => {
          const manager = (state.users || []).find(u => u.id === session.userId);
          if (manager.role === 'admin' && manager.selfPasswordChange) {
              showChangePwdModalManager(manager);
          } else {
              alert('Você não tem permissão ou não é um administrador secundário para alterar a senha por aqui.');
          }
      });
  }
  // ********************************************************

  // NOVO: Handler para o botão de exclusão em lote
  const btnDeleteSelectedUsers = document.getElementById('btnDeleteSelectedUsers');
  if (btnDeleteSelectedUsers) {
      btnDeleteSelectedUsers.addEventListener('click', deleteSelectedUsers);
  }

  // Adiciona a lógica para alternar as seções
  document.querySelectorAll('.sidebar-item').forEach(item => {
    item.addEventListener('click', (e) => {
      const sectionId = e.currentTarget.dataset.section;
      // Trata a seção 'Backup' como um modal, não uma seção de conteúdo
      if (e.currentTarget.id === 'btnSidebarBackup') {
          showBackupModal();
          return; 
      }
      
      document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
      e.currentTarget.classList.add('active');
      
      document.querySelectorAll('.content-section').forEach(s => s.classList.remove('active'));
      if(sectionId) document.getElementById(sectionId).classList.add('active');
      
      if (sectionId === 'relatorios') {
        renderReports();
      } else if (sectionId === 'provas') {
        renderProvasSection();
      } else if (sectionId === 'pendentes') {
        renderPendingList();
      } else if (sectionId === 'lixeira') {
        renderTrashList();
      }
      // Seção de backup só precisa abrir o modal
      if (sectionId === 'backup') {
          showBackupModal();
      }
    });
  });

  document.getElementById('btnLogoutMgr').addEventListener('click', ()=>{ session=null; render(); });
  document.getElementById('btnNewUser').addEventListener('click', ()=> showCreateUserForm((state.users || []).find(u => u.id === session.userId)));
  
  // NOVO: Listener para o botão de importação em lote
  document.getElementById('btnBulkImport').addEventListener('click', () => {
    const manager = (state.users || []).find(u => u.id === session.userId);
    if(!hasPower(manager, 'create_intern')) return alert('Sem permissão para criar estagiários em lote.');
    showBulkImportModal();
  });

  // O botão 'Abrir Opções de Backup' na seção de conteúdo 'Backup' (caso o usuário a ative manualmente)
  const btnOpenBackupModal = document.getElementById('btnOpenBackupModal');
  if (btnOpenBackupModal) {
      // Adiciona o listener APENAS se for o super admin
      if(user.role === 'super') {
          btnOpenBackupModal.addEventListener('click', showBackupModal);
      } else {
          // Garante que se um admin tentar clicar no botão do main content, será alertado
          btnOpenBackupModal.addEventListener('click', () => alert('Acesso negado. Somente o Administrador Principal pode gerenciar o Backup.'));
          // Esconde o botão se o elemento da seção for visível para outros admins (melhor que confiar apenas no menu lateral)
          btnOpenBackupModal.style.display = 'none';
      }
  }

  // A lógica de Importação/Exportação foi movida para o modal, 
  // mas o 'fileMgmt' é universal e precisa ser configurado.
  // Novo: Handler para o input de arquivo (Importação de Backup)
  document.getElementById('fileMgmt').addEventListener('change', (ev)=>{ 
      const f = ev.target.files[0]; 
      if(!f) return; 
      importDataFromFile(f);
      // Limpa o valor do input para permitir o upload do mesmo arquivo novamente
      ev.target.value = null; 
  });

  document.getElementById('searchMgmt').addEventListener('input', renderUsersList);

  // Name search dropdown handlers
  const nameInput = document.getElementById('mgrNameSearch');
  const dropdown = document.getElementById('mgrNameDropdown');

  nameInput.addEventListener('input', (ev)=> {
    const q = ev.target.value.trim().toLowerCase();
    renderNameDropdown(q);
  });

  nameInput.addEventListener('focus', (ev)=> {
    const q = ev.target.value.trim().toLowerCase();
    renderNameDropdown(q);
  });

  // close dropdown when clicking outside
  document.addEventListener('click', (ev)=>{
    if(!ev.target.closest('#mgrNameSearch') && !ev.target.closest('#mgrNameDropdown')){
      dropdown.style.display = 'none';
    }
  });

  document.getElementById('cfgBlockDays').value = String((state.meta || {}).provaBlockDays || 5);
  document.getElementById('btnSaveConfig').addEventListener('click', async ()=> {
    const val = Number(document.getElementById('cfgBlockDays').value || 0);
    if (!state.meta) state.meta = {};
    state.meta.provaBlockDays = val;
    await save(state);
    alert('Configuração salva (bloqueio: '+val+' dias).');
  });

  // Configuração da lixeira
  document.getElementById('cfgTrashRetention').value = String((state.meta || {}).trashRetentionDays || 10);
  document.getElementById('btnSaveRetention').addEventListener('click', async ()=> {
    const val = Number(document.getElementById('cfgTrashRetention').value || 10);
    if (!state.meta) state.meta = {};
    state.meta.trashRetentionDays = val;
    await save(state);
    alert('Período de retenção da lixeira salvo: '+val+' dias.');
  });
  
  // Event listeners para a lixeira
  document.getElementById('btnEmptyTrash').addEventListener('click', emptyTrash);
  document.getElementById('btnRestoreAll').addEventListener('click', restoreAllTrash);
  document.getElementById('btnRestoreSelected').addEventListener('click', restoreSelectedTrash);

  renderUsersList();
}

/**
 * Nova função para gerar dados de Horas e Provas em formato CSV.
 * Concatena os dois relatórios para uma visão completa.
 * @returns {string} Dados formatados em CSV.
 */
function generateCsvData() {
    // 1. Coleta e formata os dados
    const allEntries = [];

    (state.interns || []).forEach(intern => {
        // Horas
        (intern.hoursEntries || []).forEach(entry => {
            const entryType = entry.hours > 0 ? 'Banco (Crédito)' : 'Negativa (Falta)';
            const hoursValue = entry.hours; // Inclui o sinal de + ou -
            
            allEntries.push({
                Tipo_Registro: 'Horas',
                Estagiario_Nome: intern.name,
                Estagiario_ID: intern.id,
                Data: entry.date,
                Detalhe: entryType,
                Horas: hoursValue.toFixed(2).replace('.', ','), // Formato brasileiro com vírgula
                Compensado: entry.compensated ? 'Sim' : 'Não',
                Motivo_Razao: entry.reason ? entry.reason.replace(/["\n\r]/g, '') : '', // Limpa aspas e quebras de linha para CSV
                Link_Prova: '', // Vazio para entradas de horas
                Criado_Em: new Date(entry.createdAt).toLocaleString('pt-BR'),
                Criado_Por: entry.createdByName || 'N/A'
            });
        });

        // Provas
        (intern.dates || []).forEach(prova => {
            allEntries.push({
                Tipo_Registro: 'Folga-Prova',
                Estagiario_Nome: intern.name,
                Estagiario_ID: intern.id,
                Data: prova.date,
                Detalhe: 'Folga-Prova Agendada',
                Horas: '8,00', // Padrão de 8 horas para folga-prova, formatado
                Compensado: 'N/A',
                Motivo_Razao: 'Folga para realização de prova',
                Link_Prova: prova.link || 'N/A',
                Criado_Em: 'N/A', // Data de criação da prova não é facilmente rastreável aqui, exceto pelo Audit Log
                Criado_Por: 'N/A'
            });
        });
    });

    if (allEntries.length === 0) {
        return '';
    }

    // Ordena por Estagiário e Data
    allEntries.sort((a, b) => {
        if (a.Estagiario_Nome !== b.Estagiario_Nome) {
            return a.Estagiario_Nome.localeCompare(b.Estagiario_Nome);
        }
        return a.Data.localeCompare(b.Data);
    });

    // 2. Geração do CSV
    const headers = Object.keys(allEntries[0]);
    const csvRows = [];
    
    // Adiciona o cabeçalho
    csvRows.push(headers.join(';'));
    
    // Adiciona as linhas de dados
    for (const row of allEntries) {
        const values = headers.map(header => {
            const value = row[header];
            // Envolve o valor em aspas se contiver ponto e vírgula, quebras de linha ou aspas
            let safeValue = String(value || '').replace(/"/g, '""'); // Escapa aspas duplas
            if (safeValue.includes(';') || safeValue.includes('\n') || safeValue.includes('\r') || safeValue.includes('"')) {
                safeValue = `"${safeValue}"`;
            }
            return safeValue;
        });
        csvRows.push(values.join(';'));
    }

    // Junta todas as linhas com quebra de linha
    return csvRows.join('\n');
}


// NOVO: Função para o Modal de Backup
function showBackupModal(){
    // Restrição de acesso ao modal caso seja chamado por fora do menu lateral
    const currentUser = (state.users || []).find(u => u.id === session.userId);
    if (currentUser.role !== 'super') {
        alert('Acesso negado. Somente o Administrador Principal pode gerenciar o Backup.');
        return;
    }
    
    const html = `
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h3>Opções de Backup (Exportar/Importar)</h3>
          <button id="closeBackupModal" class="button ghost">Fechar</button>
        </div>
        <div style="margin-top: 15px; display: flex; flex-direction: column; gap: 15px;">
          
          <div class="card" style="padding: 15px;">
            <h4>1. EXPORTAR Backup</h4>
            <div class="muted small">Cria um arquivo com todos os dados (usuários, horas, provas, etc.).</div>
            <div style="display:flex; gap: 10px; margin-top: 10px;">
                <button id="btnDownloadAllJson" class="button">Exportar todos (.JSON)</button>
                <button id="btnDownloadAllCsv" class="button alt">Exportar (CSV)</button>
            </div>
          </div>
          
          <div class="card" style="padding: 15px;">
            <h4>2. CARREGAR Backup </h4>
            <div class="muted small">Carrega um arquivo .json. **Isso irá sobrescrever todos os dados atuais no sistema!** Use com cautela.</div>
            <button id="btnImportTrigger" class="button danger" style="margin-top: 10px;">Importar (.json)</button>
          </div>
          
        </div>
    `;
    
    const m = showModal(html, { allowBackdropClose: true });
    
    m.modal.querySelector('#closeBackupModal').addEventListener('click', () => { m.close(); m.cleanup(); });
    
    // Adiciona evento para Exportar JSON
    m.modal.querySelector('#btnDownloadAllJson').addEventListener('click', () => {
        downloadBlob(JSON.stringify(state,null,2), 'backup_provas_all.json', 'application/json');
        m.close();
        m.cleanup();
    });
    
    // Adiciona evento para Exportar CSV (NOVO)
    m.modal.querySelector('#btnDownloadAllCsv').addEventListener('click', () => {
        const csvData = generateCsvData();
        if (csvData) {
             // O CSV deve ser utf-8 com BOM para que acentuações funcionem no Excel
            const bom = '\ufeff'; // Byte Order Mark
            downloadBlob(bom + csvData, `relatorio_provas_horas_${nowISO()}.csv`, 'text/csv;charset=utf-8;');
        } else {
            alert('Nenhum dado de estagiário para exportar.');
        }
        m.close();
        m.cleanup();
    });
    
    // Adiciona evento para Importar (clica no input de arquivo escondido)
    m.modal.querySelector('#btnImportTrigger').addEventListener('click', () => {
        if(confirm('ATENÇÃO: A importação de um backup irá SUBSTITUIR TODOS OS DADOS ATUAIS. Deseja continuar?')){
            document.getElementById('fileMgmt').click();
            m.close();
            m.cleanup();
        }
    });
}

// NOVO: Função para Importar dados do arquivo
async function importDataFromFile(file) {
    const r = new FileReader();
    r.onload = async e => {
        try {
            const parsed = JSON.parse(e.target.result);
            // Validação mínima da estrutura do arquivo
            if (!parsed.users || !parsed.interns || typeof parsed.meta === 'undefined') {
                throw new Error('Formato do arquivo de backup inválido.');
            }
            
            // Aplica valores padrão para meta se não existirem
            parsed.meta = parsed.meta || {};
            if (typeof parsed.meta.provaBlockDays === 'undefined') parsed.meta.provaBlockDays = 0;
            if (typeof parsed.meta.trashRetentionDays === 'undefined') parsed.meta.trashRetentionDays = 10;
            
            state = parsed;
            await save(state);
            alert('Importação de backup concluída com sucesso! Os novos dados foram carregados.');
            render(); // Renderiza com o novo estado
        } catch (err) {
            console.error(err);
            alert('Erro ao importar o backup: ' + err.message);
        }
    };
    r.readAsText(file);
}

// NOVO: Variável global para armazenar dados importados em lote
let importedUserData = [];

// NOVO: Função para o Modal de Importação em Lote (Excel)
function showBulkImportModal(){
    const html = `
        <div style="display:flex;justify-content:space-between;align-items:center">
            <div>
                <h3>CRIAR USUÁRIOS EM LOTE (ESTAGIÁRIO)</h3>
                <div class="muted small">Carregue um arquivo Excel/CSV com os dados dos estagiários a serem criados.</div>
            </div>
            <button id="closeBulkImport" class="button ghost">Cancelar</button>
        </div>
        <div class="card" style="margin-top:10px; padding: 15px; background: var(--input-bg); border: 1px dashed var(--input-border);">
            <h4>Formato da Planilha:</h4>
            <div class="muted small">A planilha deve conter 4 colunas na primeira aba, com a primeira linha sendo o cabeçalho:</div>
            <ul style="list-style-type: disc; padding-left: 20px; font-size: 14px;">
                <li><strong>Coluna A: Nome completo</strong></li>
                <li><strong>Coluna B: Usuário</strong> (Matrícula, ex: e710021)</li>
                <li><strong>Coluna C: Senha</strong> (Se vazia, será 'senha123')</li>
                <li><strong>Coluna D: Permitir alteração de senha (Sim/Não)</strong></li>
            </ul>
            <div class="form-check" style="margin-top: 10px;">
                <input type="checkbox" id="userTypeBulk" checked disabled />
                <label for="userTypeBulk" style="font-weight: 600;">Cargo: Estagiário (Fixo)</label>
            </div>
        </div>

        <div style="display:flex; gap: 10px; margin-top: 15px; align-items:center;">
            <button id="btnTriggerFile" class="button alt" style="min-width: 150px;">Carregar Planilha (.xlsx/.csv)</button>
            <span id="fileNameDisplay" class="small-muted" style="flex-grow: 1;">Nenhum arquivo carregado.</span>
        </div>
        
        <div id="bulkStatus" style="margin-top: 15px;"></div>

        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top: 15px;">
            <button id="btnCreateInBatch" class="button" disabled>Criar em Lote (0 usuários)</button>
        </div>
    `;
    const m = showModal(html, { allowBackdropClose: true });
    
    const btnTriggerFile = m.modal.querySelector('#btnTriggerFile');
    const btnCreateInBatch = m.modal.querySelector('#btnCreateInBatch');
    const fileNameDisplay = m.modal.querySelector('#fileNameDisplay');
    const bulkStatus = m.modal.querySelector('#bulkStatus');
    const fileInput = document.getElementById('fileBulkImport');
    
    // Zera o estado para um novo uso do modal
    importedUserData = [];
    btnCreateInBatch.textContent = 'Criar em Lote (0 usuários)';
    btnCreateInBatch.disabled = true;
    fileInput.value = null; // Limpa o input file

    m.modal.querySelector('#closeBulkImport').addEventListener('click', () => { m.close(); m.cleanup(); });
    
    // 1. Abre o seletor de arquivo
    btnTriggerFile.addEventListener('click', () => fileInput.click());

    // 2. Processa o arquivo carregado
    fileInput.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;

        fileNameDisplay.textContent = `Arquivo: ${file.name}`;
        
        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                // É obrigatório que a biblioteca XLSX esteja incluída no index.html
                if (typeof XLSX === 'undefined') {
                    throw new Error('A biblioteca SheetJS (xlsx.js) não foi carregada no index.html.');
                }
                
                const data = new Uint8Array(event.target.result);
                // Usa SheetJS para ler o arquivo como ArrayBuffer
                const workbook = XLSX.read(data, { type: 'array' });
                const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
                
                // Converte para Array de Arrays, ignorando o cabeçalho (header: 1)
                const sheetData = XLSX.utils.sheet_to_json(firstSheet, { header: 1, raw: false });
                
                // Valida e armazena os dados
                importedUserData = validateExcelData(sheetData);

                const validCount = importedUserData.length;
                bulkStatus.innerHTML = `<div class="chip" style="background:${validCount > 0 ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)'}; color:${validCount > 0 ? 'var(--ok)' : 'var(--danger)'};">Pronto para criação: <strong>${validCount}</strong> estagiário(s) válido(s)</div>`;
                
                btnCreateInBatch.textContent = `Criar em Lote (${validCount} usuários)`;
                btnCreateInBatch.disabled = validCount === 0;

            } catch (error) {
                bulkStatus.innerHTML = `<div class="chip" style="background:rgba(239,68,68,0.1); color:var(--danger);">Erro ao processar planilha: ${error.message}</div>`;
                importedUserData = [];
                btnCreateInBatch.textContent = 'Criar em Lote (0 usuários)';
                btnCreateInBatch.disabled = true;
            }
        };
        reader.readAsArrayBuffer(file);
    };

    // 3. Cria os usuários em lote
    btnCreateInBatch.onclick = async () => {
        if (importedUserData.length === 0) return alert('Nenhum dado válido para criar.');
        
        if (!confirm(`Deseja realmente criar ${importedUserData.length} novos estagiários?`)) return;
        
        const totalToCreate = importedUserData.length;
        let createdCount = 0;
        const manager = (state.users || []).find(u=>u.id===session.userId);
        const creationDate = timestamp();

        for (const userData of importedUserData) {
            const internId = uuid();
            const userId = uuid();
            
            // Cria o estagiário
            (state.interns || []).push({ 
                id: internId, 
                name: userData.name, 
                dates: [], 
                hoursEntries: [], 
                auditLog: [] 
            });
            
            // Cria o usuário
            (state.users || []).push({ 
                id: userId, 
                username: userData.username, 
                name: userData.name, 
                password: userData.password, 
                role:'intern', 
                internId: internId, 
                powers: defaultPowersFor('intern'), 
                selfPasswordChange: userData.allowSelfPwd, 
                createdAt: creationDate 
            });
            
            // Registra no log do criador
            manager.auditLog = manager.auditLog || [];
            manager.auditLog.push({ id: uuid(), action:'bulk_create_intern', byUserId: manager.id, byUserName: manager.username, at: creationDate, details: `Criou estagiário ${userData.name} (${userData.username}) via lote` });

            createdCount++;
        }
        
        await save(state);
        alert(`Criação em lote concluída! ${createdCount} de ${totalToCreate} estagiários criados com sucesso.`);
        m.close(); 
        m.cleanup(); 
        render(); // Recarrega o painel de gestão para exibir os novos usuários
    };

}

/**
 * NOVO: Valida os dados da planilha e formata.
 * @param {Array<Array<string>>} sheetData - Dados lidos do SheetJS (array de arrays).
 * @returns {Array<Object>} Array de objetos de usuário válidos.
 */
function validateExcelData(sheetData) {
    const validUsers = [];
    const existingUsernames = new Set((state.users || []).map(u => u.username.toLowerCase()));
    
    // Ignora a primeira linha (cabeçalho)
    const dataRows = sheetData.slice(1); 
    
    if (dataRows.length === 0) throw new Error('A planilha não contém dados de usuários.');

    // Colunas: A=0 (Nome), B=1 (Usuário/Matrícula), C=2 (Senha), D=3 (Permitir Senha)
    dataRows.forEach((row, index) => {
        // Ignora linhas vazias
        if (!row || row.filter(cell => String(cell).trim() !== '').length === 0) return; 

        const name = String(row[0] || '').trim();
        const username = String(row[1] || '').trim().toLowerCase();
        const password = String(row[2] || '').trim() || 'senha123';
        const allowSelfPwdText = String(row[3] || '').trim().toLowerCase();
        
        // Coluna D: 'Sim' ou 'Não'. Qualquer outra coisa é tratada como 'Não' (false)
        const allowSelfPwd = allowSelfPwdText === 'sim';
        
        const isMatriculaValid = /^e\d{6}$/.test(username);

        // Validação mínima
        if (!name) {
            console.warn(`Linha ${index + 2} ignorada: Nome completo vazio.`);
            return;
        }
        if (!username) {
            console.warn(`Linha ${index + 2} ignorada: Usuário/Matrícula vazio.`);
            return;
        }
        if (!isMatriculaValid) {
             console.warn(`Linha ${index + 2} ignorada: Usuário/Matrícula "${username}" inválido (formato esperado: e123456).`);
            return;
        }
        if (existingUsernames.has(username)) {
            console.warn(`Linha ${index + 2} ignorada: Usuário "${username}" já existe no sistema.`);
            return;
        }

        validUsers.push({
            name: name,
            username: username,
            password: password,
            allowSelfPwd: allowSelfPwd
        });
        
        existingUsernames.add(username); // Adiciona para evitar duplicatas dentro do mesmo lote
    });

    return validUsers;
}


// Novo: Função para renderizar a lista de pré-cadastros pendentes
function renderPendingList(){
  const list = document.getElementById('pendingList');
  if (!list) return;
  list.innerHTML = '';
  
  const pending = (state.pendingRegistrations || []).filter(r => r.status !== 'rejected');
  if (pending.length === 0) {
    list.innerHTML = '<div class="muted">Nenhum pré-cadastro pendente.</div>';
    return;
  }

  pending.forEach(reg => {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <div>
        <div style="font-weight:700">${escapeHtml(reg.name)}</div>
        <div class="muted small">Usuário: ${escapeHtml(reg.username)}</div>
        <div class="muted small">Solicitado em: ${new Date(reg.createdAt).toLocaleString()}</div>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="button" data-approve-id="${reg.id}">Aprovar</button>
        <button class="button danger" data-reject-id="${reg.id}">Recusar</button>
      </div>
    `;
    list.appendChild(row);

    // Event listeners para aprovar e recusar
    row.querySelector(`[data-approve-id="${reg.id}"]`).addEventListener('click', async () => approveRegistration(reg.id));
    row.querySelector(`[data-reject-id="${reg.id}"]`).addEventListener('click', async () => rejectRegistration(reg.id));
  });
}

// Novo: Funções de aprovação e recusa de pré-cadastro
async function approveRegistration(regId){
  const reg = (state.pendingRegistrations || []).find(r => r.id === regId);
  if (!reg) return;

  const internId = uuid();
  (state.interns || []).push({ id: internId, name: reg.name, dates: [], hoursEntries: [], auditLog: [] });
  (state.users || []).push({ id: uuid(), username: reg.username, name: reg.name, password: reg.password, role:'intern', internId: internId, powers: defaultPowersFor('intern'), selfPasswordChange: true, createdAt: timestamp() });

  state.pendingRegistrations = (state.pendingRegistrations || []).filter(r => r.id !== regId);
  
  await save(state);
  alert('Pré-cadastro aprovado! Usuário criado com sucesso.');
  render();
}

async function rejectRegistration(regId){
  if (!confirm('Tem certeza que deseja recusar este pré-cadastro? Ele será movido para a lixeira.')) return;

  const reg = (state.pendingRegistrations || []).find(r => r.id === regId);
  if (!reg) return;
  
  reg.status = 'rejected';
  reg.rejectedAt = timestamp();

  (state.trash || []).push(reg);
  state.pendingRegistrations = (state.pendingRegistrations || []).filter(r => r.id !== regId);
  
  await save(state);
  alert('Pré-cadastro recusado e movido para a lixeira.');
  render();
}

// Novo: Funções para a lixeira
function renderTrashList(){
  const list = document.getElementById('trashList');
  if(!list) return;
  list.innerHTML = '';
  
  if ((state.trash || []).length === 0) {
    list.innerHTML = '<div class="muted">A lixeira está vazia.</div>';
    return;
  }
  
  const now = new Date();
  const retentionDays = (state.meta || {}).trashRetentionDays;
  (state.trash || []).forEach(item => {
    const deletedDate = new Date(item.deletedAt || item.rejectedAt);
    const daysLeft = Math.max(0, retentionDays - Math.ceil((now - deletedDate) / (1000 * 60 * 60 * 24)));
    
    const row = document.createElement('div');
    row.className = 'trash-item-row';
    const typeLabel = item.type === 'user' ? 'Usuário Excluído' : 'Pré-cadastro Rejeitado';
    
    row.innerHTML = `
      <input type="checkbox" data-id="${item.id}" />
      <div class="trash-item-details">
        <div style="font-weight:700">${escapeHtml(item.internName || item.name || item.username)}</div>
        <div class="muted small">${typeLabel} • Usuário: ${escapeHtml(item.username)}</div>
        <div class="muted small">Removido em: ${deletedDate.toLocaleString()}</div>
        <div class="muted small">Será excluído em ${daysLeft} dia(s)</div>
      </div>
    `;
    list.appendChild(row);
  });
}

async function emptyTrash() {
  if ((state.trash || []).length === 0) {
    alert('A lixeira já está vazia.');
    return;
  }
  if (!confirm('Tem certeza que deseja esvaziar a lixeira? Todos os itens serão excluídos permanentemente.')) return;
  state.trash = [];
  await save(state);
  alert('Lixeira esvaziada.');
  renderTrashList();
}

async function restoreAllTrash(){
  if ((state.trash || []).length === 0) {
    alert('A lixeira está vazia.');
    return;
  }
  if (!confirm('Tem certeza que deseja restaurar todos os itens da lixeira?')) return;
  
  (state.trash || []).forEach(item => {
    if (item.type === 'user') {
      const user = (state.users || []).find(u => u.id === item.userId);
      if (!user) {
        (state.users || []).push({ 
          id: item.userId, 
          username: item.username, 
          password: 'senha123', // Senha padrão para restaurar
          role: item.role, 
          internId: item.internId,
          powers: defaultPowersFor(item.role),
          selfPasswordChange: true,
          createdAt: item.createdAt || timestamp()
        });
        if (item.internId) {
          (state.interns || []).push({ 
            id: item.internId, 
            name: item.internName,
            dates: [], 
            hoursEntries: [], 
            auditLog: [] 
          });
        }
      }
    } else { // type === 'pre-registration'
      (state.pendingRegistrations || []).push({ ...item, status: 'pending' });
    }
  });
  
  state.trash = [];
  await save(state);
  alert('Todos os itens restaurados.');
  render();
}

async function restoreSelectedTrash(){
  const checkboxes = document.querySelectorAll('#trashList input[type="checkbox"]:checked');
  if (checkboxes.length === 0) {
    alert('Selecione pelo menos um item para restaurar.');
    return;
  }
  if (!confirm(`Tem certeza que deseja restaurar os ${checkboxes.length} itens selecionados?`)) return;

  const idsToRestore = Array.from(checkboxes).map(cb => cb.dataset.id);
  const itemsToRestore = (state.trash || []).filter(item => idsToRestore.includes(item.id));
  
  itemsToRestore.forEach(item => {
    if (item.type === 'user') {
      const user = (state.users || []).find(u => u.id === item.userId);
      if (!user) {
        (state.users || []).push({ 
          id: item.userId, 
          username: item.username, 
          password: 'senha123', // Senha padrão para restaurar
          role: item.role, 
          internId: item.internId,
          powers: defaultPowersFor(item.role),
          selfPasswordChange: true,
          createdAt: item.createdAt || timestamp()
        });
        if (item.internId) {
          (state.interns || []).push({ 
            id: item.internId, 
            name: item.internName,
            dates: [], 
            hoursEntries: [], 
            auditLog: [] 
          });
        }
      }
    } else { // type === 'pre-registration'
      (state.pendingRegistrations || []).push({ ...item, status: 'pending' });
    }
  });

  state.trash = (state.trash || []).filter(item => !idsToRestore.includes(item.id));
  await save(state);
  alert('Itens selecionados restaurados.');
  render();
}

// Lógica para remover cadastros recusados com mais de 10 dias
async function cleanupRejectedRegistrations() {
  const now = new Date();
  const retentionDays = (state.meta || {}).trashRetentionDays;
  state.trash = (state.trash || []).filter(reg => {
    const deletedDate = new Date(reg.deletedAt || reg.rejectedAt);
    const diffDays = Math.ceil((now - deletedDate) / (1000 * 60 * 60 * 24));
    return diffDays <= retentionDays;
  });
  await save(state);
}

// Esta função agora inicia a aplicação
initApp();


function renderProvasSection() {
    const listSection = document.getElementById('provasListSection');
    const calendarSection = document.getElementById('provasCalendarSection');
    const toggleListBtn = document.getElementById('toggleProvasListView');
    const toggleCalendarBtn = document.getElementById('toggleProvasCalendarView');
    
    // Clear previous event listeners to prevent duplicates
    const newToggleListBtn = toggleListBtn.cloneNode(true);
    const newToggleCalendarBtn = toggleCalendarBtn.cloneNode(true);
    toggleListBtn.replaceWith(newToggleListBtn);
    toggleCalendarBtn.replaceWith(newToggleCalendarBtn);
    
    if (adminProvasView === 'list') {
        listSection.style.display = 'block';
        calendarSection.style.display = 'none';
        newToggleListBtn.className = 'button';
        newToggleCalendarBtn.className = 'button ghost';

        const filterDateInput = document.getElementById('mgrFilterDate');
        if (filterDateInput && !filterDateInput.value) {
            filterDateInput.value = nowISO();
        }
        filterAndRenderProvas();
        document.getElementById('btnApplyFilter').addEventListener('click', () => filterAndRenderProvas());
        document.getElementById('btnClearDateFilter').addEventListener('click', () => {
            document.getElementById('mgrFilterDate').value = '';
            document.getElementById('provasResults').innerHTML = '';
        });
    } else { // 'calendar' view
        listSection.style.display = 'none';
        calendarSection.style.display = 'block';
        newToggleListBtn.className = 'button ghost';
        newToggleCalendarBtn.className = 'button';
        renderAdminProvasCalendar();
    }
    
    newToggleListBtn.addEventListener('click', () => {
      adminProvasView = 'list';
      renderProvasSection();
    });
    
    newToggleCalendarBtn.addEventListener('click', () => {
      adminProvasView = 'calendar';
      renderProvasSection();
    });
}

let adminCalendarViewing = new Date();

function renderAdminProvasCalendar() {
  const wrap = document.getElementById('adminCalendarWrap');
  const monthStart = new Date(adminCalendarViewing.getFullYear(), adminCalendarViewing.getMonth(), 1);
  const label = monthStart.toLocaleString('pt-BR',{month:'long', year:'numeric'});
  wrap.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <div><strong>Calendário de Folgas-prova</strong></div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="button ghost" id="prevAdminMonth">&lt;</button>
        <div class="small-muted" id="adminMonthLabel">${label}</div>
        <button class="button ghost" id="nextAdminMonth">&gt;</button>
      </div>
    </div>
    <div class="calendar" style="grid-template-columns:repeat(7,1fr);font-weight:700;color:var(--muted)">
      <div>Dom</div><div>Seg</div><div>Ter</div><div>Qua</div><div>Qui</div><div>Sex</div><div>Sáb</div>
    </div>
    <div id="adminMonthGrid" class="calendar" style="margin-top:10px"></div>
  `;
  const grid = document.getElementById('adminMonthGrid');
  grid.innerHTML = '';
  const firstDay = new Date(adminCalendarViewing.getFullYear(), adminCalendarViewing.getMonth(), 1).getDay();
  const daysInMonth = new Date(adminCalendarViewing.getFullYear(), adminCalendarViewing.getMonth()+1, 0).getDate();

  for(let i=0;i<firstDay;i++){
    const blank = document.createElement('div'); blank.className='day'; blank.style.visibility='hidden'; blank.innerHTML='&nbsp;'; grid.appendChild(blank);
  }
  
  const provasByDate = {};
  (state.interns || []).forEach(intern => {
    (intern.dates || []).forEach(p => {
      if (!provasByDate[p.date]) {
        provasByDate[p.date] = [];
      }
      provasByDate[p.date].push(intern);
    });
  });

  for(let d=1; d<=daysInMonth; d++){
    const date = new Date(adminCalendarViewing.getFullYear(), adminCalendarViewing.getMonth(), d);
    const iso = date.toISOString().slice(0,10);
    const dayEl = document.createElement('div'); dayEl.className='day';
    dayEl.innerHTML = `<div class="date">${d}</div>`;
    
    if (provasByDate[iso] && provasByDate[iso].length > 0) {
        const count = provasByDate[iso].length;
        const countEl = document.createElement('div');
        countEl.className = 'tag bank';
        countEl.textContent = `${count} estagiário(s)`;
        countEl.style.cursor = 'pointer';
        dayEl.appendChild(countEl);
        dayEl.addEventListener('click', () => showProvasDayDetails(iso, provasByDate[iso]));
    } else {
        dayEl.addEventListener('click', () => showProvasDayDetails(iso, []));
    }
    
    grid.appendChild(dayEl);
  }

  document.getElementById('prevAdminMonth').addEventListener('click', ()=>{
    adminCalendarViewing.setMonth(adminCalendarViewing.getMonth()-1);
    renderAdminProvasCalendar();
  });
  document.getElementById('nextAdminMonth').addEventListener('click', ()=>{
    adminCalendarViewing.setMonth(adminCalendarViewing.getMonth()+1);
    renderAdminProvasCalendar();
  });
}

function showProvasDayDetails(iso, interns) {
    const htmlParts = [];
    htmlParts.push(`<div style="display:flex;justify-content:space-between;align-items:center"><h3>Folgas-prova — ${iso}</h3><button id="closeProvasDetails" class="button ghost">Fechar</button></div>`);
    htmlParts.push('<div style="margin-top:8px">');
    
    if (interns.length === 0) {
        htmlParts.push('<div class="muted small">Nenhuma folga-prova marcada para esta data.</div>');
    } else {
        interns.forEach(intern => {
            const prova = (intern.dates || []).find(p => p.date === iso);
            const linkIcon = prova && prova.link ? `<a href="${prova.link}" target="_blank" class="button ghost" style="margin-left: 8px;">Ver prova</a>` : '';
            htmlParts.push(`<div class="row"><div><strong>${escapeHtml(intern.name)}</strong><div class="muted small">${intern.id}</div></div><div>${linkIcon}</div></div>`);
        });
    }
    
    htmlParts.push('</div>');

    const m = showModal(htmlParts.join(''), { allowBackdropClose: true });
    m.modal.querySelector('#closeProvasDetails').addEventListener('click', () => { m.close(); m.cleanup(); });
}

// ----------------- renderUsersList (esquerda) -----------------
// NOVO: Função para atualizar o estado do botão de exclusão em lote
function updateBulkDeleteButtonState() {
    const selectedCount = document.querySelectorAll('#usersList .user-row-selectable input[type="checkbox"]:checked').length;
    const button = document.getElementById('btnDeleteSelectedUsers');
    const currentUser = (state.users || []).find(u => u.id === session.userId);
    const canDelete = hasPower(currentUser, 'delete_user');
    
    if (button) {
        button.textContent = `Excluir selecionados (${selectedCount})`;
        // Habilita o botão se houver itens selecionados E o usuário tiver permissão
        button.disabled = selectedCount === 0 || !canDelete; 
        if (!canDelete) {
            button.title = 'Você não tem permissão para excluir usuários.';
        } else if (selectedCount === 0) {
            button.title = 'Selecione pelo menos um perfil.';
        } else {
            button.title = '';
        }
    }
}

// NOVO: Função principal de exclusão em lote
async function deleteSelectedUsers() {
    const checkboxes = document.querySelectorAll('#usersList .user-row-selectable input[type="checkbox"]:checked');
    const idsToDelete = Array.from(checkboxes).map(cb => cb.dataset.userId);
    const currentUser = (state.users || []).find(u => u.id === session.userId);
    
    if (idsToDelete.length === 0) {
        return alert('Selecione pelo menos um perfil para excluir.');
    }
    
    if (!hasPower(currentUser, 'delete_user')) {
        return alert('Você não tem permissão para excluir usuários.');
    }
    
    // Evita a exclusão do Super Admin, caso ele esteja listado e selecionado.
    const superAdmin = (state.users || []).find(u => u.role === 'super');
    const finalIdsToDelete = idsToDelete.filter(id => id !== superAdmin.id);
    
    if (finalIdsToDelete.length !== idsToDelete.length) {
        alert('Atenção: O Administrador Principal não pode ser excluído.');
    }
    
    if (finalIdsToDelete.length === 0) {
        return; // Não há nada para excluir após a filtragem
    }
    
    if (!confirm(`Tem certeza que deseja mover ${finalIdsToDelete.length} perfil(is) para a lixeira? Todos os dados associados serão perdidos.`)) {
        return;
    }

    const deletedAt = timestamp();
    const manager = currentUser;
    
    // 1. Processa e move para a lixeira
    const usersToProcess = (state.users || []).filter(u => finalIdsToDelete.includes(u.id));
    
    for (const userToDelete of usersToProcess) {
        userToDelete.status = 'deleted';
        userToDelete.deletedAt = deletedAt;
        
        const internData = userToDelete.internId ? findInternById(userToDelete.internId) : null;
        
        // Adiciona à lixeira
        (state.trash || []).push({
            id: uuid(),
            type: 'user',
            userId: userToDelete.id,
            username: userToDelete.username,
            role: userToDelete.role,
            internId: userToDelete.internId,
            internName: internData ? internData.name : null,
            deletedAt: userToDelete.deletedAt,
            createdAt: userToDelete.createdAt || timestamp()
        });
        
        // Adiciona ao log de auditoria
        manager.auditLog = manager.auditLog || [];
        manager.auditLog.push({ 
            id: uuid(), 
            action:'bulk_delete_user', 
            byUserId: manager.id, 
            byUserName: manager.username, 
            at: deletedAt, 
            details: `Excluiu em lote o usuário ${userToDelete.username}` 
        });
    }

    // 2. Remove do estado ativo
    state.users = (state.users || []).filter(u => !finalIdsToDelete.includes(u.id));
    state.interns = (state.interns || []).filter(i => {
        const user = usersToProcess.find(u => u.internId === i.id);
        return !user; // Remove se o estagiário pertencia a um usuário excluído
    });
    
    await save(state);
    alert(`${finalIdsToDelete.length} perfil(is) movido(s) para a lixeira com sucesso.`);
    render(); // Recarrega o painel
}


function renderUsersList(){
  const q = document.getElementById('searchMgmt').value.trim().toLowerCase();
  const container = document.getElementById('usersList'); container.innerHTML='';
  let list = (state.users || []).slice();
  
  // 1. Aplicar Filtro de Cargo
  if (userFilter === 'intern') {
      list = list.filter(u => u.role === 'intern');
  } else if (userFilter === 'admin') {
      list = list.filter(u => u.role === 'admin' || u.role === 'super');
  }
  
  // 2. Aplicar Filtro de Pesquisa
  if(q) list = list.filter(u => (u.username||'').toLowerCase().includes(q) || (u.name||'').toLowerCase().includes(q) || (u.internId && findInternById(u.internId)?.name.toLowerCase().includes(q)) || (u.id||'').toLowerCase().includes(q));
  
  document.getElementById('totalUsers').textContent = list.length;
  
  // 3. Organização por Ordem Alfabética (Nome do Estagiário, depois Usuário)
  list.sort((a,b)=> {
    const aName = a.role === 'intern' ? (findInternById(a.internId)?.name || a.name || a.username) : (a.name || a.username);
    const bName = b.role === 'intern' ? (findInternById(b.internId)?.name || b.name || b.username) : (b.name || b.username);
    
    // Tenta ordenar pelo nome (Estagiários/Admin) ou usuário
    const nameCompare = aName.localeCompare(bName, 'pt-BR', { sensitivity: 'base' });
    if (nameCompare !== 0) return nameCompare;

    // Se os nomes forem iguais, ordena pelo cargo (Admin > Estagiário)
    return a.role.localeCompare(b.role);
  });
  
  const currentUser = (state.users || []).find(u => u.id === session.userId);
  const canDelete = hasPower(currentUser, 'delete_user');

  list.forEach(u=>{
    const row = document.createElement('div'); 
    row.className = 'row user-row-selectable'; // NOVO: Adiciona classe para estilização e seleção
    
    let displayName;
    let roleText = u.role;
    
    if (u.role === 'intern') {
        const internName = findInternById(u.internId)?.name || '';
        displayName = `${escapeHtml(internName)} (${escapeHtml(u.username)})`;
        roleText = 'estagiário(a)';
    } else {
        const name = u.name || u.username; 
        displayName = `${escapeHtml(name)} (${escapeHtml(u.username)})`;
    }
    
    const createdDate = formatDate(u.createdAt);
    const roleAndDateDisplay = `${roleText} (${createdDate})`;
    
    // NOVO: Verifica se o usuário é o Super Admin
    const isSuperAdmin = u.role === 'super';
    
    // 1. Checkbox
    const checkboxHtml = canDelete && !isSuperAdmin
        ? `<input type="checkbox" data-user-id="${u.id}" class="user-select-checkbox" />`
        : (isSuperAdmin ? `<div class="icon-placeholder" title="Administrador Principal não pode ser excluído">👑</div>` : '<div class="icon-placeholder"></div>'); // Placeholder para alinhar
        
    // 2. Detalhes (Left)
    const left = document.createElement('div'); 
    left.innerHTML = `<div style="font-weight:700">${displayName}</div><div class="muted small">${roleAndDateDisplay}</div>`;
    
    // 3. Ações (Right)
    const right = document.createElement('div');
    right.style.display = 'flex';
    right.style.gap = '8px';

    const btnView = document.createElement('button'); btnView.className='button ghost'; btnView.textContent='Abrir'; btnView.addEventListener('click', ()=> openUserManagerView(u.id));
    const btnEdit = document.createElement('button'); btnEdit.className='button'; btnEdit.textContent='Editar'; btnEdit.addEventListener('click', ()=> showEditUserForm(u.id));
    right.appendChild(btnView); 
    right.appendChild(btnEdit);
    
    // Monta a linha: Checkbox | Detalhes | Ações
    row.innerHTML = checkboxHtml;
    row.appendChild(left);
    row.appendChild(right);
    container.appendChild(row);
    
    // Adiciona listener ao checkbox
    const checkbox = row.querySelector('.user-select-checkbox');
    if (checkbox) {
        checkbox.addEventListener('change', updateBulkDeleteButtonState);
    }
  });
  
  // NOVO: Garante que o estado do botão de exclusão seja atualizado após a renderização
  updateBulkDeleteButtonState();
}

// ----------------- renderReports() -----------------
function renderReports(){
  const area = document.getElementById('reportsArea');
  if (!area) return;
  area.innerHTML = '';

  const computed = (state.interns || []).map(i=>{
    const totalBank = ((i.hoursEntries) || []).filter(e=>e.hours>0).reduce((s,e)=>s+e.hours,0);
    const totalNeg = ((i.hoursEntries) || []).filter(e=>e.hours<0 && !e.compensated).reduce((s,e)=>s + Math.abs(e.hours),0);
    const net = totalBank - totalNeg;
    return { id: i.id, name: i.name, bank: totalBank, neg: totalNeg, net };
  });

  const negatives = computed.filter(x => x.net < 0).sort((a,b)=> Math.abs(b.net) - Math.abs(a.net)); 
  const banks = computed.filter(x => x.net > 0).sort((a,b)=> b.net - a.net);

  const negHtml = `<div style="margin-top:8px"><h4>Horas negativas (saldo líquido)</h4>${negatives.length===0?'<div class="muted small">Nenhum</div>': negatives.map(n=>{
    return `<div class="row"><div><strong>${escapeHtml(n.name)}</strong><div class="small-muted">${n.id}</div></div><div><span class="badge" style="background:rgba(239,68,68,0.08);color:var(--danger)">${Math.abs(n.net)}h</span></div></div>`;
  }).join('')}</div>`;

  const bankHtml = `<div style="margin-top:12px"><h4>Banco de horas (saldo líquido)</h4>${banks.length===0?'<div class="muted small">Nenhum</div>': banks.map(n=>{
    return `<div class="row"><div><strong>${escapeHtml(n.name)}</strong><div class="small-muted">${n.id}</div></div><div><span class="badge" style="background:rgba(154,205,154,0.12);color:var(--accent-2)">${n.net}h</span></div></div>`;
  }).join('')}</div>`;

  area.innerHTML = negHtml + bankHtml;
}


// ----------------- Remaining manager helpers -----------------
function openUserManagerView(userId){
  const u = (state.users || []).find(x=>x.id===userId); if(!u) return;
  const area = document.getElementById('mgrResults'); if(!area) return;
  area.innerHTML = '';
  const card = document.createElement('div'); card.className='card';
  const intern = u.internId ? findInternById(u.internId) : null;
  
  // Variável para controlar se o botão de exclusão deve ser mostrado/habilitado
  const canDelete = u.role !== 'super';

  let html = `
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div>
        <h3>${escapeHtml(u.username)} ${u.role === 'intern' ? '• ' + escapeHtml(intern?.name || '') : ''}</h3>
        <div class="muted small">ID: ${u.id}</div>
      </div>
      <div>
        <button class="button ghost" id="btnCloseView">Fechar</button>
      </div>
    </div>
    <div style="margin-top:8px">
      <div class="small-muted">Cargo: ${u.role === 'intern' ? 'estagiário(a)' : u.role}</div>
      <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
        <button id="btnResetPwd" class="button ghost">Alterar/Resetar senha</button>
        <button id="btnManageDates" ${u.role!=='intern' ? 'disabled' : ''} class="button ghost">Gerenciar folgas-prova</button>
        <button id="btnManageHours" ${u.role!=='intern' ? 'disabled' : ''} class="button ghost">Gerenciar horas</button>
        
        ${canDelete ? `<button id="btnDeleteUser" class="button danger">Excluir usuário</button>` : `<button class="button danger" disabled title="Não é possível excluir o administrador principal (super)">Excluir usuário</button>`}
      </div>
    </div>
    <div id="mgrUserBody" style="margin-top:10px"></div>
  `;
  card.innerHTML = html;
  area.appendChild(card);

  document.getElementById('btnCloseView').addEventListener('click', ()=> renderManager((state.users || []).find(u=>u.id===session.userId)));
  document.getElementById('btnResetPwd').addEventListener('click', async ()=> {
    const currentManager = (state.users || []).find(uu=>uu.id===session.userId);
    if(!hasPower(currentManager, 'reset_password')) return alert('Você não tem permissão para resetar senhas.');
    const np = prompt(`Defina nova senha para ${u.username} (vazio cancela)`);
    if(!np) return;
    u.password = np;
    await save(state);
    alert('Senha alterada.');
  });
  document.getElementById('btnManageDates').addEventListener('click', ()=> {
    if(u.role!=='intern') return;
    openInternManagerView(u.internId);
  });
  document.getElementById('btnManageHours').addEventListener('click', ()=> {
    if(u.role!=='intern') return;
    openInternHoursView(u.internId);
  });
  
  // Adiciona o listener APENAS se o botão estiver visível (ou seja, se não for 'super')
  if (canDelete) {
    document.getElementById('btnDeleteUser').addEventListener('click', async ()=> {
      const mgr = (state.users || []).find(uu=>uu.id===session.userId);
      if(!hasPower(mgr, 'delete_user')) return alert('Você não tem permissão para excluir usuários.');
      if(!confirm('Excluir este usuário e (se houver) estagiário associado? Esta ação moverá o usuário para a lixeira.')) return;
      
      // Mover para a lixeira
      const userToDelete = (state.users || []).find(x => x.id === userId);
      if (userToDelete) {
        userToDelete.status = 'deleted';
        userToDelete.deletedAt = timestamp();
        
        const internData = userToDelete.internId ? findInternById(userToDelete.internId) : null;
        
        (state.trash || []).push({
          id: uuid(),
          type: 'user',
          userId: userToDelete.id,
          username: userToDelete.username,
          role: userToDelete.role,
          internId: userToDelete.internId,
          internName: internData ? internData.name : null,
          deletedAt: userToDelete.deletedAt,
          createdAt: userToDelete.createdAt || timestamp()
        });
        
        state.users = (state.users || []).filter(x => x.id !== userId);
        if (userToDelete.internId) {
          state.interns = (state.interns || []).filter(i => i.id !== userToDelete.internId);
        }
        
        await save(state);
        alert('Usuário movido para a lixeira.');
        render();
      }
    });
  }
}

function openInternManagerView(internId){
  const intern = findInternById(internId); if(!intern) return;
  const area = document.getElementById('mgrResults'); if(!area) return;
  area.innerHTML = '';
  const card = document.createElement('div'); card.className='card';
  // Encontra o usuário associado para saber qual ID voltar
  const user = findUserByIntern(intern.id);
  
  card.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div>
        <h3>${escapeHtml(intern.name)}</h3>
        <div class="muted small">ID: ${intern.id}</div>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="button ghost" id="btnBackToUser">Voltar</button>
        <button class="button ghost" id="btnCloseViewIntern">Fechar</button>
      </div>
    </div>
    <div style="margin-top:8px;display:flex;gap:8px;align-items:center">
      <input type="date" id="mgrAddDate" />
      <input type="text" id="mgrAddLink" class="input" placeholder="Link da prova" />
      <button id="mgrAddDateBtn" class="button">Adicionar folga-prova</button>
    </div>
    <div id="mgrDates" style="margin-top:10px"></div>

    <div style="margin-top:12px">
      <h4>Log de ações</h4>
      <div id="mgrAudit" class="muted small"></div>
    </div>
  `;
  area.appendChild(card);
  
  // Botão para fechar tudo e voltar para o painel de gestão principal
  document.getElementById('btnCloseViewIntern').addEventListener('click', ()=> renderManager((state.users || []).find(u=>u.id===session.userId)));
  
  // NOVO: Botão para voltar à visualização do usuário específico
  if(user) {
    document.getElementById('btnBackToUser').addEventListener('click', ()=> openUserManagerView(user.id));
  }
  
  document.getElementById('mgrAddDateBtn').addEventListener('click', async ()=>{ 
    const d = document.getElementById('mgrAddDate').value;
    const link = document.getElementById('mgrAddLink').value;
    if(!d) return alert('Escolha uma data'); 
    
    const currentManager = (state.users || []).find(u=>u.id===session.userId);
    if(!hasPower(currentManager, 'manage_provas')) return alert('Sem permissão para gerenciar folgas-prova.');

    // CORREÇÃO APLICADA: Garante que `intern.dates` é um array e adiciona a nova data.
    if(!((intern.dates || []).some(p => p.date === d))) {
      intern.dates = intern.dates || [];
      intern.dates.push({ date: d, link: link });
    }
    
    const manager = (state.users || []).find(u=>u.id===session.userId);
    intern.auditLog = intern.auditLog || [];
    intern.auditLog.push({ id: uuid(), action:'create_prova', byUserId: manager.id, byUserName: manager.username, at: timestamp(), details: `Criou folga-prova ${d}` });
    await save(state);
    openInternManagerView(intern.id); 
    renderUsersList(); 
  });
  renderMgrDates(intern);
  const auditEl = document.getElementById('mgrAudit'); const auditArr = ((intern.auditLog) || []).slice().sort((a,b)=> b.at.localeCompare(a.at));
  if(auditArr.length===0) auditEl.innerHTML = 'Nenhuma ação administrativa registrada';
  else auditEl.innerHTML = auditArr.map(a=>`${new Date(a.at).toLocaleString()} — ${escapeHtml(a.byUserName)} — ${escapeHtml(a.action)} — ${escapeHtml(a.details||'')}`).join('<br/>');
}

function renderMgrDates(intern){
  const el = document.getElementById('mgrDates'); el.innerHTML='';
  if(!intern.dates || intern.dates.length===0){ el.innerHTML='<div class="muted">Nenhuma folga-prova cadastrada</div>'; return; }
  (intern.dates || []).slice().sort((a,b) => a.date.localeCompare(b.date)).forEach(p=>{
    const row = document.createElement('div'); row.className='row';
    const left = document.createElement('div'); 
    left.innerHTML = `<div style="font-weight:700">${p.date}</div><div class="muted small">Data da folga-prova</div>`;
    
    const right = document.createElement('div'); 
    right.style.display = 'flex';
    right.style.gap = '8px';
    
    const currentUser = (state.users || []).find(u=>u.id===session.userId);

    if(p.link) {
      const btnLink = document.createElement('a'); 
      btnLink.className = 'button ghost'; 
      // Não temos ícones aqui, então apenas o texto 'Link'
      btnLink.textContent = `Link`;
      btnLink.href = p.link;
      btnLink.target = '_blank';
      btnLink.style.textDecoration = 'none';
      right.appendChild(btnLink);
    }
    
    if(hasPower(currentUser, 'manage_provas')){
        const btnDel = document.createElement('button'); btnDel.className='button ghost'; btnDel.textContent='Remover'; btnDel.addEventListener('click', async ()=>{ 
          if(confirm('Remover folga-prova '+p.date+'?')){ 
            intern.dates = (intern.dates || []).filter(x=>x.date!==p.date); 
            const manager = (state.users || []).find(u=>u.id===session.userId); 
            intern.auditLog = intern.auditLog || []; 
            intern.auditLog.push({ id: uuid(), action:'remove_prova', byUserId: manager.id, byUserName: manager.username, at: timestamp(), details: `Removida folga-prova ${p.date}` }); 
            await save(state); 
            render(); 
          }});
        right.appendChild(btnDel);
    }
    
    row.appendChild(left); row.appendChild(right); el.appendChild(row);
  });
}

function openInternHoursView(internId){
  const intern = findInternById(internId); if(!intern) return;
  const area = document.getElementById('mgrResults'); if(!area) return;
  area.innerHTML = '';
  const card = document.createElement('div'); card.className='card';
  // Encontra o usuário associado para saber qual ID voltar
  const user = findUserByIntern(intern.id);
  
  card.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div>
        <h3>Horas — ${escapeHtml(intern.name)}</h3>
        <div class="muted small">Lançamentos e compensações.</div>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="button ghost" id="btnBackToUser">Voltar (Usuário)</button>
        <button class="button ghost" id="btnCloseHours">Fechar</button>
      </div>
    </div>
    <div style="margin-top:10px;display:flex;gap:8px;align-items:center">
      <button id="btnAddHoursAdmin" class="button">Lançar horas (admin)</button>
    </div>
    <div id="mgrHoursList" style="margin-top:10px"></div>
  `;
  area.appendChild(card);
  
  // Botão para fechar tudo e voltar para o painel de gestão principal
  document.getElementById('btnCloseHours').addEventListener('click', ()=> renderManager((state.users || []).find(u=>u.id===session.userId)));
  
  // NOVO: Botão para voltar à visualização do usuário específico
  if(user) {
    document.getElementById('btnBackToUser').addEventListener('click', ()=> openUserManagerView(user.id));
  }
  
  document.getElementById('btnAddHoursAdmin').addEventListener('click', ()=> showHourEntryForm(intern.id));
  renderMgrHoursList(intern);
}

function renderMgrHoursList(intern){
  const el = document.getElementById('mgrHoursList'); el.innerHTML='';
  const arr = ((intern.hoursEntries) || []).slice().sort((a,b)=> b.date.localeCompare(a.date));
  if(arr.length===0){ el.innerHTML='<div class="muted">Nenhum lançamento</div>'; return; }
  arr.forEach(e=>{
    const row = document.createElement('div'); row.className='row';
    const currentUser = (state.users || []).find(u => u.id === session.userId);
    
    // Agrupamento de botões de ação (editar, excluir)
    const actionButtons = hasPower(currentUser, 'manage_hours')
      ? `<div style="display:flex;gap:6px">
        <button class="button ghost" data-edit="${e.id}">Editar</button>
        <button class="button" data-delete="${e.id}">Excluir</button>
      </div>`
      : '';

    // Botão de compensação (se aplicável)
    const compensationButton = e.hours < 0 && hasPower(currentUser, 'manage_hours')
      ? (e.compensated
        ? `<button class="button ghost" data-uncomp="${e.id}">Desfazer comp.</button>`
        : `<button class="button" data-comp="${e.id}">Marcar comp.</button>`)
      : '';

    row.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;width:100%">
        <div>
          <div style="font-weight:700">${e.date} • ${e.hours>0?'+':''}${e.hours}h ${e.type==='bank' ? '(Banco)' : '(Negativa)'} ${e.compensated ? '• Compensado' : ''}</div>
          <div class="muted small" style="margin-top:4px">${escapeHtml(e.reason||'Sem justificativa')}</div>
          <div class="audit" style="margin-top:6px">Criado por: ${escapeHtml(e.createdByName||'—')} em ${e.createdAt? new Date(e.createdAt).toLocaleString() : ''}${e.lastModifiedBy ? ' • Alterado por: '+escapeHtml(e.lastModifiedBy) : ''}${e.compensatedBy ? ' • Compensado por: '+escapeHtml(e.compensatedBy)+' em '+(e.compensatedAt? new Date(e.compensatedAt).toLocaleString(): '') : ''}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${actionButtons}
          ${compensationButton}
        </div>
      </div>
    `;

    el.appendChild(row);

    // Adiciona event listeners para os novos botões
    if(hasPower(currentUser,'manage_hours')){
        row.querySelector('[data-edit]').addEventListener('click', ()=> showHourEntryForm(intern.id, e.id));
        row.querySelector('[data-delete]').addEventListener('click', async ()=> {
          if(confirm('Excluir lançamento?')){
            const manager = (state.users || []).find(u=>u.id===session.userId);
            intern.auditLog = intern.auditLog || [];
            intern.auditLog.push({ id: uuid(), action:'delete_entry', byUserId: manager.id, byUserName: manager.username, at: timestamp(), details: `Excluído lançamento ${e.id} (${e.hours}h ${e.type})` });
            intern.hoursEntries = (intern.hoursEntries || []).filter(x=>x.id!==e.id);
            await save(state);
            render();
          }
        });
        if(e.hours < 0) {
          const compBtn = row.querySelector('[data-comp]') || row.querySelector('[data-uncomp]');
          if(compBtn){
            compBtn.addEventListener('click', async ()=> {
              await markCompensated(intern.id, e.id, !e.compensated);
              const manager = (state.users || []).find(u=>u.id===session.userId);
              intern.auditLog = intern.auditLog || [];
              intern.auditLog.push({ id: uuid(), action: e.compensated ? 'uncompensated' : 'compensated', byUserId: manager.id, byUserName: manager.username, at: timestamp(), details: `${e.compensated ? 'Desfez compensação' : 'Compensou'} lançamento ${e.id}` });
              await save(state);
              render();
            });
          }
        }
    }
  });
}


// ----------------- User creation / edit forms (modals) -----------------
function showCreateUserForm(currentManager){
  if(!hasPower(currentManager,'create_intern') && currentManager.role!=='super') return alert('Sem permissão');
  const html = `
    <div style="display:flex;justify-content:space-between;align-items:center"><h3>Criar usuário</h3><button id="closeC" class="button ghost">Fechar</button></div>
    <form id="formCreate" style="margin-top:10px;display:flex;flex-direction:column;gap:10px">
      <label><span class="small-muted">Tipo</span><select id="newType"><option value="intern">Estagiário</option><option value="admin">Admin secundário</option></select></label>
      <label id="labelNewName"><span class="small-muted">Nome completo (se estagiário/admin)</span><input id="newName" /></label>
      <label><span class="small-muted">Usuário (login/matrícula)</span><input id="newUser" required/></label>
      <label style="position:relative;"><span class="small-muted">Senha</span>
        <input id="newPass" type="password" value="senha123" style="padding-right: 36px;"/>
        <span class="password-toggle-icon" id="toggleNewPass">🔒</span>
      </label>
      <label class="form-check"><input type="checkbox" id="allowSelfPwd" checked/> Permitir alteração de senha pelo próprio usuário</label>
      <div id="adminPowers" style="display:none">
        <div class="small-muted" style="margin-bottom: 8px;">Poderes do admin</div>
        <div class="form-check-group">
          <label class="form-check"><input type="checkbox" id="p_create"/> Criar estagiários</label>
          <label class="form-check"><input type="checkbox" id="p_edit"/> Editar usuários</label>
          <label class="form-check"><input type="checkbox" id="p_delete"/> Excluir usuários</label>
          <label class="form-check"><input type="checkbox" id="p_reset"/> Resetar senhas</label>
          <label class="form-check"><input type="checkbox" id="p_manage"/> Gerenciar horas</label>
          <label class="form-check"><input type="checkbox" id="p_provas"/> Gerenciar folgas-prova</label>
          <label class="form-check"><input type="checkbox" id="p_delegate" ${currentManager.role !== 'super' ? 'disabled' : ''}/> Delegar admins (só super pode marcar)</label>
        </div>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button type="submit" class="button">Criar</button>
      </div>
    </form>
  `;
  const m = showModal(html);
  const modal = m.modal;
  modal.querySelector('#closeC').addEventListener('click', ()=> { m.close(); m.cleanup(); });
  
  const labelNewName = modal.querySelector('#labelNewName');
  const newNameInput = modal.querySelector('#newName');
  
  // Lógica para mostrar/esconder o campo Nome completo
  modal.querySelector('#newType').addEventListener('change', (e)=> {
    const isIntern = e.target.value === 'intern';
    modal.querySelector('#adminPowers').style.display = isIntern ? 'none' : 'block';
    
    // Ajusta o texto do label para refletir se é obrigatório ou não
    labelNewName.querySelector('.small-muted').textContent = `Nome completo (${isIntern ? 'se estagiário' : 'se admin'})`;
    
    // Deixa o campo nome obrigatório para admins e estagiários
    newNameInput.required = true;

    // Garante que a delegação de admins só pode ser marcada pelo super
    modal.querySelector('#p_delegate').disabled = currentManager.role !== 'super';
    
    // Preenche os poderes padrão ao trocar para admin
    if (!isIntern) {
        const defaultAdminPowers = defaultPowersFor('admin');
        modal.querySelector('#p_create').checked = defaultAdminPowers.create_intern;
        modal.querySelector('#p_edit').checked = defaultAdminPowers.edit_user;
        modal.querySelector('#p_delete').checked = defaultAdminPowers.delete_user;
        modal.querySelector('#p_reset').checked = defaultAdminPowers.reset_password;
        modal.querySelector('#p_manage').checked = defaultAdminPowers.manage_hours;
        modal.querySelector('#p_provas').checked = defaultAdminPowers.manage_provas;
        // Delegar só pode ser true se for super e estiver criando outro super/admin
        modal.querySelector('#p_delegate').checked = false;
    }
  });

  const toggleNewPass = modal.querySelector('#toggleNewPass');
  const newPass = modal.querySelector('#newPass');
  toggleNewPass.style.position = 'absolute';
  toggleNewPass.style.right = '10px';
  toggleNewPass.style.top = '50%';
  toggleNewPass.style.transform = 'translateY(-50%)';
  toggleNewPass.style.cursor = 'pointer';
  toggleNewPass.addEventListener('click', () => {
      const type = newPass.getAttribute('type') === 'password' ? 'text' : 'password';
      newPass.setAttribute('type', type);
      toggleNewPass.textContent = type === 'password' ? '🔒️' : '🔓';
  });

  modal.querySelector('#formCreate').addEventListener('submit', async (ev)=> {
    ev.preventDefault();
    const type = modal.querySelector('#newType').value;
    const name = modal.querySelector('#newName').value.trim();
    const uname = modal.querySelector('#newUser').value.trim();
    
    if(!name) return alert('Nome completo obrigatório.');
    if(!uname) return alert('Usuário obrigatório');
    
    const pass = modal.querySelector('#newPass').value || 'senha123';
    const allowSelf = !!modal.querySelector('#allowSelfPwd').checked;
    
    // Novo: Captura a data de criação
    const creationDate = timestamp();
    
    if(type==='intern'){
      const id = uuid();
      (state.interns || []).push({ id, name, dates: [], hoursEntries: [], auditLog: [] });
      (state.users || []).push({ id: uuid(), username: uname, name: name, password: pass, role:'intern', internId: id, powers: defaultPowersFor('intern'), selfPasswordChange: !!allowSelf, createdAt: creationDate });
      await save(state); alert('Estagiário criado'); m.close(); m.cleanup(); render();
    } else { // admin
      const p_create = modal.querySelector('#p_create').checked;
      const p_edit = modal.querySelector('#p_edit').checked;
      const p_delete = modal.querySelector('#p_delete').checked;
      const p_reset = modal.querySelector('#p_reset').checked;
      const p_manage = modal.querySelector('#p_manage').checked;
      const p_provas = modal.querySelector('#p_provas').checked;
      const p_delegate = modal.querySelector('#p_delegate').checked && currentManager.role==='super';
      const powers = { create_intern: p_create, edit_user: p_edit, delete_user: p_delete, reset_password: p_reset, manage_hours: p_manage, manage_provas: p_provas, delegate_admins: p_delegate };
      
      // Admin não tem internId
      (state.users || []).push({ id: uuid(), username: uname, name: name, password: pass, role:'admin', powers, selfPasswordChange: true, createdAt: creationDate });
      await save(state); alert('Admin criado'); m.close(); m.cleanup(); render();
    }
  });
  
  // Chama o change listener para configurar o estado inicial (admin powers)
  modal.querySelector('#newType').dispatchEvent(new Event('change'));
}

function showEditUserForm(userId){
  const u = (state.users || []).find(x=>x.id===userId); if(!u) return;
  const currentManager = (state.users || []).find(uu=>uu.id===session.userId);
  if(u.id !== currentManager.id && !hasPower(currentManager,'edit_user')) return alert('Sem permissão');
  
  // Se o usuário logado não for super, e estiver editando outro super, não permite
  if (u.role === 'super' && currentManager.role !== 'super') {
     return alert('Somente o Administrador Principal pode editar as informações do Super Administrador.');
  }
  
  const intern = u.internId ? findInternById(u.internId) : null;
  const isIntern = u.role === 'intern';
  const isEditingAdmin = !isIntern;
  // Apenas o SUPER pode editar poderes de outros admins, e admins podem editar o próprio nome/login/senha
  const canEditPowers = currentManager.role === 'super' && isEditingAdmin;
  
  // Estrutura de Poderes para Admins/Super
  let powersHtml = '';
  if (isEditingAdmin) {
      powersHtml = `
        <div id="adminPowersEdit" style="margin-top:15px; border-top: 1px solid var(--muted); padding-top: 10px;">
          <div class="small-muted" style="margin-bottom: 8px;">Poderes do Admin (Editável pelo Super)</div>
          <div class="form-check-group">
            <label class="form-check"><input type="checkbox" id="p_create_edit" ${u.powers.create_intern ? 'checked' : ''} ${canEditPowers ? '' : 'disabled'}/> Criar estagiários</label>
            <label class="form-check"><input type="checkbox" id="p_edit_edit" ${u.powers.edit_user ? 'checked' : ''} ${canEditPowers ? '' : 'disabled'}/> Editar usuários</label>
            <label class="form-check"><input type="checkbox" id="p_delete_edit" ${u.powers.delete_user ? 'checked' : ''} ${canEditPowers ? '' : 'disabled'}/> Excluir usuários</label>
            <label class="form-check"><input type="checkbox" id="p_reset_edit" ${u.powers.reset_password ? 'checked' : ''} ${canEditPowers ? '' : 'disabled'}/> Resetar senhas</label>
            <label class="form-check"><input type="checkbox" id="p_manage_edit" ${u.powers.manage_hours ? 'checked' : ''} ${canEditPowers ? '' : 'disabled'}/> Gerenciar horas</label>
            <label class="form-check"><input type="checkbox" id="p_provas_edit" ${u.powers.manage_provas ? 'checked' : ''} ${canEditPowers ? '' : 'disabled'}/> Gerenciar folgas-prova</label>
            <label class="form-check"><input type="checkbox" id="p_delegate_edit" ${u.powers.delegate_admins ? 'checked' : ''} ${currentManager.role === 'super' && u.role !== 'super' ? '' : 'disabled'}/> Delegar admins (só super pode marcar)</label>
          </div>
        </div>
      `;
  }
  
  const html = `
    <div style="display:flex;justify-content:space-between;align-items:center"><h3>Editar usuário</h3><button id="closeE" class="button ghost">Fechar</button></div>
    <form id="formEdit" style="margin-top:10px;display:flex;flex-direction:column;gap:10px">
      <label><span class="small-muted">Nome completo</span><input id="editName" value="${escapeHtml(isIntern ? intern?.name || '' : u.name || '')}" required/></label>
      <label><span class="small-muted">Usuário (login/matrícula)</span><input id="editUser" value="${escapeHtml(u.username)}" required/></label>
      <label><input type="checkbox" id="editAllowSelf" ${u.selfPasswordChange ? 'checked' : ''}/> Permitir alteração de senha pelo próprio usuário</label>
      
      ${powersHtml}
      
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button type="submit" class="button">Salvar</button>
      </div>
    </form>
  `;
  const m = showModal(html);
  const modal = m.modal;
  modal.querySelector('#closeE').addEventListener('click', ()=> { m.close(); m.cleanup(); });
  
  modal.querySelector('#formEdit').addEventListener('submit', async (ev)=> {
    ev.preventDefault();
    
    const newName = modal.querySelector('#editName').value.trim();
    const newUsername = modal.querySelector('#editUser').value.trim();
    
    if(!newName || !newUsername) return alert('Nome e Usuário são obrigatórios');
    
    u.username = newUsername || u.username;
    u.name = newName; // Atualiza o nome para admin e intern (no objeto user)
    
    if(isIntern && intern){
      intern.name = newName; // Atualiza o nome na lista de estagiários
    }
    
    u.selfPasswordChange = !!modal.querySelector('#editAllowSelf').checked;
    
    // Atualiza os poderes se for um admin e o usuário logado for super
    if (canEditPowers) {
        u.powers.create_intern = !!modal.querySelector('#p_create_edit').checked;
        u.powers.edit_user = !!modal.querySelector('#p_edit_edit').checked;
        u.powers.delete_user = !!modal.querySelector('#p_delete_edit').checked;
        u.powers.reset_password = !!modal.querySelector('#p_reset_edit').checked;
        u.powers.manage_hours = !!modal.querySelector('#p_manage_edit').checked;
        u.powers.manage_provas = !!modal.querySelector('#p_provas_edit').checked;
        // A permissão de delegar só pode ser marcada pelo SUPER, e só vale para admins (não super)
        if (currentManager.role === 'super' && u.role === 'admin') {
            u.powers.delegate_admins = !!modal.querySelector('#p_delegate_edit').checked;
        }
    }
    
    await save(state);
    alert('Atualizado');
    m.close();
    m.cleanup();
    render();
  });
}

// ----------------- Filters -----------------
function filterAndRenderProvas(){
  const date = document.getElementById('mgrFilterDate').value;
  const area = document.getElementById('provasResults'); if(!area) return;
  area.innerHTML='';
  if(!date){ area.innerHTML = '<div class="muted">Escolha uma data para filtrar</div>'; return; }
  
  const matched = (state.interns || []).filter(i=> (i.dates || []).some(p => p.date === date) );
  if(matched.length===0){ area.innerHTML = '<div class="muted">Nenhum estagiário com folga-prova nesta data</div>'; return; }
  
  matched.sort((a,b)=>a.name.localeCompare(b.name,'pt-BR')).forEach(it=>{
    const row = document.createElement('div'); row.className='row';
    
    // Encontra a prova específica para a data
    const prova = (it.dates || []).find(p => p.date === date);

    const left = document.createElement('div'); 
    left.innerHTML = `<div style="font-weight:700">${escapeHtml(it.name)}</div><div class="muted small">ID: ${it.id}</div>`;
    
    const right = document.createElement('div');
    right.style.display = 'flex';
    right.style.gap = '8px';

    if (prova && prova.link) {
      const btnLink = document.createElement('a');
      btnLink.className = 'button';
      // Não temos ícones aqui, então apenas o texto 'Link'
      btnLink.textContent = `Link`;
      btnLink.href = prova.link;
      btnLink.target = '_blank';
      right.appendChild(btnLink);
    }
    
    const btnView = document.createElement('button'); 
    btnView.className='button ghost'; 
    btnView.textContent='Abrir'; 
    btnView.addEventListener('click', ()=> openInternManagerView(it.id));
    right.appendChild(btnView);
    
    row.appendChild(left); 
    row.appendChild(right); 
    area.appendChild(row);
  });
}

// ----------------- Name search dropdown (independente) -----------------
function renderNameDropdown(q){
  const dropdown = document.getElementById('mgrNameDropdown');
  if(!dropdown) return;
  dropdown.innerHTML = '';
  if(!q || q.length < 1){ dropdown.style.display = 'none'; return; }
  const matches = (state.interns || []).filter(i => i.name.toLowerCase().includes(q)).slice(0,50);
  if(matches.length === 0){ dropdown.style.display = 'none'; return; }
  matches.forEach(it => {
    const item = document.createElement('div');
    item.className = 'dropdown-item';
    item.style.padding = '8px';
    item.style.cursor = 'pointer';
    item.innerHTML = `<div style="font-weight:700">${escapeHtml(it.name)}</div><div class="muted small">${it.id}</div>`;
    item.addEventListener('click', ()=> {
      document.getElementById('mgrNameDropdown').style.display = 'none';
      document.getElementById('mgrNameSearch').value = '';
      openInternManagerView(it.id);
    });
    dropdown.appendChild(item);
  });
  dropdown.style.display = 'block';
}
