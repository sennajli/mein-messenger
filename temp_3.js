
// ── PROFILE VIEW ────────────────────────────────────────────
async function openProfileView(username){
  if(!username||username.startsWith('group:'))return; // FIX: guard group chats
  profileViewUsername=username;
  try{
    const res=await fetch(`/api/profile/${encodeURIComponent(username)}?token=${encodeURIComponent(authToken)}`);
    if(!res.ok){showToast('Profil nicht gefunden');return;}
    const p=await res.json();
    document.getElementById('pv-name').textContent=p.username;
    document.getElementById('pv-online').textContent=p.online?'🟢 Online':'⚫ Offline';
    document.getElementById('pv-status-emoji').textContent=p.statusEmoji||'🟢';
    document.getElementById('pv-bio').textContent=p.bio||'Keine Bio.';
    document.getElementById('pv-status-msg').textContent=p.statusMessage?'\u201e'+p.statusMessage+'\u201c':'';
    document.getElementById('pv-cover').style.background=p.online?'linear-gradient(135deg,#1a0a3e,#3b1a78,#7c3aed)':'linear-gradient(135deg,#0a0a1a,#1a1a2e,#2a1a4e)';
    const av=document.getElementById('pv-avatar');
    av.style.cssText='width:80px;height:80px;font-size:30px';
    av.innerHTML=p.avatar?`<img src="${p.avatar}" style="width:100%;height:100%;object-fit:cover"/>`:p.username.charAt(0).toUpperCase();
    const sl=document.getElementById('pv-socials');sl.innerHTML='';const sc=p.socials||{};
    if(sc.instagram)sl.innerHTML+=`<a class="social-link" href="https://instagram.com/${encodeURIComponent(sc.instagram)}" target="_blank"><div class="social-link-icon si-insta">📸</div>@${esc(sc.instagram)} auf Instagram</a>`;
    if(sc.tiktok)sl.innerHTML+=`<a class="social-link" href="https://tiktok.com/@${encodeURIComponent(sc.tiktok)}" target="_blank"><div class="social-link-icon si-tt">🎵</div>@${esc(sc.tiktok)} auf TikTok</a>`;
    if(sc.twitter)sl.innerHTML+=`<a class="social-link" href="https://x.com/${encodeURIComponent(sc.twitter)}" target="_blank"><div class="social-link-icon si-tw">🐦</div>@${esc(sc.twitter)} auf X/Twitter</a>`;
    if(!sc.instagram&&!sc.tiktok&&!sc.twitter)sl.innerHTML=`<div style="font-size:12px;color:var(--tx4)">Keine sozialen Medien verknüpft</div>`;
    openModal('modal-profile');
  }catch(e){showToast('Fehler beim Laden des Profils');}
}
function startChatFromProfile(){closeModal('modal-profile');if(profileViewUsername)openChat(profileViewUsername);}

// ── SETTINGS ────────────────────────────────────────────────
function openSettings(){document.getElementById('settings-panel').classList.add('active');document.getElementById('settings-overlay').style.display='block';updateSettingsUI();}
function closeSettings(){document.getElementById('settings-panel').classList.remove('active');document.getElementById('settings-overlay').style.display='none';}
function updateSettingsUI(){
  const av=document.getElementById('settings-avatar');if(!av)return;
  if(myAvatar){av.innerHTML=`<img src="${myAvatar}"/>`;}else{av.textContent=(myUsername||'?').charAt(0).toUpperCase();}
  document.getElementById('settings-uname').textContent=myUsername||'—';
  document.getElementById('settings-bio').value=myBio||'';
  document.getElementById('settings-status-msg').value=myStatusMsg||'';
  document.getElementById('settings-insta').value=mySocials?.instagram||'';
  document.getElementById('settings-tt').value=mySocials?.tiktok||'';
  document.getElementById('settings-tw').value=mySocials?.twitter||'';
  document.getElementById('dark-toggle')?.classList.toggle('on',mySettings.darkMode!==false);
  document.querySelectorAll('.emoji-pick:not(.color-pick)').forEach(b=>b.classList.toggle('active',b.dataset.emoji===myStatusEmoji));
  document.querySelectorAll('.color-pick').forEach(b=>b.classList.toggle('active',b.dataset.color===(mySettings.themeColor||'purple')));
  document.getElementById('wp-hint').textContent=mySettings.chatWallpaper?'Wallpaper aktiv':'Wallpaper hochladen';
  loadDevices();
}
async function loadDevices(){
  try{
    const devices=await navigator.mediaDevices.enumerateDevices();
    const mic=document.getElementById('settings-mic');
    const spk=document.getElementById('settings-speaker');
    mic.innerHTML='';spk.innerHTML='';
    devices.forEach(d=>{
      if(d.kind==='audioinput'){const o=document.createElement('option');o.value=d.deviceId;o.text=d.label||'Mikrofon '+(mic.length+1);mic.appendChild(o);}
      if(d.kind==='audiooutput'){const o=document.createElement('option');o.value=d.deviceId;o.text=d.label||'Lautsprecher '+(spk.length+1);spk.appendChild(o);}
    });
    if(mySettings.micId)mic.value=mySettings.micId;
    if(mySettings.speakerId)spk.value=mySettings.speakerId;
    
    mic.onchange=e=>{mySettings.micId=e.target.value;localStorage.setItem('jm_settings',JSON.stringify(mySettings));};
    spk.onchange=async e=>{
      mySettings.speakerId=e.target.value;
      localStorage.setItem('jm_settings',JSON.stringify(mySettings));
      const rv=document.getElementById('remote-video');
      if(rv&&typeof rv.setSinkId==='function')await rv.setSinkId(mySettings.speakerId);
    };
  }catch(e){console.error(e);}
}
const themes = {
  purple: {p:'#8b5cf6', pd:'#7c3aed', pll:'#c4b5fd', pglow:'rgba(139,92,246,0.35)', bmine:'linear-gradient(135deg,#8b5cf6,#7c3aed)'},
  blue: {p:'#3b82f6', pd:'#2563eb', pll:'#93c5fd', pglow:'rgba(59,130,246,0.35)', bmine:'linear-gradient(135deg,#3b82f6,#2563eb)'},
  emerald: {p:'#10b981', pd:'#059669', pll:'#6ee7b7', pglow:'rgba(16,185,129,0.35)', bmine:'linear-gradient(135deg,#10b981,#059669)'},
  pink: {p:'#ec4899', pd:'#db2777', pll:'#f9a8d4', pglow:'rgba(236,72,153,0.35)', bmine:'linear-gradient(135deg,#ec4899,#db2777)'},
  orange: {p:'#f97316', pd:'#ea580c', pll:'#fdba74', pglow:'rgba(249,115,22,0.35)', bmine:'linear-gradient(135deg,#f97316,#ea580c)'}
};
function applyCustomTheme() {
  const t = themes[mySettings.themeColor || 'purple'];
  if(t) {
    const root = document.documentElement;
    root.style.setProperty('--p', t.p);
    root.style.setProperty('--pd', t.pd);
    root.style.setProperty('--pll', t.pll);
    root.style.setProperty('--pglow', t.pglow);
    root.style.setProperty('--bmine', t.bmine);
  }
  const ca = document.getElementById('chat-area');
  if(ca) {
    if(mySettings.chatWallpaper) {
      ca.style.backgroundImage = `linear-gradient(var(--bg), var(--bg)), url(${mySettings.chatWallpaper})`;
      ca.style.backgroundSize = 'cover';
      ca.style.backgroundPosition = 'center';
      ca.style.backgroundBlendMode = 'overlay';
    } else {
      ca.style.backgroundImage = 'none';
    }
  }
}
function initStatusEmojis(){
  const emojis=['🟢','🔴','🟡','😴','🎮','💼','🚀','🏋️','🎵','🏖️'];
  const row=document.getElementById('emoji-status-row');if(!row)return;
  emojis.forEach(em=>{const b=document.createElement('button');b.className='emoji-pick';b.textContent=em;b.dataset.emoji=em;b.onclick=()=>{myStatusEmoji=em;document.querySelectorAll('.emoji-pick').forEach(x=>x.classList.toggle('active',x.dataset.emoji===em));};row.appendChild(b);});
  
  const themeRow = document.getElementById('theme-color-row');
  if(themeRow) {
    const btns = themeRow.querySelectorAll('.color-pick');
    btns.forEach(b => {
      b.onclick = () => {
        mySettings.themeColor = b.dataset.color;
        localStorage.setItem('jm_settings', JSON.stringify(mySettings));
        btns.forEach(x => x.classList.toggle('active', x.dataset.color === mySettings.themeColor));
        applyCustomTheme();
      };
    });
  }
}
function onWallpaperSelected(e) {
  const file=e.target.files[0];if(!file)return;
  const reader=new FileReader();
  reader.onload=ev=>{
    mySettings.chatWallpaper = ev.target.result;
    localStorage.setItem('jm_settings', JSON.stringify(mySettings));
    applyCustomTheme();
    document.getElementById('wp-hint').textContent = 'Wallpaper geladen';
  };
  reader.readAsDataURL(file);e.target.value='';
}
function removeWallpaper() {
  mySettings.chatWallpaper = null;
  localStorage.setItem('jm_settings', JSON.stringify(mySettings));
  applyCustomTheme();
  document.getElementById('wp-hint').textContent = 'Wallpaper hochladen';
}
async function onAvatarSelected(e){
  const file=e.target.files[0];if(!file)return;
  const reader=new FileReader();
  reader.onload=async ev=>{myAvatar=ev.target.result;localStorage.setItem('jm_avatar',myAvatar);updateSettingsUI();updateSidebarProfile();};
  reader.readAsDataURL(file);e.target.value='';
}
async function saveProfile(){
  myBio=document.getElementById('settings-bio').value;
  myStatusMsg=document.getElementById('settings-status-msg').value;
  mySocials={instagram:document.getElementById('settings-insta').value.replace('@',''),tiktok:document.getElementById('settings-tt').value.replace('@',''),twitter:document.getElementById('settings-tw').value.replace('@','')};
  const res=await post('/api/profile',{token:authToken,avatar:myAvatar,bio:myBio,socials:mySocials,statusMessage:myStatusMsg,statusEmoji:myStatusEmoji});
  if(res.ok){showToast('✓ Profil gespeichert!');updateSidebarProfile();closeSettings();}
  else showToast('⚠ Fehler beim Speichern.');
}

// ── FRIEND REQUESTS ─────────────────────────────────────────
function openAddFriend(){document.getElementById('add-friend-input').value='';document.getElementById('add-friend-err').textContent='';openModal('modal-add-friend');}
async function sendFriendReq(){
  const u=document.getElementById('add-friend-input').value.trim();const err=document.getElementById('add-friend-err');err.textContent='';
  if(!u){err.textContent='[ FEHLER ] Benutzername eingeben.';return;}
  const res=await post('/api/friends/request',{token:authToken,to:u});const d=await res.json();
  if(!res.ok){err.textContent='[ FEHLER ] '+d.error;return;}
  closeModal('modal-add-friend');showToast('✓ Anfrage gesendet!');
}
function openFRModal(){renderFRList();openModal('modal-fr');}
function renderFRList(){
  const list=document.getElementById('fr-list');list.innerHTML='';
  if(!pendingFRs.length){list.innerHTML=`<div style="color:var(--tx4);font-size:13px;padding:8px 0;text-align:center">Keine offenen Anfragen</div>`;return;}
  pendingFRs.forEach(r=>{
    const d=document.createElement('div');d.className='fr-item';
    d.innerHTML=`<div class="avatar">${r.from.charAt(0).toUpperCase()}</div><div class="fr-info"><strong>${esc(r.from)}</strong><small>${new Date(r.time).toLocaleString('de-DE')}</small></div><div class="fr-btns"><button class="fr-acc" onclick="respondFR('${r.id}',true)">✓ Annehmen</button><button class="fr-dec" onclick="respondFR('${r.id}',false)">✕</button></div>`;
    list.appendChild(d);
  });
}
async function respondFR(id,accept){
  const res=await post('/api/friends/respond',{token:authToken,requestId:id,accept});
  if(res.ok){pendingFRs=pendingFRs.filter(r=>r.id!==id);updateFRBadge();if(accept)await loadContacts();renderList();renderFRList();}
}

// ── GROUPS ──────────────────────────────────────────────────
let groupMembersSelected=[];
function openCreateGroup(){groupMembersSelected=[];document.getElementById('group-name-in').value='';document.getElementById('group-err').textContent='';renderGroupMemberSelect();openModal('modal-group');}
function renderGroupMemberSelect(){
  document.getElementById('group-chips').innerHTML=groupMembersSelected.map(m=>`<div class="chip">${esc(m)}<button onclick="removeGM('${m}')">✕</button></div>`).join('');
  document.getElementById('group-member-list').innerHTML=contacts.filter(c=>!groupMembersSelected.includes(c.username)).map(c=>`<div class="ci" onclick="addGM('${c.username}')" style="border-radius:8px;margin-bottom:2px"><div class="avatar">${c.avatar?`<img src="${c.avatar}"/>`:c.username.charAt(0).toUpperCase()}</div><div class="ci-info"><div class="ci-name">${esc(c.username)}</div></div><div style="color:var(--pll);font-size:18px">＋</div></div>`).join('');
}
function addGM(u){if(!groupMembersSelected.includes(u))groupMembersSelected.push(u);renderGroupMemberSelect();}
function removeGM(u){groupMembersSelected=groupMembersSelected.filter(x=>x!==u);renderGroupMemberSelect();}
async function createGroup(){
  const name=document.getElementById('group-name-in').value.trim();const err=document.getElementById('group-err');
  if(!name){err.textContent='[ FEHLER ] Gruppenname eingeben.';return;}
  const res=await post('/api/groups/create',{token:authToken,name,members:groupMembersSelected});const d=await res.json();
  if(!res.ok){err.textContent='[ FEHLER ] '+d.error;return;}
  if(!groups_list.find(g=>g.id===d.groupId))groups_list.push(d.group);
  localMessages['group:'+d.groupId]=d.group.messages||[];
  closeModal('modal-group');switchSec('groups');openGroupChat(d.groupId);
}

// ── TOAST ───────────────────────────────────────────────────
function showToast(msg){
  let t=document.getElementById('toast-el');
  if(!t){t=document.createElement('div');t.id='toast-el';t.style.cssText='position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:linear-gradient(135deg,var(--p),var(--pd));color:white;font-weight:700;padding:11px 22px;border-radius:24px;z-index:500;font-size:13px;box-shadow:0 4px 20px var(--pglow);opacity:0;transition:opacity .25s;pointer-events:none;white-space:nowrap';document.body.appendChild(t);}
  t.textContent=msg;t.style.opacity='1';clearTimeout(t._to);t._to=setTimeout(()=>t.style.opacity='0',2800);
}

// ── KEYBOARD ────────────────────────────────────────────────
function setupKeyboard(){
  document.addEventListener('keydown',e=>{
    if(e.key!=='Enter')return;
    const id=document.activeElement?.id;
    if(id==='access-input')submitAccess();
    else if(id==='auth-user'||id==='auth-pass')submitAuth();
    else if(id==='msg-input')sendMessage();
    else if(id==='add-friend-input')sendFriendReq();
    else if(id==='group-name-in')createGroup();
  });
}
