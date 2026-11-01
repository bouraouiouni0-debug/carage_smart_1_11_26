// Miroir de http://192.168.4.1/ : toutes les pages de l'ESP32-CAM sont
// relayees par ce serveur (l'ESP32 appelle Render, jamais l'inverse).
const express = require('express');
const app = express();

// La cle doit etre definie dans Render > Environment (variable KEY)
const KEY = process.env.KEY;
if (!KEY) {
  console.error('ERREUR : definir la variable d\'environnement KEY dans Render.');
  process.exit(1);
}

let queue = [];      // requetes navigateur en attente {id, method, path, body}
let pollers = [];    // appels longs de l'ESP32 en attente
let waiting = {};    // id -> {resolve, timer}
let nextId = 1;
let lastSeen = 0;    // derniere activite de l'ESP32 (poll ou resultat)
let wasOnline = false;
const cache = new Map();   // images deja recuperees (path -> reponse)

const ONLINE_DELAY = 45000;  // ESP32 considere hors ligne apres 45 s sans signe de vie

function isOnline() {
  return pollers.length > 0 || (Date.now() - lastSeen) < ONLINE_DELAY;
}

// Pastille "ESP32 en ligne / hors ligne" ajoutee a toutes les pages HTML
const BADGE = `
<div id="esp-badge" style="position:fixed;top:8px;right:8px;z-index:99999;padding:6px 12px;border-radius:14px;font:bold 13px Arial;color:#fff;background:#888">ESP32 ...</div>
<script>
(function(){
  var b = document.getElementById('esp-badge');
  function maj(){
    fetch('/__status', {cache:'no-store'})
      .then(function(r){ return r.json(); })
      .then(function(s){
        b.style.background = s.online ? '#1a9c3c' : '#d32f2f';
        b.textContent = s.online ? 'ESP32 en ligne'
          : 'ESP32 hors ligne' + (s.ago !== null ? ' (vu il y a ' + s.ago + ' s)' : '');
      })
      .catch(function(){ b.style.background = '#888'; b.textContent = 'Serveur injoignable'; });
  }
  maj();
  setInterval(maj, 5000);
})();
</script>
<div style="position:fixed;bottom:8px;right:8px;z-index:99999;padding:8px 12px;border-radius:10px;font:13px Arial;color:#fff;background:#333;text-align:center">
  <button id="cpt-btn" style="padding:6px 10px;cursor:pointer">Envoyer compteur 0 a 10</button>
  <div id="cpt-out" style="margin-top:4px">&nbsp;</div>
</div>
<script>
(function(){
  var btn = document.getElementById('cpt-btn');
  var out = document.getElementById('cpt-out');
  btn.onclick = async function(){
    btn.disabled = true;
    for (var i = 0; i <= 10; i++) {
      out.textContent = 'Envoi ' + i + ' / 10 ...';
      try {
        var r = await fetch('/counter?n=' + i, {cache:'no-store'});
        if (!r.ok) throw new Error(r.status);
      } catch (e) {
        out.textContent = 'Echec a ' + i + ' (ESP32 hors ligne ?)';
        btn.disabled = false;
        return;
      }
    }
    out.textContent = 'Termine : 0 a 10 envoyes';
    btn.disabled = false;
  };
})();
</script>`;

function authEsp(req, res, next) {
  if (req.query.k !== KEY) return res.status(401).send('Cle invalide');
  next();
}

function dispatch() {
  while (queue.length && pollers.length) {
    const p = pollers.shift();
    clearTimeout(p.timer);
    const c = queue.shift();
    p.res.send(`${c.id}\n${c.method}\n${c.path}\n${c.body}`);
  }
}

function ask(method, path, body) {
  return new Promise((resolve, reject) => {
    const id = String(nextId++);
    const timer = setTimeout(() => {
      delete waiting[id];
      queue = queue.filter(q => q.id !== id);
      reject(new Error('timeout'));
    }, 90000);
    waiting[id] = { resolve, timer };
    queue.push({ id, method, path, body });
    dispatch();
  });
}

/* ---------- Cote ESP32 ---------- */
// L'ESP32 attend ici (appel long) qu'une page soit demandee
app.get('/esp/poll', authEsp, (req, res) => {
  lastSeen = Date.now();
  if (!wasOnline) { wasOnline = true; console.log('ESP32 connecte'); }

  const p = { res };
  p.timer = setTimeout(() => {
    pollers = pollers.filter(x => x !== p);
    lastSeen = Date.now();
    res.send('none');
  }, 20000);
  req.on('close', () => {
    clearTimeout(p.timer);
    pollers = pollers.filter(x => x !== p);
    lastSeen = Date.now();
  });
  pollers.push(p);
  dispatch();
});

// L'ESP32 renvoie ici la reponse de sa propre page
app.post('/esp/result', authEsp, express.raw({ type: '*/*', limit: '60mb' }), (req, res) => {
  lastSeen = Date.now();
  const w = waiting[req.query.id];
  if (w) {
    clearTimeout(w.timer);
    delete waiting[req.query.id];
    w.resolve({
      status: parseInt(req.get('X-Status')) || 502,
      ctype: req.get('X-Ctype') || 'application/octet-stream',
      loc: req.get('X-Location') || '',
      disp: req.get('X-Disp') || '',
      body: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
    });
  }
  res.send('ok');
});

// ===== COMPTEUR DE 1 A 10 =====
let compteur = 0;
let file = [];

setInterval(() => {
  compteur++;
  if (compteur > 10) compteur = 1;
  file.push(compteur);
  if (file.length > 20) file.shift();
}, 1000);

// L'ESP32 lit ici la prochaine valeur (vide s'il n'y en a pas)
app.get('/compteur', authEsp, (req, res) => {
  lastSeen = Date.now();
  res.set('Cache-Control', 'no-store').type('text/plain')
     .send(file.length ? String(file.shift()) : '');
});

// Log quand l'ESP32 disparait
setInterval(() => {
  if (wasOnline && !isOnline()) { wasOnline = false; console.log('ESP32 hors ligne'); }
}, 10000);

/* ---------- Cote navigateur : miroir de l'ESP32 ---------- */
app.use(express.raw({ type: '*/*', limit: '1mb' }));

app.use(async (req, res) => {
  // Mot de passe : /?k=CLE la premiere fois, ensuite cookie
  if (req.query.k === KEY) {
    res.set('Set-Cookie', `k=${KEY}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`);
    const u = new URL(req.originalUrl, 'http://x');
    u.searchParams.delete('k');
    return res.redirect(u.pathname + u.search);
  }
  const m = /(?:^|;\s*)k=([^;]*)/.exec(req.headers.cookie || '');
  if (!m || m[1] !== KEY) {
    return res.status(401).send('Acces refuse. Ouvrez /?k=VOTRE_CLE une premiere fois.');
  }

  // Etat de l'ESP32 (repond meme si l'ESP32 est hors ligne)
  if (req.path === '/__status') {
    return res.set('Cache-Control', 'no-store').json({
      online: isOnline(),
      ago: lastSeen ? Math.round((Date.now() - lastSeen) / 1000) : null
    });
  }

  if (req.path === '/favicon.ico') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

  const isImg = req.method === 'GET' && /\.jpe?g$/i.test(req.path);
  if (req.path.startsWith('/delete')) cache.clear();
  if (isImg && cache.has(req.path)) {
    const c = cache.get(req.path);
    return res.status(c.status).type(c.ctype).send(c.body);
  }

  const body = Buffer.isBuffer(req.body) ? req.body.toString() : '';
  let r;
  try {
    r = await ask(req.method, req.originalUrl, body);
  } catch (e) {
    console.log('Timeout ESP32 :', req.originalUrl);
    const off = '<meta charset="utf-8"><body style="font-family:Arial">ESP32 hors ligne ou ne repond pas. Reessayez.' + BADGE + '</body>';
    return res.status(504).type('html').send(off);
  }

  if (r.loc) res.set('Location', r.loc);
  if (r.disp) res.set('Content-Disposition', r.disp);
  res.status(r.status);

  if (/text\/html/i.test(r.ctype)) {
    // charge les photos seulement quand on les voit + ajoute la pastille d'etat
    let html = r.body.toString('utf8').replace(/<img /g, '<img loading="lazy" ');
    html = /<\/body>/i.test(html)
      ? html.replace(/<\/body>/i, () => BADGE + '</body>')
      : html + BADGE;
    return res.type('html').send(html);
  }
  if (isImg && r.status === 200) {
    if (cache.size > 300) cache.clear();
    cache.set(req.path, { status: r.status, ctype: r.ctype, body: r.body });
  }
  res.type(r.ctype).send(r.body);
});

app.listen(process.env.PORT || 3000, () => console.log('Serveur demarre'));
