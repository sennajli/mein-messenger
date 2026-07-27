
// ── SECTION TABS ────────────────────────────────────────────
let currentSec='chats';
function switchSec(s){currentSec=s;document.getElementById('stab-chats').classList.toggle('active',s==='chats');document.getElementById('stab-groups').classList.toggle('active',s==='groups');renderList();}

// ── RENDER LIST ─────────────────────────────────────────────
function renderList(){
  const search=(document.getElementById('search-in')?.value||'').toLowerCase();
  const list=document.getElementById('contact-list');list.innerHTML='';
  if(currentSec==='chats'){
    const f=contacts.filter(c=>c.username.includes(search));
    if(!f.length){list.innerHTML=`<div style="padding:32px 16px;text-align:center;color:var(--tx4)"><div style="font-size:32px;margin-bottom:8px">👋</div><div style="font-size:13px;font-weight:500">Keine Chats</div><div style="font-size:12px;margin-top:4px">Füge Freunde hinzu ➕</div></div>`;return;}
    f.forEach(c=>{
      const msgs=localMessages[c.username]||[];const last=msgs[msgs.length-1];
      const preview=last?(last.image?'🖼 Bild':(last.from===myUsername?'Du: '+last.text:last.text)):'Noch keine Nachrichten';
      const el=document.createElement('div');el.className='ci'+(activeChatId===c.username?' selected':'');el.onclick=()=>openChat(c.username);
      el.innerHTML=`<div class="avatar ${c.online?'online':''}">${c.avatar?`<img src="${c.avatar}"/>`:(c.statusEmoji||'')+c.username.charAt(0).toUpperCase()}</div><div class="ci-info"><div class="ci-name">${esc(c.username)}</div><div class="ci-prev">${typingMap[c.username]?'<em>✍ schreibt…</em>':esc(preview)}</div></div><div class="ci-meta"><div class="ci-time">${last?fmtTime(last.time):''}</div></div>`;
      list.appendChild(el);
    });
  }else{
    const gbtn=document.createElement('div');gbtn.style.cssText='padding:8px 6px';
    gbtn.innerHTML=`<button class="btn btn-s" style="font-size:12px;padding:9px;margin-bottom:0" onclick="openCreateGroup()">＋ Neue Gruppe</button>`;
    list.appendChild(gbtn);
    const f=groups_list.filter(g=>g.name.toLowerCase().includes(search));
    if(!f.length){const e=document.createElement('div');e.style.cssText='padding:20px;text-align:center;color:var(--tx4);font-size:12px';e.textContent='Noch keine Gruppen';list.appendChild(e);return;}
    f.forEach(g=>{
      const msgs=localMessages['group:'+g.id]||g.messages||[];const last=msgs[msgs.length-1];
      const preview=last?(last.image?'🖼 Bild':(last.from===myUsername?'Du: '+last.text:last.from+': '+last.text)):'Noch keine Nachrichten';
      const el=document.createElement('div');el.className='ci'+(activeChatId==='group:'+g.id?' selected':'');el.onclick=()=>openGroupChat(g.id);
      el.innerHTML=`<div class="avatar grp">👥</div><div class="ci-info"><div class="ci-name">${esc(g.name)} <span class="gbadge">Gruppe</span></div><div class="ci-prev">${esc(preview)}</div></div><div class="ci-meta"><div class="ci-time">${last?fmtTime(last.time):''}</div></div>`;
      list.appendChild(el);
    });
  }
}

// ── OPEN CHAT ───────────────────────────────────────────────
async function openChat(username){
  activeChatId=username;
  document.getElementById('no-chat').style.display='none';
  document.getElementById('chat-content').classList.add('vis');
  const c=contacts.find(x=>x.username===username);
  const avEl=document.getElementById('ch-avatar');
  avEl.innerHTML=c?.avatar?`<img src="${c.avatar}"/>`:username.charAt(0).toUpperCase();
  avEl.className='avatar'+(c?.online?' online':'');
  document.getElementById('ch-name').textContent=username;
  updateChatStatus(username);
  document.getElementById('ch-actions').style.display='flex';
  renderList();
  if(!localMessages[username]){const r=await fetch(`/api/messages?token=${encodeURIComponent(authToken)}&with=${encodeURIComponent(username)}`);localMessages[username]=(await r.json()).messages||[];}
  renderMessages();markRead(username);
  document.getElementById('sidebar').classList.add('mobile-hidden');
  document.getElementById('chat-area').classList.add('mobile-open');
  setTimeout(()=>document.getElementById('msg-input')?.focus(),100);
}

async function openGroupChat(gid){
  activeChatId='group:'+gid;
  document.getElementById('no-chat').style.display='none';
  document.getElementById('chat-content').classList.add('vis');
  const g=groups_list.find(x=>x.id===gid);
  const avEl=document.getElementById('ch-avatar');avEl.className='avatar grp';avEl.innerHTML='👥';
  document.getElementById('ch-name').innerHTML=esc(g?.name||'Gruppe')+' <span class="gbadge">Gruppe</span>';
  document.getElementById('ch-status').textContent=(g?.members?.length||0)+' Mitglieder';
  document.getElementById('ch-status').className='ch-status';
  document.getElementById('ch-actions').style.display='none';
  renderList();
  if(!localMessages['group:'+gid]){const r=await fetch(`/api/groups/messages?token=${encodeURIComponent(authToken)}&groupId=${gid}`);localMessages['group:'+gid]=(await r.json()).messages||[];}
  renderMessages();
  document.getElementById('sidebar').classList.add('mobile-hidden');
  document.getElementById('chat-area').classList.add('mobile-open');
  setTimeout(()=>document.getElementById('msg-input')?.focus(),100);
}

function closeMobile(){document.getElementById('sidebar').classList.remove('mobile-hidden');document.getElementById('chat-area').classList.remove('mobile-open');}

function updateChatStatus(username){
  const el=document.getElementById('ch-status');if(!el)return;
  const c=contacts.find(x=>x.username===username);
  el.className='ch-status';
  if(typingMap[username]){el.textContent='✍ schreibt…';el.classList.add('typing');}
  else if(c?.online){el.textContent='● Online';el.classList.add('online');}
  else{el.textContent='⚫ Offline';}
}

// ── RENDER MESSAGES ─────────────────────────────────────────
function renderMessages(){
  const container=document.getElementById('chat-messages');if(!activeChatId||!container)return;
  const msgs=localMessages[activeChatId]||[];container.innerHTML='';
  let lastDate=null,lastFrom=null,groupEl=null;
  msgs.forEach(msg=>{
    const d=new Date(msg.time);
    const ds=d.toLocaleDateString('de-DE',{day:'2-digit',month:'long',year:'numeric'});
    if(ds!==lastDate){const sep=document.createElement('div');sep.className='date-sep';sep.innerHTML=`<span class="date-sep-inner">${ds}</span>`;container.appendChild(sep);lastDate=ds;lastFrom=null;groupEl=null;}
    const isMe=msg.from===myUsername;
    if(msg.from!==lastFrom||!groupEl){
      groupEl=document.createElement('div');groupEl.className='msg-group '+(isMe?'mine':'theirs');
      if(!isMe&&activeChatId?.startsWith('group:')){const sn=document.createElement('div');sn.className='msg-sender';sn.textContent=msg.from;groupEl.appendChild(sn);}
      container.appendChild(groupEl);lastFrom=msg.from;
    }
    const bubWrap=document.createElement('div');
    if(msg.image){
      const bub=document.createElement('div');bub.className='bubble img-bub '+(isMe?'mine':'theirs');
      const im=document.createElement('img');im.className='msg-img';im.src=msg.image;im.alt='Bild';im.onclick=()=>openLightbox(msg.image);
      bub.appendChild(im);
      if(!activeChatId.startsWith('group:')){const rt=document.createElement('span');rt.className='react-trigger';rt.textContent='😊';rt.onclick=e=>{e.stopPropagation();openReactionPicker(msg.id,bub);};bub.appendChild(rt);}
      bubWrap.appendChild(bub);
    }else{
      const bub=document.createElement('div');bub.className='bubble '+(isMe?'mine':'theirs');bub.textContent=msg.text;
      if(!activeChatId.startsWith('group:')){const rt=document.createElement('span');rt.className='react-trigger';rt.textContent='😊';rt.onclick=e=>{e.stopPropagation();openReactionPicker(msg.id,bub);};bub.appendChild(rt);}
      bubWrap.appendChild(bub);
    }
    if(msg.reactions&&Object.keys(msg.reactions).length>0){
      const reacts=document.createElement('div');reacts.className='reactions';
      Object.entries(msg.reactions).forEach(([emoji,users])=>{const pill=document.createElement('div');pill.className='rpill'+(users.includes(myUsername)?' mine-r':'');pill.textContent=emoji+' '+users.length;pill.onclick=()=>reactToMsg(msg.id,emoji);reacts.appendChild(pill);});
      bubWrap.appendChild(reacts);
    }
    groupEl.appendChild(bubWrap);
    const meta=document.createElement('div');meta.className='msg-meta '+(isMe?'mine':'theirs');
    const ts=d.toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'});
    meta.innerHTML=`<span>${ts}</span>`;
    if(isMe&&!activeChatId?.startsWith('group:')){const isRead=(msg.readBy||[]).length>0;meta.innerHTML+=`<span class="rtick ${isRead?'read':''}">${isRead?'✓✓':'✓'}</span>`;}
    groupEl.appendChild(meta);
  });
  if(!activeChatId.startsWith('group:')&&typingMap[activeChatId]){
    const tg=document.createElement('div');tg.className='msg-group theirs';const tb=document.createElement('div');tb.className='typing-bub';
    tb.innerHTML='<div class="td"></div><div class="td"></div><div class="td"></div>';tg.appendChild(tb);container.appendChild(tg);
  }
  container.scrollTop=container.scrollHeight;
}

// ── REACTION PICKER ─────────────────────────────────────────
function openReactionPicker(msgId,bubEl){
  document.querySelectorAll('[id^="react-picker-"]').forEach(p=>p.remove());
  const p=document.createElement('div');p.className='emoji-picker-popup';p.id='react-picker-'+msgId;p.style.cssText='position:absolute;z-index:50;bottom:110%;left:0;';
  ['❤️','😂','😮','😢','😠','👍','🔥','💯'].forEach(em=>{const b=document.createElement('button');b.className='ep-emoji';b.textContent=em;b.onclick=e=>{e.stopPropagation();reactToMsg(msgId,em);p.remove();};p.appendChild(b);});
  bubEl.style.position='relative';bubEl.appendChild(p);
  setTimeout(()=>document.addEventListener('click',()=>p.remove(),{once:true}),50);
}
async function reactToMsg(msgId,emoji){if(!activeChatId||activeChatId.startsWith('group:'))return;await post('/api/messages/react',{token:authToken,with:activeChatId,messageId:msgId,emoji});}

// ── SEND MESSAGE ────────────────────────────────────────────
function sendMessage(){
  const input=document.getElementById('msg-input');const text=input.value.trim();const imgData=currentImageData||'';
  if((!text&&!imgData)||!activeChatId)return;
  if(!socket||socket.readyState!==WebSocket.OPEN){showToast('⚠ Verbindung getrennt…');connectSocket();return;}
  input.value='';isTypingNow=false;
  const isGroup=activeChatId.startsWith('group:');
  const tempMsg={id:'temp_'+Date.now(),from:myUsername,text,image:imgData,time:Date.now(),readBy:[],reactions:{}};
  if(!localMessages[activeChatId])localMessages[activeChatId]=[];
  localMessages[activeChatId].push(tempMsg);
  renderMessages();cancelImageSend();
  if(isGroup){socket.send(JSON.stringify({type:'groupMessage',groupId:activeChatId.replace('group:',''),text,image:imgData}));}
  else{socket.send(JSON.stringify({type:'message',to:activeChatId,text,image:imgData}));socket.send(JSON.stringify({type:'typing',to:activeChatId,isTyping:false}));}
}

// ── TYPING ──────────────────────────────────────────────────
function onTyping(){
  if(!activeChatId||!socket||socket.readyState!==WebSocket.OPEN)return;
  if(!isTypingNow){isTypingNow=true;if(!activeChatId.startsWith('group:'))socket.send(JSON.stringify({type:'typing',to:activeChatId,isTyping:true}));else socket.send(JSON.stringify({type:'groupTyping',groupId:activeChatId.replace('group:',''),isTyping:true}));}
  if(typingTimeout)clearTimeout(typingTimeout);
  typingTimeout=setTimeout(()=>{isTypingNow=false;if(!activeChatId.startsWith('group:'))socket.send(JSON.stringify({type:'typing',to:activeChatId,isTyping:false}));else socket.send(JSON.stringify({type:'groupTyping',groupId:activeChatId.replace('group:',''),isTyping:false}));},3000);
}
async function markRead(u){await post('/api/messages/read',{token:authToken,with:u});}
function triggerImagePick(){document.getElementById('img-file-input').click();}
function onImageSelected(e){const file=e.target.files[0];if(!file)return;const reader=new FileReader();reader.onload=ev=>{currentImageData=ev.target.result;document.getElementById('img-preview-thumb').src=currentImageData;document.getElementById('img-preview-bar').classList.add('active');};reader.readAsDataURL(file);e.target.value='';}
function cancelImageSend(){currentImageData=null;document.getElementById('img-preview-bar').classList.remove('active');document.getElementById('img-preview-thumb').src='';}
function openLightbox(src){document.getElementById('lightbox-img').src=src;document.getElementById('lightbox').classList.add('active');}
function closeLightbox(){document.getElementById('lightbox').classList.remove('active');}
document.getElementById('lightbox').addEventListener('click',e=>{if(e.target.id==='lightbox')closeLightbox();});
const EMOJIS=['😀','😂','😍','🥰','😊','😎','🤩','😤','😭','😱','🥳','🤔','👍','👎','❤️','🔥','💯','✨','🎉','💀','👀','😈','🤝','🫡','💪','🙏','🫶','😏','🤯','🥶'];
function initEmojiPicker(){const pp=document.getElementById('emoji-picker-popup');EMOJIS.forEach(em=>{const b=document.createElement('button');b.className='ep-emoji';b.textContent=em;b.onclick=()=>{const inp=document.getElementById('msg-input');inp.value+=em;inp.focus();};pp.appendChild(b);});}
let emojiPickerVisible=false;
function toggleEmojiPicker(){emojiPickerVisible=!emojiPickerVisible;document.getElementById('emoji-picker-popup').style.display=emojiPickerVisible?'grid':'none';}
document.addEventListener('click',e=>{if(!e.target.closest('.chat-input-bar')){document.getElementById('emoji-picker-popup').style.display='none';emojiPickerVisible=false;}});
