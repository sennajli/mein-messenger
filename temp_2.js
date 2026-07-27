
// ── WEBSOCKET ───────────────────────────────────────────────
function connectSocket(){
  const proto=location.protocol==='https:'?'wss://':'ws://';
  socket=new WebSocket(proto+location.host);
  socket.onopen=()=>socket.send(JSON.stringify({type:'auth',token:authToken}));
  socket.onmessage=e=>{
    const d=JSON.parse(e.data);
    if(d.type==='authError'){showToast('⚠ Sitzung ungültig');logout();return;}
    if(d.type==='message'){
      const other=d.from===myUsername?d.to:d.from;
      if(!localMessages[other])localMessages[other]=[];
      if(d.from===myUsername){const i=localMessages[other].findIndex(m=>m.id&&m.id.startsWith('temp_')&&m.text===d.text&&m.image===(d.image||'')&&Math.abs(m.time-d.time)<5000);if(i!==-1)localMessages[other].splice(i,1);}
      localMessages[other].push({from:d.from,text:d.text,image:d.image||'',time:d.time,id:d.id,readBy:[],reactions:{}});
      if(activeChatId===other){renderMessages();markRead(other);}renderList();
    }
    if(d.type==='groupMessage'){
      const key='group:'+d.groupId;if(!localMessages[key])localMessages[key]=[];
      if(d.message.from===myUsername){const i=localMessages[key].findIndex(m=>m.id&&m.id.startsWith('temp_')&&m.text===d.message.text&&Math.abs(m.time-d.message.time)<5000);if(i!==-1)localMessages[key].splice(i,1);}
      localMessages[key].push(d.message);
      const g=groups_list.find(x=>x.id===d.groupId);if(g){if(!g.messages)g.messages=[];g.messages.push(d.message);}
      if(activeChatId===key)renderMessages();renderList();
    }
    if(d.type==='typing'){
      typingMap[d.from]=d.isTyping;
      if(d.isTyping){if(typingMap['__t_'+d.from])clearTimeout(typingMap['__t_'+d.from]);typingMap['__t_'+d.from]=setTimeout(()=>{typingMap[d.from]=false;if(activeChatId===d.from){updateChatStatus(d.from);renderMessages();}renderList();},5000);}
      if(activeChatId===d.from){updateChatStatus(d.from);renderMessages();}renderList();
    }
    if(d.type==='groupTyping'){
      const key='group:'+d.groupId;
      if(activeChatId===key){const st=document.getElementById('ch-status');const g=groups_list.find(x=>x.id===d.groupId);if(d.isTyping){st.textContent=d.from+' schreibt…';st.classList.add('typing');}else{st.textContent=(g?.members?.length||0)+' Mitglieder';st.classList.remove('typing');}}
    }
    if(d.type==='messagesRead'){const key=d.by;if(localMessages[key])localMessages[key].forEach(m=>{if(m.from===myUsername&&!(m.readBy||[]).includes(d.by)){if(!m.readBy)m.readBy=[];m.readBy.push(d.by);}});if(activeChatId===key)renderMessages();}
    if(d.type==='reaction'){const key=d.chatUser;if(localMessages[key]){const m=localMessages[key].find(x=>x.id===d.messageId);if(m)m.reactions=d.reactions;}if(activeChatId===key)renderMessages();}
    if(d.type==='userOnline'){const c=contacts.find(x=>x.username===d.username);if(c)c.online=true;if(activeChatId===d.username)updateChatStatus(d.username);renderList();}
    if(d.type==='userOffline'){const c=contacts.find(x=>x.username===d.username);if(c)c.online=false;if(activeChatId===d.username)updateChatStatus(d.username);renderList();}
    if(d.type==='profileUpdate'){const c=contacts.find(x=>x.username===d.username);if(c){c.avatar=d.avatar;c.statusMessage=d.statusMessage;c.statusEmoji=d.statusEmoji;}if(activeChatId===d.username){const av=document.getElementById('ch-avatar');av.innerHTML=d.avatar?`<img src="${d.avatar}"/>`:d.username.charAt(0).toUpperCase();}renderList();}
    if(d.type==='friendRequest'){pendingFRs.push(d.request);updateFRBadge();}
    if(d.type==='friendAccepted'){if(!contacts.find(c=>c.username===d.by))contacts.push({username:d.by,avatar:d.avatar||'',online:true,statusMessage:'',statusEmoji:'🟢'});showToast('✓ '+d.by+' ist jetzt dein Freund!');renderList();}
    if(d.type==='groupCreated'){if(!groups_list.find(g=>g.id===d.group.id))groups_list.push(d.group);renderList();}
    if(d.type==='callOffer')handleIncomingCall(d);
    if(d.type==='callAnswer')handleCallAnswer(d);
    if(d.type==='callReject')handleCallRejected(d);
    if(d.type==='callEnd')handleCallEnded(d);
    if(d.type==='iceCandidate')handleIceCandidate(d);
    if(d.type==='mediaToggle')handleMediaToggle(d);
  };
  socket.onclose=()=>setTimeout(connectSocket,2500);
}

// ── WEBRTC ──────────────────────────────────────────────────
async function startCall(withVideo){
  if(!activeChatId||activeChatId.startsWith('group:')||!socket)return;
  callPartner=activeChatId;isCallInitiator=true;isVideoCall=withVideo;
  const audioConstraints = mySettings.micId ? { deviceId: { ideal: mySettings.micId } } : true;
  try{localStream=await navigator.mediaDevices.getUserMedia({audio:audioConstraints,video:withVideo});}catch(e){showToast('⚠ Kein Zugriff auf Mikrofon/Kamera');return;}
  setupLocalVideo();peerConn=createPeerConn();localStream.getTracks().forEach(t=>peerConn.addTrack(t,localStream));
  const offer=await peerConn.createOffer();await peerConn.setLocalDescription(offer);
  socket.send(JSON.stringify({type:'callOffer',to:callPartner,offer,video:withVideo}));
  showCallOverlay('KLINGELT…',callPartner,withVideo);
  document.getElementById('call-avatar-el').classList.add('ringing');
  playRing(false);
}
function handleIncomingCall(d){callPartner=d.from;isCallInitiator=false;isVideoCall=d.video;pendingOffer=d.offer;document.getElementById('inc-name').textContent=d.from;document.getElementById('inc-type').textContent=d.video?'📹 Videoanruf':'📞 Sprachanruf';document.getElementById('incoming-call').classList.add('active');playRing(true);}
async function acceptCall(){
  stopRing();
  document.getElementById('incoming-call').classList.remove('active');
  const audioConstraints = mySettings.micId ? { deviceId: { ideal: mySettings.micId } } : true;
  try{localStream=await navigator.mediaDevices.getUserMedia({audio:audioConstraints,video:isVideoCall});}catch(e){showToast('⚠ Kein Mikrofon/Kamera-Zugriff.');rejectCall();return;}
  setupLocalVideo();peerConn=createPeerConn();localStream.getTracks().forEach(t=>peerConn.addTrack(t,localStream));
  await peerConn.setRemoteDescription(new RTCSessionDescription(pendingOffer));
  const answer=await peerConn.createAnswer();await peerConn.setLocalDescription(answer);
  socket.send(JSON.stringify({type:'callAnswer',to:callPartner,answer}));
  showCallOverlay('VERBUNDEN',callPartner,isVideoCall);pendingOffer=null;
  document.getElementById('call-avatar-el').classList.remove('ringing');
  startCallTimer();
}
function rejectCall(){stopRing();document.getElementById('incoming-call').classList.remove('active');if(socket)socket.send(JSON.stringify({type:'callReject',to:callPartner}));callPartner=null;pendingOffer=null;}
async function handleCallAnswer(d){stopRing();if(!peerConn)return;await peerConn.setRemoteDescription(new RTCSessionDescription(d.answer));document.getElementById('call-status-el').textContent='VERBUNDEN';document.getElementById('call-avatar-el').classList.remove('ringing');startCallTimer();}
function handleCallRejected(d){stopRing();document.getElementById('call-status-el').textContent='ABGELEHNT';document.getElementById('call-avatar-el').classList.remove('ringing');setTimeout(endCall,2000);}
function handleCallEnded(d){stopRing();endCall(true);}
function handleIceCandidate(d){if(peerConn&&d.candidate)peerConn.addIceCandidate(new RTCIceCandidate(d.candidate)).catch(()=>{});}
function handleMediaToggle(d){}
function createPeerConn(){
  const pc=new RTCPeerConnection(iceServers);
  pc.onicecandidate=e=>{if(e.candidate&&socket)socket.send(JSON.stringify({type:'iceCandidate',to:callPartner,candidate:e.candidate}));};
  pc.ontrack=e=>{
    const rv=document.getElementById('remote-video');
    rv.srcObject=e.streams[0];
    if(mySettings.speakerId&&typeof rv.setSinkId==='function')rv.setSinkId(mySettings.speakerId).catch(()=>{});
  };
  pc.onconnectionstatechange=()=>{
    if(pc.connectionState==='connected'){
      document.getElementById('call-status-el').textContent='VERBUNDEN';
      document.getElementById('call-avatar-el').classList.remove('ringing');
      stopRing(); startCallTimer();
    }
    if(pc.connectionState==='disconnected'||pc.connectionState==='failed')endCall(true);
  };
  return pc;
}
function setupLocalVideo(){document.getElementById('local-video').srcObject=localStream;}
function showCallOverlay(status,partner,video){
  document.getElementById('call-overlay').classList.add('active');
  document.getElementById('call-status-el').textContent=status;document.getElementById('call-name-el').textContent=partner;
  const c=contacts.find(x=>x.username===partner);const av=document.getElementById('call-avatar-el');
  av.innerHTML=c?.avatar?`<img src="${c.avatar}" style="width:100%;height:100%;object-fit:cover"/>`:partner.charAt(0).toUpperCase();
  const vw=document.getElementById('videos-wrap');const camBtn=document.getElementById('cam-btn');const camLbl=document.getElementById('cam-lbl');const scrBtn=document.getElementById('screen-btn');const scrLbl=document.getElementById('screen-lbl');
  if(video){vw.classList.add('active');av.style.display='none';camBtn.style.display='flex';if(camLbl)camLbl.style.display='block';scrBtn.style.display='flex';if(scrLbl)scrLbl.style.display='block';}
  else{vw.classList.remove('active');av.style.display='flex';camBtn.style.display='none';if(camLbl)camLbl.style.display='none';scrBtn.style.display='none';if(scrLbl)scrLbl.style.display='none';}
  micOn=true;camOn=video;document.getElementById('mic-btn').classList.remove('on');document.getElementById('cam-btn').classList.remove('on');
}

let audioCtx, ringOsc, ringInterval;
function playRing(isIncoming) {
  if(!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if(audioCtx.state === 'suspended') audioCtx.resume();
  stopRing();
  const playPulse = () => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = isIncoming ? 'sine' : 'sine';
    osc.frequency.setValueAtTime(isIncoming ? 440 : 480, audioCtx.currentTime);
    osc.frequency.setValueAtTime(isIncoming ? 480 : 440, audioCtx.currentTime + 0.5);
    gain.gain.setValueAtTime(0, audioCtx.currentTime);
    gain.gain.linearRampToValueAtTime(0.3, audioCtx.currentTime + 0.1);
    gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 1.5);
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.start(); osc.stop(audioCtx.currentTime + 1.5);
  };
  playPulse();
  ringInterval = setInterval(playPulse, 2000);
}
function stopRing(){
  if(ringInterval) { clearInterval(ringInterval); ringInterval = null; }
}

let callTimerInt=null; let callStartTime=0;
function startCallTimer() {
  stopCallTimer();
  document.getElementById('call-status-el').textContent = '00:00';
  callStartTime = Date.now();
  callTimerInt = setInterval(()=>{
    const diff = Math.floor((Date.now() - callStartTime)/1000);
    const m = String(Math.floor(diff/60)).padStart(2,'0');
    const s = String(diff%60).padStart(2,'0');
    document.getElementById('call-status-el').textContent = `${m}:${s}`;
  }, 1000);
}
function stopCallTimer() {
  if(callTimerInt){ clearInterval(callTimerInt); callTimerInt=null; }
}

function endCall(silent){
  stopRing(); stopCallTimer();
  if(!silent&&socket&&callPartner)socket.send(JSON.stringify({type:'callEnd',to:callPartner}));
  document.getElementById('call-overlay').classList.remove('active');
  document.getElementById('videos-wrap').classList.remove('active');
  document.getElementById('call-avatar-el').style.display='flex';
  document.getElementById('call-avatar-el').classList.remove('ringing');
  if(localStream){localStream.getTracks().forEach(t=>t.stop());localStream=null;}
  if(screenStream){screenStream.getTracks().forEach(t=>t.stop());screenStream=null;}
  if(peerConn){peerConn.close();peerConn=null;}
  ['remote-video','local-video','screen-video'].forEach(id=>{document.getElementById(id).srcObject=null;});
  document.getElementById('screen-video').style.display='none';callPartner=null;
}
function toggleMic(){if(!localStream)return;micOn=!micOn;localStream.getAudioTracks().forEach(t=>t.enabled=micOn);document.getElementById('mic-btn').textContent=micOn?'🎤':'🔇';document.getElementById('mic-btn').classList.toggle('on',!micOn);if(socket&&callPartner)socket.send(JSON.stringify({type:'mediaToggle',to:callPartner,audio:micOn,video:camOn}));}
function toggleCam(){if(!localStream)return;camOn=!camOn;localStream.getVideoTracks().forEach(t=>t.enabled=camOn);document.getElementById('cam-btn').textContent=camOn?'📷':'🚫';document.getElementById('cam-btn').classList.toggle('on',!camOn);if(socket&&callPartner)socket.send(JSON.stringify({type:'mediaToggle',to:callPartner,audio:micOn,video:camOn}));}
async function toggleScreenShare(){
  if(screenStream){screenStream.getTracks().forEach(t=>t.stop());screenStream=null;document.getElementById('screen-video').style.display='none';document.getElementById('screen-video').srcObject=null;document.getElementById('screen-btn').classList.remove('on');if(socket&&callPartner)socket.send(JSON.stringify({type:'screenShareToggle',to:callPartner,active:false}));if(peerConn&&localStream){const sender=peerConn.getSenders().find(s=>s.track?.kind==='video');if(sender&&localStream.getVideoTracks()[0])sender.replaceTrack(localStream.getVideoTracks()[0]);}}
  else{try{screenStream=await navigator.mediaDevices.getDisplayMedia({video:true});const sv=document.getElementById('screen-video');sv.srcObject=screenStream;sv.style.display='block';document.getElementById('screen-btn').classList.add('on');if(socket&&callPartner)socket.send(JSON.stringify({type:'screenShareToggle',to:callPartner,active:true}));if(peerConn){const sender=peerConn.getSenders().find(s=>s.track?.kind==='video');if(sender)sender.replaceTrack(screenStream.getVideoTracks()[0]);}screenStream.getVideoTracks()[0].onended=()=>toggleScreenShare();}catch(e){console.log('Screen share aborted');}}
}
