const CLIENT_ID = 'af89877b7d3a4e309afbdd30559fd1d6';
const REDIRECT_URI = 'https://nickisea387.github.io/mmw2026/';
const SCOPES = 'user-top-read user-read-recently-played user-read-private';

let activeGenres=new Set(['all']), activeDays=new Set(['all']), sortMode='day', minMentions=0, viewMode='list', searchQuery='';
let spotifyToken=null, refreshToken=null, tokenExpiry=0, eventMatchScores={};
let map=null, mapMarkers=[];
let favourites=JSON.parse(localStorage.getItem('mmw_favs')||'[]');
let showFavsOnly=false;
// Artist images are pre-baked in artist_images.js (ARTIST_IMAGES constant)
let hpCharImages={};

// ── PKCE AUTH ────────────────────────────────────────────────────────────────
function genVerifier(len=128){
  const c='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  return Array.from(crypto.getRandomValues(new Uint8Array(len)),x=>c[x%c.length]).join('');
}
async function genChallenge(v){
  const d=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v));
  return btoa(String.fromCharCode(...new Uint8Array(d))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}
async function startAuth(){
  const verifier=genVerifier();const challenge=await genChallenge(verifier);const state=crypto.randomUUID();
  sessionStorage.setItem('pkce_v',verifier);sessionStorage.setItem('pkce_s',state);
  const p=new URLSearchParams({client_id:CLIENT_ID,response_type:'code',redirect_uri:REDIRECT_URI,scope:SCOPES,code_challenge_method:'S256',code_challenge:challenge,state});
  window.location.href=`https://accounts.spotify.com/authorize?${p}`;
}
async function exchangeCode(code){
  const verifier=sessionStorage.getItem('pkce_v');
  if(!verifier) throw new Error('No verifier — try connecting again.');
  const body=new URLSearchParams({client_id:CLIENT_ID,grant_type:'authorization_code',code,redirect_uri:REDIRECT_URI,code_verifier:verifier});
  const r=await fetch('https://accounts.spotify.com/api/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
  if(!r.ok){const e=await r.json();throw new Error(e.error_description||'Token exchange failed');}
  return r.json();
}
function saveTokens(data){
  spotifyToken=data.access_token;if(data.refresh_token) refreshToken=data.refresh_token;
  tokenExpiry=Date.now()+(data.expires_in*1000)-60000;
  localStorage.setItem('sp_access',spotifyToken);if(refreshToken) localStorage.setItem('sp_refresh',refreshToken);
  localStorage.setItem('sp_expiry',tokenExpiry.toString());
}
function loadTokens(){spotifyToken=localStorage.getItem('sp_access');refreshToken=localStorage.getItem('sp_refresh');tokenExpiry=parseInt(localStorage.getItem('sp_expiry')||'0');return !!(spotifyToken&&refreshToken);}
function clearTokens(){spotifyToken=null;refreshToken=null;tokenExpiry=0;['sp_access','sp_refresh','sp_expiry','sp_name','sp_scores'].forEach(k=>localStorage.removeItem(k));}
async function refreshAccessToken(){
  if(!refreshToken) return false;
  try{const body=new URLSearchParams({client_id:CLIENT_ID,grant_type:'refresh_token',refresh_token:refreshToken});
  const r=await fetch('https://accounts.spotify.com/api/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
  if(!r.ok) return false;saveTokens(await r.json());return true;}catch(e){return false;}
}
async function getValidToken(){if(Date.now()>=tokenExpiry){if(!await refreshAccessToken()){clearTokens();return null;}}return spotifyToken;}

// ── LOAD HP CHARACTER IMAGES ─────────────────────────────────────────────────
fetch('https://hp-api.onrender.com/api/characters').then(r=>r.json()).then(chars=>{
  chars.forEach(c=>{if(c.image) hpCharImages[c.name.toLowerCase()]=c.image;});
}).catch(()=>{});

// ── ON LOAD ──────────────────────────────────────────────────────────────────
window.addEventListener('load',async()=>{
  const p=new URLSearchParams(window.location.search);
  const code=p.get('code'),state=p.get('state'),error=p.get('error');
  if(error){showNotice(`Spotify declined: ${error}`,'err');return;}
  if(code){
    const saved=sessionStorage.getItem('pkce_s');
    if(state!==saved){showNotice('State mismatch — try again.','err');return;}
    window.history.replaceState({},document.title,window.location.pathname);
    showLoading('Exchanging auth code with Spotify...');
    try{const t=await exchangeCode(code);saveTokens(t);sessionStorage.removeItem('pkce_v');sessionStorage.removeItem('pkce_s');await loadAndAnalyze();}
    catch(err){showNotice(`Auth failed: ${err.message}`,'err');showAllEvents();}
    return;
  }
  if(loadTokens()){
    const token=await getValidToken();
    if(token){
      const savedName=localStorage.getItem('sp_name'),savedScores=localStorage.getItem('sp_scores');
      if(savedName&&savedScores){
        document.getElementById('connectBtn').style.display='none';document.getElementById('authDesc').style.display='none';
        document.getElementById('spotifyName').textContent=savedName;document.getElementById('connectedBadge').classList.add('visible');
        try{const parsed=JSON.parse(savedScores);
          Object.entries(parsed.scores).forEach(([id,s])=>{eventMatchScores[parseInt(id)]=s;});
          const b=document.getElementById('aiBanner');
          b.innerHTML=`<strong>Your Sound:</strong> ${parsed.tasteSummary}<br><span style="display:block;margin-top:6px">Detected genres: <strong>${parsed.topGenres.join(' · ')}</strong></span>`;
          b.classList.add('visible');renderEvents();
        }catch(e){await loadAndAnalyze();}
      } else {await loadAndAnalyze();}
    }
  }
});

async function loadAndAnalyze(){
  showLoading('Reading your Spotify listening history...');
  try{
    const token=await getValidToken();if(!token){showNotice('Session expired — reconnect.','err');showAllEvents();return;}
    const headers={Authorization:`Bearer ${token}`};
    const [r1,r2,r3,r4]=await Promise.all([
      fetch('https://api.spotify.com/v1/me/top/artists?limit=50&time_range=medium_term',{headers}),
      fetch('https://api.spotify.com/v1/me/top/tracks?limit=50&time_range=medium_term',{headers}),
      fetch('https://api.spotify.com/v1/me/player/recently-played?limit=50',{headers}),
      fetch('https://api.spotify.com/v1/me',{headers}),
    ]);
    const [topArtists,topTracks,recent,profile]=await Promise.all([r1.json(),r2.json(),r3.json(),r4.json()]);
    document.getElementById('connectBtn').style.display='none';document.getElementById('authDesc').style.display='none';
    const displayName=profile.display_name||profile.id;
    document.getElementById('spotifyName').textContent=displayName;document.getElementById('connectedBadge').classList.add('visible');
    localStorage.setItem('sp_name',displayName);
    await runAI({topArtists,topTracks,recent});
  }catch(err){showNotice(`Spotify error: ${err.message}`,'err');showAllEvents();}
}

async function runAI({topArtists,topTracks,recent}){
  showLoading('Claude is matching your taste to MMW lineups...');
  const artists=(topArtists?.items||[]).map(a=>a.name).slice(0,25).join(', ');
  const userGenres=[...new Set((topArtists?.items||[]).flatMap(a=>a.genres))].slice(0,25);
  const genres=userGenres.join(', ');
  const tracks=(topTracks?.items||[]).map(t=>`${t.name} – ${t.artists[0]?.name}`).slice(0,15).join('; ');
  const recents=[...new Set((recent?.items||[]).map(i=>i.track.artists[0]?.name))].slice(0,20).join(', ');

  const prompt=`You are a music taste analyst. Match a user to Miami Music Week 2026 events based on their Spotify data.
TOP ARTISTS (6 months): ${artists}
GENRES: ${genres}
TOP TRACKS: ${tracks}
RECENTLY PLAYED: ${recents}

EVENTS:
${EVENTS.map(e=>`ID:${e.id} | ${e.name} | Artists: ${e.artists} | Genres: ${e.genre.join(',')} | Keywords: ${e.matchKeywords.join(',')}`).join('\n')}

Score each event 0-100 (direct artist match = 85-100, strong genre match = 65-84, adjacent = 35-64, outside taste = 10-34).
Write a 2-sentence taste profile and list top 3 sub-genres detected.
Respond ONLY in valid JSON (no markdown):
{"tasteSummary":"...","topGenres":["...","...","..."],"scores":{"1":85,"2":40,...}}`;

  try{
    const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:2000,messages:[{role:'user',content:prompt}]})});
    const d=await r.json();
    const parsed=JSON.parse((d.content?.[0]?.text||'').replace(/```json|```/g,'').trim());
    Object.entries(parsed.scores).forEach(([id,s])=>{eventMatchScores[parseInt(id)]=s;});
    localStorage.setItem('sp_scores',JSON.stringify(parsed));
    const b=document.getElementById('aiBanner');
    b.innerHTML=`<strong>Your Sound:</strong> ${parsed.tasteSummary}<br><span style="display:block;margin-top:6px">Detected genres: <strong>${parsed.topGenres.join(' · ')}</strong></span>`;
    b.classList.add('visible');renderEvents();
  }catch(err){
    console.error(err);EVENTS.forEach(e=>{eventMatchScores[e.id]=e.hype*18;});renderEvents();
  }
  showHPModal(userGenres);
}

// ── HARRY POTTER ─────────────────────────────────────────────────────────────
function showHPModal(userGenres){
  const genreStr=(userGenres||[]).join(' ').toLowerCase();
  let bestChar=HP_CHARACTERS[0],bestScore=0;
  HP_CHARACTERS.forEach(ch=>{
    let score=0;
    ch.genres.forEach(g=>{if(genreStr.includes(g)) score+=2;g.split(' ').forEach(w=>{if(w.length>3&&genreStr.includes(w)) score+=1;});});
    if(score>bestScore){bestScore=score;bestChar=ch;}
  });
  if(bestScore<2){
    if(genreStr.includes('house')||genreStr.includes('edm')) bestChar=HP_CHARACTERS.find(c=>c.name==='Harry Potter')||HP_CHARACTERS[0];
    else if(genreStr.includes('pop')||genreStr.includes('dance')) bestChar=HP_CHARACTERS.find(c=>c.name==='Ron Weasley')||HP_CHARACTERS[0];
    else bestChar=HP_CHARACTERS.find(c=>c.name==='Luna Lovegood')||HP_CHARACTERS[0];
  }
  const houseColors={Gryffindor:'#ae0001',Slytherin:'#1a472a',Ravenclaw:'#222f5b',Hufflepuff:'#ecb939'};
  const houseImages={
    Gryffindor:'https://images.unsplash.com/photo-1551269901-5c5e14c25df7?w=600&h=400&fit=crop&q=80',
    Slytherin:'https://images.unsplash.com/photo-1478760329108-5c3ed9d495a0?w=600&h=400&fit=crop&q=80',
    Ravenclaw:'https://images.unsplash.com/photo-1534796636912-3b95b3ab5986?w=600&h=400&fit=crop&q=80',
    Hufflepuff:'https://images.unsplash.com/photo-1507400492013-162706c8c05e?w=600&h=400&fit=crop&q=80',
  };
  document.getElementById('hpModalBg').style.backgroundImage=`url('${houseImages[bestChar.house]||houseImages.Gryffindor}')`;
  document.getElementById('hpEmoji').textContent=bestChar.emoji;
  document.getElementById('hpHouse').textContent=bestChar.house;
  document.getElementById('hpHouse').style.color=houseColors[bestChar.house]||'#fff';
  document.getElementById('hpChar').textContent=bestChar.name;
  document.getElementById('hpQuote').textContent=`"${bestChar.quote}"`;
  document.getElementById('hpReason').textContent=bestChar.reason;
  // Load character image from HP API
  const imgEl=document.getElementById('hpCharImg');
  imgEl.className='hp-char-img';imgEl.style.display='none';
  const charImg=hpCharImages[bestChar.name.toLowerCase()]||'';
  if(charImg){imgEl.src=charImg;imgEl.onload=()=>{imgEl.classList.add('loaded');imgEl.style.display='block';};imgEl.onerror=()=>{imgEl.style.display='none';};}
  document.getElementById('hpModal').classList.add('visible');
}
function closeHPModal(){
  document.getElementById('hpModal').classList.remove('visible');
  // Switch to My Picks sort and list view
  sortMode='match';
  viewMode='list';
  document.querySelectorAll('.sort-btn').forEach(b=>b.classList.toggle('active',b.dataset.sort==='match'));
  document.querySelectorAll('.view-btn').forEach(b=>b.classList.toggle('active',b.dataset.view==='list'));
  renderEvents();
  // Scroll to top of results
  document.getElementById('results')?.scrollIntoView({behavior:'smooth'});
}

// ── SEARCH ───────────────────────────────────────────────────────────────────
function getSearchableText(e){return `${e.name} ${e.artists} ${e.venue} ${e.summary} ${e.genre.join(' ')} ${e.matchKeywords.join(' ')}`.toLowerCase();}
function handleSearch(val){
  searchQuery=val.trim().toLowerCase();
  renderEvents();
}

// ── ARTIST LINKS & IMAGES ────────────────────────────────────────────────────
function linkifyArtists(str){
  return str.split(/,\s*/).map(part=>{
    if(part.toLowerCase().includes(' b2b ')){return part.split(/\s+b2b\s+/i).map(s=>mkLink(s.trim())).join(' b2b ');}
    return mkLink(part.trim());
  }).join(', ');
}
function mkLink(name){
  if(!name||name==='TBA'||name.includes('TBA ')||name.includes('rumored')||name.includes('surprise')) return name;
  const clean=name.replace(/\s*\(.*?\)\s*/g,'').trim();
  return `<a href="https://open.spotify.com/search/${encodeURIComponent(clean)}" target="_blank" rel="noopener">${name}</a>`;
}
function getHeadliner(e){return e.artists.split(/,/)[0].replace(/\s*b2b\s+.*/i,'').replace(/\s*\(.*?\)/g,'').trim();}

function getArtistImage(name){
  return ARTIST_IMAGES[name]||'';
}

// ── TICKET & PLAY ────────────────────────────────────────────────────────────
function getTicketUrl(e){return `https://www.google.com/search?q=${encodeURIComponent(e.name+' miami music week 2026 tickets')}`;}
function playSet(eventId){
  const event=EVENTS.find(e=>e.id===eventId);if(!event) return;
  const names=event.artists.split(/,\s*/).map(a=>a.replace(/\s*b2b\s+.*/i,'').replace(/\s*\(.*?\)/g,'').trim()).filter(a=>a&&a!=='TBA');
  window.open(`https://open.spotify.com/search/${encodeURIComponent(names.slice(0,5).join(' '))}`,'_blank');
}

// ── FAVOURITES ───────────────────────────────────────────────────────────────
function toggleFav(id){const i=favourites.indexOf(id);if(i>=0) favourites.splice(i,1);else favourites.push(id);localStorage.setItem('mmw_favs',JSON.stringify(favourites));renderEvents();}
function toggleFavFilter(){showFavsOnly=!showFavsOnly;document.getElementById('favFilterBtn')?.classList.toggle('active',showFavsOnly);renderEvents();}

// ── VENUE IMAGE FALLBACK ─────────────────────────────────────────────────────
function getVenueImage(event){const vd=VENUE_DATA[event.venue];if(vd&&vd.img) return vd.img;return TYPE_IMAGES[event.type]||TYPE_IMAGES.club;}

// ── UI HELPERS ────────────────────────────────────────────────────────────────
function showNotice(msg,type){const el=document.getElementById('notice');el.textContent=msg;el.className=`notice visible ${type}`;}
function showLoading(msg){document.getElementById('results').innerHTML=`<div class="loading-state"><div class="pulse-ring"></div><div>${msg}</div></div>`;}
function showAllEvents(){EVENTS.forEach(e=>{eventMatchScores[e.id]=e.hype*18;});renderEvents();}
function disconnect(){
  clearTokens();eventMatchScores={};
  document.getElementById('connectBtn').style.display='flex';document.getElementById('authDesc').style.display='block';
  document.getElementById('connectedBadge').classList.remove('visible');document.getElementById('aiBanner').classList.remove('visible');
  document.getElementById('notice').classList.remove('visible');
  document.getElementById('results').innerHTML=`<div class="empty-state"><div class="big">→</div><div style="font-size:14px;margin-bottom:8px;color:var(--text)">Connect Spotify to get personalized picks</div><br><br><button class="submit-btn" onclick="showAllEvents()">Browse All Events →</button></div>`;
}

// ── MULTI-SELECT FILTERS ─────────────────────────────────────────────────────
function toggleGenre(btn){
  const g=btn.dataset.genre;
  if(g==='all'){activeGenres=new Set(['all']);}
  else{activeGenres.delete('all');if(activeGenres.has(g)) activeGenres.delete(g);else activeGenres.add(g);if(!activeGenres.size) activeGenres=new Set(['all']);}
  document.querySelectorAll('.genre-chip').forEach(b=>b.classList.toggle('active',activeGenres.has(b.dataset.genre)));
  renderEvents();
}
function toggleDay(btn){
  const d=btn.dataset.day;
  if(d==='all'){activeDays=new Set(['all']);}
  else{activeDays.delete('all');if(activeDays.has(d)) activeDays.delete(d);else activeDays.add(d);if(!activeDays.size) activeDays=new Set(['all']);}
  document.querySelectorAll('.day-btn').forEach(b=>b.classList.toggle('active',activeDays.has(b.dataset.day)));
  renderEvents();
}
function toggleMentions(btn){document.querySelectorAll('.mentions-btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');minMentions=parseInt(btn.dataset.mentions);renderEvents();}
function setSort(mode){
  sortMode=mode;
  if(viewMode==='map'){viewMode='list';document.querySelectorAll('.view-btn').forEach(b=>b.classList.toggle('active',b.dataset.view==='list'));}
  document.querySelectorAll('.sort-btn').forEach(b=>b.classList.toggle('active',b.dataset.sort===mode));
  renderEvents();
}
function setView(mode){viewMode=mode;document.querySelectorAll('.view-btn').forEach(b=>b.classList.toggle('active',b.dataset.view===mode));renderEvents();}
function getMentionsDisplay(m){
  if(m>=6) return {text:`${m} sources`,cls:'hot',flames:'🔥🔥🔥'};
  if(m>=4) return {text:`${m} sources`,cls:'hot',flames:'🔥🔥'};
  if(m>=3) return {text:`${m} sources`,cls:'warm',flames:'🔥'};
  return {text:`${m} source${m!==1?'s':''}`,cls:'',flames:''};
}

// ── MAP ──────────────────────────────────────────────────────────────────────
function initMap(){
  if(map){try{map.remove();}catch(e){}map=null;}
  const container=document.getElementById('mapContainer');if(!container) return;
  map=L.map(container,{zoomControl:true,scrollWheelZoom:true}).setView([25.795,-80.195],12);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',{attribution:'© OSM © CARTO',subdomains:'abcd',maxZoom:19}).addTo(map);
}
function updateMap(events){
  if(!map) initMap();if(!map) return;
  mapMarkers.forEach(m=>{try{map.removeLayer(m);}catch(e){}});mapMarkers=[];
  const dayOrder=['tue','wed','thu','fri','sat','sun'];
  const byVenue={};events.forEach(e=>{if(!byVenue[e.venue]) byVenue[e.venue]=[];byVenue[e.venue].push(e);});
  Object.entries(byVenue).forEach(([venueName,venueEvents])=>{
    const vd=VENUE_DATA[venueName];if(!vd) return;
    const color=HOOD_COLORS[vd.hood]||'#999';
    venueEvents.sort((a,b)=>dayOrder.indexOf(a.day)-dayOrder.indexOf(b.day));
    const icon=L.divIcon({className:'custom-marker',
      html:`<div style="width:14px;height:14px;border-radius:50%;background:${color};border:2px solid rgba(255,255,255,0.8);box-shadow:0 0 8px ${color}80;cursor:pointer;"></div>`,
      iconSize:[14,14],iconAnchor:[7,7],popupAnchor:[0,-10]});
    const marker=L.marker([vd.lat,vd.lng],{icon}).addTo(map);
    const has=Object.keys(eventMatchScores).length>0;
    let html=`<div class="popup-venue">${venueName}</div><div style="font-size:10px;color:${color};margin-bottom:8px;text-transform:uppercase;letter-spacing:1px;">${vd.hood}</div><div style="max-height:250px;overflow-y:auto;">`;
    venueEvents.forEach(e=>{
      const s=eventMatchScores[e.id]||0;
      const sc=has?` <span style="color:${s>=70?'var(--green)':s>=40?'var(--amber)':'var(--muted)'};font-weight:600;">${s}</span>`:'';
      html+=`<div class="popup-event"><div class="popup-event-name">${e.name}${sc}</div><div class="popup-event-meta">${e.dayLabel} · ${e.time}</div><div class="popup-event-meta" style="color:#bbb">${linkifyArtists(e.artists)}</div></div>`;
    });
    html+='</div>';
    marker.bindPopup(html,{maxWidth:320,minWidth:240});mapMarkers.push(marker);
  });
  setTimeout(()=>{if(map) map.invalidateSize();},150);
}

// ── RENDER CARD ──────────────────────────────────────────────────────────────
function renderCard(e,has,dimmed){
  const s=eventMatchScores[e.id]||0;
  const cls=has?(s>=70?'match-high':s>=40?'match-med':'match-low'):'match-low';
  const reason=s>=70?'Strong match':s>=50?'Good match':s>=30?'Worth exploring':'Outside your usual';
  const stars='★'.repeat(s>=70?3:s>=45?2:1)+'☆'.repeat(s>=70?0:s>=45?1:2);
  const md=getMentionsDisplay(e.mentions);
  const isFav=favourites.includes(e.id);
  const headliner=getHeadliner(e);
  const img=getArtistImage(headliner)||getVenueImage(e);
  const ticketUrl=getTicketUrl(e);
  const crowd=VENUE_CROWD[e.venue]||TYPE_CROWD[e.type]||'';
  return `<div class="event-card ${cls}" style="${dimmed?'opacity:0.6':''}">
    <div class="event-card-img" style="background-image:url('${img}')"></div>
    <div class="event-card-body">
      <div class="event-card-top">
        <div style="flex:1">
          <div class="event-name"><a href="${ticketUrl}" target="_blank" rel="noopener" class="event-link">${e.name}</a><span class="tag ${e.type}">${e.type}</span></div>
          <div class="event-meta"><span class="venue">${e.venue}</span><span>${e.dayLabel}</span><span>${e.time}</span></div>
          <div class="artists">${linkifyArtists(e.artists)}</div>
          <div class="event-summary">${e.summary}</div>
          ${crowd?`<div class="event-crowd"><strong>TLDR:</strong> ${crowd}</div>`:''}
          <div class="event-actions">
            <div class="mentions-badge ${md.cls}">${md.flames} ${md.text}</div>
            <button class="play-btn" onclick="playSet(${e.id})" title="Play artist set on Spotify">▶ Play Set</button>
            <button class="fav-btn ${isFav?'active':''}" onclick="toggleFav(${e.id})" title="${isFav?'Remove from':'Add to'} favourites">${isFav?'♥':'♡'}</button>
          </div>
        </div>
        ${has?`<div class="match-badge"><div class="match-score">${s}</div><div class="match-label">match</div><div class="match-reason">${reason}</div><div style="font-size:10px;letter-spacing:-1px;color:var(--green)">${stars}</div></div>`
             :`<div class="match-badge"><div class="match-score" style="font-size:18px;color:var(--muted2)">—</div></div>`}
      </div>
    </div>
  </div>`;
}

// ── MAIN RENDER ──────────────────────────────────────────────────────────────
function renderEvents(){
  const dayOrder=['tue','wed','thu','fri','sat','sun'];
  const filterFn=e=>
    (activeDays.has('all')||activeDays.has(e.day))&&
    (activeGenres.has('all')||e.genre.some(g=>activeGenres.has(g)))&&
    (e.mentions>=minMentions)&&
    (!showFavsOnly||favourites.includes(e.id));
  const sortFn=(a,b)=>{
    if(sortMode==='match') return (eventMatchScores[b.id]||0)-(eventMatchScores[a.id]||0)||b.mentions-a.mentions;
    if(sortMode==='day') return dayOrder.indexOf(a.day)-dayOrder.indexOf(b.day)||(a.time<b.time?-1:1);
    if(sortMode==='buzz') return b.mentions-a.mentions||b.hype-a.hype;
    return 0;
  };

  const hasSpotifyScores=localStorage.getItem('sp_scores')!==null;
  let events,outsideEvents=[];
  if(searchQuery){
    const filtered=EVENTS.filter(filterFn);
    const unfiltered=EVENTS.filter(e=>!filterFn(e));
    events=filtered.filter(e=>getSearchableText(e).includes(searchQuery)).sort(sortFn);
    outsideEvents=unfiltered.filter(e=>getSearchableText(e).includes(searchQuery)).sort(sortFn);
  } else if(sortMode==='match'&&hasSpotifyScores){
    // "My Picks" mode: show only top matches (score >= 50), sorted by score
    events=EVENTS.filter(filterFn).filter(e=>(eventMatchScores[e.id]||0)>=50).sort(sortFn);
  } else {
    events=EVENTS.filter(filterFn).sort(sortFn);
  }

  if(!events.length&&!outsideEvents.length){
    document.getElementById('results').innerHTML=`<div class="empty-state"><div class="big">∅</div><div style="font-size:14px">No events match${searchQuery?' "'+searchQuery+'"':' this filter'}</div></div>`;
    return;
  }

  const has=Object.keys(eventMatchScores).length>0;
  const mapLegendHtml=Object.entries(HOOD_COLORS).map(([hood,color])=>`<div class="map-legend-item"><div class="map-legend-dot" style="background:${color};box-shadow:0 0 6px ${color}80;"></div>${hood}</div>`).join('');
  const favCount=favourites.length;

  document.getElementById('results').innerHTML=`
    <div class="results-header">
      <div class="results-count">${events.length} events${outsideEvents.length?' + '+outsideEvents.length+' outside filters':''}${has?' · ranked':''}
        <button class="fav-filter-btn ${showFavsOnly?'active':''}" id="favFilterBtn" onclick="toggleFavFilter()">♥ ${favCount}</button>
      </div>
      <div style="display:flex;gap:12px;align-items:center;">
        <div class="view-toggle">
          <button class="view-btn ${viewMode==='list'?'active':''}" data-view="list" onclick="setView('list')">List</button>
          <button class="view-btn ${viewMode==='map'?'active':''}" data-view="map" onclick="setView('map')">Map</button>
        </div>
        <div class="sort-btns">
          <button class="sort-btn ${sortMode==='match'?'active':''}" data-sort="match" onclick="setSort('match')">My Picks</button>
          <button class="sort-btn ${sortMode==='day'?'active':''}" data-sort="day" onclick="setSort('day')">By Day</button>
          <button class="sort-btn ${sortMode==='buzz'?'active':''}" data-sort="buzz" onclick="setSort('buzz')">By Buzz</button>
        </div>
      </div>
    </div>
    ${viewMode==='map'?`<div class="map-legend">${mapLegendHtml}</div>`:''}
    <div id="mapContainer" class="${viewMode==='map'?'visible':''}"></div>
    <div class="events-grid" style="${viewMode==='map'?'display:none':''}">
      ${events.map(e=>renderCard(e,has,false)).join('')}
    </div>
    ${outsideEvents.length&&viewMode!=='map'?`
      <div class="search-divider">Outside your current filters</div>
      <div class="events-grid">${outsideEvents.map(e=>renderCard(e,has,true)).join('')}</div>
    `:''}`;

  if(viewMode==='map'){initMap();updateMap(events);}
}
