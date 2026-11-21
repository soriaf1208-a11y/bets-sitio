// Función serverless (Vercel). Variables de entorno: API_FOOTBALL_KEY, MAX_MATCHES (opcional)
const BASE = "https://v3.football.api-sports.io", KEY = process.env.API_FOOTBALL_KEY, MAX = +process.env.MAX_MATCHES || 5;
const LEAGUES = { 39: "Premier League", 140: "LaLiga", 135: "Serie A", 78: "Bundesliga", 61: "Ligue 1" };
const get = async p => {
  const r = await fetch(BASE + p, { headers: { "x-apisports-key": KEY } }), j = await r.json();
  if (j.errors && Object.keys(j.errors).length) throw new Error(JSON.stringify(j.errors));
  return j.response;
};
const n = v => +v || 0, mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
const stat = (s, t) => n(s.statistics.find(x => x.type === t)?.value);
const col = (r, k) => r.map(x => x[k]);
const season = () => { const d = new Date(); return d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1; };

// Últimos 5 partidos terminados de un equipo, con estadísticas
async function form(team) {
  const fx = await get(`/fixtures?team=${team}&last=5&status=FT`);
  return (await Promise.all(fx.map(async f => {
    const st = await get(`/fixtures/statistics?fixture=${f.fixture.id}`);
    const me = st.find(s => s.team.id === team), op = st.find(s => s.team.id !== team);
    if (!me || !op) return null;
    const home = f.teams.home.id === team;
    return {
      gf: home ? f.goals.home : f.goals.away, ga: home ? f.goals.away : f.goals.home,
      corners: stat(me, "Corner Kicks") + stat(op, "Corner Kicks"),
      cards: stat(me, "Yellow Cards") + stat(me, "Red Cards") + stat(op, "Yellow Cards") + stat(op, "Red Cards"),
      sot: stat(me, "Shots on Goal"), sotAg: stat(op, "Shots on Goal"), saves: stat(me, "Goalkeeper Saves")
    };
  }))).filter(Boolean);
}

const conf = cv => cv < .3 ? "alta" : cv < .5 ? "media" : "baja";
function market(name, exp, all) {
  const cv = sd(all) / (exp || 1);
  return { m: name, exp: +exp.toFixed(1), pick: `Más de ${Math.max(0.5, Math.floor(exp) - 0.5)}`, conf: conf(cv) };
}

function analyze(h, a, hn, an) {
  if (h.length < 3 || a.length < 3) return [];
  const out = [];
  // Goles totales (Poisson)
  const l = (mean(col(h, "gf")) + mean(col(a, "ga")) + mean(col(a, "gf")) + mean(col(h, "ga"))) / 2;
  const pO = 1 - Math.exp(-l) * (1 + l + l * l / 2);
  out.push({ m: "Goles totales", exp: +l.toFixed(1), pick: pO >= .5 ? "Más de 2.5" : "Menos de 2.5",
    prob: Math.round((pO >= .5 ? pO : 1 - pO) * 100), conf: Math.abs(pO - .5) > .15 ? "alta" : Math.abs(pO - .5) > .07 ? "media" : "baja" });
  out.push(market("Córners totales", (mean(col(h, "corners")) + mean(col(a, "corners"))) / 2, [...col(h, "corners"), ...col(a, "corners")]));
  out.push(market("Tarjetas totales", (mean(col(h, "cards")) + mean(col(a, "cards"))) / 2, [...col(h, "cards"), ...col(a, "cards")]));
  const sotH = (mean(col(h, "sot")) + mean(col(a, "sotAg"))) / 2, sotA = (mean(col(a, "sot")) + mean(col(h, "sotAg"))) / 2;
  out.push(market(`Tiros a puerta ${hn}`, sotH, [...col(h, "sot"), ...col(a, "sotAg")]));
  out.push(market(`Tiros a puerta ${an}`, sotA, [...col(a, "sot"), ...col(h, "sotAg")]));
  const svH = (mean(col(h, "saves")) + mean(col(a, "sot")) - mean(col(a, "gf"))) / 2, svA = (mean(col(a, "saves")) + mean(col(h, "sot")) - mean(col(h, "gf"))) / 2;
  out.push(market(`Atajadas arquero ${hn}`, Math.max(0, svH), col(h, "saves")));
  out.push(market(`Atajadas arquero ${an}`, Math.max(0, svA), col(a, "saves")));
  const rank = { alta: 0, media: 1, baja: 2 };
  return out.sort((x, y) => rank[x.conf] - rank[y.conf]);
}

const star = (ts, id) => {
  const p = ts.find(x => x.statistics[0].team.id === id);
  if (!p) return null;
  const s = p.statistics[0], g = n(s.games.appearences) || 1;
  return { name: p.player.name, sotPG: +(n(s.shots.on) / g).toFixed(1), shotsPG: +(n(s.shots.total) / g).toFixed(1), goals: n(s.goals.total) };
};

export default async function handler(req, res) {
  try {
    if (!KEY) throw new Error("Falta API_FOOTBALL_KEY");
    const d = new Date().toISOString().slice(0, 10), s = season(), list = [];
    for (const [id, name] of Object.entries(LEAGUES)) {
      const fx = (await get(`/fixtures?date=${d}&league=${id}&season=${s}`)).filter(f => f.fixture.status.short === "NS");
      if (!fx.length) continue;
      const ts = await get(`/players/topscorers?league=${id}&season=${s}`);
      fx.forEach(f => list.push({ f, name, ts }));
    }
    const picks = [];
    for (const { f, name, ts } of list.slice(0, MAX)) {
      const hh = f.teams.home, aa = f.teams.away;
      const [fh, fa] = await Promise.all([form(hh.id), form(aa.id)]);
      picks.push({ league: name, time: f.fixture.date, home: hh.name, away: aa.name,
        markets: analyze(fh, fa, hh.name, aa.name), players: [star(ts, hh.id), star(ts, aa.id)].filter(Boolean) });
    }
    res.setHeader("Cache-Control", "s-maxage=21600, stale-while-revalidate");
    res.status(200).json({ updated: new Date().toISOString(), picks });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
}

