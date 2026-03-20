const CLIENT_ID = 'af89877b7d3a4e309afbdd30559fd1d6';
const REDIRECT_URI = 'https://nickisea387.github.io/mmw2026/';
const SCOPES = 'user-top-read user-read-recently-played user-read-private playlist-modify-private';

let activeGenres=new Set(['all']), activeDays=new Set(['all']), activeVtypes=new Set(['all']), activeBandwagons=new Set(['all']), trendingFilter='all', sortMode='day', minMentions=0, viewMode='list', searchQuery='';
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

// ── THEME TOGGLE ─────────────────────────────────────────────────────────────
function toggleTheme(){
  const isLight=document.documentElement.classList.toggle('light');
  localStorage.setItem('mmw_theme',isLight?'light':'dark');
  document.getElementById('themeToggle').innerHTML=isLight?'🌙 Dark Mode':'☀️ Light Mode';
}
(function(){
  const saved=localStorage.getItem('mmw_theme');
  if(saved==='light'){
    document.documentElement.classList.add('light');
    document.addEventListener('DOMContentLoaded',()=>{
      document.getElementById('themeToggle').innerHTML='🌙 Dark Mode';
    });
  }
})();

// ── AUTO-CLEAR STALE TOKENS ──────────────────────────────────────────────────
// If token is expired and refresh fails, clear everything so user sees Connect button
(function(){
  const expiry=parseInt(localStorage.getItem('sp_expiry')||'0');
  const hasRefresh=!!localStorage.getItem('sp_refresh');
  if(expiry&&Date.now()>expiry&&!hasRefresh){
    ['sp_access','sp_refresh','sp_expiry','sp_name','sp_scores','sp_profile'].forEach(k=>localStorage.removeItem(k));
  }
})();

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
    try{
      const t=await exchangeCode(code);
      saveTokens(t);
      sessionStorage.removeItem('pkce_v');sessionStorage.removeItem('pkce_s');
    }catch(err){showNotice(`Auth failed: ${err.message}`,'err');showAllEvents();return;}
    try{await loadAndAnalyze();}catch(err){console.error(err);showAllEvents();}
    return;
  }
  if(loadTokens()){
    const token=await getValidToken();
    if(!token){
      clearTokens();
      document.getElementById('connectBtn').style.display='flex';
      document.getElementById('authDesc').style.display='block';
      document.getElementById('connectedBadge').classList.remove('visible');
      showAllEvents();return;
    }
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
      fetch('https://api.spotify.com/v1/me/top/artists?limit=50&time_range=short_term',{headers}),  // Last ~4 weeks
      fetch('https://api.spotify.com/v1/me/top/tracks?limit=50&time_range=short_term',{headers}),   // Last ~4 weeks
      fetch('https://api.spotify.com/v1/me/player/recently-played?limit=50',{headers}),              // Last ~50 plays
      fetch('https://api.spotify.com/v1/me',{headers}),
    ]);
    // Check if any response failed (e.g. token expired / scope mismatch)
    if(!r1.ok||!r4.ok){
      clearTokens();
      showNotice('Spotify session expired — please reconnect.','warn');
      document.getElementById('connectBtn').style.display='flex';
      document.getElementById('authDesc').style.display='block';
      showAllEvents();return;
    }
    const [topArtists,topTracks,recent,profile]=await Promise.all([r1.json(),r2.json(),r3.json(),r4.json()]);
    document.getElementById('connectBtn').style.display='none';document.getElementById('authDesc').style.display='none';
    const displayName=profile.display_name||profile.id||'User';
    document.getElementById('spotifyName').textContent=displayName;document.getElementById('connectedBadge').classList.add('visible');
    localStorage.setItem('sp_name',displayName);
    await runAI({topArtists:topArtists||{},topTracks:topTracks||{},recent:recent||{}});
  }catch(err){
    console.error(err);
    clearTokens();
    showNotice('Spotify connection failed — please reconnect.','warn');
    document.getElementById('connectBtn').style.display='flex';
    document.getElementById('authDesc').style.display='block';
    showAllEvents();
  }
}

async function runAI({topArtists,topTracks,recent}){
  showLoading('Analyzing your listening history...');
  const topArtistNames=(topArtists?.items||[]).filter(a=>a&&a.name).map(a=>a.name).slice(0,25);
  const artists=topArtistNames.join(', ');
  const userGenres=[...new Set((topArtists?.items||[]).filter(a=>a&&a.genres).flatMap(a=>a.genres))].slice(0,25);
  const genres=userGenres.join(', ');
  const topTracksList=(topTracks?.items||[]).filter(t=>t&&t.name&&t.artists).map(t=>`${t.name} – ${t.artists[0]?.name||'Unknown'}`).slice(0,15);
  const tracks=topTracksList.join('; ');
  const recentArtists=[...new Set((recent?.items||[]).filter(i=>i&&i.track&&i.track.artists).map(i=>i.track.artists[0]?.name).filter(Boolean))].slice(0,20);
  const recents=recentArtists.join(', ');

  // Save rich Spotify profile for "My Picks" explainer
  const spotifyProfile={
    topArtists:topArtistNames,
    topGenres:userGenres,
    topTracks:topTracksList.slice(0,8),
    recentArtists:recentArtists,
  };
  localStorage.setItem('sp_profile',JSON.stringify(spotifyProfile));

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
    b.classList.add('visible');
  }catch(err){
    console.error(err);EVENTS.forEach(e=>{eventMatchScores[e.id]=e.hype*18;});
  }
  // Default to My Picks after Spotify connect
  sortMode='match';
  renderEvents();
  showHPModal(userGenres);
}

// ── HARRY POTTER ─────────────────────────────────────────────────────────────
// Broad keyword map: Spotify genre tags → character affinities
const HP_GENRE_MAP={
  // Luna: eclectic, experimental, ambient, world, psychedelic
  'Luna Lovegood':['ambient','experimental','psychedelic','new age','world','trip hop','chillwave','shoegaze','dream pop','ethereal','space','downtempo','idm','glitch','witch house','folklore'],
  // Snape: dark, intense, underground electronic
  'Severus Snape':['techno','dark','industrial','ebm','noise','hardstyle','gabber','acid','minimal techno','berlin'],
  // Fred & George: chaotic, fun, high energy
  'Fred & George Weasley':['trap','dubstep','bass','drum and bass','jungle','dnb','riddim','brostep','moombahton','jersey club','grime','uk bass','garage','2-step'],
  // Hermione: sophisticated, complex, refined
  'Hermione Granger':['progressive','electronica','deep house','organic house','melodic techno','classical crossover','neo-classical','intelligent','jazz','contemporary'],
  // Sirius: rebellious, underground, raw
  'Sirius Black':['punk','post-punk','indie','alternative','grunge','garage rock','underground','lo-fi','noise rock','new wave'],
  // Dumbledore: broad taste, timeless, wise
  'Dumbledore':['soul','funk','disco','jazz','blues','motown','classic','r&b','gospel','swing','vintage','bossa'],
  // Draco: sleek, polished, exclusive
  'Draco Malfoy':['tech house','minimal','microhouse','deep tech','uk house','bass house','future house','slap house'],
  // Hagrid: earthy, warm, global
  'Hagrid':['afro','african','latin','reggae','dancehall','cumbia','tribal','organic','world music','afrobeats','soca','zouk'],
  // Neville: understated, chill, grower
  'Neville Longbottom':['lo-fi','chill','bedroom','indie folk','soft','mellow','acoustic','singer-songwriter','emo','sad'],
  // Ginny: fierce, high energy, powerful
  'Ginny Weasley':['hard techno','rave','hardstyle','hardcore','peak time','big room','festival','mainstage','hard dance','rawstyle'],
  // Tonks: shapeshifter, genre-fluid
  'Tonks':['electro','breakbeat','uk garage','speed garage','breaks','house','fidget','electro house','nu disco'],
  // Dobby: pure, emotional, uplifting
  'Dobby':['trance','uplifting','vocal trance','euphoric','anjuna','above beyond','emotional','epic','anthem'],
  // McGonagall: proper, classic, quality
  'McGonagall':['classic house','chicago','detroit','soulful','garage','uk garage','vocal house','gospel house','warehouse'],
  // Bellatrix: extreme, unhinged
  'Bellatrix Lestrange':['metal','death metal','black metal','noise','power electronics','harsh','extreme','screamo','deathcore'],
  // Harry: mainstream but genuine, popular
  'Harry Potter':['pop','dance pop','edm','electropop','synth pop','future bass','tropical','mainstream','chart','top 40','radio'],
  // Ron: fun-loving, crowd-pleaser
  'Ron Weasley':['party','dance','club','bounce','melbourne bounce','commercial','hands up','eurodance','happy hardcore'],
  // Lupin: thoughtful, shifts between calm and wild
  'Lupin':['deep house','organic house','downtempo','electronica','ambient house','balearic','slow house','dub','dub techno'],
  // Cedric: golden, anthemic
  'Cedric Diggory':['melodic house','progressive house','vocal house','anthem','swedish house','big room progressive','epic trance'],
  // Molly: timeless classics, warm
  'Molly Weasley':['70s','80s','classic rock','soft rock','adult contemporary','oldies','country','folk','americana','easy listening'],
  // Newt: curious, rare, unusual
  'Newt Scamander':['field recording','musique concrete','avant-garde','free jazz','noise pop','art pop','outsider','microtonal','found sound'],
};

function showHPModal(userGenres){
  const genreStr=(userGenres||[]).join(' ').toLowerCase();
  // Also check top artists for additional signal
  const profile=JSON.parse(localStorage.getItem('sp_profile')||'null');
  const artistStr=(profile?.topArtists||[]).join(' ').toLowerCase();
  const combinedStr=genreStr+' '+artistStr;

  let bestChar=null,bestScore=0;
  HP_CHARACTERS.forEach(ch=>{
    const keywords=HP_GENRE_MAP[ch.name]||ch.genres||[];
    let score=0;
    keywords.forEach(k=>{
      if(combinedStr.includes(k)) score+=3;
      // Partial word match for compound genres
      k.split(' ').forEach(w=>{if(w.length>2&&combinedStr.includes(w)) score+=1;});
    });
    if(score>bestScore){bestScore=score;bestChar=ch;}
  });

  // Better fallback based on broader patterns
  if(bestScore<3){
    if(combinedStr.match(/house|edm|electronic|dance|dj|club|techno|beat/)) bestChar=HP_CHARACTERS.find(c=>c.name==='Harry Potter');
    else if(combinedStr.match(/pop|hip.?hop|rap|r&b|urban|latin|reggaeton/)) bestChar=HP_CHARACTERS.find(c=>c.name==='Ron Weasley');
    else if(combinedStr.match(/rock|indie|alternative|punk|metal/)) bestChar=HP_CHARACTERS.find(c=>c.name==='Sirius Black');
    else if(combinedStr.match(/jazz|soul|funk|blues|classical/)) bestChar=HP_CHARACTERS.find(c=>c.name==='Dumbledore');
    else bestChar=HP_CHARACTERS.find(c=>c.name==='Hermione Granger');
    bestChar=bestChar||HP_CHARACTERS[0];
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
function getTicketUrl(e){
  if(e.ticketUrl) return e.ticketUrl;
  return `https://www.eventbrite.com/d/fl--miami/${encodeURIComponent(e.name.replace(/[^\w\s]/g,'').replace(/\s+/g,'-').toLowerCase())}/`;
}

// Artist Spotify ID cache (persisted to localStorage) — v2 clears old bad matches
if(localStorage.getItem('mmw_artist_cache_v')!=='2'){localStorage.removeItem('mmw_artist_ids');localStorage.setItem('mmw_artist_cache_v','2');}
let artistSpotifyCache=JSON.parse(localStorage.getItem('mmw_artist_ids')||'{}');
function saveArtistCache(){localStorage.setItem('mmw_artist_ids',JSON.stringify(artistSpotifyCache));}

// Resolve an artist name to a Spotify artist object {id, uri, name}
async function resolveArtist(name){
  const clean=name.replace(/\s*\(.*?\)/g,'').trim();
  const key=clean.toLowerCase();
  if(artistSpotifyCache[key]) return artistSpotifyCache[key];
  const token=await getValidToken();
  if(!token) return null;
  try{
    // Try exact search first, then broader search for ALL CAPS names like ANNA
    const queries=[`artist:"${clean}"`,clean];
    for(const q of queries){
      const r=await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=artist&limit=5`,{
        headers:{Authorization:`Bearer ${token}`}
      });
      if(!r.ok) continue;
      const data=await r.json();
      const items=data.artists?.items||[];
      // Find best match — prefer exact case-insensitive name match
      const exact=items.find(a=>a.name.toLowerCase()===clean.toLowerCase());
      const artist=exact||items[0];
      if(artist){
        const result={id:artist.id,uri:artist.uri,name:artist.name};
        artistSpotifyCache[key]=result;
        saveArtistCache();
        return result;
      }
    }
    return null;
  }catch(e){return null;}
}

// Get top tracks for an artist
async function getArtistTopTracks(artistId){
  const token=await getValidToken();
  if(!token) return [];
  try{
    const r=await fetch(`https://api.spotify.com/v1/artists/${artistId}/top-tracks?market=US`,{
      headers:{Authorization:`Bearer ${token}`}
    });
    if(!r.ok) return [];
    const data=await r.json();
    return (data.tracks||[]).slice(0,3);
  }catch(e){return [];}
}

// ── SPOTIFY EMBED (TIER 1: no extra auth, 30-sec previews inline) ───────────
function toggleEmbed(eventId){
  const container=document.getElementById(`embed-${eventId}`);
  if(!container) return;
  if(container.style.display==='block'){
    container.style.display='none';
    container.innerHTML='';
    return;
  }
  container.style.display='block';
  container.innerHTML=`<div style="padding:12px;color:var(--muted);font-size:11px;">Loading artist previews...</div>`;
  loadEmbeds(eventId,container);
}

async function loadEmbeds(eventId,container){
  const event=EVENTS.find(e=>e.id===eventId);
  if(!event){container.innerHTML='';return;}
  // Get ALL artists, not just 4
  const names=event.artists.split(/,\s*/)
    .flatMap(a=>a.split(/\s+b2b\s+/i))
    .map(a=>a.replace(/\s*\(.*?\)/g,'').trim())
    .filter(a=>a&&a!=='TBA'&&!a.includes('rumored')&&!a.includes('surprise'));

  // Refresh token if needed before loading embeds
  const token=await getValidToken();
  if(!token){
    container.innerHTML=`<div style="padding:8px;font-size:12px;"><a href="https://open.spotify.com/search/${encodeURIComponent(names.join(' '))}" target="_blank" style="color:white;">Open in Spotify →</a></div>`;
    return;
  }

  const artists=await Promise.all(names.map(n=>resolveArtist(n)));
  const valid=artists.filter(Boolean);

  if(!valid.length){
    container.innerHTML=`<div style="padding:8px;font-size:12px;color:var(--muted);">Could not find artists. <a href="https://open.spotify.com/search/${encodeURIComponent(names.join(' '))}" target="_blank" style="color:white;">Search on Spotify →</a></div>`;
    return;
  }

  // Scrollable container with compact embeds for ALL artists
  container.innerHTML=`<div style="max-height:400px;overflow-y:auto;display:flex;flex-direction:column;gap:2px;">${valid.map(a=>
    `<iframe src="https://open.spotify.com/embed/artist/${a.id}?utm_source=generator&theme=0" width="100%" height="80" frameborder="0" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy" style="border-radius:4px;flex-shrink:0;"></iframe>`
  ).join('')}</div><button class="play-btn" style="margin-top:6px;width:100%;" data-playlist-btn="${eventId}" onclick="createEventPlaylist(${eventId})">Create Full Playlist</button>`;
}

// ── CREATE PLAYLIST (TIER 2: needs playlist-modify-private scope) ───────────
async function createEventPlaylist(eventId){
  const event=EVENTS.find(e=>e.id===eventId);
  if(!event) return;
  const token=await getValidToken();
  if(!token){showNotice('Connect Spotify to create playlists.','warn');return;}

  const btn=document.querySelector(`[data-playlist-btn="${eventId}"]`);
  if(btn){btn.textContent='Creating playlist...';btn.disabled=true;}

  try{
    // 1. Get artist names
    const names=event.artists.split(/,\s*/)
      .map(a=>a.replace(/\s*b2b\s+.*/i,'').replace(/\s*\(.*?\)/g,'').trim())
      .filter(a=>a&&a!=='TBA')
      .slice(0,8);

    // 2. Resolve all artists and get top tracks
    const artists=await Promise.all(names.map(n=>resolveArtist(n)));
    const validArtists=artists.filter(Boolean);
    if(!validArtists.length){
      showNotice('Could not find artists on Spotify.','warn');
      if(btn){btn.textContent='Create Full Playlist';btn.disabled=false;}
      return;
    }

    const trackArrays=await Promise.all(validArtists.map(a=>getArtistTopTracks(a.id)));
    const trackUris=trackArrays.flat().map(t=>t.uri);
    if(!trackUris.length){
      showNotice('No tracks found for these artists.','warn');
      if(btn){btn.textContent='Create Full Playlist';btn.disabled=false;}
      return;
    }

    // 3. Get user ID
    const meR=await fetch('https://api.spotify.com/v1/me',{headers:{Authorization:`Bearer ${token}`}});
    const me=await meR.json();

    // 4. Create playlist
    const playlistName=`MMW 2026: ${event.name}`;
    const playlistDesc=`${event.dayLabel} @ ${event.venue} — Top tracks from ${validArtists.map(a=>a.name).join(', ')}. Generated by MMW 2026 Planner.`;
    const createR=await fetch(`https://api.spotify.com/v1/users/${me.id}/playlists`,{
      method:'POST',
      headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body:JSON.stringify({name:playlistName,description:playlistDesc,public:false})
    });
    if(!createR.ok){
      const err=await createR.json();
      if(err.error?.status===403){
        showNotice('Playlist permission needed. Click "Connect with Spotify" to re-authorize.','warn');
        if(btn){btn.textContent='Create Full Playlist';btn.disabled=false;}
        return;
      }
      throw new Error(err.error?.message||'Failed to create playlist');
    }
    const playlist=await createR.json();

    // 5. Add tracks (max 100 per request)
    await fetch(`https://api.spotify.com/v1/playlists/${playlist.id}/tracks`,{
      method:'POST',
      headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body:JSON.stringify({uris:trackUris.slice(0,100)})
    });

    // 6. Open the playlist
    window.open(playlist.external_urls.spotify,'_blank');
    if(btn){
      btn.textContent='Playlist Created';
      btn.style.borderColor='var(--green)';btn.style.color='var(--green)';
      setTimeout(()=>{btn.textContent='Create Full Playlist';btn.disabled=false;},4000);
    }

  }catch(err){
    console.error('Playlist creation failed:',err);
    showNotice(`Playlist error: ${err.message}`,'err');
    if(btn){btn.textContent='Create Full Playlist';btn.disabled=false;}
  }
}

// ── UNIFIED playSet: show inline embeds + playlist button ───────────────────
function playSet(eventId){
  toggleEmbed(eventId);
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
function toggleVtype(btn){
  const v=btn.dataset.vtype;
  if(v==='all'){activeVtypes=new Set(['all']);}
  else{activeVtypes.delete('all');if(activeVtypes.has(v)) activeVtypes.delete(v);else activeVtypes.add(v);if(!activeVtypes.size) activeVtypes=new Set(['all']);}
  document.querySelectorAll('[data-vtype]').forEach(b=>b.classList.toggle('active',activeVtypes.has(b.dataset.vtype)));
  renderEvents();
}
function toggleBandwagon(btn){
  const v=btn.dataset.bw;
  if(v==='0'){activeBandwagons=new Set(['all']);}
  else{activeBandwagons.delete('all');if(activeBandwagons.has(v)) activeBandwagons.delete(v);else activeBandwagons.add(v);if(!activeBandwagons.size) activeBandwagons=new Set(['all']);}
  document.querySelectorAll('[data-bw]').forEach(b=>b.classList.toggle('active',activeBandwagons.has(b.dataset.bw)||(activeBandwagons.has('all')&&b.dataset.bw==='0')));
  renderEvents();
}
function toggleTrending(btn){
  trendingFilter=btn.dataset.trend;
  document.querySelectorAll('[data-trend]').forEach(b=>b.classList.toggle('active',b.dataset.trend===trendingFilter));
  renderEvents();
}
function toggleMentions(btn){document.querySelectorAll('.mentions-btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');minMentions=parseInt(btn.dataset.mentions);renderEvents();}
function setMode(sort,view){
  sortMode=sort;viewMode=view;renderEvents();
}
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
      const tUrl=getTicketUrl(e);
      html+=`<div class="popup-event"><div class="popup-event-name"><a href="${tUrl}" target="_blank" rel="noopener" style="color:white;text-decoration:none;">${e.name}</a>${sc}</div><div class="popup-event-meta">${e.dayLabel} · ${e.time}</div><div class="popup-event-meta" style="color:#bbb">${linkifyArtists(e.artists)}</div></div>`;
    });
    html+='</div>';
    marker.bindPopup(html,{maxWidth:320,minWidth:240});mapMarkers.push(marker);
  });
  setTimeout(()=>{if(map) map.invalidateSize();},150);
}

// ── MY PICKS EXPLAINER ───────────────────────────────────────────────────────
function getMatchReason(event){
  const profile=JSON.parse(localStorage.getItem('sp_profile')||'null');
  if(!profile) return '';
  const reasons=[];
  const eventArtists=event.artists.toLowerCase();
  const eventKeywords=event.matchKeywords.map(k=>k.toLowerCase());

  // Check direct artist overlaps
  const directMatches=profile.topArtists.filter(a=>eventArtists.includes(a.toLowerCase()));
  const recentMatches=profile.recentArtists.filter(a=>eventArtists.includes(a.toLowerCase()));
  if(directMatches.length) reasons.push(`You listen to <strong>${directMatches.join(', ')}</strong>`);
  else if(recentMatches.length) reasons.push(`You recently played <strong>${recentMatches.join(', ')}</strong>`);

  // Check genre overlaps
  const eventGenreStr=event.genre.join(' ')+' '+eventKeywords.join(' ');
  const genreMatches=profile.topGenres.filter(g=>eventGenreStr.includes(g.split(' ')[0])).slice(0,3);
  if(genreMatches.length&&!directMatches.length) reasons.push(`Matches your <strong>${genreMatches.join(', ')}</strong> taste`);

  return reasons.join(' · ')||'';
}

function buildMyPicksSummary(events){
  const profile=JSON.parse(localStorage.getItem('sp_profile')||'null');
  if(!profile) return '';
  const savedScores=JSON.parse(localStorage.getItem('sp_scores')||'null');

  const topArtists=profile.topArtists.slice(0,5);
  const topGenres=profile.topGenres.slice(0,5);

  // Find which of their artists appear in the picks
  const allPickArtists=events.map(e=>e.artists.toLowerCase()).join(' ');
  const artistsInPicks=profile.topArtists.filter(a=>allPickArtists.includes(a.toLowerCase()));
  const recentInPicks=profile.recentArtists.filter(a=>allPickArtists.includes(a.toLowerCase()));

  // Map each matched artist to the event they're in
  function findEventForArtist(name){
    return events.find(e=>e.artists.toLowerCase().includes(name.toLowerCase()));
  }

  // Count genre distribution in picks
  const genreCounts={};
  events.forEach(e=>e.genre.forEach(g=>{genreCounts[g]=(genreCounts[g]||0)+1;}));
  const topPickGenres=Object.entries(genreCounts).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([g])=>g);

  // Count venue type distribution
  const typeCounts={};
  events.forEach(e=>{typeCounts[e.type]=(typeCounts[e.type]||0)+1;});
  const topTypes=Object.entries(typeCounts).sort((a,b)=>b[1]-a[1]).slice(0,2).map(([t])=>t);

  // Count day distribution & find best day + top event on that day
  const dayCounts={};
  const dayEvents={};
  events.forEach(e=>{
    dayCounts[e.dayLabel]=(dayCounts[e.dayLabel]||0)+1;
    if(!dayEvents[e.dayLabel]) dayEvents[e.dayLabel]=e;
    else if((eventMatchScores[e.id]||0)>(eventMatchScores[dayEvents[e.dayLabel].id]||0)) dayEvents[e.dayLabel]=e;
  });
  const bestDayEntry=Object.entries(dayCounts).sort((a,b)=>b[1]-a[1])[0];
  const bestDayTopEvent=bestDayEntry?dayEvents[bestDayEntry[0]]:null;

  // Find best venue based on picks
  const venueCounts={};
  events.forEach(e=>{venueCounts[e.venue]=(venueCounts[e.venue]||0)+1;});
  const topVenue=Object.entries(venueCounts).sort((a,b)=>b[1]-a[1])[0];

  // Taste summary from AI or fallback
  const tasteSummary=savedScores?.tasteSummary||'';

  let html=`<div class="picks-summary">`;
  html+=`<div class="picks-summary-title">Why these ${events.length} picks?</div>`;
  html+=`<div class="picks-summary-body">`;

  // Your sound — from AI taste summary, Spotify genres, or derived from picks
  if(tasteSummary){
    html+=`<div class="picks-insight"><span class="picks-icon">🎧</span><div><strong>Your sound:</strong> ${tasteSummary}</div></div>`;
  } else {
    // Build a taste description from what we know
    const soundParts=[];
    if(topGenres.length) soundParts.push(`Based on your Spotify, you're into <strong>${topGenres.slice(0,4).join(', ')}</strong>`);
    if(artistsInPicks.length) soundParts.push(`and artists like <strong>${artistsInPicks.slice(0,3).join(', ')}</strong> are right in your wheelhouse`);
    if(!soundParts.length) soundParts.push(`Based on <strong>${topArtists.slice(0,3).join(', ')}</strong> in your library, we matched you to <strong>${topPickGenres.join(', ')}</strong> events`);
    html+=`<div class="picks-insight"><span class="picks-icon">🎧</span><div><strong>Your sound:</strong> ${soundParts.join(' ')}. We picked the ${events.length} events you'll vibe with most.</div></div>`;
  }

  // Top artists — linked to Spotify
  const artistLinks=topArtists.map(a=>`<a href="https://open.spotify.com/search/${encodeURIComponent(a)}" target="_blank" rel="noopener" class="picks-link">${a}</a>`);
  html+=`<div class="picks-insight"><span class="picks-icon">⭐</span><div><strong>Most played this month:</strong> ${artistLinks.join(', ')}</div></div>`;

  // Direct artist matches — each links to the event they're in
  if(artistsInPicks.length){
    const matchLinks=artistsInPicks.map(a=>{
      const ev=findEventForArtist(a);
      return ev?`<a href="#" onclick="document.getElementById('searchInput').value='${a.replace(/'/g,"\\'")}';handleSearch('${a.replace(/'/g,"\\'")}');return false;" class="picks-link-highlight">${a}</a>`:`<span>${a}</span>`;
    });
    html+=`<div class="picks-insight picks-highlight"><span class="picks-icon">🎯</span><div><strong>${artistsInPicks.length} artist${artistsInPicks.length>1?'s':''} you've been playing this month ${artistsInPicks.length>1?'are':'is'} performing:</strong> ${matchLinks.join(', ')}</div></div>`;
  }

  // Recently played matches — linked to search
  const uniqueRecent=recentInPicks.filter(a=>!artistsInPicks.includes(a));
  if(uniqueRecent.length){
    const recentLinks=uniqueRecent.map(a=>`<a href="#" onclick="document.getElementById('searchInput').value='${a.replace(/'/g,"\\'")}';handleSearch('${a.replace(/'/g,"\\'")}');return false;" class="picks-link">${a}</a>`);
    html+=`<div class="picks-insight"><span class="picks-icon">🔄</span><div><strong>In your last 7 days:</strong> ${recentLinks.join(', ')} — also playing this week</div></div>`;
  }

  // Genre breakdown — clickable to filter
  const genreLinks=topPickGenres.map(g=>`<a href="#" onclick="activeGenres=new Set(['${g}']);document.querySelectorAll('.genre-chip').forEach(b=>b.classList.toggle('active',b.dataset.genre==='${g}'));setMode('day','list');return false;" class="picks-link">${g}</a>`);
  html+=`<div class="picks-insight"><span class="picks-icon">🎵</span><div><strong>These picks lean:</strong> ${genreLinks.join(', ')} — matching your listening profile</div></div>`;

  // Best day — with top event recommendation
  if(bestDayEntry){
    let dayHtml=`<strong>Your biggest day:</strong> ${bestDayEntry[0]} (${bestDayEntry[1]} picks)`;
    if(bestDayTopEvent) dayHtml+=` — don't miss <a href="#" onclick="document.getElementById('searchInput').value='${bestDayTopEvent.name.replace(/'/g,"\\'")}';handleSearch('${bestDayTopEvent.name.replace(/'/g,"\\'")}');return false;" class="picks-link-highlight">${bestDayTopEvent.name}</a>`;
    html+=`<div class="picks-insight"><span class="picks-icon">📅</span><div>${dayHtml}</div></div>`;
  }

  // Venue mix — with top venue recommendation
  let venueHtml=`<strong>Venue mix:</strong> Mostly ${topTypes.join(' + ')} events`;
  if(topVenue) venueHtml+=` — <a href="#" onclick="document.getElementById('searchInput').value='${topVenue[0].replace(/'/g,"\\'")}';handleSearch('${topVenue[0].replace(/'/g,"\\'")}');return false;" class="picks-link-highlight">${topVenue[0]}</a> has ${topVenue[1]} of your picks`;
  html+=`<div class="picks-insight"><span class="picks-icon">📍</span><div>${venueHtml}</div></div>`;

  // Biggest discovery event — find event with decent score but NO direct artist overlap
  const discoveryEvent=events.find(e=>{
    const eArtists=e.artists.toLowerCase();
    const hasDirectMatch=profile.topArtists.some(a=>eArtists.includes(a.toLowerCase()))||
                         profile.recentArtists.some(a=>eArtists.includes(a.toLowerCase()));
    return !hasDirectMatch&&(eventMatchScores[e.id]||0)>=40;
  });
  if(discoveryEvent){
    const dGenres=discoveryEvent.genre.slice(0,2).join(', ');
    html+=`<div class="picks-insight" style="border-top:1px solid var(--border);padding-top:12px;margin-top:4px;"><span class="picks-icon">🔮</span><div><strong>Biggest discovery:</strong> <a href="#" onclick="document.getElementById('searchInput').value='${discoveryEvent.name.replace(/'/g,"\\'")}';handleSearch('${discoveryEvent.name.replace(/'/g,"\\'")}');return false;" class="picks-link-highlight">${discoveryEvent.name}</a> — you don't listen to these artists yet, but based on your ${dGenres} taste, this could be your new favourite find this week.</div></div>`;
  }

  html+=`</div></div>`;
  return html;
}

// ── BANDWAGON DISPLAY ────────────────────────────────────────────────────────
function getBandwagonDisplay(bw){
  if(!bw) return {label:'',cls:''};
  if(bw>=5) return {label:'BANDWAGON 🎪',cls:'bw-high'};
  if(bw>=4) return {label:'POPULAR 🎵',cls:'bw-med'};
  if(bw>=3) return {label:'KNOWN 👀',cls:'bw-low'};
  if(bw>=2) return {label:'UNDERGROUND 🔊',cls:'bw-ug'};
  return {label:'DEEP CUT 💎',cls:'bw-deep'};
}

// ── RENDER CARD ──────────────────────────────────────────────────────────────
function renderCard(e,has,dimmed){
  const s=eventMatchScores[e.id]||0;
  const cls=has?(s>=70?'match-high':s>=40?'match-med':'match-low'):'match-low';
  const reason=s>=70?'Strong match':s>=50?'Good match':s>=30?'Worth exploring':'Outside your usual';
  const stars='★'.repeat(s>=70?3:s>=45?2:1)+'☆'.repeat(s>=70?0:s>=45?1:2);
  const md=getMentionsDisplay(e.mentions);
  const bw=getBandwagonDisplay(e.bandwagon);
  const isTrending=typeof TRENDING_IDS!=='undefined'&&TRENDING_IDS.includes(e.id);
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
          <div class="event-name"><a href="${ticketUrl}" target="_blank" rel="noopener" class="event-link">${e.name}</a><span class="tag ${e.type}">${e.type}</span>${isTrending?`<span class="trending-badge" data-tip="This event scores high on editorial buzz (${e.mentions} sources) relative to how underground the act is. Underground artists getting unexpected press trend faster.">🔥 TRENDING</span>`:''}</div>
          <div class="event-meta"><span class="venue">${e.venue}</span><span>${e.dayLabel}</span><span>${e.time}</span></div>
          <div class="artists">${linkifyArtists(e.artists)}</div>
          <div class="event-genres">${e.genre.map(g=>`<button class="genre-tag" onclick="activeGenres=new Set(['${g}']);document.querySelectorAll('.genre-chip').forEach(b=>b.classList.toggle('active',b.dataset.genre==='${g}'));setMode('day','list');return false;">${g}</button>`).join('')}</div>
          <div class="event-summary">${e.summary}</div>
          ${sortMode==='match'&&getMatchReason(e)?`<div class="event-match-reason">🎯 ${getMatchReason(e)}</div>`:''}
          ${crowd?`<div class="event-crowd"><strong>TLDR:</strong> ${crowd}</div>`:''}
          <div class="event-actions">
            <div class="mentions-badge ${md.cls}">${md.flames} ${md.text}</div>
            ${bw.label?`<span class="bandwagon-badge ${bw.cls}">${bw.label}</span>`:''}
            <button class="play-btn" onclick="playSet(${e.id})" title="Preview artists on Spotify">▶ Play Set</button>
            <button class="fav-btn ${isFav?'active':''}" onclick="toggleFav(${e.id})" title="${isFav?'Remove from':'Add to'} favourites">${isFav?'♥':'♡'}</button>
          </div>
          <div id="embed-${e.id}" class="spotify-embed-container" style="display:none;margin-top:10px;"></div>
        </div>
        ${has?`<div class="match-badge"><div class="match-score">${s}</div><div class="match-label">match</div><div class="match-reason">${reason}</div><div style="font-size:10px;letter-spacing:-1px;color:var(--muted)">${stars}</div></div>`
             :`<div class="match-badge"><div class="match-score" style="font-size:18px;color:var(--muted2)">—</div></div>`}
      </div>
    </div>
  </div>`;
}

// ── LAZY LOADING ─────────────────────────────────────────────────────────────
let allFilteredEvents=[], renderedCount=0;
const BATCH_SIZE=20;

function renderMoreCards(){
  const grid=document.querySelector('.events-grid');
  if(!grid||renderedCount>=allFilteredEvents.length) return;
  const has=Object.keys(eventMatchScores).length>0;
  const next=allFilteredEvents.slice(renderedCount,renderedCount+BATCH_SIZE);
  next.forEach(e=>{
    const div=document.createElement('div');
    div.innerHTML=renderCard(e,has,false);
    grid.appendChild(div.firstElementChild);
  });
  renderedCount+=next.length;
  updateLoadMore();
}

function updateLoadMore(){
  const btn=document.getElementById('loadMoreBtn');
  if(!btn) return;
  if(renderedCount>=allFilteredEvents.length) btn.style.display='none';
  else btn.textContent=`Show more (${allFilteredEvents.length-renderedCount} remaining)`;
}

// ── MAIN RENDER ──────────────────────────────────────────────────────────────
function renderEvents(){
  const dayOrder=['tue','wed','thu','fri','sat','sun'];
  const filterFn=e=>
    (activeDays.has('all')||activeDays.has(e.day))&&
    (activeGenres.has('all')||e.genre.some(g=>activeGenres.has(g)||(activeGenres.has('house')&&g.includes('house'))))&&
    (activeVtypes.has('all')||activeVtypes.has(e.type))&&
    (activeBandwagons.has('all')||activeBandwagons.has(String(e.bandwagon||0)))&&
    (trendingFilter==='all'||(typeof TRENDING_IDS!=='undefined'&&TRENDING_IDS.includes(e.id)))&&
    (e.mentions>=minMentions)&&
    (!showFavsOnly||favourites.includes(e.id));
  const sortFn=(a,b)=>{
    if(sortMode==='match') return (eventMatchScores[b.id]||0)-(eventMatchScores[a.id]||0)||b.mentions-a.mentions;
    if(sortMode==='day') return dayOrder.indexOf(a.day)-dayOrder.indexOf(b.day)||(a.time<b.time?-1:1);
    if(sortMode==='buzz') return b.mentions-a.mentions||b.hype-a.hype;
    return 0;
  };

  const hasSpotifyScores=Object.keys(eventMatchScores).length>0;
  let events,outsideEvents=[];
  if(searchQuery){
    const filtered=EVENTS.filter(filterFn);
    const unfiltered=EVENTS.filter(e=>!filterFn(e));
    events=filtered.filter(e=>getSearchableText(e).includes(searchQuery)).sort(sortFn);
    outsideEvents=unfiltered.filter(e=>getSearchableText(e).includes(searchQuery)).sort(sortFn);
  } else if(sortMode==='match'){
    if(hasSpotifyScores){
      // My Picks: show top 15 events ranked by match score
      events=EVENTS.filter(filterFn).sort(sortFn).slice(0,15);
    } else {
      // No Spotify: show prompt
      document.getElementById('results').innerHTML=`<div class="empty-state"><div class="big">🎧</div><div style="font-size:16px;color:var(--text);margin-bottom:8px;">Connect Spotify to unlock My Picks</div><div style="font-size:13px;color:var(--muted);line-height:1.7">We'll analyze your listening history and show<br>only the events that match your taste</div><br><button class="submit-btn" onclick="startAuth()">Connect Spotify →</button></div>`;
      return;
    }
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

  // Store for lazy loading
  allFilteredEvents=events;
  const initialEvents=events.slice(0,BATCH_SIZE);
  renderedCount=initialEvents.length;

  document.getElementById('results').innerHTML=`
    <div class="results-header">
      <div class="results-count">${events.length} events${outsideEvents.length?' + '+outsideEvents.length+' outside filters':''}${sortMode==='match'?' · your top picks':''}
        <button class="fav-filter-btn ${showFavsOnly?'active':''}" id="favFilterBtn" onclick="toggleFavFilter()">♥ ${favCount}</button>
      </div>
      <div class="mode-btns">
        <button class="mode-btn ${sortMode==='match'&&viewMode==='list'?'active':''}" onclick="setMode('match','list')">My Picks</button>
        <button class="mode-btn ${sortMode==='day'&&viewMode==='list'?'active':''}" onclick="setMode('day','list')">By Day</button>
        <button class="mode-btn ${sortMode==='buzz'&&viewMode==='list'?'active':''}" onclick="setMode('buzz','list')">By Buzz</button>
        <button class="mode-btn ${viewMode==='map'?'active':''}" onclick="setMode(sortMode,'map')">Map</button>
      </div>
    </div>
    ${sortMode==='match'&&viewMode!=='map'?buildMyPicksSummary(EVENTS.sort((a,b)=>(eventMatchScores[b.id]||0)-(eventMatchScores[a.id]||0)).slice(0,15)):''}
    ${viewMode==='map'?`<div class="map-legend">${mapLegendHtml}</div>`:''}
    <div id="mapContainer" class="${viewMode==='map'?'visible':''}"></div>
    <div class="events-grid" style="${viewMode==='map'?'display:none':''}">
      ${initialEvents.map(e=>renderCard(e,has,false)).join('')}
    </div>
    ${events.length>BATCH_SIZE&&viewMode!=='map'?`<button class="load-more-btn" id="loadMoreBtn" onclick="renderMoreCards()">Show more (${events.length-BATCH_SIZE} remaining)</button>`:''}
    ${outsideEvents.length&&viewMode!=='map'?`
      <div class="search-divider">Outside your current filters</div>
      <div class="events-grid">${outsideEvents.map(e=>renderCard(e,has,true)).join('')}</div>
    `:''}`;

  if(viewMode==='map'){initMap();updateMap(events);}

  // Infinite scroll
  if(viewMode==='list'&&events.length>BATCH_SIZE){
    const observer=new IntersectionObserver((entries)=>{
      if(entries[0].isIntersecting&&renderedCount<allFilteredEvents.length){renderMoreCards();}
    },{threshold:0.1});
    const btn=document.getElementById('loadMoreBtn');
    if(btn) observer.observe(btn);
  }
}
