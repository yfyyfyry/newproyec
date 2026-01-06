/* nexus_bridge.js
   Bridge externo para:
   - Subida de videos/ historias a Supabase Storage (evitando Base64)
   - Sincronización de chats (IndexedDB <-> Supabase)
   - Presencia básica (online/offline)
   - No redeclara variables globales que ya están en tu HTML (usa window.user, window.db)
*/

/* ========== CONFIG: REMPLAZA ESTO ========== */
const SUPABASE_URL = "https://TU_PROYECTO.supabase.co";           // <- pon tu URL
const SUPABASE_ANON_KEY = "sb_publishable_XXXXXXXXXXXX";         // <- pon tu ANON KEY
const VIDEOS_BUCKET = "videos";   // crea este bucket en Supabase Storage
const STORIES_BUCKET = "stories"; // crea este bucket en Supabase Storage
const POLL_INTERVAL_MS = 2000;    // cada 2s revisa la BD local para sync

/* ========== NO TOCAR MÁS ABAJO (salvo la config) ========== */
(function () {
  // Usar variable global user si existe (no redeclaramos)
  window.user = window.user || JSON.parse(localStorage.getItem('nexus_v9_user') || 'null');
  const user = window.user || null;

  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    console.error("Supabase JS no encontrado. Asegúrate de incluir el CDN antes del bridge.");
    return;
  }

  const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // Helper: espera hasta que window.db (IndexedDB) esté listo
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

  // Helper: convertir DataURL o File a Blob/File (si necesitas)
  function dataURLtoBlob(dataurl) {
    const arr = dataurl.split(',');
    const mime = arr[0].match(/:(.*?);/)[1];
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) u8arr[n] = bstr.charCodeAt(n);
    return new Blob([u8arr], { type: mime });
  }

  // Upload file (File object) to Supabase Storage and return public URL
  async function uploadFileToStorage(bucket, file, path) {
    try {
      // path: carpeta/nombre
      const filePath = path || `${user ? user.email.replace(/[@.]/g, '_') : 'anon'}_${Date.now()}_${file.name}`;
      const { error } = await supabase.storage.from(bucket).upload(filePath, file, { upsert: false });
      if (error) throw error;
      // obtener URL pública (si tu bucket es público) o signed URL
      const { data: pub } = supabase.storage.from(bucket).getPublicUrl(filePath);
      // si quieres signed url (temporal) usa createSignedUrl
      return pub.publicUrl;
    } catch (err) {
      console.error("uploadFileToStorage error:", err);
      throw err;
    }
  }

  // Crear fila en tabla 'videos' en Supabase (opcional, si quieres mantener DB remota)
  async function createRemoteVideoRecord(meta) {
    // meta: { title, url, type, author, email, pfp, color, timestamp }
    try {
      const { error } = await supabase.from('videos').insert([meta]);
      if (error) console.error("createRemoteVideoRecord:", error);
    } catch (err) {
      console.error("createRemoteVideoRecord:", err);
    }
  }

  // Crear fila en tabla 'stories' en Supabase (opcional)
  async function createRemoteStoryRecord(meta) {
    try {
      const { error } = await supabase.from('stories').insert([meta]);
      if (error) console.error("createRemoteStoryRecord:", error);
    } catch (err) {
      console.error("createRemoteStoryRecord:", err);
    }
  }

  // Sincroniza videos locales que todavía usen DataURL (Base64) -> sube a storage -> actualiza IndexedDB
  async function syncLocalVideos(db) {
    try {
      const tx = db.transaction("videos", "readwrite");
      const store = tx.objectStore("videos");
      store.getAll().onsuccess = async (e) => {
        const list = e.target.result || [];
        for (const v of list) {
          // Detectar si blob es DataURL (base64)
          if (v.blob && typeof v.blob === 'string' && v.blob.startsWith('data:') && !v.synced) {
            try {
              // convert dataURL to blob
              const blob = dataURLtoBlob(v.blob);
              // create a File so Supabase storage gets name/type
              const file = new File([blob], (v.title || 'video') + '.webm', { type: blob.type || 'video/webm' });
              // upload to storage
              const publicUrl = await uploadFileToStorage(VIDEOS_BUCKET, file);
              // update local record: replace blob with url, mark synced
              v.blob = publicUrl;
              v.remote_url = publicUrl;
              v.synced = true;
              store.put(v);
              // opcional: crear registro remoto en tabla 'videos'
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

  // Sincroniza historias locales similares a videos
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

  // ===== Interceptar inputs (sin modificar HTML) =====
  function hookFileInputs() {
    // #vFile -> cuando usuario seleccione un archivo, subimos directo y actualizamos IndexedDB con la URL
    const vf = document.getElementById('vFile');
    if (vf) {
      vf.addEventListener('change', async (ev) => {
        const file = ev.target.files[0];
        if (!file) return;
        try {
          // subir inmediatamente (esto evita que la app convierta a base64)
          const publicUrl = await uploadFileToStorage(VIDEOS_BUCKET, file);
          // crear registro en IndexedDB igual que la app espera, pero con URL en vez de base64
          const dbRef = await waitForDB();
          const vid = {
            title: (document.getElementById('vTitle') && document.getElementById('vTitle').value) || file.name,
            blob: publicUrl,
            remote_url: publicUrl,
            type: (document.getElementById('vT') && document.getElementById('vT').value) || 'video',
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
            // Si la app original también ejecuta su toB64->add, habrá duplicado; pero la app normalmente llama upVideo()
            // que hace location.reload() — esto mantendrá compatibilidad y hará que la UI muestre el vídeo.
            console.info("Bridge: video guardado local con URL:", publicUrl);
            // opcional: crear registro remoto adicional en tabla 'videos'
            createRemoteVideoRecord({
              title: vid.title, url: publicUrl, type: vid.type, author: vid.author, email: vid.email, pfp: vid.pfp, color: vid.color, timestamp: vid.timestamp
            });
          };
        } catch (err) {
          console.error("Error subiendo en hook vFile:", err);
        }
      }, { passive: true });
    }

    // #sFile para historias
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

  // ===== Chats sync (poll + realtime) =====
  // Poll local IndexedDB for unsynced chat messages -> push to Supabase
  async function pushLocalChatsToRemote(db) {
    try {
      const tx = db.transaction("chats", "readwrite");
      const store = tx.objectStore("chats");
      store.getAll().onsuccess = async (e) => {
        const all = e.target.result || [];
        for (const m of all) {
          if (!m.synced_remote) {
            // insert into supabase table 'chats'
            try {
              await supabase.from('chats').insert([{
                from: m.from,
                to: m.to,
                type: m.type || 'text',
                content: m.content,
                timestamp: m.timestamp || Date.now(),
                seen: !!m.seen
              }]);
              // mark local as synced_remote
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

  // When remote chat message arrives, write to IndexedDB if doesn't exist
  async function handleRemoteInsertToLocal(db, payload) {
    try {
      const rec = payload.record;
      // quick dedupe: check if identical msg exists (timestamp/from/to/content)
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

  // Subscribe to Supabase postgres_changes for inserts on 'chats' table
  function subscribeToRemoteChats(db) {
    try {
      const channel = supabase.channel('public:chats')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chats' }, payload => {
          // payload.record contains the inserted row
          if (!payload || !payload.record) return;
          // If message is related to this user (to or from), sync to local
          const rec = payload.record;
          if (user && (rec.to === user.email || rec.from === user.email)) {
            handleRemoteInsertToLocal(db, payload);
          }
        })
        .subscribe(status => {
          if (status === 'SUBSCRIBED') console.info("Bridge: suscrito a chats remotos");
        });
      // Keep the channel reference if needed later
      window._nexus_bridge_channel = channel;
    } catch (err) {
      console.error("subscribeToRemoteChats error:", err);
    }
  }

  // Presence (simple): notify server that this user is online (insert/update row in 'presence' table)
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

  // Starter: pollers and initialization after DB ready + DOM loaded
  async function startBridge() {
    try {
      // Wait DB
      const dbRef = await waitForDB();
      // Hook file inputs right away
      hookFileInputs();
      // initial one-time sync
      syncLocalVideos(dbRef);
      syncLocalStories(dbRef);
      pushLocalChatsToRemote(dbRef);
      // subscribe remote chats
      subscribeToRemoteChats(dbRef);
      // presence
      setPresenceOnline();

      // Pollers
      setInterval(() => syncLocalVideos(dbRef), POLL_INTERVAL_MS);
      setInterval(() => syncLocalStories(dbRef), POLL_INTERVAL_MS);
      setInterval(() => pushLocalChatsToRemote(dbRef), POLL_INTERVAL_MS);

      console.info("Nexus bridge iniciado. Pollers activos.");
    } catch (err) {
      console.error("startBridge error:", err);
    }
  }

  // Crear user remoto en tabla 'users' si no existe (permite ver perfiles y presencia)
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

  // Inicializar cuando DOM esté listo (no bloquea si ya lo está)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', async () => {
      await ensureRemoteUserRow();
      startBridge();
    });
  } else {
    (async () => {
      await ensureRemoteUserRow();
      startBridge();
    })();
  }

  // Exponer funciones útiles para debugging en consola
  window.nexus_bridge = {
    supabase,
    uploadFileToStorage,
    syncLocalVideos,
    syncLocalStories,
    pushLocalChatsToRemote,
    subscribeToRemoteChats
  };

})();
