/* nexus_bridge.js + UI desktop patch
   Bridge externo para:
   - Subida de videos/ historias a Supabase Storage (evitando Base64)
   - Sincronización de chats (IndexedDB <-> Supabase)
   - Presencia básica (online/offline)
   - UI mejorada para laptop/PC (2 columnas, videos grandes)
   - No redeclara variables globales (usa window.user, window.db)
*/

/* ========== CONFIG: REMPLAZA ESTO ========== */
const SUPABASE_URL = "https://dmlwrwovwzvcfeoxyxtb.supabase.co";           // <- pon tu URL
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRtbHdyd292d3p2Y2Zlb3h5eHRiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc2NjMzNTgsImV4cCI6MjA4MzIzOTM1OH0.hukw5FC7S3gV-4PFh1Bskj9dm_7qsNTrrKVJqh2ORMQ";         // <- pon tu ANON KEY
const VIDEOS_BUCKET = "videos";   // crea este bucket en Supabase Storage
const STORIES_BUCKET = "stories"; // crea este bucket en Supabase Storage
const POLL_INTERVAL_MS = 2000;    // cada 2s revisa la BD local para sync

/* ========== NO TOCAR MÁS ABAJO (salvo la config) ========== */
(function () {
  // ====== USER GLOBAL ======
  window.user = window.user || JSON.parse(localStorage.getItem('nexus_v9_user') || 'null');
  const user = window.user || null;

  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    console.error("Supabase JS no encontrado. Asegúrate de incluir el CDN antes del bridge.");
    return;
  }

  const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // ===== Helpers =====
  function waitForDB(timeout = 15000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function check() {
        if (window.db) return resolve(window.db);
        if (Date.now() - start > timeout) return reject(new Error("Timeout esperando IndexedDB (window.db)"));
        setTimeout(check, 200);
      })();
    });
  }

  function dataURLtoBlob(dataurl) {
    const arr = dataurl.split(',');
    const mime = arr[0].match(/:(.*?);/)[1];
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) u8arr[n] = bstr.charCodeAt(n);
    return new Blob([u8arr], { type: mime });
  }

  async function uploadFileToStorage(bucket, file, path) {
    try {
      const filePath = path || `${user ? user.email.replace(/[@.]/g, '_') : 'anon'}_${Date.now()}_${file.name}`;
      const { error } = await supabase.storage.from(bucket).upload(filePath, file, { upsert: false });
      if (error) throw error;
      const { data: pub } = supabase.storage.from(bucket).getPublicUrl(filePath);
      return pub.publicUrl;
    } catch (err) {
      console.error("uploadFileToStorage error:", err);
      throw err;
    }
  }

  async function createRemoteVideoRecord(meta) {
    try {
      const { error } = await supabase.from('videos').insert([meta]);
      if (error) console.error("createRemoteVideoRecord:", error);
    } catch (err) {
      console.error("createRemoteVideoRecord:", err);
    }
  }

  async function createRemoteStoryRecord(meta) {
    try {
      const { error } = await supabase.from('stories').insert([meta]);
      if (error) console.error("createRemoteStoryRecord:", error);
    } catch (err) {
      console.error("createRemoteStoryRecord:", err);
    }
  }

  async function syncLocalVideos(db) {
    try {
      const tx = db.transaction("videos", "readwrite");
      const store = tx.objectStore("videos");
      store.getAll().onsuccess = async (e) => {
        const list = e.target.result || [];
        for (const v of list) {
          if (v.blob && typeof v.blob === 'string' && v.blob.startsWith('data:') && !v.synced) {
            try {
              const blob = dataURLtoBlob(v.blob);
              const file = new File([blob], (v.title || 'video') + '.webm', { type: blob.type || 'video/webm' });
              const publicUrl = await uploadFileToStorage(VIDEOS_BUCKET, file);
              v.blob = publicUrl;
              v.remote_url = publicUrl;
              v.synced = true;
              store.put(v);
              createRemoteVideoRecord({
                title: v.title || 'Untitled',
                url: publicUrl,
                type: v.type || 'video',
                author: v.author || (user && user.name) || null,
                email: v.email || (user && user.email) || null,
                pfp: v.pfp || (user && user.pfp) || null,
                color: v.color || (user && user.color) || null,
                timestamp: v.timestamp || Date.now()
              });
              console.info("Video subido y actualizado local:", publicUrl);
            } catch (err) {
              console.error("Error subiendo video local:", err);
            }
          }
        }
      };
    } catch (err) {
      console.error("syncLocalVideos error:", err);
    }
  }

  async function syncLocalStories(db) {
    try {
      const tx = db.transaction("stories", "readwrite");
      const store = tx.objectStore("stories");
      store.getAll().onsuccess = async (e) => {
        const list = e.target.result || [];
        for (const s of list) {
          if (s.img && typeof s.img === 'string' && s.img.startsWith('data:') && !s.synced) {
            try {
              const blob = dataURLtoBlob(s.img);
              const file = new File([blob], `story_${Date.now()}.png`, { type: blob.type || 'image/png' });
              const publicUrl = await uploadFileToStorage(STORIES_BUCKET, file);
              s.img = publicUrl;
              s.remote_url = publicUrl;
              s.synced = true;
              store.put(s);
              createRemoteStoryRecord({
                img: publicUrl,
                author: s.author || (user && user.name) || null,
                email: s.email || (user && user.email) || null,
                pfp: s.pfp || (user && user.pfp) || null,
                color: s.color || (user && user.color) || null,
                created: s.created || Date.now()
              });
              console.info("Story subido y actualizado local:", publicUrl);
            } catch (err) {
              console.error("Error subiendo story:", err);
            }
          }
        }
      };
    } catch (err) {
      console.error("syncLocalStories error:", err);
    }
  }

  function hookFileInputs() {
    const vf = document.getElementById('vFile');
    if (vf) {
      vf.addEventListener('change', async (ev) => {
        const file = ev.target.files[0];
        if (!file) return;
        try {
          const publicUrl = await uploadFileToStorage(VIDEOS_BUCKET, file);
          const dbRef = await waitForDB();
          const vid = {
            title: (document.getElementById('vTitle')?.value) || file.name,
            blob: publicUrl,
            remote_url: publicUrl,
            type: (document.getElementById('vT')?.value) || 'video',
            author: user ? user.name : 'anon',
            email: user ? user.email : null,
            pfp: user ? user.pfp : null,
            color: user ? user.color : null,
            likedBy: [],
            comms: [],
            timestamp: Date.now(),
            synced: true
          };
          dbRef.transaction("videos", "readwrite").objectStore("videos").add(vid).onsuccess = () => {
            createRemoteVideoRecord({
              title: vid.title, url: publicUrl, type: vid.type, author: vid.author, email: vid.email, pfp: vid.pfp, color: vid.color, timestamp: vid.timestamp
            });
            console.info("Bridge: video guardado local con URL:", publicUrl);
          };
        } catch (err) {
          console.error("Error subiendo en hook vFile:", err);
        }
      }, { passive: true });
    }

    const sf = document.getElementById('sFile');
    if (sf) {
      sf.addEventListener('change', async (ev) => {
        const file = ev.target.files[0];
        if (!file) return;
        try {
          const publicUrl = await uploadFileToStorage(STORIES_BUCKET, file);
          const dbRef = await waitForDB();
          const story = { img: publicUrl, author: user ? user.name : 'anon', email: user ? user.email : null, color: user ? user.color : null, pfp: user ? user.pfp : null, created: Date.now(), synced: true };
          dbRef.transaction("stories", "readwrite").objectStore("stories").add(story).onsuccess = () => {
            createRemoteStoryRecord({ img: publicUrl, author: story.author, email: story.email, pfp: story.pfp, color: story.color, created: story.created });
            console.info("Bridge: story guardada local con URL:", publicUrl);
          };
        } catch (err) {
          console.error("Error subiendo en hook sFile:", err);
        }
      }, { passive: true });
    }
  }

  async function pushLocalChatsToRemote(db) {
    try {
      const tx = db.transaction("chats", "readwrite");
      const store = tx.objectStore("chats");
      store.getAll().onsuccess = async (e) => {
        const all = e.target.result || [];
        for (const m of all) {
          if (!m.synced_remote) {
            try {
              await supabase.from('chats').insert([{
                from: m.from,
                to: m.to,
                type: m.type || 'text',
                content: m.content,
                timestamp: m.timestamp || Date.now(),
                seen: !!m.seen
              }]);
              m.synced_remote = true;
              store.put(m);
            } catch (err) {
              console.error("pushLocalChatsToRemote insert error:", err);
            }
          }
        }
      };
    } catch (err) {
      console.error("pushLocalChatsToRemote error:", err);
    }
  }

  async function handleRemoteInsertToLocal(db, payload) {
    try {
      const rec = payload.record;
      const tx = db.transaction("chats", "readwrite");
      const store = tx.objectStore("chats");
      store.getAll().onsuccess = (e) => {
        const all = e.target.result || [];
        const exists = all.some(m => (m.timestamp === rec.timestamp && m.from === rec.from && m.to === rec.to && m.content === rec.content));
        if (!exists) {
          const local = {
            from: rec.from,
            to: rec.to,
            type: rec.type,
            content: rec.content,
            timestamp: rec.timestamp,
            seen: rec.seen,
            synced_remote: true
          };
          store.add(local);
        }
      };
    } catch (err) {
      console.error("handleRemoteInsertToLocal error:", err);
    }
  }

  function subscribeToRemoteChats(db) {
    try {
      const channel = supabase.channel('public:chats')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chats' }, payload => {
          const rec = payload.record;
          if (user && (rec.to === user.email || rec.from === user.email)) {
            handleRemoteInsertToLocal(db, payload);
          }
        })
        .subscribe(status => {
          if (status === 'SUBSCRIBED') console.info("Bridge: suscrito a chats remotos");
        });
      window._nexus_bridge_channel = channel;
    } catch (err) {
      console.error("subscribeToRemoteChats error:", err);
    }
  }

  async function setPresenceOnline() {
    if (!user) return;
    try {
      await supabase.from('presence').upsert([{ email: user.email, last_online: new Date().toISOString(), online: true }]);
      window.addEventListener('beforeunload', async () => {
        await supabase.from('presence').upsert([{ email: user.email, last_online: new Date().toISOString(), online: false }]);
      });
    } catch (err) {
      console.error("setPresenceOnline error:", err);
    }
  }

  async function startBridge() {
    try {
      const dbRef = await waitForDB();
      hookFileInputs();
      syncLocalVideos(dbRef);
      syncLocalStories(dbRef);
      pushLocalChatsToRemote(dbRef);
      subscribeToRemoteChats(dbRef);
      setPresenceOnline();
      setInterval(() => syncLocalVideos(dbRef), POLL_INTERVAL_MS);
      setInterval(() => syncLocalStories(dbRef), POLL_INTERVAL_MS);
      setInterval(() => pushLocalChatsToRemote(dbRef), POLL_INTERVAL_MS);
      console.info("Nexus bridge iniciado. Pollers activos.");
    } catch (err) {
      console.error("startBridge error:", err);
    }
  }

  async function ensureRemoteUserRow() {
    if (!user) return;
    try {
      const { data } = await supabase.from('users').select('*').eq('email', user.email).limit(1);
      if (!data || data.length === 0) {
        await supabase.from('users').insert([{
          email: user.email,
          name: user.name,
          pfp: user.pfp || null,
          color: user.color || null,
          created_at: new Date().toISOString()
        }]);
      }
    } catch (err) {
      console.error("ensureRemoteUserRow error:", err);
    }
  }

  // ===== UI PATCH DESKTOP / LAPTOP =====
  (function(){
    const WAIT_MS = 50;
    function onReady(fn){ if(document.readyState==='loading')document.addEventListener('DOMContentLoaded', fn); else setTimeout(fn,WAIT_MS);}
    function injectCSS(){
      const css = `
      body { overflow:auto !important; }
      @media(min-width:900px){
        .video-card video{max-height:560px;height:auto;}
        #homePage,#shortsPage{padding:18px;}
      }
      #inboxPage.nx-desktop-layout{display:flex;gap:12px;align-items:stretch;}
      #inboxPage.nx-desktop-layout>.nx-left{width:340px;min-width:220px;max-width:45%;overflow-y:auto;}
      #inboxPage.nx-desktop-layout>.nx-splitter{width:6px;cursor:col-resize;background:linear-gradient(90deg,rgba(255,255,255,0.03),rgba(255,255,255,0.00));}
      #inboxPage.nx-desktop-layout>.nx-right{flex:1;min-width:300px;overflow:hidden;display:flex;flex-direction:column;}
      #chatView.nx-inlined{position:relative !important;inset:auto !important;z-index:auto !important;display:flex !important;height:calc(100vh-140px);border-radius:10px;}
      #chatView.nx-inlined .messages-area{flex:1;overflow-y:auto;}
      .chat-input-area{align-items:center;}
      .chat-input-area .auth-input{min-height:44px;border-radius:12px;}
      .video-card:hover{transform:translateY(-2px);transition:transform .12s ease;}
      .user-item:hover{background:rgba(255,255,255,0.02);}
      .short-frame{max-height:800px;}
      `;
      const s=document.createElement('style');s.id='nexus-desktop-style';s.appendChild(document.createTextNode(css));document.head.appendChild(s);
    }
    function moveEl(el,parent){if(!el||!parent)return;if(parent.contains(el))return;parent.appendChild(el);}
    function enableDesktopInboxLayout(){
      const inbox=document.getElementById('inboxPage');if(!inbox)return;if(inbox.classList.contains('nx-desktop-layout'))return;
      const left=document.createElement('div');left.className='nx-left';
      const heading=inbox.querySelector('h3');const chatList=document.getElementById('chatList');if(heading)left.appendChild(heading);if(chatList)left.appendChild(chatList);
      const splitter=document.createElement('div');splitter.className='nx-splitter';
      const right=document.createElement('div');right.className='nx-right';
      inbox.innerHTML='';inbox.classList.add('nx-desktop-layout');inbox.appendChild(left);inbox.appendChild(splitter);inbox.appendChild(right);
      const chatView=document.getElementById('chatView');if(chatView){chatView.classList.add('nx-inlined');moveEl(chatView,right);}
      implementSplitter(left,splitter,right);
    }
    function implementSplitter(left,splitter,right){
      let dragging=false,startX=0,startWidth=0;
      splitter.addEventListener('mousedown',e=>{dragging=true;startX=e.clientX;startWidth=left.getBoundingClientRect().width;document.body.style.cursor='col-resize';e.preventDefault();});
      document.addEventListener('mousemove',e=>{if(!dragging)return;let newWidth=startWidth+(e.clientX-startX);left.style.width=newWidth+'px';});
      document.addEventListener('mouseup',e=>{if(dragging)dragging=false;document.body.style.cursor='auto';});
    }
    onReady(()=>{injectCSS();enableDesktopInboxLayout();});
  })();

  // ===== Init =====
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', async () => { await ensureRemoteUserRow(); startBridge(); });
  } else {
    (async () => { await ensureRemoteUserRow(); startBridge(); })();
  }

  window.nexus_bridge = { supabase, uploadFileToStorage, syncLocalVideos, syncLocalStories, pushLocalChatsToRemote, subscribeToRemoteChats };

})();
