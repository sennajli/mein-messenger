
// MeinMessenger v4.0 – All bugs fixed + Complete Redesign
// ── STATE ───────────────────────────────────────────────────
let accessCode = localStorage.getItem('jm_access') || null; // FIX: persist
let authToken  = localStorage.getItem('jm_token');
let myUsername = localStorage.getItem('jm_user');
let myAvatar   = localStorage.getItem('jm_avatar') || '';
let mySettings = JSON.parse(localStorage.getItem('jm_settings') || '{"darkMode":true}');
let myBio='', mySocials={}, myStatusMsg='', myStatusEmoji='🟢';
let contacts=[], groups_list=[], localMessages={};
let activeChatId=null, socket=null;
let typingTimeout=null, isTypingNow=false, typingMap={};
let pendingFRs=[], currentImageData=null, profileViewUsername=null;
let peerConn=null, localStream=null, screenStream=null;
let callPartner=null, isCallInitiator=false, isVideoCall=false;
let micOn=true, camOn=true, pendingOffer=null;
const iceServers={iceServers:[{urls:'stun:stun.l.google.com:19302'}]};

// ── HELPERS ─────────────────────────────────────────────────
async function post(url,body){return fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function fmtTime(ts){const d=new Date(ts),now=new Date();if(d.toDateString()===now.toDateString())return d.toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'});return d.toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit'});}
function shake(id){const el=document.getElementById(id);if(!el)return;el.style.animation='none';el.offsetHeight;el.style.animation='shake .4s ease';}
function openModal(id){document.getElementById(id).classList.add('active');}
function closeModal(id){document.getElementById(id).classList.remove('active');}
document.addEventListener('click',e=>{if(e.target.classList.contains('modal-overlay'))e.target.classList.remove('active');});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){document.querySelectorAll('.modal-overlay.active').forEach(m=>m.classList.remove('active'));closeSettings();}});

// ── SCREENS ─────────────────────────────────────────────────
function showScreen(id){
  document.querySelectorAll('.screen').forEach(el=>{el.style.display='none';el.classList.remove('active');});
  const el=document.getElementById(id);if(el){el.style.display='flex';el.classList.add('active');}
}

// ── THEME ───────────────────────────────────────────────────
function applyTheme(dark){document.documentElement.setAttribute('data-theme',dark?'dark':'light');const t=document.getElementById('dark-toggle');if(t)t.classList.toggle('on',dark);}
applyTheme(mySettings.darkMode!==false);
function toggleDark(){mySettings.darkMode=!mySettings.darkMode;applyTheme(mySettings.darkMode);localStorage.setItem('jm_settings',JSON.stringify(mySettings));if(authToken)post('/api/settings',{token:authToken,settings:mySettings});}

// ── INIT ────────────────────────────────────────────────────
window.addEventListener('load',()=>{
  initStatusEmojis();initEmojiPicker();
  if(authToken&&myUsername){enterApp();}
  else if(accessCode){showScreen('screen-auth');}
  else{showScreen('screen-access');}
  setupKeyboard();
});

// ── ACCESS ──────────────────────────────────────────────────
async function submitAccess(){
  const code=document.getElementById('access-input').value.trim();
  const err=document.getElementById('access-err');err.textContent='';
  if(!code){err.textContent='[ FEHLER ] Geheimwort eingeben.';return;}
  const res=await fetch('/api/check-access',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});
  const d=await res.json();
  if(d.ok){
    accessCode=code;
    localStorage.setItem('jm_access',code); // FIX: persist access code
    showScreen('screen-auth');
  }else{err.textContent='[ FEHLER ] Falsches Geheimwort.';shake('access-input');}
}
function goBackAccess(){showScreen('screen-access');}

// ── AUTH ────────────────────────────────────────────────────
let authMode='login';
function switchTab(m){
  authMode=m;
  document.getElementById('tab-login').classList.toggle('active',m==='login');
  document.getElementById('tab-reg').classList.toggle('active',m==='register');
  document.getElementById('auth-btn').textContent=m==='login'?'Anmelden':'Konto erstellen';
  document.getElementById('auth-err').textContent='';
}
async function submitAuth(){
  const user=document.getElementById('auth-user').value.trim();
  const pass=document.getElementById('auth-pass').value;
  const err=document.getElementById('auth-err');err.textContent='';
  if(!user||!pass){err.textContent='[ FEHLER ] Alle Felder ausfüllen.';return;}
  if(!accessCode){err.textContent='[ FEHLER ] Sitzung abgelaufen.';setTimeout(()=>showScreen('screen-access'),1500);return;}
  const res=await post(authMode==='login'?'/api/login':'/api/register',{code:accessCode,username:user,password:pass});
  const d=await res.json();
  if(!res.ok){err.textContent='[ FEHLER ] '+d.error;shake('auth-pass');return;}
  authToken=d.token;myUsername=d.username;myAvatar=d.avatar||'';
  myBio=d.bio||'';mySocials=d.socials||{};myStatusMsg=d.statusMessage||'';myStatusEmoji=d.statusEmoji||'🟢';
  mySettings={darkMode:true,...(d.settings||{})};
  localStorage.setItem('jm_token',authToken);localStorage.setItem('jm_user',myUsername);
  localStorage.setItem('jm_avatar',myAvatar);localStorage.setItem('jm_settings',JSON.stringify(mySettings));
  applyTheme(mySettings.darkMode!==false);enterApp();
}
function logout(){
  ['jm_token','jm_user','jm_avatar','jm_settings'].forEach(k=>localStorage.removeItem(k));
  authToken=null;myUsername=null;location.reload();
}

// ── ENTER APP ───────────────────────────────────────────────
async function enterApp(){
  showScreen('screen-app');updateSidebarProfile();updateSettingsUI();
  applyCustomTheme(); // App theme setup
  await Promise.all([loadContacts(),loadGroups(),loadFRs()]);
  renderList();connectSocket();
}
function updateSidebarProfile(){
  const av=document.getElementById('sidebar-avatar');
  if(av){if(myAvatar){av.innerHTML=`<img src="${myAvatar}"/>`;}else{av.textContent=(myUsername||'?').charAt(0).toUpperCase();}}
  const un=document.getElementById('sidebar-uname');if(un)un.textContent=myUsername||'—';
  const st=document.getElementById('sidebar-status');if(st)st.textContent=(myStatusEmoji||'🟢')+' '+(myStatusMsg||'Online');
}
async function loadContacts(){const r=await fetch('/api/contacts?token='+encodeURIComponent(authToken));if(!r.ok){logout();return;}contacts=(await r.json()).contacts||[];}
async function loadGroups(){const r=await fetch('/api/groups?token='+encodeURIComponent(authToken));if(!r.ok)return;groups_list=(await r.json()).groups||[];}
async function loadFRs(){const r=await fetch('/api/friends/requests?token='+encodeURIComponent(authToken));if(!r.ok)return;pendingFRs=(await r.json()).requests||[];updateFRBadge();}
function updateFRBadge(){const b=document.getElementById('fr-badge');const n=pendingFRs.length;b.textContent=n;b.style.display=n>0?'flex':'none';document.getElementById('fr-btn').style.animation=n>0?'ring 1s infinite':'none';}
