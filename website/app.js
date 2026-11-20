(() => {
"use strict";
/* =========================================================
   Barangay Kaligayahan Health Center Availability Tracking System
   With the secure server (backend/run.py) all data is kept in the server's encrypted
   database and the page keeps itself up to date. Opened as a plain file, it falls back to
   the offline prototype that stores data in this browser (localStorage).
   ========================================================= */
const TZ = 'Asia/Manila';
const KEY = 'bkhc-site-v1', TKEY = 'bkhc-site-mine', AKEY = 'bkhc-site-admin', PKEY = 'bkhc-site-prefs';
const ls = {
  get(k){ try { return localStorage.getItem(k); } catch(e){ return null; } },
  set(k,v){ try { localStorage.setItem(k,v); } catch(e){} }
};
const memSS = {};
const ss = {
  get(k){ try { const v = sessionStorage.getItem(k); return v != null ? v : (memSS[k] ?? null); } catch(e){ return memSS[k] ?? null; } },
  set(k,v){ memSS[k] = v; try { sessionStorage.setItem(k,v); } catch(e){} },
  del(k){ delete memSS[k]; try { sessionStorage.removeItem(k); } catch(e){} }
};
const $ = s => document.querySelector(s);
const app = $('#app');
// Two separate sites share this code: the public website (index.html) for residents, and the staff
// portal (staff.html, served at /staff) for sign-in and the staff tools. The public site never shows
// or links to the staff side.
const PORTAL = document.body.dataset.portal === 'staff' ? 'staff' : 'public';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pad = n => String(n).padStart(2,'0');
const rand01 = () => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] / 4294967296; };
const uid = () => { const a = new Uint32Array(2); crypto.getRandomValues(a); return (a[0].toString(36) + a[1].toString(36)).slice(0,10); };
const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const DOW_LONG = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MON = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

/* ---------- time helpers (always Philippine time) ---------- */
// The phone's clock may be wrong. When the server is used, its time is applied as an offset.
const CLOCK = { offset:0 };
const nowMs = () => Date.now() + CLOCK.offset;
function now(){
  const d = new Date(nowMs()), p = {};
  new Intl.DateTimeFormat('en-US',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',weekday:'short'})
    .formatToParts(d).forEach(x => p[x.type] = x.value);
  const h = (+p.hour) % 24, m = +p.minute;
  return { date:`${p.year}-${p.month}-${p.day}`, h, m, s:+p.second, min:h*60+m, dow:DOW.indexOf(p.weekday) };
}
const toMin = t => { const [h,m] = String(t).split(':').map(Number); return h*60 + (m||0); };
function fmt(min){ min = Math.round(min); let h = Math.floor(min/60)%24, m = ((min%60)+60)%60; const ap = h>=12?'PM':'AM'; h = h%12||12; return `${h}:${pad(m)} ${ap}`; }
const fmtT = t => fmt(toMin(t));
const ymd = ds => ds.split('-').map(Number);
function addDays(ds,n){ const [y,mo,d] = ymd(ds); return new Date(Date.UTC(y,mo-1,d+n)).toISOString().slice(0,10); }
function dowOf(ds){ const [y,mo,d] = ymd(ds); return new Date(Date.UTC(y,mo-1,d)).getUTCDay(); }
function dateLong(ds){ const [y,mo,d] = ymd(ds); return new Date(Date.UTC(y,mo-1,d)).toLocaleDateString('en-US',{timeZone:'UTC',weekday:'long',month:'long',day:'numeric',year:'numeric'}); }
function dateShort(ds){ const [y,mo,d] = ymd(ds); return new Date(Date.UTC(y,mo-1,d)).toLocaleDateString('en-US',{timeZone:'UTC',weekday:'short',month:'short',day:'numeric'}); }
function tsFor(ds, min){ const [y,mo,d] = ymd(ds); return Date.UTC(y, mo-1, d, 0, min) - 8*3600*1000; }
function clockOf(ts){ const p = {}; new Intl.DateTimeFormat('en-US',{timeZone:TZ,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(ts)).forEach(x => p[x.type]=x.value); return fmt((+p.hour%24)*60 + +p.minute); }
function fmtDur(ms){ ms = Math.max(0, ms); const s = Math.floor(ms/1000); return `${Math.floor(s/60)}:${pad(s%60)}`; }

/* ---------- labels ---------- */
const MED_ST = { available:['ok','Available','Mayroon'], low:['warn','Low stock','Paubos na'], out:['crit','Out of stock','Wala na'] };
const T_ST = {
  waiting:['info','Waiting','Naghihintay'], called:['warn','Called — go to the desk now','Tinatawag na kayo'],
  serving:['ok','Being served','Inaasikaso na'], served:['neutral','Done','Tapos na'],
  void:['crit','Voided — did not arrive','Na-void'], cancelled:['neutral','Cancelled','Kinansela']
};
const PRIO = { senior:'Senior citizen', pwd:'Person with disability (PWD)', pregnant:'Pregnant', regular:'Regular patient' };
const PRIO_TL = { senior:'Nakatatanda, 60 pataas', pwd:'May kapansanan', pregnant:'Buntis', regular:'Karaniwang pasyente' };
const PRIO_SHORT = { senior:'Senior', pwd:'PWD', pregnant:'Pregnant', regular:'Regular' };
const PROOFS = {
  senior:['Senior Citizen ID (OSCA)','Any government ID showing birthdate'],
  pwd:['PWD ID','Medical certificate of disability'],
  pregnant:["MCH booklet (Mother's book)",'Prenatal record or ultrasound result','Medical certificate of pregnancy']
};
const ANN_T = { leave:['crit','Doctor on leave'], schedule:['info','Schedule / Holiday'], cutoff:['warn','Service cut-off'], advisory:['ok','Health advisory'], general:['neutral','General'] };
const REQ_ST = { pending:['warn','Waiting for stock check'], ready:['ok','Ready for pick-up'], forwarded:['info','Requested from City Health'], claimed:['neutral','Claimed'], cancelled:['neutral','Cancelled'] };
const medStatusFor = (stock,thr) => stock <= 0 ? 'out' : stock <= thr ? 'low' : 'available';
const pill = (k,t,plain,cls='') => `<span class="pill ${k}${plain?' plain':''} ${cls}">${esc(t)}</span>`;

const TIPS = [
  ['Drink enough water','Adults need about 8 glasses of water a day. Drink more when it is hot or when you have fever or diarrhea.','Uminom ng sapat na tubig — mga 8 baso kada araw.'],
  ['Take maintenance medicine every day','Do not stop your blood pressure or diabetes medicine even if you feel well. Get a refill before you run out.','Huwag itigil ang maintenance kahit maganda ang pakiramdam.'],
  ['Know the signs of stroke: B.E. F.A.S.T.','Balance loss, Eyes blurry, Face drooping, Arm weakness, Speech difficulty — Time to call 911 right away.','Kapag may senyales ng stroke, tumawag agad sa 911.'],
  ['Dengue: search and destroy','Empty and scrub water containers weekly. Seek care if fever lasts 2 days, with rashes or bleeding gums.','Linisin ang mga lalagyan ng tubig linggo-linggo.'],
  ['Animal bites need care right away','Wash the wound with soap and running water for 15 minutes, then go to the health center for anti-rabies vaccine.','Hugasan ng sabon at tubig ang kagat, at magpabakuna agad.'],
  ['Wash your hands','Wash with soap for at least 20 seconds before eating and after using the toilet. This prevents diarrhea and flu.','Maghugas ng kamay gamit ang sabon nang 20 segundo.'],
  ['Check your blood pressure','Adults 40 and above should have their blood pressure checked at least once a year. It is free at the health center.','Libre ang pagkuha ng blood pressure sa health center.'],
  ['Flu vaccine for seniors','Senior citizens should get a flu vaccine every year and a pneumonia vaccine as advised by the doctor.','May libreng flu vaccine para sa senior citizens.'],
  ['Prenatal check-ups','Pregnant women should have at least 4 prenatal check-ups. Bring your MCH booklet every visit.','Magpa-check-up nang hindi bababa sa 4 na beses habang buntis.'],
  ['Eat more vegetables, less salt','Too much salt raises blood pressure. Choose fruits, vegetables and fish; limit instant noodles and processed food.','Bawasan ang alat; kumain ng gulay at prutas.'],
  ['Walk 30 minutes a day','Light exercise like walking helps the heart, blood sugar and mood. Start slowly and rest when tired.','Maglakad nang 30 minuto araw-araw.'],
  ['Stay cool on hot days','Rest in the shade, drink water, and watch for dizziness or headache — signs of heat exhaustion.','Iwasan ang matinding init; uminom ng tubig.']
];

/* ---------- icons (48×48 line icons) ---------- */
const I = {
  home:'<path d="M6 22 24 7l18 15"/><path d="M11 19v22h26V19"/><path d="M20 41V29h8v12"/>',
  status:'<path d="M6 42h36M10 42V18l14-9 14 9v24"/><path d="M21 23h6M24 20v6"/><path d="M20 42v-8h8v8"/>',
  doctor:'<path d="M13 6h-2v10a9 9 0 0 0 18 0V6h-2"/><path d="M20 25v5a9 9 0 0 0 18 0v-5"/><circle cx="38" cy="21" r="4"/>',
  medicine:'<path d="M8.5 29.5 21 17a7.1 7.1 0 0 1 10 10L18.5 39.5a7.1 7.1 0 0 1-10-10z"/><path d="M14.8 23.2l10 10"/><circle cx="36" cy="10.5" r="5.5"/><path d="M32.1 14.4l7.8-7.8"/>',
  queue:'<path d="M6 14h36v6a4 4 0 0 0 0 8v6H6v-6a4 4 0 0 0 0-8z"/><path d="M17 14v20" stroke-dasharray="2.5 3"/><path d="M23 21h12M23 27h8"/>',
  announce:'<path d="M8 20v8h6l15 8V12l-15 8z"/><path d="M14 28l2.5 10h5L19 29"/><path d="M35 19a7 7 0 0 1 0 10M39 15a12 12 0 0 1 0 18"/>',
  receipt:'<path d="M12 5h24v38l-4-3-4 3-4-3-4 3-4-3-4 3z"/><path d="M18 14h12M18 20h12M18 26h7"/>',
  dash:'<rect x="6" y="6" width="15" height="15" rx="2"/><rect x="27" y="6" width="15" height="9" rx="2"/><rect x="27" y="21" width="15" height="21" rx="2"/><rect x="6" y="27" width="15" height="15" rx="2"/>',
  cal:'<rect x="6" y="10" width="36" height="32" rx="3"/><path d="M6 19h36M16 5v9M32 5v9"/><path d="M17 30l5 5 9-9"/>',
  clock:'<circle cx="24" cy="24" r="18"/><path d="M24 13v11l7 5"/>',
  chart:'<path d="M6 42h36"/><path d="M12 36V24M21 36V14M30 36V20M39 36V9"/>',
  search:'<circle cx="21" cy="21" r="12"/><path d="M30 30l11 11"/>',
  info:'<circle cx="24" cy="24" r="18"/><path d="M24 22v11M24 15v1"/>',
  back:'<path d="M28 12L16 24l12 12"/>',
  idcard:'<rect x="5" y="10" width="38" height="28" rx="3"/><circle cx="17" cy="21" r="4"/><path d="M10 32c1.2-3.6 4-5 7-5s5.8 1.4 7 5M29 19h9M29 25h9M29 31h5"/>',
  alert:'<path d="M24 6 44 40H4z"/><path d="M24 19v10M24 34v1"/>',
  phone:'<path d="M14 6h7l3 9-5 3a24 24 0 0 0 11 11l3-5 9 3v7a4 4 0 0 1-4 4C21 38 10 27 10 10a4 4 0 0 1 4-4z"/>',
  speaker:'<path d="M8 19v10h8l10 8V11l-10 8z"/><path d="M32 18a8 8 0 0 1 0 12M36 13a14 14 0 0 1 0 22"/>',
  sms:'<path d="M6 10h36v24H20l-9 7v-7H6z"/><path d="M14 19h20M14 25h13"/>',
  heart:'<path d="M24 41S6 30 6 17a9 9 0 0 1 18-3 9 9 0 0 1 18 3c0 13-18 24-18 24z"/><path d="M12 24h7l3-5 4 9 3-4h7"/>',
  senior:'<circle cx="22" cy="8" r="4"/><path d="M22 14v14l-6 14M22 28l6 14M22 18l-8 8M22 18l8 6"/><path d="M34 24v18"/>',
  pwd:'<circle cx="22" cy="8" r="4"/><path d="M22 13v13h11l4 11"/><path d="M16 20a12 12 0 1 0 14 17"/>',
  pregnant:'<circle cx="22" cy="8" r="4"/><path d="M20 14c-3 5-3 10 0 14l-2 14M22 14c7 2 11 7 11 12s-4 7-9 6l1 10"/>',
  person:'<circle cx="24" cy="13" r="7"/><path d="M10 42c1-9 7-14 14-14s13 5 14 14"/>',
  walk:'<circle cx="26" cy="7" r="4"/><path d="M22 16l-6 8M24 14l4 12 8 4M26 26l-6 16M24 30l8 12"/>',
  print:'<path d="M14 18V6h20v12"/><rect x="6" y="18" width="36" height="16" rx="3"/><path d="M14 28h20v14H14z"/>',
  download:'<path d="M24 6v24M14 20l10 10 10-10"/><path d="M8 36v6h32v-6"/>',
  gear:'<circle cx="24" cy="24" r="6"/><path d="M24 4v6M24 38v6M4 24h6M38 24h6M9.9 9.9l4.2 4.2M33.9 33.9l4.2 4.2M9.9 38.1l4.2-4.2M33.9 14.1l4.2-4.2"/>',
  pill:'<rect x="5" y="17" width="38" height="14" rx="7" transform="rotate(-35 24 24)"/><path d="M19 17l10 14"/>',
  check:'<path d="M9 25l10 10 20-22"/>',
  tooth:'<path d="M14 8c-5 0-8 4-7 10 1 5 3 7 4 13 1 5 2 10 5 10s3-8 5-11c1-2 5-2 6 0 2 3 2 11 5 11s4-5 5-10c1-6 3-8 4-13 1-6-2-10-7-10-4 0-6 2-10 2s-6-2-10-2z"/>',
  syringe:'<path d="M31 7l10 10M36 12 16 32l-6-6 20-20z"/><path d="M10 38l6-6M6 42l4-4M20 18l4 4M25 13l4 4"/>',
  baby:'<circle cx="24" cy="15" r="9"/><path d="M20 15h.1M28 15h.1M21 19c2 1.5 4 1.5 6 0"/><path d="M12 42c1-8 6-13 12-13s11 5 12 13"/>',
  paw:'<circle cx="14" cy="18" r="4"/><circle cx="22" cy="11" r="4"/><circle cx="31" cy="12" r="4"/><circle cx="37" cy="20" r="4"/><path d="M16 35c0-7 5-12 10-12s10 5 9 11c-1 5-5 5-9 3-4 2-10 4-10-2z"/>',
  steth:'<path d="M12 6v12a8 8 0 0 0 16 0V6"/><path d="M20 26v4a9 9 0 0 0 18 0v-6"/><circle cx="38" cy="20" r="4"/>',
  logout:'<path d="M20 8H8v32h12"/><path d="M30 14l10 10-10 10M40 24H18"/>',
  plus:'<path d="M24 8v32M8 24h32"/>',
  pin:'<path d="M24 44s14-13.5 14-25a14 14 0 0 0-28 0c0 11.5 14 25 14 25z"/><circle cx="24" cy="19" r="5"/>',
  users:'<circle cx="24" cy="15" r="6"/><path d="M13 38c0-7 5-11 11-11s11 4 11 11z"/><circle cx="11" cy="19" r="4.5"/><path d="M3 36c0-5 3.5-8 8-8 1.6 0 3 .4 4.2 1"/><circle cx="37" cy="19" r="4.5"/><path d="M45 36c0-5-3.5-8-8-8-1.6 0-3 .4-4.2 1"/>',
  clinic:'<path d="M6 22 24 8l18 14"/><path d="M10 19v23h28V19"/><path d="M21 42v-9h6v9"/><path d="M24 20v8M20 24h8"/>'
};
const icon = (k, cls='', sw=2.4) => `<svg class="${cls}" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[k]||I.info}</svg>`;

/* =========================================================
   SEED DATA
   ========================================================= */
function vcode(){ const A='ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let s=''; for (let i=0;i<6;i++) s += A[Math.floor(rand01()*A.length)]; return 'KLG-' + s; }
/* ---------- reasons for visit (used by the reports and the staffing / surge planner) ---------- */
const CONCERNS = { fever:'Fever / dengue-like illness', cough:'Cough, colds, flu', bp:'High blood pressure', sugar:'Diabetes', diarrhea:'Diarrhea / stomach', wound:'Wound / skin', other:'Other' };

/* ---------- Philippine holidays, pre-set for every year (Holy Week moves with Easter) ---------- */
function easter(y){
  const a = y % 19, b = Math.floor(y/100), c = y % 100, d = Math.floor(b/4), e = b % 4, f = Math.floor((b+8)/25), g = Math.floor((b-f+1)/3);
  const h = (19*a + b - d - g + 15) % 30, i = Math.floor(c/4), k = c % 4, l = (32 + 2*e + 2*i - h - k) % 7, m = Math.floor((a + 11*h + 22*l)/451);
  const month = Math.floor((h + l - 7*m + 114)/31), day = ((h + l - 7*m + 114) % 31) + 1;
  return `${y}-${pad(month)}-${pad(day)}`;
}
const holidayCache = {};
function phHolidays(y){
  if (holidayCache[y]) return holidayCache[y];
  const E = easter(y), H = {};
  let heroes = `${y}-08-31`; while (dowOf(heroes) !== 1) heroes = addDays(heroes, -1);   // last Monday of August
  [[`${y}-01-01`,"New Year's Day"],[addDays(E,-3),'Maundy Thursday (Holy Week)'],[addDays(E,-2),'Good Friday (Holy Week)'],[addDays(E,-1),'Black Saturday (Holy Week)'],
   [`${y}-04-09`,'Araw ng Kagitingan'],[`${y}-05-01`,'Labor Day'],[`${y}-06-12`,'Independence Day'],[`${y}-08-19`,'Quezon City Day'],[`${y}-08-21`,'Ninoy Aquino Day'],
   [heroes,'National Heroes Day'],[`${y}-11-01`,"All Saints' Day"],[`${y}-11-02`,"All Souls' Day"],[`${y}-11-30`,'Bonifacio Day'],[`${y}-12-08`,'Feast of the Immaculate Conception'],
   [`${y}-12-24`,'Christmas Eve'],[`${y}-12-25`,'Christmas Day'],[`${y}-12-30`,'Rizal Day'],[`${y}-12-31`,'Last day of the year']].forEach(([d, n]) => { H[d] = n; });
  return holidayCache[y] = H;
}

function defaultCenter(){
  return { open:'08:00', close:'20:00', days:[1,2,3,4,5], lunchStart:'12:00', lunchEnd:'13:00',
    sessions:[ { id:'am', name:'Morning', tl:'Umaga', start:'08:00', cutoff:'11:00' }, { id:'pm', name:'Afternoon', tl:'Hapon', start:'13:00', cutoff:'19:00' } ],
    force:'auto', forceNote:'', lockSite:false, demo:false, grace:15,
    autoHolidays:true, noticeDays:1, smsOn:false, cutNow:null, restockPct:20, pharmacyEmail:'pharmacy@kaligayahan.example' };
}

// A brand-new, empty record set: the clinic's settings and services only. Doctors, medicines,
// announcements and patients are added by the staff.
function seed(){
  const T = now().date;
  const services = [
    { code:'CU', name:'General Check-up', tl:'Konsulta', icon:'steth', desc:'For fever, cough, blood pressure follow-up and other common illnesses.', avg:12, limit:40, walkin:15, open:true, note:'' },
    { code:'AR', name:'Anti-Rabies', tl:'Bakuna kontra rabies', icon:'paw', desc:'Vaccine after an animal bite or scratch. Bring your bite record card.', avg:10, limit:25, walkin:10, open:true, note:'' },
    { code:'VX', name:'Vaccination', tl:'Bakuna / Immunization', icon:'syringe', desc:'Child immunization, flu and pneumonia vaccines for senior citizens.', avg:8, limit:40, walkin:15, open:true, note:'' },
    { code:'PN', name:'Prenatal Check-up', tl:'Para sa buntis', icon:'baby', desc:'Check-up for pregnant women. Bring your MCH booklet.', avg:15, limit:20, walkin:8, open:true, note:'' },
    { code:'DN', name:'Dental', tl:'Ngipin', icon:'tooth', desc:'Tooth extraction and dental check-up.', avg:20, limit:15, walkin:5, open:true, note:'' }
  ];
  return { v:2, created:T, center:defaultCenter(), services, doctors:[], medicines:[], tickets:[], turned:{}, sms:[], medRequests:[], closures:[], announcements:[],
    pending:[], subs:[], monthly:[], stockHist:{}, sample:false };
}
const svcName = (services, code) => (services.find(s => s.code === code) || {}).name || code;

/* =========================================================
   STATE
   ========================================================= */
let S, saveFailed = false, loadWarning = '';
function load(){
  let raw = null; try { raw = localStorage.getItem(KEY); } catch(e){}
  if (raw) {
    try { const o = JSON.parse(raw); if (o && o.v === 2 && Array.isArray(o.tickets) && Array.isArray(o.medicines) && o.center) {
      if (o.sample !== false) { S = seed(); if (Array.isArray(o.users)) { S.users = o.users; S.rev = o.rev; } migrate(); save(); return; }   // old made-up sample records: start clean
      S = o; migrate(); return; } } catch(e){}
    // saved data could not be read: keep a copy instead of silently replacing it
    try { localStorage.setItem(KEY + '-damaged-' + now().date, raw); } catch(e){}
    loadWarning = 'Saved data could not be read, so sample data was loaded. A copy of the damaged data was kept on this device.';
  }
  S = seed(); migrate(); save();
}
// save, and show a warning bar if the browser refuses (storage full, private mode, blocked)
function save(){
  if (SERVER.on) { if (SERVER.me) queueSync(); return true; }
  let ok = true;
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch(e){ ok = false; }
  if (ok === saveFailed) { saveFailed = !ok; saveWarning(); }
  return ok;
}
function saveWarning(){
  let el = document.getElementById('saveWarn');
  if (!saveFailed) { if (el) el.remove(); return; }
  if (!el) { el = document.createElement('div'); el.id = 'saveWarn'; el.setAttribute('role', 'alert'); document.body.appendChild(el); }
  el.innerHTML = `<b>Changes are not being saved on this device.</b> <span>The browser storage may be full or blocked (for example in private browsing).</span> ${S && currentUser() && can('settings') ? '<button class="btn white sm" type="button" data-act="backup">Download a backup now</button>' : '<span>Please tell the health center staff.</span>'}`;
}
function commit(msg){ recordStock(); save(); render(); if (msg) toast(msg); }

/* =========================================================
   SECURE SERVER CONNECTION
   When the page is served by backend/run.py, every change goes to the server, which checks
   it, saves it in the encrypted database and shares it with every other screen. Residents
   only send forms (book, cancel, request, subscribe); staff changes are sent as a list of
   changed records and checked against the staff member's role on the server.
   ========================================================= */
const SERVER = { on:false, rev:-1, cursor:0, me:null, csrf:'', tabs:[], syncing:false, again:false, pending:false, timer:null, retry:null, down:false, inflight:new Map() };
let BASE = null;            // the last copy received from the server, to find what changed
const MINE_FULL = {};       // this device's own tickets, with the personal details
class ApiError extends Error { constructor(m, s){ super(m); this.status = s; } }
async function api(path, opts = {}){
  const method = opts.method || 'GET', o = { method, headers:{ Accept:'application/json' }, credentials:'same-origin', cache:'no-store' };
  if (method !== 'GET') { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(opts.body === undefined ? {} : opts.body); if (SERVER.csrf) o.headers['X-CSRF-Token'] = SERVER.csrf; }
  if (opts.background) o.headers['X-Background'] = '1';      // automatic refresh: does not keep a staff session awake
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), opts.timeout || 20000);
  o.signal = ctl.signal;
  let r;
  try { r = await fetch(path, o); } catch(e){ clearTimeout(timer); throw new ApiError('Cannot reach the health center server. Please check the connection and try again.', 0); }
  let j = null; try { j = await r.json(); } catch(e){}
  clearTimeout(timer);
  if (j && j.serverTime && typeof j.serverTime.ts === 'number') CLOCK.offset = j.serverTime.ts - Date.now();
  if (!r.ok) {
    if (r.status === 401 && SERVER.me && (path.startsWith('/api/staff') || path.startsWith('/api/auth/password'))) sessionEnded();
    throw new ApiError((j && j.error) || 'Something went wrong. Please try again.', r.status);
  }
  if (!j) throw new ApiError('The server sent an unexpected reply.', r.status);
  return j;
}
function setMe(j){ SERVER.me = j && j.user || null; SERVER.csrf = j && j.csrf || ''; SERVER.tabs = j && j.tabs || []; }
function clearStaffState(){
  setMe(null); BASE = null; SERVER.cursor = 0; SERVER.inflight = new Map();
  clearTimeout(SERVER.timer); clearTimeout(SERVER.retry); SERVER.pending = false;
  SYS = null; showXlsPw = false; apQ = ''; smsQ = ''; rp = null; pendingRestore = null; adminTab = 'dash';
  closeModal();
}
function sessionEnded(){
  if (!SERVER.me) return;
  clearStaffState();
  toast('Your session ended. Please log in again.');
  pull(true).catch(() => {}).then(() => render());
}
// wait until every change on this screen has reached the server (or failed)
async function flushSync(){
  clearTimeout(SERVER.timer);
  for (let i = 0; i < 100 && (SERVER.pending || SERVER.syncing); i++) {
    if (!SERVER.syncing && SERVER.pending) await doSync(); else await new Promise(r => setTimeout(r, 100));
    if (SERVER.down) break;
  }
  return !SERVER.pending && !SERVER.syncing;
}
const SYNC_COLLS = { tickets:'id', medicines:'id', medRequests:'id', doctors:'id', services:'code', announcements:'id', closures:'id', sms:'id' };
const WRITES = {
  admin:['tickets','medicines','medRequests','doctors','services','announcements','closures','sms','subs','center','turned','pending','sample'],
  bhw:['tickets','doctors','announcements','sms','subs','turned'],
  pharmacy:['medicines','medRequests','sms','center']
};
// Older tickets arrive without personal details (for reports only). They are never edited, so they
// are left out of the change tracking.
const tracked = (c, r) => !(c === 'tickets' && !('code' in r));
function snapshot(st){
  const b = { colls:{}, kv:{}, subs:JSON.stringify(st.subs || []) };
  Object.entries(SYNC_COLLS).forEach(([c, k]) => { const m = new Map(); (st[c] || []).forEach(r => { if (tracked(c, r)) m.set(r[k], JSON.stringify(r)); }); b.colls[c] = m; });
  ['center','turned','pending','sample'].forEach(k => { b.kv[k] = JSON.stringify(st[k]); });
  return b;
}
function diffState(){
  if (!BASE || !SERVER.me) return null;
  const can = WRITES[SERVER.me.role] || [], out = {}; let any = false;
  Object.entries(SYNC_COLLS).forEach(([c, k]) => {
    if (!can.includes(c)) return;
    const base = BASE.colls[c], ups = [], seen = new Set(), from = {};
    (S[c] || []).forEach(r => { if (!tracked(c, r)) return; seen.add(r[k]); const b = base.get(r[k]); if (b !== JSON.stringify(r)) { ups.push(r); if (b && c !== 'sms') from[r[k]] = JSON.parse(b); } });
    const dels = c === 'sms' ? [] : [...base.keys()].filter(id => !seen.has(id));
    dels.forEach(id => { from[id] = JSON.parse(base.get(id)); });
    // `base`: the version this screen started from, so the server can merge with other people's changes
    if (ups.length || dels.length) { out[c] = { upsert:ups, delete:dels, base:from }; any = true; }
  });
  if (can.includes('subs') && JSON.stringify(S.subs || []) !== BASE.subs) { out.subs = S.subs || []; any = true; }
  const kv = {};
  ['center','turned','pending','sample'].forEach(k => { if (can.includes(k) && JSON.stringify(S[k]) !== BASE.kv[k]) kv[k] = S[k]; });
  if (Object.keys(kv).length) { out.kv = kv; any = true; }
  return any ? out : null;
}
function applyServer(state, rev){
  SERVER.rev = rev; SERVER.cursor = state.cursor || 0;
  S = state; S.users = state.users || []; S.subs = state.subs || [];
  BASE = SERVER.me ? snapshot(S) : null;
  if (!SERVER.me) overlayMine();
}
// Merge "only what changed" from the server. A record this screen has changed but not yet saved
// keeps the local version (it will be sent next); everything else takes the server's version.
function mergeDelta(d){
  Object.entries(d.changes || {}).forEach(([c, recs]) => {
    const k = SYNC_COLLS[c]; if (!k) return;
    const list = S[c] || (S[c] = []), idx = new Map(list.map((r, i) => [r[k], i])), base = BASE && BASE.colls[c];
    recs.forEach(r => {
      const id = r[k], i = idx.get(id), js = JSON.stringify(r);
      if (i == null && base && base.has(id) && !SERVER.inflight.has(c + ':' + id)) { base.set(id, js); return; }   // deleted here, not yet saved
      const local = i != null ? JSON.stringify(list[i]) : null;
      const dirty = base && local != null && local !== base.get(id) && local !== SERVER.inflight.get(c + ':' + id);
      if (!dirty) { if (i != null) list[i] = r; else { idx.set(id, list.length); list.push(r); } }
      if (base && tracked(c, r)) base.set(id, js);
    });
  });
  Object.entries(d.deleted || {}).forEach(([c, ids]) => {
    const k = SYNC_COLLS[c]; if (!k) return;
    const gone = new Set(ids); S[c] = (S[c] || []).filter(r => !gone.has(r[k]));
    if (BASE && BASE.colls[c]) ids.forEach(id => BASE.colls[c].delete(id));
  });
  ['center','turned','pending','stockHist','sample','created'].forEach(key => {
    if (!(key in d)) return;
    const v = d[key] ?? ({ turned:{}, pending:[], stockHist:{}, sample:false })[key] ?? d[key], dirty = BASE && key in BASE.kv && JSON.stringify(S[key]) !== BASE.kv[key] && JSON.stringify(S[key]) !== SERVER.inflight.get('kv:' + key);
    if (!dirty) S[key] = v;
    if (BASE && key in BASE.kv) BASE.kv[key] = JSON.stringify(v);
  });
  if ('subs' in d) {
    const dirty = BASE && JSON.stringify(S.subs || []) !== BASE.subs && JSON.stringify(S.subs || []) !== SERVER.inflight.get('subs');
    if (!dirty) S.subs = d.subs || [];
    if (BASE) BASE.subs = JSON.stringify(d.subs || []);
  }
  if (Array.isArray(d.users)) S.users = d.users;
}
// fetch the newest data (only if something changed since the last time)
async function pull(force){
  const staff = !!SERVER.me, delta = staff && !force && SERVER.cursor && BASE;
  const url = (staff ? '/api/staff/state' : '/api/public/state') + '?rev=' + (force ? -1 : SERVER.rev) + (delta ? '&since=' + SERVER.cursor : '');
  const j = await api(url, { background:!force });
  netWarning(false);
  if (j.same) return false;
  if (j.state && j.state.delta) { if (j.state.users === undefined && S.users) j.state.users = S.users; mergeDelta(j.state); SERVER.cursor = j.state.cursor; SERVER.rev = j.rev; }
  else applyServer(j.state, j.rev);
  return true;
}
function queueSync(){
  SERVER.pending = true;
  clearTimeout(SERVER.timer); SERVER.timer = setTimeout(doSync, 120);
}
async function doSync(){
  if (SERVER.syncing) { SERVER.again = true; return; }
  clearTimeout(SERVER.retry);
  const changes = diffState();
  if (!changes) { SERVER.pending = false; return; }
  SERVER.syncing = true;
  SERVER.inflight = new Map();
  Object.entries(changes).forEach(([c, v]) => {
    if (SYNC_COLLS[c]) (v.upsert || []).forEach(r => SERVER.inflight.set(c + ':' + r[SYNC_COLLS[c]], JSON.stringify(r)));
    else if (c === 'kv') Object.entries(v).forEach(([k, x]) => SERVER.inflight.set('kv:' + k, JSON.stringify(x)));
    else if (c === 'subs') SERVER.inflight.set('subs', JSON.stringify(v));
  });
  let retry = false;
  try {
    const res = await api('/api/staff/sync', { method:'POST', body:changes });
    try { await pull(false); } catch(_){}
    if (res.conflicts && res.conflicts.length) openModal(`<h2>Someone else changed this first</h2><p>Your change to <b>${esc(res.conflicts.slice(0, 5).join(', '))}${res.conflicts.length > 5 ? ' and more' : ''}</b> was not saved, because another staff member or the patient changed it a moment earlier. The screen now shows the latest information. Please check it and do it again if it is still needed.</p><div class="btn-row"><button class="btn primary" type="button" data-act="closeModal">OK</button></div>`);
    if (!busy()) render();
    netWarning(false);
  } catch(e){
    if (e.status) {                           // refused by the server: show why and reload the real data
      toast('Not saved: ' + e.message);
      try { await pull(true); render(); } catch(_){}
    } else { netWarning(true); retry = true; } // connection problem: keep the change and try again
  } finally {
    SERVER.syncing = false; SERVER.inflight = new Map();
    if (SERVER.again) { SERVER.again = false; doSync(); }
    else if (retry) SERVER.retry = setTimeout(doSync, 5000);
    else SERVER.pending = false;
  }
}
function netWarning(on){
  if (SERVER.down === on) return; SERVER.down = on;
  let el = document.getElementById('netWarn');
  if (!on) { if (el) el.remove(); return; }
  if (!el) { el = document.createElement('div'); el.id = 'netWarn'; el.setAttribute('role', 'alert'); document.body.appendChild(el); }
  el.innerHTML = '<b>No connection to the health center server.</b> <span>Trying again… What you see may be out of date.</span>';
}
// a resident's own tickets: the code is kept on this device and proves the ticket is theirs
const OWN_FIELDS = ['name','age','contact','email','address','concern','code','val','smsOff','consentAt'];
function rememberTicket(t){
  addMyTicket(t.id, t.code); MINE_FULL[t.id] = t;
  const i = S.tickets.findIndex(x => x.id === t.id);
  if (i >= 0) Object.assign(S.tickets[i], t); else S.tickets.push({ ...t });
}
function overlayMine(){
  S.tickets.forEach(t => { const m = MINE_FULL[t.id]; if (m) OWN_FIELDS.forEach(k => { t[k] = m[k]; }); });
}
async function refreshMine(){
  const codes = myCodes(), items = Object.entries(codes).slice(-20).map(([id, code]) => ({ id, code }));
  if (!items.length) return;
  try { const j = await api('/api/public/tickets/mine', { method:'POST', body:{ items } }); j.tickets.forEach(t => { MINE_FULL[t.id] = t; }); overlayMine(); } catch(e){}
}
// Anti-bot check before a public form is sent: solve the server's small puzzle (well under a
// second on a phone), and, when the health center switched it on, include the Turnstile answer.
async function solvePuzzle(){
  const c = await api('/api/public/challenge'), zeros = '0'.repeat(c.bits / 4);
  for (let i = 0; i < 50000000; i++) {
    if (sha256(c.token + ':' + i).startsWith(zeros)) return c.token + ':' + i;
    if (i % 3000 === 2999) await new Promise(r => setTimeout(r));
  }
  throw new ApiError('The security check could not finish. Please try again.', 0);
}
async function guard(body, form){
  const b = form && form.querySelector('[type="submit"]'), label = b && b.innerHTML;
  if (b) b.textContent = 'Checking…';
  try {
    body.pow = await solvePuzzle();
    if (SERVER.captcha) {
      body.captcha = (form && form.querySelector('[name="cf-turnstile-response"]') || {}).value || '';
      if (!body.captcha) throw new ApiError('Please complete the "I am not a robot" check first.', 0);
    }
  } finally { if (b && b.isConnected) b.innerHTML = label; }
  return body;
}
function resetCaptcha(form){ try { const w = form && form.querySelector('.cf-turnstile'); if (w && window.turnstile && w.dataset.wid) window.turnstile.reset(w.dataset.wid); } catch(e){} }
const captchaBox = () => SERVER.on && SERVER.captcha ? `<div class="cf-turnstile" data-sitekey="${esc(SERVER.captcha)}"></div>` : '';
function mountCaptcha(){
  if (!SERVER.captcha) return;
  const boxes = [...document.querySelectorAll('.cf-turnstile:not([data-wid])')];
  if (!boxes.length) return;
  if (!window.turnstile) {
    if (!document.getElementById('cfTs')) { const s = document.createElement('script'); s.id = 'cfTs'; s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; s.async = true; s.onload = mountCaptcha; document.head.appendChild(s); }
    return;
  }
  boxes.forEach(el => { try { el.dataset.wid = window.turnstile.render(el, { sitekey:el.dataset.sitekey, size:el.clientWidth < 300 ? 'compact' : 'normal' }); } catch(e){} });
}
function deviceId(){
  let d = ls.get('bkhc-device');
  if (!d || !/^[A-Za-z0-9_-]{16,64}$/.test(d)) { d = uid() + uid() + uid(); ls.set('bkhc-device', d); }
  return d;
}
// replace the data on the server (backup restore, sample data, clearing sample records)
function serverRestore(data, msg){
  toast('Saving…');
  api('/api/staff/restore', { method:'POST', body:{ data, keepUsers:true } })
    .then(() => pull(true)).then(() => { flow = { step:1, prio:null, svc:null, err:'', data:{} }; rp = null; SYS = null; render(); toast(msg); })
    .catch(e => toast(e.message));
}

// bring older saved data up to date with new features
function migrate(){
  let ch = false; const c = S.center;
  if (c.restockPct == null) {          // v2.1: restock reminder at 20% of full stock
    c.restockPct = 20; c.pharmacyEmail = 'pharmacy@kaligayahan.example';
    S.medicines.forEach(m => { m.thr = Math.min(m.thr, Math.round(m.cap * 0.15)); delete m.reorder; m.status = medStatusFor(m.stock, m.thr); });
    ch = true;
  }
  if (!S.stockHist) { S.stockHist = {}; ch = true; }
  if (!S.hoursV || S.hoursV < 2) {     // v2.4: open until 8 PM, afternoon online cut-off 7 PM (only if still the old defaults)
    if (c.close === '17:00') c.close = '20:00';
    const pm = (c.sessions || []).find(s => s.id === 'pm');
    if (pm && pm.cutoff === '16:00') pm.cutoff = '19:00';
    S.hoursV = 2; ch = true;
  }
  if (!S.rev || S.rev < 3) {           // v2.3: staff accounts, sample-data label, practice mode off by default
    S.rev = 3; c.demo = false;
    if (S.sample == null) S.sample = false;
    if (!S.users) S.users = defaultUsers();
    ch = true;
  }
  if (!SERVER.on && (S.users || []).some(u => u.mustChange && ['kaligayahan','bhw-kaligayahan1','pharmacy-kaligayahan1'].some(p => hashPw(u.salt, p) === u.hash))) {
    const users = S.users, fresh = defaultUsers(); S.users = users.map(u => fresh.find(f => f.user === u.user && u.mustChange) || u); ch = true;
  }
  if (ch) save();
}

/* ---------- staff accounts & roles ----------
   Passwords are stored only as salted SHA-256 hashes. Default accounts must change their password
   on first login. (In this browser-only prototype the checks still run on the device; a real
   deployment must check logins on a server.) */
/* ---------- SHA-256 (for staff passwords; works offline and from file://) ---------- */
const SHA_K = (() => { const k = [], prime = n => { for (let f = 2; f * f <= n; f++) if (n % f === 0) return false; return true; };
  for (let n = 2; k.length < 64; n++) if (prime(n)) k.push((Math.cbrt(n) % 1) * 4294967296 | 0); return k; })();
const SHA_H = (() => { const h = [], prime = n => { for (let f = 2; f * f <= n; f++) if (n % f === 0) return false; return true; };
  for (let n = 2; h.length < 8; n++) if (prime(n)) h.push((Math.sqrt(n) % 1) * 4294967296 | 0); return h; })();
function sha256(str){
  const bytes = new TextEncoder().encode(str), len = bytes.length, total = ((len + 9 + 63) >> 6) << 4, words = new Array(total).fill(0);
  for (let i = 0; i < len; i++) words[i >> 2] |= bytes[i] << (24 - (i % 4) * 8);
  words[len >> 2] |= 0x80 << (24 - (len % 4) * 8);
  words[total - 1] = len * 8;
  let h = SHA_H.slice(); const w = new Array(64);
  for (let i = 0; i < total; i += 16) {
    for (let t = 0; t < 64; t++) {
      if (t < 16) w[t] = words[i + t] | 0;
      else { const a = w[t-15], b = w[t-2];
        const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3), s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
        w[t] = (w[t-16] + s0 + w[t-7] + s1) | 0; }
    }
    let [A, B, C, D, E, F, G, H] = h;
    for (let t = 0; t < 64; t++) {
      const S1 = ((E >>> 6) | (E << 26)) ^ ((E >>> 11) | (E << 21)) ^ ((E >>> 25) | (E << 7)), ch = (E & F) ^ (~E & G);
      const t1 = (H + S1 + ch + SHA_K[t] + w[t]) | 0;
      const S0 = ((A >>> 2) | (A << 30)) ^ ((A >>> 13) | (A << 19)) ^ ((A >>> 22) | (A << 10)), maj = (A & B) ^ (A & C) ^ (B & C);
      H = G; G = F; F = E; E = (D + t1) | 0; D = C; C = B; B = A; A = (t1 + ((S0 + maj) | 0)) | 0;
    }
    h = [A, B, C, D, E, F, G, H].map((v, j) => (v + h[j]) | 0);
  }
  return h.map(v => (v >>> 0).toString(16).padStart(8, '0')).join('');
}

const ROLES = {
  admin:{ label:'Administrator', tabs:['dash','queue','appts','doctors','meds','ann','sms','reports','settings','users','account'] },
  bhw:{ label:'Health worker (BHW / nurse)', tabs:['dash','queue','appts','doctors','ann','sms','account'] },
  pharmacy:{ label:'Pharmacy staff', tabs:['dash','meds','account'] }
};
const hashPw = (salt, pw) => sha256(salt + ':' + pw);
function makeUser(user, name, role, pw){ const salt = uid() + uid(); return { id:'u' + uid(), user, name, role, salt, hash:hashPw(salt, pw), mustChange:true, created:now().date }; }
// Offline demo only (the real server makes its own accounts). One-time passwords are random and
// shown on the offline staff sign-in page until each account has chosen its own password.
function defaultUsers(){
  const pw = { admin:tempPassword(), bhw:tempPassword(), pharmacy:tempPassword() };
  ls.set('bkhc-demo-pw', JSON.stringify(pw));
  return [makeUser('admin', 'Administrator', 'admin', pw.admin), makeUser('bhw', 'Health worker', 'bhw', pw.bhw), makeUser('pharmacy', 'Pharmacy staff', 'pharmacy', pw.pharmacy)];
}
function demoPasswords(){
  if (SERVER.on || !S || !S.users) return [];
  let pw = {}; try { pw = JSON.parse(ls.get('bkhc-demo-pw') || '{}') || {}; } catch(e){}
  return S.users.filter(u => u.mustChange && pw[u.user]).map(u => [u.user, pw[u.user]]);
}
const currentUser = () => SERVER.on ? SERVER.me : ((S && S.users || []).find(u => u.id === ss.get(AKEY)) || null);
const isAdmin = () => !!currentUser();                 // signed in as any staff member
const can = tab => { if (SERVER.on) return !!SERVER.me && SERVER.tabs.includes(tab); const u = currentUser(); return !!u && (ROLES[u.role] || ROLES.bhw).tabs.includes(tab); };
const loginLockLeft = () => { const t = +ss.get('bkhc-lock') || 0; return t > Date.now() ? Math.ceil((t - Date.now()) / 1000) : 0; };
function pwProblem(pw, user){
  if (pw.length < 10) return 'Use at least 10 characters.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Use both letters and numbers.';
  if (user && pw.toLowerCase().includes(user.toLowerCase())) return 'Do not put the username inside the password.';
  return '';
}
function tempPassword(){ const L = 'abcdefghjkmnpqrstuvwxyz', D = '23456789'; let s = ''; for (let i = 0; i < 6; i++) s += L[Math.floor(rand01() * L.length)]; return s + D[Math.floor(rand01() * D.length)] + D[Math.floor(rand01() * D.length)]; }

/* ---------- keeping stored data small and private ----------
   Runs once a day: personal details are removed from records older than 90 days (the counts
   stay for reports), and very old records and messages are deleted. */
const KEEP_PERSONAL_DAYS = 90, KEEP_RECORD_DAYS = 400, KEEP_MESSAGE_DAYS = 60;
function trimOld(){
  const T = now().date, pCut = addDays(T, -KEEP_PERSONAL_DAYS), rCut = addDays(T, -KEEP_RECORD_DAYS), mCut = addDays(T, -KEEP_MESSAGE_DAYS);
  S.tickets = S.tickets.filter(t => t.date >= rCut);
  S.tickets.forEach(t => { if (t.date < pCut && !t.anon) Object.assign(t, { name:'(removed)', contact:'', email:'', address:'', anon:true }); });
  S.sms = S.sms.filter(m => m.date >= mCut);
  S.medRequests = S.medRequests.filter(r => !(['claimed','cancelled'].includes(r.status) && r.date < pCut));
  S.medRequests.forEach(r => { if (r.date < pCut && !r.anon) Object.assign(r, { name:'(removed)', contact:'', email:'', anon:true }); });
  Object.keys(S.turned).forEach(d => { if (d < rCut) delete S.turned[d]; });
}
const storageUsed = () => { try { return JSON.stringify(S).length; } catch(e){ return 0; } };
// remember today's stock of every medicine (keeps the last 30 days)
function recordStock(){
  if (!S.stockHist) S.stockHist = {};
  const T = now().date; let ch = false;
  S.medicines.forEach(m => {
    const h = S.stockHist[m.id] = S.stockHist[m.id] || {};
    if (h[T] !== m.stock) { h[T] = m.stock; ch = true; }
    const days = Object.keys(h).sort(); if (days.length > 30) days.slice(0, days.length - 30).forEach(d => delete h[d]);
  });
  return ch;
}
// one restock reminder email a day to the pharmacy while anything is at or below the restock level
function restockReminder(force){
  const due = S.medicines.filter(needsReorder), T = now().date;
  if (!due.length || (!force && S.lastRestockMail === T)) return false;
  S.lastRestockMail = T;
  S.sms.push({ id:uid(), ts:Date.now(), date:T, ch:'email', to:S.center.pharmacyEmail || 'pharmacy@kaligayahan.example', tid:'', num:'STOCK',
    text:(`BKHC: Restock reminder — ${due.length} medicine${due.length>1?'s are':' is'} at or below ${restockPct()}% of full stock: ` + due.map(m => `${m.name} ${m.stock}/${m.cap}`).join('; ') + '.').slice(0, 990) });
  return true;
}
function myTickets(){ try { return JSON.parse(ls.get(TKEY) || '[]'); } catch(e){ return []; } }
const memMine = [];
function addMyTicket(id, code){
  const a = myTickets().filter(x => x !== id); a.push(id); ls.set(TKEY, JSON.stringify(a.slice(-20))); memMine.push(id);
  if (code) { const m = myCodeRecs(); delete m[id]; m[id] = { code, date:now().date }; const keep = Object.keys(m).slice(-20); ls.set(TKEY + '-codes2', JSON.stringify(Object.fromEntries(keep.map(k => [k, m[k]])))); }
}
// ticket codes are kept on this device only for today's tickets
function myCodeRecs(){ try { const m = JSON.parse(ls.get(TKEY + '-codes2') || '{}') || {}, T = now().date; Object.keys(m).forEach(k => { if (!m[k] || m[k].date !== T) delete m[k]; }); return m; } catch(e){ return {}; } }
function myCodes(){ const m = myCodeRecs(), out = {}; Object.keys(m).forEach(k => { out[k] = m[k].code; }); return out; }
// Offline mode has no server to check a restored file, so ids, codes, numbers and times are cleaned here.
function sanitizeImport(d){
  const id = v => String(v ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  const tok = v => String(v ?? '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 12);
  const num = (v, d0 = 0) => Number.isFinite(+v) ? +v : d0;
  const hm = (v, d0) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : d0;
  (d.tickets || []).forEach(t => { t.id = id(t.id); t.svc = tok(t.svc); t.num = tok(t.num); t.code = tok(t.code); if (t.origNum) t.origNum = tok(t.origNum);
    ['age','cmin','calledMin','doneMin','calledAt','consentAt'].forEach(k => { if (t[k] != null) t[k] = num(t[k]); }); });
  (d.medicines || []).forEach(m => { m.id = id(m.id); ['stock','cap','thr','freq'].forEach(k => { m[k] = num(m[k]); }); });
  (d.services || []).forEach(s => { s.code = tok(s.code); s.icon = String(s.icon || '').replace(/[^a-z]/g, ''); ['avg','limit','walkin'].forEach(k => { s[k] = num(s[k], 1); }); });
  (d.doctors || []).forEach(x => { x.id = id(x.id); x.limit = num(x.limit); x.days = (Array.isArray(x.days) ? x.days : []).map(v => num(v)).filter(v => v >= 0 && v <= 6); x.start = hm(x.start, '08:00'); x.end = hm(x.end, '17:00'); });
  (d.medRequests || []).forEach(r => { r.id = id(r.id); r.medId = id(r.medId); r.qty = num(r.qty, 1); r.code = tok(r.code); });
  ['announcements','closures','sms'].forEach(c => (d[c] || []).forEach(x => { x.id = id(x.id); }));
  (d.closures || []).forEach(x => { x.open = hm(x.open, ''); x.close = hm(x.close, ''); });
  const c = d.center || {}; c.open = hm(c.open, '08:00'); c.close = hm(c.close, '20:00'); c.lunchStart = hm(c.lunchStart, ''); c.lunchEnd = hm(c.lunchEnd, '');
  (c.sessions || []).forEach(s => { s.id = id(s.id); s.start = hm(s.start, '08:00'); s.cutoff = hm(s.cutoff, '11:00'); });
  return d;
}
function forgetMine(){
  try { localStorage.removeItem(TKEY); localStorage.removeItem(TKEY + '-codes'); localStorage.removeItem(TKEY + '-codes2'); } catch(e){}
  memMine.length = 0; Object.keys(MINE_FULL).forEach(k => delete MINE_FULL[k]); viewTicketId = null;
  S.tickets.forEach(t => OWN_FIELDS.forEach(k => { if (k !== 'concern') delete t[k]; }));
}
function mineToday(){
  const ids = new Set([...myTickets(), ...memMine]); const T = now().date;
  return S.tickets.filter(t => ids.has(t.id) && t.date === T).sort((a,b) => b.cmin - a.cmin);
}
const prefs = (() => { try { return JSON.parse(ls.get(PKEY) || '{}'); } catch(e){ return {}; } })();
function applyPrefs(){
  document.documentElement.dataset.size = prefs.size || 'md';
  document.documentElement.dataset.contrast = prefs.contrast ? 'high' : 'normal';
  document.querySelectorAll('[data-act="contrast"]').forEach(b => b.setAttribute('aria-pressed', !!prefs.contrast));
}

/* =========================================================
   DERIVED STATE
   ========================================================= */
const svcBy = code => S.services.find(s => s.code === code);
const todayTickets = () => { const T = now().date; return S.tickets.filter(t => t.date === T); };
const isPrio = t => t.prio !== 'regular';
function lineFor(code){
  return todayTickets().filter(t => t.svc === code && t.status === 'waiting')
    .sort((a,b) => ((a.prio==='regular')-(b.prio==='regular')) || a.cmin - b.cmin || a.num.localeCompare(b.num));
}
const currentFor = code => todayTickets().find(t => t.svc === code && (t.status === 'called' || t.status === 'serving')) || null;
const lastServed = code => todayTickets().filter(t => t.svc === code && t.calledMin != null && t.status !== 'void').sort((a,b) => b.calledMin - a.calledMin)[0] || null;
// What applies on one specific date: a staff-set special date wins, then the automatic holiday list.
//   { closed, reason }  → health center closed       { hours, open, close, reason } → special hours
//   { reopen }          → staff chose to open on a holiday        null → the normal weekly schedule
function dayRule(ds){
  const m = S.closures.find(c => c.date === ds);
  if (m) return m.type === 'hours' ? { hours:true, open:m.open, close:m.close, reason:m.reason } : m.type === 'open' ? { reopen:true, reason:m.reason } : { closed:true, reason:m.reason };
  const h = S.center.autoHolidays ? phHolidays(+ds.slice(0,4))[ds] : null;
  return h ? { closed:true, reason:h, auto:true } : null;
}
const closureOn = ds => { const r = dayRule(ds); return r && r.closed ? r : undefined; };
const hoursOn = ds => { const r = dayRule(ds); return r && r.hours ? { open:r.open, close:r.close, special:r.reason } : { open:S.center.open, close:S.center.close }; };
const isClinicDay = ds => { const r = dayRule(ds); return r ? !r.closed : S.center.days.includes(dowOf(ds)); };
// queue sessions for a date, trimmed to that day's hours
function sessionsOn(ds){
  const h = hoursOn(ds);
  return S.center.sessions.map(s => ({ ...s, start:toMin(s.start) < toMin(h.open) ? h.open : s.start, cutoff:toMin(s.cutoff) > toMin(h.close) - 60 && h.special ? fmt24(Math.min(toMin(s.cutoff), toMin(h.close) - 60)) : s.cutoff }))
    .filter(s => toMin(s.start) < toMin(s.cutoff));
}
const fmt24 = min => `${pad(Math.floor(min/60))}:${pad(min%60)}`;
function upcomingDates(limit){
  const T = now().date, out = [];
  for (let i = 0; i < 400 && out.length < (limit || 8); i++) { const d = addDays(T, i), r = dayRule(d); if (r && (r.closed || r.hours) && (S.center.days.includes(dowOf(d)) || r.hours)) out.push({ date:d, ...r }); }
  return out;
}

function centerStatus(){
  const n = now(), c = S.center, cl = closureOn(n.date), h = hoursOn(n.date);
  if (c.force === 'closed') return { open:false, state:'closed', label:'CLOSED', reason:c.forceNote || 'Temporarily closed by the health center' };
  if (c.force === 'open') return { open:true, state:'open', label:'OPEN NOW', reason:c.forceNote || 'Open today' };
  if (cl) return { open:false, state:'closed', label:'CLOSED', reason:'Closed today: ' + cl.reason };
  if (!isClinicDay(n.date)) return { open:false, state:'closed', label:'CLOSED', reason:'No clinic today. Opens ' + nextOpen() };
  if (n.min < toMin(h.open)) return { open:false, state:'closed', label:'NOT YET OPEN', reason:'Opens today at ' + fmtT(h.open) };
  if (n.min >= toMin(h.close)) return { open:false, state:'closed', label:'CLOSED', reason:'Closed for the day. Opens ' + nextOpen() };
  if (c.lunchStart && n.min >= toMin(c.lunchStart) && n.min < toMin(c.lunchEnd) && toMin(h.close) > toMin(c.lunchEnd)) return { open:true, state:'lunch', label:'LUNCH BREAK', reason:'Back at ' + fmtT(c.lunchEnd) };
  return { open:true, state:'open', label:'OPEN NOW', reason:`Open until ${fmtT(h.close)} today${h.special ? ' (' + h.special + ')' : ''}` };
}
function nextOpen(){
  const n = now();
  for (let i = 1; i < 30; i++) {
    const d = addDays(n.date, i);
    if (isClinicDay(d)) return (i === 1 ? 'tomorrow' : dateShort(d)) + ', ' + fmtT(hoursOn(d).open);
  }
  return 'soon';
}
function queueState(){
  const c = S.center, cs = centerStatus(), n = now(), ss_ = sessionsOn(n.date);
  // an emergency cut-off by staff closes today's queue at once, even in practice mode
  if (c.cutNow && c.cutNow.date === n.date) return { open:false, cut:true, reason:`Queue closed early today: ${c.cutNow.reason}` };
  // HARD DAILY CUT-OFF: once the last cut-off time passes, every service closes by itself
  // until the next clinic day. Nothing bypasses this, not even practice mode.
  const hardCut = ss_.length ? ss_[ss_.length-1].cutoff : null;
  if (hardCut && n.min >= toMin(hardCut)) return { open:false, cut:true, hard:true, at:hardCut, reason:`Today's cut-off (${fmtT(hardCut)}) has been reached. All services are closed until ${nextOpen()}` };
  if (c.demo) return { open:true, reason:'Practice mode: queueing is open before the cut-off', demo:true, until:hardCut, left:hardCut ? toMin(hardCut) - n.min : null };
  if (c.force === 'closed' || (!cs.open && cs.state === 'closed')) return { open:false, reason:cs.reason };
  if (!ss_.length) return { open:false, reason:'No queue sessions today' };
  for (const s of ss_) if (n.min >= toMin(s.start) && n.min < toMin(s.cutoff)) return { open:true, reason:`${s.name} queue is open until ${fmtT(s.cutoff)}`, until:s.cutoff, session:s, left:toMin(s.cutoff) - n.min };
  const first = ss_[0], last = ss_[ss_.length-1];
  if (n.min < toMin(first.start)) return { open:false, reason:`Queue numbers start at ${fmtT(first.start)}` };
  const nextS = ss_.find(s => n.min < toMin(s.start));
  if (nextS) { const prev = ss_[ss_.indexOf(nextS)-1]; return { open:false, reason:`${prev.name} cut-off (${fmtT(prev.cutoff)}) reached. ${nextS.name} queue opens at ${fmtT(nextS.start)}` }; }
  return { open:false, reason:`Today's cut-off (${fmtT(last.cutoff)}) has been reached. Queue opens ${nextOpen()}` };
}const siteLocked = () => S.center.lockSite && !S.center.demo && !centerStatus().open;

function counts(code){
  const tt = todayTickets().filter(t => t.svc === code && t.status !== 'cancelled');
  return { online:tt.filter(t => t.source === 'online').length, walkin:tt.filter(t => t.source === 'walkin').length };
}
function serviceState(s){
  const c = counts(s.code), left = Math.max(0, s.limit - c.online), wleft = Math.max(0, s.walkin - c.walkin);
  if (!s.open) return { ok:false, k:'crit', t:'Not available today', sub:s.note || '', left, wleft };
  const q = queueState();
  if (!q.open) return q.cut ? { ok:false, k:'crit', t:'Closed · cut-off reached', sub:q.reason, left, wleft, cut:true } : { ok:false, k:'warn', t:'Queue closed now', sub:q.reason, left, wleft };
  if (left <= 0) return { ok:false, k:'crit', t:'Online slots full', sub:wleft > 0 ? `Walk-ins still accepted at the center (${wleft} left)` : 'Full for today', left, wleft };
  return { ok:true, k:'ok', t:'Accepting patients', sub:`${left} online slots left`, left, wleft };
}
// a leave / day off covering a date (each doctor keeps a list of leave periods: first day, last day, reason)
const leaveOn = (d, ds) => (d.leaves || []).find(l => l.first <= ds && ds <= l.last) || null;
// is this doctor working on this date? (duty day, clinic open, not on leave; today also needs "available")
function dutyOn(d, ds){
  if (!d.days.includes(dowOf(ds)) || closureOn(ds) || leaveOn(d, ds)) return false;
  return ds !== now().date || d.available;
}
function docState(d){
  const n = now(), cl = closureOn(n.date), lv = leaveOn(d, n.date);
  if (lv) return { k:'crit', t:'On leave today', sub:`${lv.reason || 'Day off'} · back ${backFrom(d, lv)}`, duty:false };
  if (!d.available) return { k:'crit', t:'Unavailable', sub:d.note || 'Not available today', duty:false };
  if (!d.days.includes(n.dow) || cl) return { k:'neutral', t:'Not on duty today', sub:'Next duty: ' + nextDuty(d), duty:false };
  if (n.min < toMin(d.start)) return { k:'info', t:'On duty later today', sub:`Starts at ${fmtT(d.start)}`, duty:true };
  if (n.min >= toMin(d.end)) return { k:'neutral', t:'Duty ended today', sub:`Was on duty ${fmtT(d.start)} – ${fmtT(d.end)}`, duty:true };
  return { k:'ok', t:'Available now', sub:`Until ${fmtT(d.end)}`, duty:true };
}
function nextDuty(d){
  const n = now();
  for (let i = 1; i < 90; i++) { const ds = addDays(n.date,i); if (dutyOn(d, ds)) return (i < 7 ? DOW_LONG[dowOf(ds)] : dateShort(ds)) + ', ' + fmtT(d.start); }
  return 'not scheduled yet';
}
// the first duty day after a leave ends
function backFrom(d, lv){
  for (let i = 1; i < 90; i++) { const ds = addDays(lv.last, i); if (d.days.includes(dowOf(ds)) && !closureOn(ds) && !leaveOn(d, ds)) return dateShort(ds); }
  return 'to be announced';
}
function aheadOf(t){ if (t.status !== 'waiting') return 0; return lineFor(t.svc).findIndex(x => x.id === t.id); }
function estWait(t){ const s = svcBy(t.svc), cur = currentFor(t.svc); return Math.round((aheadOf(t) + (cur ? 0.5 : 0)) * s.avg); }
const hoursLabel = () => `${fmtT(S.center.open)} – ${fmtT(S.center.close)}, ${daysLabel(S.center.days)}`;
const daysLabel = days => { const order=[1,2,3,4,5,6,0]; const on = order.filter(d => days.includes(d)); if (on.join() === '1,2,3,4,5') return 'Monday to Friday'; return on.map(d => DOW[d]).join(', ') || 'No days set'; };
const sessionsLabel = () => S.center.sessions.map(s => `${s.name} ${fmtT(s.start)}–${fmtT(s.cutoff)}`).join(' · ');
function nextNum(svc, prio){
  const re = prio === 'regular' ? new RegExp(`^${svc}-\\d`) : new RegExp(`^${svc}-P\\d`);
  // one more than the highest number issued today, so a deleted ticket's number is never given again
  let n = 0;
  todayTickets().forEach(t => { if (t.svc !== svc) return; [t.num, t.origNum].forEach(v => { if (v && re.test(v)) n = Math.max(n, +(v.match(/(\d+)$/) || [0, 0])[1]); }); });
  n += 1;
  return `${svc}-${prio === 'regular' ? '' : 'P'}${pad(n)}`;
}

/* ---------- notifications (simulated) ----------
   Email is the default channel because it is free. SMS costs money per text, so it is only
   used when staff switch it on in Settings and the patient gave no email address. */
function channelFor(t){ return t.email ? 'email' : (S.center.smsOn && t.contact ? 'sms' : null); }
function sms(t, text){
  const ch = t.smsOff ? null : channelFor(t); if (!ch) return;
  S.sms.push({ id:uid(), ts:nowMs(), date:t.date || now().date, ch, to:ch === 'email' ? t.email : t.contact, tid:t.id, num:t.num, text:('BKHC: ' + text).slice(0, 990) });
  if (S.sms.length > 600) S.sms = S.sms.slice(-600);
}
// schedule / cut-off changes go to every subscriber and to patients holding a number today
function broadcast(subject, text){
  const T = now().date, seen = new Set(); let n = 0;
  const send = (ch, to, t) => { if (!to || seen.has(to)) return; seen.add(to); n++; S.sms.push({ id:uid(), ts:nowMs(), date:T, ch, to, tid:t ? t.id : '', num:t ? t.num : 'ALL', text:`BKHC: ${subject} — ${text}`.slice(0, 990) }); };
  todayTickets().filter(t => ['waiting','called'].includes(t.status) && !t.smsOff).forEach(t => { const ch = channelFor(t); if (ch) send(ch, ch === 'email' ? t.email : t.contact, t); });
  (S.subs || []).forEach(e => send('email', e, null));
  if (S.sms.length > 600) S.sms = S.sms.slice(-600);
  return n;
}
function postAnnouncement(type, title, body, pinned){ S.announcements.push({ id:uid(), type, title, body, date:now().date, pinned:!!pinned }); }function notifyNear(code){
  lineFor(code).slice(0, 3).forEach((t, i) => {
    if (t.nNear) return; t.nNear = true;
    sms(t, `${t.num}: ${i === 0 ? 'you are next' : `${i} patient${i>1?'s':''} ahead of you`}. Please go to the health center now and wait near the triage desk.`);
  });
}
// auto-void called numbers after the grace period; close out earlier days
function checkAuto(){
  if (SERVER.on) return false;           // the server voids no-shows, applies planned changes and cleans up
  const T = now().date, g = (S.center.grace || 15) * 60000; let ch = false;
  S.tickets.forEach(t => {
    if (t.date === T && t.status === 'called' && t.calledAt && Date.now() - t.calledAt > g) {
      t.status = 'void'; t.voidAuto = true; ch = true;
      sms(t, `${t.num} was voided because you did not arrive within ${S.center.grace} minutes after being called. You may get a new number or ask at the triage desk.`);
      notifyNear(t.svc);
    }
    if (t.date < T && ['waiting','called'].includes(t.status)) { t.status = 'void'; t.voidAuto = true; ch = true; }
    if (t.date < T && t.status === 'serving') { t.status = 'served'; ch = true; }
  });
  (S.pending || []).filter(x => x.effective <= T).sort((a,b) => a.effective.localeCompare(b.effective)).forEach(x => {
    S.center.sessions = S.center.sessions.map((s,i) => ({ ...s, ...x.sessions[i] })); ch = true;
  });
  if (S.pending && S.pending.some(x => x.effective <= T)) S.pending = S.pending.filter(x => x.effective > T);
  if (S.center.cutNow && S.center.cutNow.date < T) { S.center.cutNow = null; ch = true; }
  if (S.stockHist && recordStock()) ch = true;
  if (S.stockHist && restockReminder(false)) ch = true;
  if (S.lastTrim !== T) { trimOld(); S.lastTrim = T; ch = true; }
  if (ch) save();
  return ch;
}

/* ---------- read aloud (for elders and low-vision users) ---------- */
function speak(text){
  if (!('speechSynthesis' in window)) { toast('Read aloud is not available on this device.'); return; }
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text.replace(/([A-Z]{2})-P?(\d+)/g, (m, a, b) => `${a.split('').join(' ')} ${m.includes('-P')?'P ':''}${+b}`));
    u.lang = 'en-PH'; u.rate = 0.88;
    speechSynthesis.speak(u);
    toast('Reading aloud…');
  } catch(e){ toast('Read aloud is not available on this device.'); }
}
const speakBtn = (act, label='Read aloud', extra='', cls='ghost') => `<button class="btn ${cls} no-print" type="button" data-act="${act}" ${extra}>${icon('speaker')}${label}</button>`;

/* =========================================================
   RESIDENT VIEWS
   ========================================================= */
let flow = { step:1, prio:null, svc:null, err:'', data:{} };
let medQ = '', medF = 'all';
let viewTicketId = null;
let tipIdx = null;
let refill = { med:'', perDay:1, have:30, result:null };
let reqDone = null;
let homeSvc = 'CU';
let searchQ = '';
const ADDRESS = '58 Kingfisher St., Zabarte Subdivision, Brgy. Kaligayahan, Quezon City';
const MAP_URL = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('Kaligayahan Health Center, Zabarte Subdivision, Quezon City');
const MAP_EMBED = 'https://www.google.com/maps?q=' + encodeURIComponent('Kaligayahan Health Center, Kingfisher St, Zabarte Subdivision, Novaliches, Quezon City') + '&z=16&output=embed';
// map view of the health center (needs internet; the address and link still show without it)
function mapCard(tall){
  return `<figure class="map-card ${tall ? 'tall' : ''}">
    <iframe src="${MAP_EMBED}" title="Map showing the Barangay Kaligayahan Health Center" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>
    <figcaption>${icon('pin','',2.6)}<span><b>${esc(ADDRESS)}</b><a href="${MAP_URL}" target="_blank" rel="noopener">Open in Google Maps →</a></span></figcaption>
  </figure>`;
}

// [route, label, routes that highlight this item]
const NAV = [
  ['home','Home',['home','search']],
  ['availability','Availability',['availability','doctors','medicines','status']],
  ['services','Services',['services']],
  ['queue','Online Queue',['queue','ticket']],
  ['announcements','Announcements',['announcements']],
  ['contact','Contact',['contact','emergency']]
];
const NAV_IC = { home:'home', availability:'doctor', services:'steth', queue:'queue', announcements:'announce', contact:'phone', emergency:'alert', search:'search', privacy:'info' };
const navIc = k => `<span class="nl-ic">${icon(NAV_IC[k] || 'info','',2.4)}</span>`;
function renderNav(){
  if (!$('#nav')) return;
  const r = route(), mine = mineToday().find(t => ['waiting','called','serving'].includes(t.status));
  $('#nav').innerHTML = NAV.map(([k,l,act]) => `<a class="nav-link" href="#${k}" ${act.includes(r)?'aria-current="page"':''}>${navIc(k)}${l}${k==='queue' && mine ? pill(mine.status==='called'?'warn':'ok', mine.num, true) : ''}</a>`).join('')
    + `<a class="nav-link nav-phone" href="#emergency">${navIc('emergency')}Emergency</a><a class="nav-link nav-phone" href="#search">${navIc('search')}Search</a><a class="nav-link nav-phone" href="#privacy">${navIc('privacy')}Privacy Notice</a>`
    + `<div class="nav-extra">
        <button class="icon-btn" type="button" data-act="textSize" aria-label="Change text size"><span aria-hidden="true" class="aa">A<small>A</small></span></button>
        <button class="icon-btn" type="button" data-act="contrast" aria-label="High contrast" aria-pressed="${!!prefs.contrast}"><span aria-hidden="true" class="ct"></span></button>
      </div>`;
  renderTabbar();
}
// phone-only bottom bar: the 4 things residents use most + "More" (opens the menu sheet)
function renderTabbar(){
  const tb = $('#tabbar'); if (!tb) return;
  const r = route(), q = queueState(), mine = mineToday().find(t => ['waiting','called','serving'].includes(t.status));
  const on = keys => keys.includes(r) ? 'aria-current="page"' : '';
  const qLabel = mine ? 'My ticket' : q.cut ? 'Closed' : 'Queue';
  tb.innerHTML = `
    <a href="#home" ${on(['home','search'])}>${icon('home','',2.6)}<span>Home</span></a>
    <a href="#availability" ${on(['availability','doctors','status'])}>${icon('doctor','',2.6)}<span>Doctors</span></a>
    <a href="#${mine ? 'ticket' : 'queue'}" class="tb-main ${mine && mine.status === 'called' ? 'calling' : ''} ${!mine && q.cut ? 'off' : ''}" ${on(['queue','ticket'])}>
      <span class="tb-fab">${icon(mine ? 'receipt' : 'queue','',2.6)}${mine ? `<em class="mono">${esc(mine.num)}</em>` : ''}</span><span>${qLabel}</span></a>
    <a href="#medicines" ${on(['medicines'])}>${icon('medicine','',2.6)}<span>Medicines</span></a>
    <button type="button" data-act="menu" aria-controls="nav" aria-expanded="${$('#nav').classList.contains('open')}">
      <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><rect x="7" y="7" width="13" height="13" rx="3.5"/><rect x="28" y="7" width="13" height="13" rx="3.5"/><rect x="7" y="28" width="13" height="13" rx="3.5"/><rect x="28" y="28" width="13" height="13" rx="3.5"/></svg><span>More</span></button>`;
}
// phones: give each table cell the name of its column, so tables can show as stacked cards
function labelTables(root){
  (root || app).querySelectorAll('table').forEach(t => {
    const heads = [...t.querySelectorAll('thead th')].map(th => th.textContent.trim());
    if (!heads.length) return;
    t.classList.toggle('stack', heads.length >= 3);
    t.querySelectorAll('tbody tr').forEach(tr => [...tr.children].forEach((td, i) => {
      if (td.tagName === 'TD' && !td.hasAttribute('data-label')) td.setAttribute('data-label', td.colSpan > 1 ? '' : (heads[i] || ''));
    }));
  });
}
function renderFooter(){
  const fh = $('#footHours'); if (fh) fh.textContent = `Open ${hoursLabel()} · Queue: ${sessionsLabel()}`;
  const sn = $('#sampleNote'); if (sn) sn.textContent = SERVER.on ? 'Records are kept on the health center\u2019s secure server.' : 'Prototype: data is saved in this browser only.';
}
function tickClock(){
  const n = now(), stamp = `${dateLong(n.date).replace(/^\w+, /,'')} • ${fmt(n.min)}`;
  document.querySelectorAll('[data-clock]').forEach(el => { if (el.textContent !== stamp) el.textContent = stamp; el.setAttribute('aria-live', 'off'); });
  const g = (S.center.grace || 15) * 60000;
  document.querySelectorAll('[data-since]').forEach(el => {
    const ms = nowMs() - (+el.dataset.since), left = g - ms;
    el.textContent = left > 0 ? fmtDur(left) + ' left' : 'time is up';
    el.classList.toggle('over', left < 3*60000);
  });
}
const crumbs = (...items) => `<nav class="crumbs no-print" aria-label="Breadcrumb"><a href="#home">Home</a>${items.map((it,i) => `<span class="sep" aria-hidden="true">›</span>${i === items.length-1 ? `<span aria-current="page">${esc(it[0])}</span>` : `<a href="#${it[1]}">${esc(it[0])}</a>`}`).join('')}</nav>`;
function availTabs(active){
  return `<nav class="subtabs no-print" aria-label="Availability sections">${[['availability','doctor','Health personnel'],['medicines','medicine','Medicines'],['status','clock','Hours & status']].map(([k,ic,l]) => `<a href="#${k}" ${active===k?'aria-current="page"':''}>${icon(ic,'',2.4)}${l}</a>`).join('')}</nav>`;
}
function waitRange(n, avg){ if (!n) return 'No wait'; const lo = Math.max(5, Math.round(n*avg*0.85/5)*5), hi = Math.max(lo+5, Math.round(n*avg*1.15/5)*5); return `${lo} – ${hi} minutes`; }

function statusCard(){
  const cs = centerStatus(), q = queueState();
  const k = cs.state === 'open' ? 'ok' : cs.state === 'lunch' ? 'warn' : 'crit';
  return `<div class="stack" style="gap:10px">
    <div class="row-between" style="justify-content:flex-start">${pill('solid-'+k, cs.label, true, 'lg')}<b style="font-size:1.05rem">${esc(cs.reason)}</b></div>
    <div class="row-between" style="justify-content:flex-start">${pill(q.open?'ok':'crit', q.open ? 'Online queue open' : 'Online queue closed')}<span class="muted">${esc(q.reason)}</span></div>
    <div class="small muted">Hours: ${esc(hoursLabel())} · Lunch ${fmtT(S.center.lunchStart)}–${fmtT(S.center.lunchEnd)}</div>
  </div>`;
}
function statusSpeech(){
  const cs = centerStatus(), q = queueState();
  const docs = S.doctors.filter(d => docState(d).k === 'ok').map(d => d.name).join(', ');
  return `The health center is ${cs.label.toLowerCase()}. ${cs.reason}. ${q.reason}. ${docs ? 'Available now: ' + docs + '.' : 'No doctor is available right now.'}`;
}

function board(){
  return `<div class="board">${S.services.map(s => {
    const cur = currentFor(s.code), line = lineFor(s.code), nx = line[0], last = lastServed(s.code);
    const shown = cur || last, calling = cur && cur.status === 'called';
    if (!s.open) return `<article class="bcard closed"><div class="svc">${esc(s.name)}<small>${esc(s.tl)}</small></div><div class="lbl">Not available today</div><div class="big idle">${esc(s.note || 'Closed')}</div></article>`;
    return `<article class="bcard ${calling?'calling':''}" aria-label="${esc(s.name)} queue">
      <div class="svc">${esc(s.name)}<small>${esc(s.tl)}</small></div>
      <div class="lbl">${calling ? 'Now calling' : 'Now serving'}</div>
      <div class="big ${shown?'':'idle'}">${shown ? esc(shown.num) : 'No one yet'}</div>
      <div class="meta">Next: <b class="mono">${nx ? esc(nx.num) : '—'}</b> · ${line.length} waiting</div>
    </article>`; }).join('')}</div>`;
}

function emergencyNotice(){
  return `<section class="emergency" aria-labelledby="emH"><span class="emg-dot" aria-hidden="true">!</span>
    <div><h2 id="emH">Emergency? Do not join the queue.</h2>
      <p>Proceed directly to the health center or call the hotline.<span class="tl">Kung emergency, pumunta agad o tumawag.</span></p></div>
    <div class="btn-row"><a class="btn red" href="tel:+639631541440">${icon('phone')}0963-154-1440</a><a class="btn danger" href="#emergency">Emergency info</a></div></section>`;
}
function tipCard(){
  if (tipIdx == null) { const [y,m,d] = ymd(now().date); tipIdx = (y + m*31 + d) % TIPS.length; }
  const [t, b, tl] = TIPS[tipIdx];
  return `<section class="tip" aria-live="polite">
    <div class="eyebrow">${icon('heart','',2.6).replace('<svg ','<svg width="18" height="18" style="vertical-align:-3px;margin-right:6px" ')}Health advisory ${tipIdx+1} of ${TIPS.length} · Payong pangkalusugan</div>
    <h3>${esc(t)}</h3><p>${esc(b)}<span class="tl">${esc(tl)}</span></p>
    <div class="tip-nav"><button class="btn ghost sm" type="button" data-act="tip" data-v="-1">‹ Previous</button><button class="btn ghost sm" type="button" data-act="tip" data-v="1">Next tip ›</button><button class="btn ghost sm" type="button" data-act="speakTip">${icon('speaker')}Read aloud</button></div>
  </section>`;
}
function viewLocked(){
  const cs = centerStatus();
  return `<div class="wrap page"><section class="card" style="max-width:720px;margin:10px auto 20px;text-align:center;padding:34px 24px">
    <div style="color:var(--brand);display:flex;justify-content:center">${icon('clock','',2).replace('<svg ','<svg width="72" height="72" ')}</div>
    <h1 style="margin:12px 0 8px">The website opens during clinic hours</h1>
    <p class="muted" style="font-size:1.1rem">${esc(cs.reason)}. You can use this website ${esc(hoursLabel())}.<span class="tl">Bukas ang website tuwing oras ng klinika.</span></p>
  </section>${emergencyNotice()}
  <section class="card" style="max-width:720px;margin:0 auto"><div class="card-head"><h2>Announcements</h2></div>${annList(3)}</section></div>`;
}

/* ---------- home ---------- */
function viewHome(){
  const n = now(), cs = centerStatus(), q = queueState();
  const duty = S.doctors.filter(d => d.available && docState(d).duty).length, availNow = S.doctors.filter(d => docState(d).k === 'ok').length;
  const outMeds = S.medicines.filter(m => m.status === 'out').length;
  const mine = mineToday().find(t => ['waiting','called','serving'].includes(t.status));
  const annTop = sortedAnn()[0];
  if (!svcBy(homeSvc) || !svcBy(homeSvc).open) homeSvc = (S.services.find(s => s.open) || S.services[0]).code;
  const hs = svcBy(homeSvc), hcur = currentFor(hs.code) || lastServed(hs.code), hline = lineFor(hs.code);
  const k = cs.state === 'open' ? 'ok' : cs.state === 'lunch' ? 'warn' : 'crit';
  const dayWord = cs.state === 'open' ? 'Open Today' : cs.state === 'lunch' ? 'Lunch Break' : cs.label === 'NOT YET OPEN' ? 'Opens Later Today' : 'Closed Today';
  const tiles = [
    ['queue','queue','Get a queue number','Kumuha ng numero', q.open ? '' : pill(q.cut ? 'crit' : 'neutral', q.cut ? 'Cut-off' : 'Closed', true), q.cut],
    ['ticket','receipt','My queue ticket','Aking numero', mine ? pill(mine.status==='called'?'warn':'ok', mine.num, true) : ''],
    ['availability','doctor','Health personnel','Sino ang nasa duty', pill('ok', availNow + ' now', true)],
    ['medicines','medicine','Medicine availability','May gamot ba?', outMeds ? pill('crit', outMeds + ' out', true) : ''],
    ['services','steth','Services','Mga serbisyo', ''],
    ['announcements','announce','Announcements','Mga paalala', '']
  ];
  return `
  <section class="hero" aria-labelledby="heroH">
    <img class="hero-img" src="hero.jpg" srcset="hero-960.jpg 960w, hero.jpg 1672w" sizes="100vw" width="1672" height="941" fetchpriority="high" decoding="async" alt="">
    <div class="wrap hero-inner hero-grid">
      <div>
        <p class="hero-live"><span class="dot ${k}"></span><b>${esc(cs.label === 'OPEN NOW' ? 'Open now' : cs.label.charAt(0) + cs.label.slice(1).toLowerCase())}</b><span>${esc(fmtT(S.center.open))} – ${esc(fmtT(S.center.close))}</span><span class="sep">·</span><span>${q.open ? 'Queue open' : 'Queue closed'}</span></p>
        <p class="hero-kicker">Barangay Kaligayahan Health Center · Availability Tracking System</p>
        <h1 id="heroH">Care That Keeps You in Sync</h1>
        <p class="hero-sub"><b>Stay informed. Plan your visit. Get the care you need.</b></p>
        <p class="hero-intro">This website shows, in real time, if the health center is open, who is on duty, which medicines are in stock and how long the line is — so you can get a queue number before leaving home.<span class="tl">Alamin muna bago pumunta: bukas ba, sino ang doktor, may gamot ba, at gaano kahaba ang pila.</span></p>
        <div class="btn-row">${q.cut ? `<span class="btn white lg is-off" aria-disabled="true">${icon('clock')}Closed · cut-off reached</span>` : `<a class="btn white lg" href="#queue">${icon('queue')}Get a queue number</a>`}${speakBtn('speakStatus','Read aloud','','outline-white lg')}</div>
      </div>
      ${mapCard()}
    </div>
    <svg class="hero-wave" viewBox="0 0 1440 90" preserveAspectRatio="none" aria-hidden="true"><path d="M0,90 L0,74 C380,96 820,84 1110,44 C1260,22 1370,10 1440,4 L1440,90 Z" style="fill:var(--bg)"/></svg>
  </section>
  <div class="wrap">
    <div class="hero-search"><form data-form="search" class="searchbar" role="search">${icon('search','',3)}<label class="sr" for="heroQ">Search</label><input id="heroQ" name="q" type="search" placeholder="Search service, medicine, or personnel…" autocomplete="off" value="${esc(searchQ)}"><button class="btn primary" type="submit">Check</button></form></div>

    <div class="stat-row">
      <article class="stat"><div class="stat-ic green">${icon('clinic','',2.4)}</div><div class="stat-body">
        <div>${pill('solid-'+k, cs.label === 'OPEN NOW' ? 'OPEN' : cs.label, true)}</div>
        <span class="lbl">Health Center Status</span>
        <span class="stat-big" style="color:var(--${k})">${dayWord}</span>
        <span class="meta">${fmtT(S.center.open)} – ${fmtT(S.center.close)}</span>
        <span class="meta small" data-clock></span></div></article>
      <article class="stat"><div class="stat-ic blue">${icon('users','',2.4)}</div><div class="stat-body">
        <span class="stat-num green">${duty} / ${S.doctors.length}</span>
        <span class="lbl">Health Personnel Available</span>
        <span class="meta">${availNow} on duty right now</span>
        <a class="arrow-link" href="#availability">View Details →</a></div></article>
      <article class="stat"><div class="stat-ic blue">${icon('users','',2.4)}</div><div class="stat-body">
        <span class="lbl">Currently Serving · ${esc(hs.name)}</span>
        <span class="stat-num">${hcur ? esc(hcur.num) : '—'}</span>
        <b>Waiting: ${hline.length} patient${hline.length===1?'':'s'}</b>
        <span class="meta">Estimated Wait: ${waitRange(hline.length, hs.avg)}</span>
        <div class="svc-chips" role="group" aria-label="Choose service">${S.services.filter(s => s.open).map(s => `<button type="button" data-act="homeSvc" data-v="${s.code}" aria-pressed="${s.code===hs.code}" title="${esc(s.name)}" aria-label="${esc(s.name)}">${s.code}</button>`).join('')}</div></div></article>
    </div>

    ${mine ? `<div class="notice ${mine.status==='called'?'warn':'ok'}" style="margin-bottom:26px">${icon('receipt')}<div><b>Your number: <span class="mono">${esc(mine.num)}</span></b> — ${mine.status === 'called' ? 'You are being called. Go to the triage desk now.' : mine.status === 'serving' ? 'You are being served.' : `${aheadOf(mine)} ahead of you · about ${estWait(mine)} minutes.`} <a href="#ticket">Open my ticket</a></div></div>` : ''}
    ${emergencyNotice()}

    <section class="section" aria-labelledby="bH">
      <div class="section-title"><div><div class="eyebrow">Live queue · updates by itself</div><h2 id="bH">Now serving<span class="tl">Kasalukuyang pinaglilingkuran</span></h2></div>${q.cut ? pill('crit','Cut-off reached',true,'lg') : `<a class="btn ghost sm" href="#queue">Get a number</a>`}</div>
      ${board()}
      <p class="swipe-hint" aria-hidden="true">Swipe to see all services →</p>
    </section>
    <section class="section" aria-labelledby="svcH">
      <div class="section-title"><div><div class="eyebrow">Online services</div><h2 id="svcH">What do you need today?<span class="tl">Ano ang kailangan mo ngayon?</span></h2></div></div>
      <div class="tiles">${tiles.map(([to,ic,t,sub,p,off]) => off ? `<div class="tile is-off" aria-disabled="true">${p}<span class="t-ic">${icon(ic,'',2.2)}</span><b>${t}</b><small>Closed for today</small></div>` : `<a class="tile" href="#${to}">${p}<span class="t-ic">${icon(ic,'',2.2)}</span><b>${t}</b><small>${sub}</small></a>`).join('')}</div>
    </section>
    <div class="grid-2">
      ${tipCard()}
      ${annTop ? `<section class="card"><div class="card-head"><h2>Latest announcement</h2><a class="btn ghost sm" href="#announcements">See all</a></div>${annItem(annTop)}</section>` : ''}
    </div>
  </div>`;
}

/* ---------- search ---------- */
function viewSearch(){
  const q = searchQ.trim().toLowerCase();
  const has = (...xs) => xs.some(x => String(x||'').toLowerCase().includes(q));
  const svcs = q ? S.services.filter(s => has(s.name, s.tl, s.desc, s.code)) : [];
  const meds = q ? S.medicines.filter(m => has(m.name, m.use, m.form)).sort((a,b) => a.name.localeCompare(b.name)) : [];
  const docs = q ? S.doctors.filter(d => has(d.name, d.role) || (/(doc|doktor|personnel|nurse|staff|midwife)/.test(q))) : [];
  const anns = q ? S.announcements.filter(a => has(a.title, a.body)) : [];
  const total = svcs.length + meds.length + docs.length + anns.length;
  return `${crumbs(['Search results'])}
  <div class="page-head"><div><h1>Search results</h1><p>${q ? `${total} result${total===1?'':'s'} for “${esc(searchQ)}”` : 'Type what you are looking for.'}</p></div></div>
  <form data-form="search" class="searchbar" role="search" style="margin-bottom:24px">${icon('search','',3)}<label class="sr" for="sQ">Search</label><input id="sQ" name="q" type="search" placeholder="Search service, medicine, or personnel…" value="${esc(searchQ)}" autocomplete="off"><button class="btn primary" type="submit">Check</button></form>
  ${q && !total ? `<section class="card"><p style="font-size:1.1rem">Nothing matched “${esc(searchQ)}”.</p><p class="muted" style="margin-top:6px">Try a medicine's generic name (e.g. paracetamol), a service (e.g. vaccination), or a doctor's name.</p></section>` : ''}
  ${svcs.length ? `<section class="card search-group"><h2 style="margin-bottom:6px">Services</h2>${svcs.map(s => { const st = serviceState(s); return `<a class="search-hit" href="#services"><span><b>${esc(s.name)}</b> <span class="muted">· ${esc(s.tl)}</span><span class="tl" style="font-style:normal">${esc(s.desc)}</span></span>${pill(st.k, st.t)}</a>`; }).join('')}</section>` : ''}
  ${meds.length ? `<section class="card search-group"><h2 style="margin-bottom:6px">Medicines</h2>${meds.map(m => { const [k,t,tl] = MED_ST[m.status]; return `<a class="search-hit" href="#medicines"><span><b>${esc(m.name)}</b><span class="tl" style="font-style:normal">${esc(m.form)} · ${esc(m.use||'')}</span></span>${pill(k, `${t} · ${tl}`, false, 'lg')}</a>`; }).join('')}</section>` : ''}
  ${docs.length ? `<section class="card search-group"><h2 style="margin-bottom:6px">Health personnel</h2>${docs.map(d => { const st = docState(d); return `<a class="search-hit" href="#availability"><span><b>${esc(d.name)}</b><span class="tl" style="font-style:normal">${esc(d.role)} · ${fmtT(d.start)} – ${fmtT(d.end)}</span></span>${pill(st.k, st.t)}</a>`; }).join('')}</section>` : ''}
  ${anns.length ? `<section class="card search-group"><h2 style="margin-bottom:6px">Announcements</h2>${anns.map(a => `<a class="search-hit" href="#announcements"><span><b>${esc(a.title)}</b><span class="tl" style="font-style:normal">${esc(dateShort(a.date))}</span></span></a>`).join('')}</section>` : ''}`;
}

/* ---------- availability: hours / personnel / medicines ---------- */
function viewStatus(){
  const c = S.center, n = now(), order = [1,2,3,4,5,6,0];
  const up = upcomingDates(8);
  return `${crumbs(['Availability','availability'],['Hours & status'])}
  <div class="page-head"><div><h1>Is the health center open?<span class="tl">Bukas ba ang health center?</span></h1><p>Clinic hours, queue cut-off and slots left today.</p></div>${speakBtn('speakStatus')}</div>
  ${availTabs('status')}
  <div class="grid-2">
    <section class="card stack">
      ${statusCard()}
      <div class="table-wrap"><table><thead><tr><th>Day</th><th>Clinic hours</th></tr></thead><tbody>
        ${order.map(d => `<tr${d===n.dow?' style="font-weight:700;background:var(--brand-soft)"':''}><td>${DOW_LONG[d]}${d===n.dow?' '+pill('info','Today',true):''}</td><td class="num">${c.days.includes(d) ? `${fmtT(c.open)} – ${fmtT(c.close)}` : '<span class="muted">Closed</span>'}</td></tr>`).join('')}
      </tbody></table></div>
    </section>
    <div class="stack">
      <section class="card"><div class="card-head"><h2>Queue number cut-off</h2></div>
        <div class="list">${c.sessions.map(s => `<div class="row-between"><div><b>${esc(s.name)} session</b> <span class="muted">· ${esc(s.tl)}</span><p class="muted small">Numbers given ${fmtT(s.start)} to ${fmtT(s.cutoff)}</p></div><span class="pill info plain lg">Cut-off ${fmtT(s.cutoff)}</span></div>`).join('')}</div>
        <p class="small muted" style="margin-top:12px">When your number is called, go to the triage desk within <b>${c.grace} minutes</b>, or it will be voided and the next patient will be served.</p>
      </section>
      <section class="card"><div class="card-head"><h2>Slots left today</h2></div>
        <div class="table-wrap"><table><thead><tr><th>Service</th><th>Online</th><th>Walk-in</th></tr></thead><tbody>
        ${S.services.map(s => { const st = serviceState(s); return `<tr><td><b>${esc(s.name)}</b><span class="sub">${pill(st.k, st.t)}</span></td><td class="num">${s.open ? `${st.left} of ${s.limit}` : '—'}</td><td class="num">${s.open ? `${st.wleft} of ${s.walkin}` : '—'}</td></tr>`; }).join('')}
        </tbody></table></div>
      </section>
      <section class="card"><div class="card-head"><h2>Holiday closures</h2></div>
        ${up.length ? `<div class="list">${up.map(x => `<div class="row-between"><div><b>${esc(dateLong(x.date))}</b><p class="muted small">${esc(x.reason)}</p></div>${x.hours ? pill('warn', `Open ${fmtT(x.open)} – ${fmtT(x.close)} only`, true) : pill('crit', 'Closed', true)}</div>`).join('')}</div>` : '<p class="muted">No scheduled closures.</p>'}
      </section>
    </div>
  </div>`;
}

// Month calendar of duty schedules and days off. "All" shows how many are on duty each day; one
// doctor shows their own days (on duty with hours, day off, leave, clinic closed). Tap a day for details.
let dcal = { ym:null, doc:'all', day:null };
function dutyCalendar(staff){
  const T = now().date;
  if (!dcal.ym) dcal.ym = T.slice(0, 7);
  if (!dcal.day || dcal.day.slice(0, 7) !== dcal.ym) dcal.day = dcal.ym === T.slice(0, 7) ? T : dcal.ym + '-01';
  if (dcal.doc !== 'all' && !S.doctors.some(d => d.id === dcal.doc)) dcal.doc = 'all';
  const [y, m] = dcal.ym.split('-').map(Number), first = dowOf(`${dcal.ym}-01`), days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const title = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { timeZone:'UTC', month:'long', year:'numeric' });
  const one = dcal.doc === 'all' ? null : S.doctors.find(d => d.id === dcal.doc);
  const minYM = T.slice(0, 7), maxYM = addDays(T, 92).slice(0, 7);
  let cells = '';
  for (let i = 0; i < first; i++) cells += '<span aria-hidden="true"></span>';
  for (let dd = 1; dd <= days; dd++) {
    const ds = `${dcal.ym}-${pad(dd)}`, cl = closureOn(ds), past = ds < T;
    let cls, lbl, title2;
    if (cl) { cls = 'closed'; lbl = 'Closed'; title2 = cl.reason; }
    else if (one) {
      const lv = leaveOn(one, ds);
      if (lv) { cls = 'leave'; lbl = 'Leave'; title2 = lv.reason || 'Day off'; }
      else if (dutyOn(one, ds)) { cls = 'duty'; lbl = `${fmtT(one.start).replace(':00', '')}–${fmtT(one.end).replace(':00', '')}`; title2 = `On duty ${fmtT(one.start)} – ${fmtT(one.end)}`; }
      else { cls = 'off'; lbl = 'Off'; title2 = 'Day off'; }
    } else {
      const on = S.doctors.filter(d => dutyOn(d, ds)).length, lv = S.doctors.filter(d => leaveOn(d, ds)).length;
      cls = on ? 'duty' : 'off'; lbl = on ? `${on} on duty` : 'No duty'; title2 = `${on} on duty${lv ? `, ${lv} on leave` : ''}`;
      if (lv) lbl += ` · ${lv} off`;
    }
    cells += `<button type="button" class="cal-day dc ${cls} ${ds === T ? 'today' : ''} ${ds === dcal.day ? 'picked' : ''} ${past ? 'past' : ''}" data-act="dcalDay" data-date="${ds}" aria-pressed="${ds === dcal.day}" aria-label="${esc(dateLong(ds))}: ${esc(title2)}"><b>${dd}</b><small>${esc(lbl)}</small></button>`;
  }
  // details of the picked day
  const pd = dcal.day, pcl = closureOn(pd);
  const rows = S.doctors.map(d => { const lv = leaveOn(d, pd), on = dutyOn(d, pd);
    return { d, on, lv, txt: pcl ? 'Clinic closed' : on ? `${fmtT(d.start)} – ${fmtT(d.end)}` : lv ? `On leave${lv.reason ? ': ' + lv.reason : ''}` : (pd === T && !d.available && d.days.includes(dowOf(pd))) ? (d.note || 'Unavailable today') : 'Day off' }; })
    .filter(x => !one || x.d.id === one.id).sort((a, b) => (b.on - a.on) || a.d.name.localeCompare(b.d.name));
  const detail = `<div class="dc-detail" aria-live="polite"><h3>${esc(dateLong(pd))}</h3>
    ${pcl ? `<p class="notice warn" style="margin:8px 0">${icon('alert')}<span>The health center is closed: ${esc(pcl.reason)}</span></p>` : ''}
    ${rows.length ? `<ul class="dc-list">${rows.map(x => `<li class="${x.on ? 'on' : x.lv ? 'lv' : 'off'}"><span class="dot" aria-hidden="true"></span><div><b>${esc(x.d.name)}</b><span class="muted small">${esc(x.d.role)}</span></div><span class="dc-when">${esc(x.txt)}</span></li>`).join('')}</ul>` : '<p class="muted">No schedule posted yet.</p>'}</div>`;
  return `<section class="card dcal" aria-labelledby="dcalH">
    <div class="card-head"><div><h2 id="dcalH">${staff ? 'Duty calendar' : 'Duty schedule calendar'}<span class="tl">Iskedyul ng duty at day off</span></h2>${staff ? '' : '<p class="muted small" style="margin-top:4px">See which days each doctor is on duty, on leave or off. Schedules may change; check announcements.</p>'}</div>
      <label class="dc-pick"><span class="sr">Show</span><select data-change="dcalDoc" aria-label="Show the schedule of">
        <option value="all" ${dcal.doc === 'all' ? 'selected' : ''}>All doctors &amp; staff</option>
        ${S.doctors.map(d => `<option value="${esc(d.id)}" ${dcal.doc === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></label></div>
    <div class="dc-wrap"><div class="cal">
      <div class="row-between" style="margin-bottom:10px">
        <button class="btn ghost sm" type="button" data-act="dcalNav" data-v="-1" aria-label="Previous month" ${dcal.ym <= minYM ? 'disabled' : ''}>‹</button>
        <h3>${esc(title)}</h3>
        <button class="btn ghost sm" type="button" data-act="dcalNav" data-v="1" aria-label="Next month" ${dcal.ym >= maxYM ? 'disabled' : ''}>›</button></div>
      <div class="cal-grid cal-head">${DOW.map(d => `<span>${d}</span>`).join('')}</div>
      <div class="cal-grid">${cells}</div>
      <div class="cal-legend small"><span><i class="duty"></i>${one ? 'On duty' : 'Doctors on duty'}</span>${one ? '<span><i class="leave"></i>On leave</span>' : ''}<span><i class="off"></i>${one ? 'Day off' : 'No one on duty'}</span><span><i class="closed"></i>Clinic closed</span></div>
    </div>${detail}</div>
  </section>`;
}
function leaveModal(d){
  const T = now().date, list = (d.leaves || []).slice().sort((a, b) => a.first.localeCompare(b.first));
  return `<h2>Days off &amp; leave · ${esc(d.name)}</h2>
    ${list.length ? `<ul class="dc-list" style="margin-bottom:14px">${list.map(l => `<li class="${l.last < T ? 'off' : 'lv'}"><span class="dot" aria-hidden="true"></span><div><b>${esc(l.first === l.last ? dateShort(l.first) : `${dateShort(l.first)} – ${dateShort(l.last)}`)}</b><span class="muted small">${esc(l.reason || 'Day off')}${l.last < T ? ' · past' : ''}</span></div><button class="btn danger sm" type="button" data-act="leaveDel" data-id="${esc(d.id)}" data-v="${esc(l.id)}" data-confirm="Remove?">Remove</button></li>`).join('')}</ul>` : '<p class="muted" style="margin-bottom:12px">No days off or leave entered yet.</p>'}
    <form data-form="leave" data-id="${esc(d.id)}" class="stack" novalidate>
      <div class="form-grid">
        <div class="field"><label for="lvFirst">First day</label><input type="date" id="lvFirst" name="first" min="${T}" value="${T}"></div>
        <div class="field"><label for="lvLast">Last day</label><input type="date" id="lvLast" name="last" min="${T}" value="${T}"></div>
        <div class="field" style="grid-column:1/-1"><label for="lvReason">Reason shown to residents (optional)</label><input type="text" id="lvReason" name="reason" maxlength="120" placeholder="e.g. Seminar, sick leave, vacation"></div>
      </div>
      <p class="err hide" id="lvErr" role="alert"></p>
      <div class="btn-row"><button class="btn primary" type="submit">${icon('plus')}Add day off / leave</button><button class="btn ghost" type="button" data-act="closeModal">Done</button></div>
    </form>`;
}
function viewDoctors(){
  const n = now(), rank = { ok:0, info:1, neutral:2, crit:3 };
  const list = S.doctors.slice().sort((a,b) => rank[docState(a).k] - rank[docState(b).k]);
  return `${crumbs(['Availability','availability'],['Health personnel'])}
  <div class="page-head"><div><h1>Who is on duty today?<span class="tl">Sino ang doktor at nurse ngayon?</span></h1><p>${esc(dateLong(n.date))}. Updated daily — check announcements for leaves.</p></div>${speakBtn('speakDoctors')}</div>
  ${availTabs('availability')}
  ${list.length ? '' : `<div class="empty card">The duty schedule has not been posted yet. Please call the hotline <a href="tel:+639631541440">0963-154-1440</a> to ask who is on duty.<span class="tl">Wala pang nakalagay na iskedyul. Tumawag sa hotline.</span></div>`}
  <div class="doc-grid">
    ${list.map(d => { const st = docState(d); const ini = d.name.replace(/^(Dr\.)\s*/,'').split(/\s+/).filter(w => /^[A-Z]/.test(w)).slice(0,2).map(w => w[0]).join('');
      return `<article class="card doc">
        <div class="avatar" aria-hidden="true">${esc(ini)}</div>
        <div class="meta">
          <div><h3>${esc(d.name)}</h3><span class="muted">${esc(d.role)}</span></div>
          <div>${pill(st.k, st.t, false, 'lg')}</div>
          <div><b class="num" style="font-size:1.1rem">${fmtT(d.start)} – ${fmtT(d.end)}</b><br><span class="muted">${esc(st.sub)}</span></div>
          <div class="days" aria-label="Duty days">${[1,2,3,4,5,6].map(x => `<span class="${d.days.includes(x)?'on':''} ${x===n.dow?'today':''}">${DOW[x]}</span>`).join('')}</div>
          <span class="muted small">Up to ${d.limit} patients per day</span>
          ${(() => { const up = (d.leaves || []).filter(l => l.last >= n.date).sort((a, b) => a.first.localeCompare(b.first))[0]; return up && up.first > n.date ? `<span class="small" style="color:var(--crit)">Day off: ${esc(up.first === up.last ? dateShort(up.first) : `${dateShort(up.first)} – ${dateShort(up.last)}`)}</span>` : ''; })()}
        </div>
      </article>`; }).join('')}
  </div>
  ${S.doctors.length ? dutyCalendar(false) : ''}`;
}

// the most-dispensed medicines of the month, shown first as shortcuts
const frequentMeds = (n = 8) => S.medicines.slice().sort((a,b) => (b.freq||0) - (a.freq||0)).slice(0, n);
const isFrequent = m => frequentMeds().some(x => x.id === m.id);
const restockPct = () => S.center.restockPct || 20;
const stockPct = m => Math.round(m.stock / Math.max(1, m.cap) * 100);
// restock reminder when stock is at or below restockPct% of full stock (e.g. 20 of 100)
const needsReorder = m => m.stock <= Math.floor(m.cap * restockPct() / 100);
const stockClass = m => m.stock <= 0 || m.status === 'out' || m.status === 'low' ? 'low' : needsReorder(m) ? 'due' : 'ok';
function medFiltered(){
  const q = medQ.trim().toLowerCase();
  return S.medicines.filter(m => (medF === 'all' || (medF === 'freq' ? isFrequent(m) : medF === 'reorder' ? needsReorder(m) : m.status === medF)) && (!q || m.name.toLowerCase().includes(q) || m.form.toLowerCase().includes(q) || (m.use||'').toLowerCase().includes(q)))
    .sort((a,b) => a.name.localeCompare(b.name));
}
// One medicine box, following the group's reference sketch:
// name on top, small description under it, AVAILABILITY in the middle, then available / total stock.
function medCard(m){
  const [k,t,tl] = MED_ST[m.status], cap = Math.max(m.cap || 0, m.stock, 1);
  return `<article class="med-card ${k}" id="med-${m.id}">
    <div class="med-frame">
      ${isFrequent(m) ? '<span class="med-star" title="Frequently used">★ Frequently used</span>' : ''}
      <div class="med-head"><h3>${esc(m.name)}</h3><p class="use">${esc(m.use || m.form)}</p></div>
      <div class="med-avail"><span class="med-pill ${k}">${esc(t)}<small>${esc(tl)}</small></span></div>
      <div class="med-count" aria-label="${m.stock} available out of ${cap} ${esc(m.form.toLowerCase())}s"><b>${m.stock}</b><span>/${cap}</span></div>
      <span class="med-unit">${esc(m.form.toLowerCase())}s available / total stock</span>
    </div>
  </article>`;
}function medListHtml(){
  const list = medFiltered();
  if (!S.medicines.length) return `<div class="empty card">The medicine list has not been added yet. Please ask at the health center or call 0963-154-1440.<span class="tl">Wala pang nakalistang gamot.</span></div>`;
  if (!list.length) return `<div class="empty card">No medicine matches “${esc(medQ)}”. Check the spelling, or try the generic name (example: paracetamol).</div>`;
  let last = '', out = '';
  list.forEach(m => { const L = m.name[0].toUpperCase(); if (L !== last) { out += `<div class="med-letter">${L}</div>`; last = L; } out += medCard(m); });
  return out;
}
function medShortcuts(){
  if (!frequentMeds().length) return '';
  return `<section class="freq-box" aria-labelledby="fqH">
    <div class="row-between"><h2 id="fqH">★ Frequently used medicines<span class="tl">Mga madalas kunin na gamot</span></h2><span class="small muted">Tap one to jump to it</span></div>
    <div class="freq-row">${frequentMeds().map(m => { const [k,t] = MED_ST[m.status]; return `<button class="freq-chip ${k}" type="button" data-act="medJump" data-id="${m.id}"><b>${esc(m.name)}</b><span><span class="num">${m.stock}/${Math.max(m.cap||0, m.stock, 1)}</span> · ${t}</span></button>`; }).join('')}</div>
  </section>`;
}
function medToolbar(admin){
  const c = s => S.medicines.filter(m => s === 'all' || (s === 'freq' ? isFrequent(m) : s === 'reorder' ? needsReorder(m) : m.status === s)).length;
  const chips = [['all','All'],['freq','★ Frequently used'],['available','Available'],['low','Low stock'],['out','Out of stock']];
  if (admin) chips.splice(2, 0, ['reorder','Needs reorder']);
  return `<div class="toolbar">
    <label class="search">${icon('search','',3)}<span class="sr">Search medicine</span><input type="search" id="medSearch" placeholder="Type a medicine, e.g. paracetamol" value="${esc(medQ)}" autocomplete="off"></label>
    <div class="chips" role="group" aria-label="Filter medicines">
      ${chips.map(([v,l]) => `<button class="chip" type="button" data-act="medFilter" data-v="${v}" data-admin="${admin?1:0}" aria-pressed="${medF===v}">${l} <span class="num">${c(v)}</span></button>`).join('')}
    </div></div>`;
}function viewMedicines(){
  const opts = S.medicines.slice().sort((a,b) => a.name.localeCompare(b.name));
  const r = refill.result;
  return `${crumbs(['Availability','availability'],['Medicines'])}
  <div class="page-head"><div><h1>Is my medicine available?<span class="tl">May gamot ba sa health center?</span></h1><p>Free medicines are given with a prescription from the health center doctor. Stock may change before you arrive.</p></div></div>
  ${availTabs('medicines')}
  <div class="notice info" style="margin-bottom:16px">${icon('info')}<div>Each box shows how many are left, for example <b class="mono">40/100</b> means 40 left out of a full stock of 100. <b>Green</b> = available · <b>Yellow</b> = low stock, come early · <b>Red</b> = out of stock, you may request it below.</div></div>
  ${medShortcuts()}
  ${medToolbar(false)}
  <div class="med-grid" id="medBody">${medListHtml()}</div>

  <div class="grid-2" style="margin-top:26px">
    <section class="card stack" aria-labelledby="rfH">
      <div><div class="eyebrow">For maintenance medicine</div><h2 id="rfH">When should I come back?<span class="tl">Kailan ako babalik para sa gamot?</span></h2>
      <p class="muted" style="margin-top:6px">Tell us how many tablets you take and how many you have. We will tell you your next refill date.</p></div>
      <form data-form="refill" class="stack" novalidate>
        <div class="field"><label for="rfMed">Medicine</label><select id="rfMed" name="med"><option value="">Choose your medicine</option>${opts.map(m => `<option value="${m.id}" ${refill.med===m.id?'selected':''}>${esc(m.name)}</option>`).join('')}</select></div>
        <div class="form-grid">
          <div class="field"><label for="rfDay">Tablets per day</label><input type="number" id="rfDay" name="perDay" min="0.5" step="0.5" value="${refill.perDay}" inputmode="decimal"></div>
          <div class="field"><label for="rfHave">Tablets you have now</label><input type="number" id="rfHave" name="have" min="1" value="${refill.have}" inputmode="numeric"></div>
        </div>
        <button class="btn primary" type="submit">${icon('cal')}Show my refill date</button>
      </form>
      ${r ? `<div class="result-box" aria-live="polite">
        <span>Your medicine will last</span><span class="big">${r.days} days</span>
        <span>Come back on or before <b>${esc(dateLong(r.back))}</b>.</span>
        <span>That is about <b>${r.perMonth} visit${r.perMonth===1?'':'s'} a month</b> (${r.perYear} visits a year).</span>
        ${r.status ? `<span>Today's stock: ${pill(...MED_ST[r.status].slice(0,2))}</span>` : ''}
        <div class="btn-row" style="margin-top:6px">${speakBtn('speakRefill','Read aloud','','ghost sm')}<button class="btn ghost sm" type="button" data-act="prefillReq">Request this medicine</button></div>
      </div>` : ''}
    </section>

    <section class="card stack" id="reqCard" aria-labelledby="rqH">
      <div><div class="eyebrow">Request in advance</div><h2 id="rqH">Reserve or request a medicine<span class="tl">Magpa-reserba ng gamot</span></h2>
      <p class="muted" style="margin-top:6px">Staff will check the stock. If it is out of stock, they will request it from the City Health Office. ${SERVER.on && !SERVER.mail ? 'The staff will contact you when it is ready.' : 'We will email you when it is ready.'}</p></div>
      ${reqDone ? `<div class="notice ok" role="status">${icon('check')}<div><b>Request sent. Your request number is <span class="mono">${esc(reqDone.code)}</span>.</b><br>We will message ${esc(reqDone.email || reqDone.contact)} when your medicine is ready. Bring your prescription when you pick it up.</div></div>
        <button class="btn ghost" type="button" data-act="reqAgain">Make another request</button>` : queueState().cut ? `<div class="notice crit" role="status">${icon('clock')}<div><b>Requests are closed for today.</b><br>${esc(queueState().reason)}.</div></div>` : `
      <form data-form="medReq" class="stack" novalidate><input type="text" name="website" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true">
        <div class="field"><label for="rqMed">Medicine</label><select id="rqMed" name="med"><option value="">Choose a medicine</option>${opts.map(m => `<option value="${m.id}" ${refill.med===m.id?'selected':''}>${esc(m.name)} — ${MED_ST[m.status][1]}</option>`).join('')}</select></div>
        <div class="form-grid">
          <div class="field"><label for="rqQty">How many tablets / pieces?</label><input type="number" id="rqQty" name="qty" min="1" value="30"></div>
          <div class="field"><label for="rqName">Full name</label><input type="text" id="rqName" name="name" autocomplete="name" placeholder="Juan Dela Cruz"></div>
          <div class="field"><label for="rqEmail">Email address</label><input type="email" id="rqEmail" name="email" placeholder="juan@gmail.com" autocomplete="email"></div>
          <div class="field"><label for="rqContact">Mobile number <span class="muted">(optional)</span></label><input type="tel" id="rqContact" name="contact" placeholder="09XX XXX XXXX" inputmode="tel"></div>
        </div>
        <div class="field"><label for="rqNote">Note <span class="muted">(optional)</span></label><input type="text" id="rqNote" name="note" placeholder="e.g. maintenance for high blood pressure"></div>
        <p class="err hide" id="rqErr" role="alert"></p>
        <label class="check"><input type="checkbox" name="consent"> <span>I agree to the <a href="#privacy" target="_blank" rel="noopener">Privacy Notice</a>. My details will be used only for this request.</span></label>
        ${captchaBox()}<button class="btn primary" type="submit">Send request</button>
      </form>`}
    </section>
  </div>`;
}

/* ---------- services ---------- */
function viewServices(){
  return `${crumbs(['Services'])}
  <div class="page-head"><div><h1>Health center services<span class="tl">Mga serbisyo ng health center</span></h1><p>All services are free for barangay residents. Each service has its own queue line.</p></div></div>
  <div class="svc-grid">${S.services.map(s => { const st = serviceState(s), cur = currentFor(s.code) || lastServed(s.code), line = lineFor(s.code);
    return `<article class="card svc-card">
      <div class="top"><span class="t-ic">${icon(s.icon,'',2.2)}</span><div><h2 style="font-size:1.2rem">${esc(s.name)}<span class="tl">${esc(s.tl)}</span></h2><div style="margin-top:6px">${pill(st.k, st.t)}</div></div></div>
      <p class="muted">${esc(s.desc)}</p>
      ${s.open ? `<div class="svc-stats"><div><span>Now serving</span><b>${cur ? esc(cur.num) : '—'}</b></div><div><span>Waiting</span><b>${line.length}</b></div><div><span>Est. wait</span><b>${line.length ? '~' + Math.round(line.length*s.avg) + 'm' : '0'}</b></div></div>
        <p class="small muted">Online slots left: <b>${st.left}</b> of ${s.limit} · Walk-in slots left: <b>${st.wleft}</b> of ${s.walkin}</p>` : `<p class="small"><b>${esc(s.note || 'Not offered today')}</b></p>`}
      ${st.sub && !st.ok ? `<p class="small muted">${esc(st.sub)}</p>` : ''}
      <button class="btn ${st.ok?'primary':'ghost'} block" type="button" data-act="queueFor" data-v="${s.code}" ${st.ok?'':'disabled'}>${icon('queue')}Get queue number</button>
    </article>`; }).join('')}</div>`;
}

/* ---------- announcements ---------- */
function annItem(a){
  const [k,t] = ANN_T[a.type] || ANN_T.general; const [, m, d] = ymd(a.date);
  return `<article class="ann"><div class="ann-date" aria-hidden="true"><span>${MON[m-1]}</span><b>${d}</b></div>
    <div><div class="btn-row">${pill(k,t)}${a.pinned ? pill('neutral','Pinned',true) : ''}</div><h3>${esc(a.title)}</h3><p>${esc(a.body)}</p></div></article>`;
}
const sortedAnn = () => S.announcements.slice().sort((a,b) => (b.pinned - a.pinned) || b.date.localeCompare(a.date));
function annList(limit){
  const list = sortedAnn().slice(0, limit || 999);
  return list.length ? `<div class="list">${list.map(annItem).join('')}</div>` : '<p class="muted">No announcements right now.</p>';
}
function viewAnnouncements(){
  const n = now(), up = upcomingDates(8);
  return `${crumbs(['Announcements'])}
  <div class="page-head"><div><h1>Announcements<span class="tl">Mga balita at paalala</span></h1><p>Doctor leaves, holiday schedules, service cut-offs and health advisories.</p></div></div>
  <div class="grid-2">
    <section class="card" style="grid-column:1/-1">${annList()}</section>
    <section class="card stack" aria-labelledby="subH"><div><h2 id="subH">Get free email updates<span class="tl">Libreng abiso sa email</span></h2>${SERVER.on && !SERVER.mail ? '' : '<p class="muted" style="margin-top:6px">We will email you when the schedule changes, on holidays, and when a cut-off time changes.</p>'}</div>
      ${SERVER.on && !SERVER.mail ? `<div class="notice info">${icon('info')}<div>Email updates will start soon. For now, please check this page or call <a href="tel:+639631541440">0963-154-1440</a> for schedule changes.</div></div>` : subDone ? `<div class="notice ok" role="status">${icon('check')}<div>${SERVER.on ? `<b>Almost done.</b> We sent a message to ${esc(subDone)}. Open it and tap the link to confirm. (Check the spam folder too.)` : `<b>You are subscribed.</b> Updates will be sent to ${esc(subDone)}.`}</div></div>` : `<form data-form="subscribe" class="stack" novalidate><input type="text" name="website" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true"><div class="field"><label for="subEmail">Email address</label><input type="email" id="subEmail" name="email" placeholder="juan@gmail.com" autocomplete="email"></div><p class="err hide" id="subErr" role="alert"></p>${captchaBox()}<button class="btn primary" type="submit">${icon('sms')}Subscribe</button><p class="small muted">By subscribing you agree to the <a href="#privacy">Privacy Notice</a>. You can ask us to remove your email anytime.</p></form>`}
    </section>
    <section class="card"><div class="card-head"><h2>Holiday &amp; closure schedule</h2></div>
      ${up.length ? `<div class="list">${up.map(x => `<div class="row-between"><div><b>${esc(dateLong(x.date))}</b><p class="muted small">${esc(x.reason)}</p></div>${x.hours ? pill('warn', `Open ${fmtT(x.open)} – ${fmtT(x.close)} only`, true) : pill('crit', 'Closed', true)}</div>`).join('')}</div>` : '<p class="muted">No scheduled closures.</p>'}</section>
    ${tipCard()}
  </div>`;
}

/* ---------- privacy notice (Data Privacy Act of 2012, RA 10173) ---------- */
function viewPrivacy(){
  const row = (h, b, tl) => `<section class="card"><h2 style="font-size:1.15rem;margin-bottom:8px">${h}</h2>${b}${tl ? `<p class="tl" style="margin-top:8px">${tl}</p>` : ''}</section>`;
  return `${crumbs(['Privacy Notice'])}
  <div class="page-head"><div><h1>Privacy Notice<span class="tl">Abiso sa Privacy</span></h1><p>How the Barangay Kaligayahan Health Center handles your personal information on this website, under the Data Privacy Act of 2012 (Republic Act No. 10173).</p></div></div>
  <div class="stack" style="max-width:860px">
    ${row('What we collect', `<ul><li><b>For a queue number:</b> name, age, purok or street, mobile number and email (both optional), patient type (senior, PWD, pregnant, regular), the kind of ID you will show, and for check-ups the general reason for your visit.</li><li><b>For a medicine request:</b> name, the medicine and amount, and your email or mobile number.</li><li><b>For email updates:</b> your email address.</li></ul><p class="small muted">We do not ask for your ID number, medical history or diagnosis on this website.</p>`, 'Pangalan, edad, tirahan, at email o numero lang ang kinukuha namin.')}
    ${row('Why we use it', `<ul><li>To give you a queue number and call you in the right order (priority patients first).</li><li>To tell you when your turn is near, when a medicine is ready, or when the schedule changes.</li><li>To count patients, waiting times and common reasons for visits, so the health center can plan staff and medicines. Reports use counts, not names.</li></ul>`)}
    ${row('Who can see it', `<p>Only authorized health center staff (health workers, nurses, pharmacy staff and the administrator), each with their own account. We do not sell or share your information with anyone outside the health center, except when the law requires it.</p>`)}
    ${row('How long we keep it', `<p>Your name, contact details and address are removed from records after <b>${KEEP_PERSONAL_DAYS} days</b>. Only the counts stay for reports. Records are deleted completely after ${KEEP_RECORD_DAYS} days.</p>`, 'Binubura ang iyong pangalan at contact pagkalipas ng 90 araw.')}
    ${row('Your rights', `<p>You may ask to see, correct or delete your information, or withdraw your consent, at the triage desk or through the hotline (0963-154-1440). You may also file a complaint with the National Privacy Commission (privacy.gov.ph).</p>`, 'Maaari mong hilingin na makita, itama, o burahin ang iyong impormasyon.')}
    ${row('Data protection officer', `<p>Barangay Kaligayahan Health Center, ${esc(ADDRESS)}. Hotline 0963-154-1440 · 7148-4934.</p><p class="small muted">${SERVER.on ? (SERVER.cloud ? `Your details are stored in a secured cloud database (Supabase, data center in ${esc(SERVER.cloud)}) used only by the health center. Names, mobile numbers, emails and addresses are encrypted by the health center before they are sent there, so the cloud provider cannot read them. Only authorized staff can see them, and every staff action is recorded.` : 'Your details are stored on the health center\u2019s own secured server. Names, mobile numbers, emails and addresses are encrypted, only authorized staff can see them, and every staff action is recorded.') : 'Prototype note: in this version, data is stored only in the browser of the device used. A live system must store it on a secured server.'}</p>`)}
  </div>`;
}

/* ---------- contact & emergency ---------- */
function viewContact(){
  return `${crumbs(['Contact'])}
  <div class="page-head"><div><h1>Contact us<span class="tl">Makipag-ugnayan</span></h1><p>Visit, call, or text the Barangay Kaligayahan Health Center.</p></div></div>
  <div class="contact-grid" style="margin-bottom:22px">
    <section class="card contact-item"><span class="stat-ic green">${icon('pin','',2.4)}</span><div class="stack" style="gap:8px"><h2 style="font-size:1.15rem">Address</h2><p>${esc(ADDRESS)}</p><a class="arrow-link" href="${MAP_URL}" target="_blank" rel="noopener">Open in Google Maps →</a></div></section>
    <section class="card contact-item"><span class="stat-ic blue">${icon('phone','',2.4)}</span><div class="stack" style="gap:8px"><h2 style="font-size:1.15rem">Hotline</h2>
      <a class="btn primary" href="tel:+639631541440">${icon('phone')}0963-154-1440</a><a class="btn ghost" href="tel:+63271484934">${icon('phone')}7148-4934</a></div></section>
    <section class="card contact-item"><span class="stat-ic green">${icon('clock','',2.4)}</span><div class="stack" style="gap:8px"><h2 style="font-size:1.15rem">Clinic hours</h2><p>${esc(hoursLabel())}</p><p class="small muted">Lunch ${fmtT(S.center.lunchStart)}–${fmtT(S.center.lunchEnd)}. Online queue: ${esc(sessionsLabel())}.</p><a class="arrow-link" href="#status">See today's status →</a></div></section>
  </div>
  <section class="section" aria-labelledby="mapH"><h2 id="mapH" style="margin-bottom:12px">Find us on the map<span class="tl">Hanapin kami sa mapa</span></h2>${mapCard(true)}</section>
  ${emergencyNotice()}`;
}
function emergencyArt(){
  return `<svg class="emg-art" viewBox="0 0 420 210" role="img" aria-label="Illustration of a health center and an ambulance">
    <ellipse cx="80" cy="60" rx="46" ry="16" fill="#fff"/><ellipse cx="110" cy="52" rx="30" ry="16" fill="#fff"/>
    <ellipse cx="340" cy="70" rx="44" ry="15" fill="#fff"/><ellipse cx="365" cy="62" rx="26" ry="14" fill="#fff"/>
    <rect x="20" y="186" width="380" height="8" rx="4" fill="#F4C5C0"/>
    <circle cx="62" cy="150" r="30" fill="#6FBF73"/><circle cx="44" cy="164" r="22" fill="#5AAE5F"/><rect x="58" y="160" width="7" height="30" fill="#7A5A3A"/>
    <circle cx="362" cy="152" r="26" fill="#6FBF73"/><rect x="359" y="162" width="6" height="28" fill="#7A5A3A"/>
    <rect x="110" y="96" width="70" height="92" fill="#A9CBF2"/><rect x="240" y="96" width="70" height="92" fill="#A9CBF2"/>
    <rect x="160" y="62" width="100" height="126" fill="#CFE2F8"/>
    <rect x="186" y="26" width="48" height="48" rx="8" fill="#fff" stroke="#E5E9F0" stroke-width="2"/>
    <path d="M204 34h12v12h12v12h-12v12h-12V58h-12V46h12z" fill="#E53935"/>
    ${[0,1,2].map(r => [0,1,2].map(c => `<rect x="${172+c*28}" y="${86+r*26}" width="18" height="16" rx="2" fill="#4A86D6"/>`).join('')).join('')}
    ${[0,1].map(r => `<rect x="122" y="${110+r*28}" width="18" height="16" rx="2" fill="#4A86D6"/><rect x="252" y="${110+r*28}" width="18" height="16" rx="2" fill="#4A86D6"/><rect x="280" y="${110+r*28}" width="18" height="16" rx="2" fill="#4A86D6"/>`).join('')}
    <rect x="196" y="160" width="28" height="28" fill="#2F6BC2"/>
    <g transform="translate(270 146)">
      <path d="M0 10h62l4-10h20l16 22v20H0z" fill="#fff" stroke="#E5E9F0" stroke-width="2"/>
      <rect x="0" y="26" width="102" height="6" fill="#E53935"/>
      <path d="M70 4h14l12 16H70z" fill="#9FC4EE"/>
      <path d="M26 12h8v8h8v8h-8v8h-8v-8h-8v-8h8z" fill="#E53935" transform="translate(0 -6) scale(.9)"/>
      <rect x="44" y="-4" width="12" height="6" rx="2" fill="#E53935"/>
      <circle cx="22" cy="44" r="9" fill="#333"/><circle cx="22" cy="44" r="4" fill="#bbb"/>
      <circle cx="80" cy="44" r="9" fill="#333"/><circle cx="80" cy="44" r="4" fill="#bbb"/>
    </g></svg>`;
}
let emgInfoOpen = false;
function viewEmergency(){
  return `${crumbs(['Contact','contact'],['Emergency'])}
  <section class="emg-page" aria-labelledby="emgH">
    <div class="emg-title"><span class="emg-dot" aria-hidden="true">!</span><h1 id="emgH">EMERGENCY</h1></div>
    ${emergencyArt()}
    <p class="emg-lead">If you are experiencing a serious or life-threatening condition:<span class="tl" style="font-family:var(--f-body);font-size:.8em">Kung malubha o delikado ang kalagayan:</span></p>
    <p class="emg-warn">DO NOT JOIN THE REGULAR QUEUE.</p>
    <p style="font-size:1.08rem">Proceed immediately to the health center or contact emergency services.<span class="tl">Pumunta agad sa health center o tumawag.</span></p>
    <a class="btn red emg-call" href="tel:+639631541440">${icon('phone')}<span>Call Health Center<small>0963-154-1440</small></span></a>
    <div class="btn-row" style="width:100%"><a class="btn danger" style="flex:1" href="tel:911">${icon('phone')}Call 911</a><a class="btn danger" style="flex:1" href="tel:+63271484934">${icon('phone')}7148-4934</a></div>
    <button class="btn danger" type="button" data-act="emgInfo" aria-expanded="${emgInfoOpen}">${icon('info')}Emergency Information</button>
    ${emgInfoOpen ? `<div class="emg-info"><h3 style="margin-bottom:8px">Go to the health center or call 911 right away for:</h3><ul>
      <li>Chest pain, or difficulty breathing</li><li>Signs of stroke: face drooping, arm weakness, slurred speech</li><li>Severe bleeding, deep wounds, or serious burns</li>
      <li>Fainting, seizures, or confusion</li><li>High fever with stiff neck, or a baby with fever under 3 months old</li><li>Pregnant women with bleeding, severe headache, or baby not moving</li>
      <li>Animal bites — wash the wound with soap and water for 15 minutes, then come in right away</li></ul>
      <p class="small muted" style="margin-top:10px">Bring a companion if you can, and any medicines you are taking.</p></div>` : ''}
  </section>`;
}

/* ---------- online queue ---------- */
function stepper(cur){
  const steps = ['Service','Patient Info','Queue Number'];
  return `<ol class="stepper" aria-label="Steps">${steps.map((t,i) => `<li class="${i+1===cur?'cur':i+1<cur?'done':''}" ${i+1===cur?'aria-current="step"':''}><i>${i+1<cur ? '✓' : i+1}</i>${t}</li>`).join('')}</ol>`;
}
function queueStatusBox(s){
  const q = queueState(), st = serviceState(s), cur = currentFor(s.code) || lastServed(s.code), line = lineFor(s.code);
  const ok = q.open && st.ok;
  return `<div class="qstatus ${ok?'':'closed'}" aria-live="polite">
    <h3>Today's Queue Status</h3>
    <div class="q-open"><span class="dot ${ok?'':'off'}"></span><div>${ok ? 'Queue is OPEN' : q.open ? esc(st.t) : 'Queue is CLOSED'}<span class="tl" style="font-style:normal;font-weight:400">as of <span data-clock></span>${S.center.demo ? ' · Practice mode' : ''}</span></div></div>
    ${!ok ? `<p>${esc(q.open ? st.sub : q.reason)}.</p>` : ''}
    <div class="q-nums"><div><span>Currently Serving</span><b>${cur ? esc(cur.num) : '—'}</b></div><div><span>Estimated Wait</span><b class="sm">${waitRange(line.length, s.avg)}</b></div></div>
    <p class="small">${line.length} waiting · ${st.left} online slots left${q.until ? ` · cut-off ${fmtT(q.until)}` : ''}</p>
  </div>`;
}
function viewQueue(){
  const mine = mineToday().find(t => ['waiting','called','serving'].includes(t.status));
  if (!flow.svc || !svcBy(flow.svc)) flow.svc = (S.services.find(s => s.open) || S.services[0]).code;
  const s = svcBy(flow.svc), st = serviceState(s);
  if (!st.ok && !flow.err) flow.step = 1;      // queue closed while filling in the form → show why
  const head = `${crumbs(['Online Queue'])}<div class="page-head"><div><h1>Online Queue<span class="tl">Kumuha ng numero sa pila</span></h1><p>Get a queue number for your chosen service. Numbers are for today only.</p></div></div>`;
  const mineNote = mine ? `<div class="notice info" style="margin-bottom:16px">${icon('receipt')}<div>You already have number <b class="mono">${esc(mine.num)}</b> today. <a href="#ticket">View my ticket</a>. Only one active number per service is allowed for each person and phone.</div></div>` : '';
  let body;
  if (flow.step === 1) {
    body = `<section class="card stack">
      <div class="field"><label for="qSvcSel" style="font-family:var(--f-display);font-size:1.15rem">Select Service <span class="tl">Pumili ng serbisyo</span></label>
        <div class="select-ic">${icon(s.icon,'',2.2)}<select id="qSvcSel" data-change="qsvc" ${queueState().cut ? 'disabled' : ''}>${S.services.map(x => `<option value="${x.code}" ${x.code===s.code?'selected':''}>${esc(x.name)}${x.open ? '' : ' (not available today)'}</option>`).join('')}</select></div>
        <span class="hint">${esc(s.desc)}</span></div>
      ${queueStatusBox(s)}
      <button class="btn primary lg block" type="button" data-act="qNext" ${st.ok?'':'disabled'}>Get Queue Number</button>
      <div class="notice info">${icon('info')}<div>Emergency patients should not wait in the online queue. Proceed directly to the health center for immediate assessment. <a href="#emergency">Emergency information</a></div></div>
      <p class="small muted" style="text-align:center">Already have a number? <a href="#ticket">View my ticket</a></p>
    </section>`;
  } else {
    const d = flow.data || {};
    const opts = [['senior','senior','Senior citizen','60 years old and above'],['pwd','pwd','Person with disability','With PWD ID'],['pregnant','pregnant','Pregnant','With MCH booklet'],['regular','person','Regular patient','Everyone else']];
    const lineAhead = lineFor(s.code).filter(t => !flow.prio || flow.prio === 'regular' || isPrio(t)).length;
    body = `<section class="card stack">
      <dl class="summary-box"><dt>Service</dt><dd>${esc(s.name)} <button class="link-btn" data-act="flowStep" data-v="1" type="button">change</button></dd><dt>Ahead of you</dt><dd>about ${lineAhead} patient${lineAhead===1?'':'s'} · ${waitRange(lineAhead, s.avg)}</dd></dl>
      <div><h2 style="margin-bottom:4px">Who is the patient?<span class="tl">Sino ang pasyente?</span></h2><p class="muted" style="margin-bottom:12px">Senior citizens, PWDs and pregnant women are called first.</p>
      <div class="choice-grid" role="group" aria-label="Patient type">${opts.map(([v,ic,t,sub]) => `<button class="choice" type="button" data-act="pickPrio" data-v="${v}" aria-pressed="${flow.prio===v}">${icon(ic,'ic',2.2)}<b>${t}<span class="tl">${PRIO_TL[v]}</span></b><span class="muted small">${sub}</span></button>`).join('')}</div></div>
      <form data-form="book" class="stack" novalidate><input type="text" name="website" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true">
        <h2>Patient information<span class="tl">Impormasyon ng pasyente</span></h2>
        <div class="form-grid">
          <div class="field"><label for="bName">Full name <span class="tl">Buong pangalan</span></label><input type="text" id="bName" name="name" autocomplete="name" placeholder="Juan Dela Cruz" value="${esc(d.name||'')}"></div>
          <div class="field"><label for="bAge">Age <span class="tl">Edad</span></label><input type="number" id="bAge" name="age" min="0" max="120" inputmode="numeric" value="${esc(d.age||'')}"></div>
          <div class="field"><label for="bContact">Mobile number <span class="tl">Cellphone</span></label><input type="tel" id="bContact" name="contact" placeholder="09XX XXX XXXX" inputmode="tel" value="${esc(d.contact||'')}"><span class="hint">So staff can reach you if needed.</span></div>
          <div class="field"><label for="bEmail">Email address <span class="tl">Email (libre ang abiso)</span></label><input type="email" id="bEmail" name="email" autocomplete="email" placeholder="juan@gmail.com" inputmode="email" value="${esc(d.email||'')}"><span class="hint">${SERVER.on && !SERVER.mail ? 'Optional. Keep this page open to see when your turn is near.' : 'Free updates: when your turn is near, when you are called, and if the schedule changes.'}</span></div>
          <div class="field"><label for="bAddr">Purok / Street <span class="tl">Tirahan</span></label><input type="text" id="bAddr" name="address" placeholder="Purok 3, Sampaguita St." value="${esc(d.address||'')}"></div>
        </div>
        ${s.code === 'CU' ? `<div class="field"><label for="bConcern">Main reason for your visit <span class="tl">Dahilan ng pagpapatingin</span></label><select id="bConcern" name="concern">${Object.entries(CONCERNS).map(([k,l]) => `<option value="${k}" ${(d.concern||'other')===k?'selected':''}>${l}</option>`).join('')}</select><span class="hint">Helps the health center prepare the right staff and medicines.</span></div>` : ''}
        ${flow.prio && flow.prio !== 'regular' ? `<div class="field"><label for="bProof">ID or document you will show <span class="tl">Anong ID ang dadalhin</span></label><select id="bProof" name="proof"><option value="">Choose one</option>${PROOFS[flow.prio].map(p => `<option ${d.proof===p?'selected':''}>${esc(p)}</option>`).join('')}</select>
          <span class="hint">Show this at the triage desk when called. If it cannot be checked, you will be moved to the regular lane.</span></div>` : ''}
        <label class="check"><input type="checkbox" name="resident" ${d.resident?'checked':''}> I am a resident of Barangay Kaligayahan.<span class="tl">Residente ako ng Barangay Kaligayahan.</span></label>
        <label class="check"><input type="checkbox" name="smsOk" ${d.smsOk===undefined||d.smsOk?'checked':''}> ${SERVER.on && !SERVER.mail && !SERVER.sms ? 'Contact me about my number if needed.' : 'Send me updates about my number by email'+(SERVER.sms ? ' or text' : '')+'.'}</label>
        <label class="check"><input type="checkbox" name="consent" ${d.consent?'checked':''}> <span>I agree to the <a href="#privacy" target="_blank" rel="noopener">Privacy Notice</a>. My details will be used only for my queue number and updates.<span class="tl">Pumapayag ako sa Privacy Notice.</span></span></label>
        ${flow.err ? `<p class="err" role="alert">${esc(flow.err)}</p>` : ''}
        ${captchaBox()}<button class="btn primary lg block" type="submit">${icon('receipt')}Get my queue number</button>
        <button class="btn ghost block" type="button" data-act="flowStep" data-v="1">Back</button>
      </form>
    </section>`;
  }
  return `<div class="queue-shell">${head}${mineNote}${stepper(flow.step)}${body}</div>`;
}

/* ---------- ticket / receipt ---------- */
function ticketMsg(t){
  if (t.status === 'waiting') {
    const a = aheadOf(t);
    return a === 0 ? ['ok','You are next! Please wait near the triage desk.'] : a <= 3 ? ['warn','Almost your turn. Please go to the health center now.'] : ['info','Please be at the health center when about 3 patients are ahead of you.'];
  }
  if (t.status === 'called') return ['warn',`It is your turn! Go to the triage desk within ${S.center.grace} minutes.${isPrio(t) && t.val && t.val.status!=='approved' ? ` Show your ${t.val.proof}.` : ''}`];
  if (t.status === 'serving') return ['ok','You are being served now.'];
  if (t.status === 'served') return ['neutral','Thank you for visiting. Get well soon! · Salamat po!'];
  if (t.status === 'void') return ['crit','This number was voided because the patient did not arrive in time. You may get a new number.'];
  return ['neutral','This number was cancelled.'];
}
function receiptHtml(t){
  const s = svcBy(t.svc), cur = currentFor(t.svc), [k,lbl,tl] = T_ST[t.status];
  const a = aheadOf(t), line = lineFor(t.svc).length, [mk, msg] = ticketMsg(t);
  const pos = t.status === 'waiting' ? Math.max(4, Math.round(100 - (a / Math.max(line,1)) * 100)) : ['called','serving','served'].includes(t.status) ? 100 : 0;
  return `<div class="receipt">
    <div class="receipt-top"><span class="logo logo-chip" aria-hidden="true"></span>
      <div><b>Barangay Kaligayahan Health Center</b><span>Online queue receipt · ${esc(dateShort(t.date))}</span></div></div>
    <div class="receipt-body">
      <div class="qnum"><div class="eyebrow">Your queue number · ${esc(s.name)}</div><div class="big" aria-live="polite">${esc(t.num)}</div>${pill(k, `${lbl} · ${tl}`, false, 'lg')}</div>
      <p class="msg ${mk}">${esc(msg)}</p>
      ${t.status === 'called' && t.calledAt ? `<p style="text-align:center">Time left to arrive: <b class="timer" data-since="${t.calledAt}">…</b></p>` : ''}
      ${t.status === 'waiting' ? `<div class="progress"><div class="row-between small"><span>Your place in line</span><b>${a === 0 ? 'Next' : a + ' ahead'}</b></div><div class="pbar" role="progressbar" aria-valuenow="${pos}" aria-valuemin="0" aria-valuemax="100" aria-label="Progress in line"><i style="width:${pos}%"></i></div></div>` : ''}
      <div class="rgrid">
        <div><span>Currently serving</span><b>${cur ? esc(cur.num) : '—'}</b></div>
        <div><span>Patients ahead</span><b>${t.status === 'waiting' ? a : '—'}</b></div>
        <div><span>Est. waiting time</span><b>${t.status === 'waiting' ? '~' + estWait(t) + ' min' : '—'}</b></div>
        <div><span>Lane</span><b style="font-size:1rem;font-family:var(--f-body)">${isPrio(t) ? 'Priority' : 'Regular'}</b></div>
      </div>
      <div class="perf"></div>
      <div class="rlines">
        <div><span>Name</span><b>${esc(t.name)}</b></div>
        <div><span>Patient type</span><b>${PRIO[t.prio]}${t.origPrio ? ' (was ' + PRIO_SHORT[t.origPrio] + ')' : ''}</b></div>
        ${t.val ? `<div><span>ID to show</span><b>${esc(t.val.proof)}</b></div>` : ''}
        <div><span>Service</span><b>${esc(s.name)} (${s.code})</b></div>
        <div><span>Issued</span><b class="num">${fmt(t.cmin)}</b></div>
      </div>
      <div class="perf"></div>
      <div class="vcode"><div class="qrbox" id="qr-${t.id}" aria-label="QR code of your verification code"></div><div style="text-align:center"><div class="eyebrow">Verification code</div><div class="code">${esc(t.code)}</div><p class="small muted" style="margin-top:6px">Show this at the triage desk.</p></div></div>
    </div></div>`;
}
function ticketSpeech(t){
  const s = svcBy(t.svc), [, msg] = ticketMsg(t);
  return `Your queue number is ${t.num}, for ${s.name}. ${t.status === 'waiting' ? `There ${aheadOf(t) === 1 ? 'is 1 patient' : `are ${aheadOf(t)} patients`} ahead of you. The estimated waiting time is ${estWait(t)} minutes.` : ''} ${msg}`;
}
function viewTicket(){
  const mine = mineToday();
  let t = mine.find(x => x.id === viewTicketId) || mine.find(x => ['waiting','called','serving'].includes(x.status)) || mine[0];
  if (!t && viewTicketId) t = S.tickets.find(x => x.id === viewTicketId && x.date === now().date);
  const find = `<section class="card stack no-print" style="max-width:480px;margin:18px auto 0"><h3>Find a ticket using its code<span class="tl">Hanapin gamit ang code</span></h3>
    <form data-form="findTicket" class="btn-row" novalidate><input type="text" name="code" placeholder="KLG-XXXXXX" aria-label="Verification code" style="flex:1 1 180px;text-transform:uppercase" autocomplete="off"><button class="btn ghost" type="submit">Find</button></form></section>`;
  const head = `${crumbs(['Online Queue','queue'],['My ticket'])}<div class="page-head"><div><h1>${t ? 'Your queue number' : 'No ticket yet today'}<span class="tl">${t ? 'Ang iyong numero' : 'Wala pang numero ngayon'}</span></h1>${t ? '<p>This page updates by itself as the line moves. Keep it open or take a screenshot.</p>' : ''}</div></div>`;
  if (!t) return `<div class="queue-shell">${head}<section class="card stack"><p style="font-size:1.1rem">You have not taken a queue number today on this phone or computer.</p><a class="btn primary lg" href="#queue">${icon('queue')}Get a queue number</a></section>${find}</div>`;
  const others = mine.filter(x => x.id !== t.id);
  const texts = S.sms.filter(m => m.tid === t.id).sort((a,b) => a.ts - b.ts);
  return `<div class="queue-shell">${head}${stepper(3)}</div>` + receiptHtml(t) + `
  <div class="btn-row no-print" style="justify-content:center;margin-top:18px">
    ${speakBtn('speakTicket','Read my number aloud',`data-id="${t.id}"`,'primary')}
    <button class="btn ghost" type="button" data-act="print">${icon('print')}Print</button>
    ${t.status === 'waiting' ? `<button class="btn danger" data-act="cancelMine" data-id="${t.id}" data-confirm="Tap again to cancel" type="button">Cancel this number</button>` : ''}
  </div>
  <p class="small muted no-print" style="text-align:center;margin-top:12px">Using a shared phone or computer? <button class="link-btn" type="button" data-act="forgetMine" data-confirm="Tap again: remove from this device">Remove my ticket from this device</button> (your number stays valid; keep the code).</p>
  ${texts.length ? `<section class="card stack no-print" style="max-width:480px;margin:18px auto 0"><h3>${icon('sms','',2.4).replace('<svg ','<svg width="22" height="22" style="vertical-align:-4px;margin-right:6px" ')}Messages sent to ${esc(texts[texts.length-1].to)}</h3>
    <div class="sms-list">${texts.map(m => `<div class="sms">${esc(m.text)}<time>${clockOf(m.ts)}</time></div>`).join('')}</div>
    ${SERVER.on && SERVER.mail ? '' : '<p class="small muted">Messages are listed here. Email sending is not switched on yet.</p>'}</section>` : ''}
  ${others.length ? `<section class="card no-print" style="max-width:480px;margin:18px auto 0"><h3 style="margin-bottom:10px">Other numbers today</h3><div class="btn-row">${others.map(o => `<button class="btn ghost sm mono" data-act="showTicket" data-id="${o.id}" type="button">${esc(o.num)} · ${T_ST[o.status][1].split(' —')[0]}</button>`).join('')}</div></section>` : ''}
  ${find}`;
}
function drawQR(){
  if (!window.QRCode) { document.querySelectorAll('.qrbox').forEach(el => { if (document.readyState === 'complete') el.hidden = true; }); return; }
  document.querySelectorAll('.qrbox').forEach(el => {
    if (el.dataset.done) return; el.dataset.done = '1';
    const t = S.tickets.find(x => 'qr-' + x.id === el.id); if (!t) return;
    try { new QRCode(el, { text:`BKHC|${t.code}|${t.num}|${t.date}`, width:98, height:98, colorDark:'#0B1A5E', colorLight:'#ffffff', correctLevel:QRCode.CorrectLevel.M }); } catch(e){}
  });
}

/* =========================================================
   ADMIN VIEWS
   ========================================================= */
let calYM = null, subDone = null;
// earliest date a normal (non-emergency) cut-off change may start: today + notice, on a clinic day
function minNoticeDate(){ let d = now().date, left = S.center.noticeDays || 1; for (let i = 0; i < 60 && left > 0; i++) { d = addDays(d, 1); if (isClinicDay(d)) left--; } return d; }
let adminTab = 'dash', qSvc = 'CU', apF = 'active', apSvc = 'all', apSrc = 'all', apQ = '', smsQ = '';
let rp = null;
const TABS = [['dash','dash','Dashboard'],['queue','queue','Queue desk'],['appts','cal','Appointments'],['doctors','doctor','Doctors'],['meds','medicine','Medicines'],['ann','announce','Announcements'],['sms','sms','Notifications'],['reports','chart','Reports'],['settings','gear','Settings'],['users','person','Staff accounts'],['account','idcard','My account']];

function viewLogin(){
  const lock = loginLockLeft();
  return `<section class="card login">
    <div class="eyebrow">Health center staff</div><h1 style="margin:4px 0 6px">Staff login</h1>
    <p class="muted" style="margin-bottom:16px">For nurses, midwives, pharmacy staff and barangay health workers who update the system.</p>
    <form data-form="login" class="stack" novalidate>
      <div class="field"><label for="lUser">Username</label><input type="text" id="lUser" name="u" autocomplete="username" autocapitalize="none" spellcheck="false"></div>
      <div class="field"><label for="lPass">Password</label><input type="password" id="lPass" name="p" autocomplete="current-password"></div>
      <p id="lErr" class="err ${lock ? '' : 'hide'}" role="alert">${lock ? `Too many wrong tries. Please wait ${lock} seconds.` : ''}</p>
      <button class="btn primary" type="submit">Log in</button>
      <p class="small muted">Forgot your password? Ask the administrator to reset it.</p>
    </form>${demoPasswords().length ? `<div class="notice info" style="margin-top:14px">${icon('info')}<div><b>Offline demo – first-time passwords</b> (each must be changed at first login):<br>${demoPasswords().map(([u, p]) => `<span class="mono">${esc(u)}</span> · <span class="mono">${esc(p)}</span>`).join('<br>')}</div></div>` : ''}</section>`;
}
const kpi = (v, l, alert) => `<div class="kpi${alert?' alert':''}"><b>${v}</b><span>${l}</span></div>`;

function qCard(s){
  const cur = currentFor(s.code), line = lineFor(s.code), nx = line[0], st = serviceState(s), c = counts(s.code);
  return `<div class="qcard">
    <div class="row-between"><div><span class="mono" style="color:var(--brand-deep);font-weight:700">${s.code}</span> <b>${esc(s.name)}</b></div>${s.open ? pill(st.k, st.ok ? 'Open' : st.t, true) : pill('crit','Not offered',true)}</div>
    <div><div class="eyebrow">${cur && cur.status === 'called' ? 'Calling' : 'At the desk'}</div><div class="now ${cur?'':'idle'}">${cur ? esc(cur.num) : 'None'}</div>${cur ? `<span class="small muted">${esc(cur.name)}</span>` : ''}</div>
    <div class="small">Next: <b class="mono">${nx ? esc(nx.num) : '—'}</b> · Waiting <b>${line.length}</b></div>
    <div class="small muted num">Online ${c.online}/${s.limit} · Walk-in ${c.walkin}/${s.walkin}</div>
    ${can('queue') ? `<button class="btn ghost sm" type="button" data-act="openDesk" data-v="${s.code}">Open queue desk</button>` : ''}
  </div>`;
}
function aDash(){
  const tt = todayTickets(), active = tt.filter(t => t.status !== 'cancelled'), q = queueState(), cs = centerStatus(), T = now().date;
  const onDuty = S.doctors.filter(d => d.available && docState(d).duty), availNow = S.doctors.filter(d => docState(d).k === 'ok').length;
  const due = S.medicines.filter(needsReorder), reqs = S.medRequests.filter(r => r.status === 'pending'), called = tt.filter(t => t.status === 'called');
  const waits = tt.filter(t => t.calledMin != null && t.status !== 'void').map(t => t.calledMin - t.cmin), avgWait = waits.length ? Math.round(waits.reduce((a,b) => a+b, 0) / waits.length) : 0;
  const hours = Array(9).fill(0); tt.forEach(t => { const h = Math.floor(t.cmin/60) - 8; if (h >= 0 && h < 9) hours[h]++; });
  const peak = hours.indexOf(Math.max(...hours)), nextDate = upcomingDates(1)[0], lastCut = sessionsOn(T).slice(-1)[0];
  const sentToday = S.sms.filter(m => m.date === T).length;
  const glance = [
    ['Online queue', q.open ? pill('ok', q.until ? `Open until ${fmtT(q.until)}` : 'Open', true) : pill(q.cut ? 'crit' : 'neutral', q.cut ? 'Closed · cut-off' : 'Closed', true)],
    ['Daily cut-off', lastCut ? `<b>${fmtT(lastCut.cutoff)}</b>${q.left != null && q.left > 0 && q.left <= 120 ? ` <span class="muted">· in ${q.left} min</span>` : ''}` : '—'],
    ['Next special date', nextDate ? `<b>${esc(dateShort(nextDate.date))}</b> <span class="muted">· ${esc(nextDate.reason)}</span>` : '<span class="muted">None</span>'],
    ['Medicine requests', reqs.length ? `<b>${reqs.length}</b> waiting` : '<span class="muted">None waiting</span>'],
    ['Messages sent today', `<b>${sentToday}</b>`],
    ['Turned away today', `<b>${S.turned[T] || 0}</b>`]
  ];
  return `<div class="page-head"><div><div class="eyebrow">${esc(dateLong(T))}</div><h1>Dashboard</h1></div>
    <div class="btn-row">${pill(cs.open ? 'ok' : 'crit', cs.label, false, 'lg')}${can('queue') ? `<button class="btn ghost" type="button" data-act="aTab" data-v="queue">${icon('queue')}Queue desk</button><button class="btn primary" type="button" data-act="walkin">${icon('walk')}Register walk-in</button>` : ''}</div></div>
  <div class="kpis" style="--cols:6">
    ${kpi(active.length, "Today's patients")}
    ${kpi(tt.filter(t => t.status === 'waiting').length, 'Waiting in queue')}
    ${kpi(tt.filter(t => t.status === 'served').length, 'Served today')}
    ${kpi(tt.filter(t => t.status === 'void').length, 'Voided (no-show)', tt.some(t => t.status === 'void'))}
    ${kpi(avgWait + '<span class="muted" style="font-size:1rem"> min</span>', 'Average wait today')}
    ${kpi(`${availNow}<span class="muted" style="font-size:1rem">/${onDuty.length}</span>`, 'Doctors & staff in now')}
  </div>
  ${called.length ? `<div class="notice warn" style="margin-bottom:18px">${icon('clock')}<div><b>${called.length} patient${called.length>1?'s':''} called but not yet at the desk:</b> ${called.map(t => `<span class="mono">${esc(t.num)}</span>`).join(', ')}. Numbers are voided automatically after ${S.center.grace} minutes.</div></div>` : ''}
  ${due.length ? `<div class="restock-alert compact" role="alert">${icon('alert','',2.4)}<div><b>Restock reminder: ${due.length} medicine${due.length>1?'s are':' is'} at or below ${restockPct()}% of full stock.</b> <span class="small">${due.slice(0,4).map(m => esc(m.name)).join(', ')}${due.length > 4 ? ` and ${due.length - 4} more` : ''}.</span></div>${can('meds') ? '<div class="act"><button class="btn white sm" type="button" data-act="aTab" data-v="meds">Open inventory</button></div>' : ''}</div>` : ''}
  <div class="dash-grid">
    <section class="card"><div class="card-head"><h2>Patients today by hour</h2><span class="small muted">${Math.max(...hours) ? `Busiest: <b style="color:var(--ink)">${fmt((8+peak)*60)}</b>` : 'No patients yet'}</span></div>
      ${barChart(['8AM','9AM','10AM','11AM','12PM','1PM','2PM','3PM','4PM'], [{ name:'patients', values:hours, color:'var(--brand)' }], { label:'Patients who got a queue number per hour today', labelsTop:true, hi:Math.max(...hours) ? peak : null, w:600, h:205 })}</section>
    <section class="card"><div class="card-head"><h2>Today at a glance</h2></div>
      <div class="glance">${glance.map(([l, v]) => `<div class="row-between"><span class="muted">${l}</span><span>${v}</span></div>`).join('')}</div></section>
  </div>
  <div class="section-title" style="margin-top:22px"><h2>Current queue</h2><span class="small muted">Tap a service to open its desk</span></div>
  <div class="qcards" style="--cols:${S.services.length};margin-bottom:22px">${S.services.map(qCard).join('')}</div>
  <div class="dash-grid">
    <section class="card"><div class="card-head"><h2>Medicine stock</h2>${can('meds') ? '<button class="btn ghost sm" data-act="aTab" data-v="meds" type="button">Full inventory</button>' : ''}</div>
      <p class="small muted" style="margin:-6px 0 10px">The 8 lowest, with the last 14 days. Restock line at ${restockPct()}%.</p>${stockChart(8)}</section>
    <section class="card"><div class="card-head"><h2>Doctors &amp; staff today</h2>${can('doctors') ? '<button class="btn ghost sm" data-act="aTab" data-v="doctors" type="button">Manage</button>' : ''}</div>
      <div class="list">${S.doctors.map(d => { const st = docState(d); return `<div class="row-between"><div><b>${esc(d.name)}</b><span class="muted small" style="display:block">${fmtT(d.start)} – ${fmtT(d.end)} · ${esc(d.role)}</span></div>${pill(st.k,st.t)}</div>`; }).join('')}</div></section>
  </div>`;
}
function aQueue(){
  const s = svcBy(qSvc), cur = currentFor(qSvc), line = lineFor(qSvc), T = now().date;
  const voided = todayTickets().filter(t => t.svc === qSvc && t.status === 'void');
  let desk;
  if (!cur) desk = `<div class="desk-now"><div class="eyebrow">Queue desk · ${esc(s.name)}</div><div class="num" style="color:var(--muted);font-size:1.4rem">No one at the desk</div>
      <button class="btn primary lg" type="button" data-act="callNext" data-v="${s.code}" ${line.length?'':'disabled'}>${icon('announce')}Call next patient${line[0] ? ' · ' + esc(line[0].num) : ''}</button></div>`;
  else if (cur.status === 'called') {
    const needId = isPrio(cur) && cur.val && cur.val.status !== 'approved';
    desk = `<div class="desk-now called"><div class="eyebrow">Calling · waiting for patient to arrive</div><div class="num">${esc(cur.num)}</div>
      <div><b>${esc(cur.name)}</b>, ${cur.age} yrs · ${PRIO[cur.prio]} · ${cur.source === 'walkin' ? 'Walk-in' : 'Online'}<br><span class="small muted">Code <span class="mono">${esc(cur.code)}</span> · called ${cur.calledAt ? clockOf(cur.calledAt) : ''} · auto-void in <b class="timer" data-since="${cur.calledAt}">…</b></span></div>
      ${needId ? `<div class="notice warn">${icon('idcard')}<div>Check the patient's <b>${esc(cur.val.proof)}</b> before starting.</div></div>
        <div class="btn-row"><button class="btn success" type="button" data-act="arrived" data-id="${cur.id}">${icon('check')}ID checked · start</button><button class="btn warn-btn" type="button" data-act="badId" data-id="${cur.id}" data-confirm="Tap again: move to regular lane">ID not valid</button><button class="btn danger" type="button" data-act="voidT" data-id="${cur.id}" data-confirm="Tap again to void">Not here · void</button></div>`
      : `<div class="btn-row"><button class="btn success lg" type="button" data-act="arrived" data-id="${cur.id}">${icon('check')}Patient arrived · start</button><button class="btn danger" type="button" data-act="voidT" data-id="${cur.id}" data-confirm="Tap again to void">Not here · void</button></div>`}
      <button class="link-btn" type="button" data-act="recallSms" data-id="${cur.id}">Send another text reminder</button></div>`;
  } else desk = `<div class="desk-now"><div class="eyebrow">Being served</div><div class="num">${esc(cur.num)}</div>
      <div><b>${esc(cur.name)}</b>, ${cur.age} yrs · ${PRIO[cur.prio]}</div>
      <div class="btn-row"><button class="btn primary lg" type="button" data-act="doneNext" data-v="${s.code}">${icon('check')}Done · call next${line[0] ? ' (' + esc(line[0].num) + ')' : ''}</button><button class="btn ghost" type="button" data-act="done" data-id="${cur.id}">Done only</button></div></div>`;
  return `<div class="page-head"><div><div class="eyebrow">Queue management</div><h1>Queue desk</h1></div>
    <div class="btn-row"><span class="small muted">Turned away today: <b class="num" style="color:var(--ink)">${S.turned[T]||0}</b></span><button class="btn ghost sm" data-act="turnAway" type="button">+1 turned away</button><button class="btn primary" type="button" data-act="walkin">${icon('walk')}Register walk-in</button></div></div>
  <div class="chips" style="margin-bottom:16px" role="group" aria-label="Service">${S.services.map(x => `<button class="chip" type="button" data-act="qSvc" data-v="${x.code}" aria-pressed="${qSvc===x.code}">${x.code} · ${esc(x.name)} (${lineFor(x.code).length})</button>`).join('')}</div>
  <div class="desk">${desk}
    <div class="card"><h3 style="margin-bottom:8px">${esc(s.name)} today</h3><div class="list small">
      <div class="row-between"><span>Online slots used</span><b class="num">${counts(s.code).online} / ${s.limit}</b></div>
      <div class="row-between"><span>Walk-in slots used</span><b class="num">${counts(s.code).walkin} / ${s.walkin}</b></div>
      <div class="row-between"><span>Served</span><b class="num">${todayTickets().filter(t => t.svc===s.code && t.status==='served').length}</b></div>
      <div class="row-between"><span>Voided (no-show)</span><b class="num">${voided.length}</b></div>
      <div class="row-between"><span>Average service time</span><b class="num">${s.avg} min</b></div></div></div>
  </div>
  <section class="card">
    <div class="card-head"><h2>Waiting patients · ${esc(s.name)}</h2><span class="small muted">Priority lane is called first</span></div>
    <div class="table-wrap"><table><thead><tr><th>#</th><th>Queue no.</th><th>Patient</th><th>Lane</th><th>Source</th><th>Issued</th><th></th></tr></thead><tbody>
    ${line.length ? line.map((t,i) => `<tr><td class="num">${i+1}</td><td class="mono"><b>${esc(t.num)}</b></td><td style="min-width:150px">${esc(t.name)}<span class="sub">${esc(t.address)} · ${t.age} yrs</span></td><td>${isPrio(t) ? pill('prio', PRIO_SHORT[t.prio], true) : pill('neutral','Regular',true)}</td><td>${t.source === 'walkin' ? 'Walk-in' : 'Online'}</td><td class="num" style="white-space:nowrap">${fmt(t.cmin)}</td>
      <td><div class="act"><button class="btn ghost sm" data-act="callThis" data-id="${t.id}" type="button">Call now</button><button class="btn danger sm" data-act="voidT" data-id="${t.id}" data-confirm="Void?" type="button">Void</button></div></td></tr>`).join('')
      : `<tr><td colspan="7" class="empty">No one is waiting for ${esc(s.name)}.</td></tr>`}
    </tbody></table></div>
    ${voided.length ? `<h3 style="margin:18px 0 8px">Voided today</h3><div class="btn-row">${voided.map(t => `<button class="btn ghost sm" data-act="restore" data-id="${t.id}" type="button"><span class="mono">${esc(t.num)}</span> · Put back in line</button>`).join('')}</div>` : ''}
  </section>`;
}

function apList(){
  const q = apQ.trim().toLowerCase();
  const F = { active:['waiting','called','serving'], all:null, served:['served'], void:['void'], cancelled:['cancelled'] };
  return todayTickets().filter(t => (!F[apF] || F[apF].includes(t.status)) && (apSvc === 'all' || t.svc === apSvc) && (apSrc === 'all' || t.source === apSrc) && (!q || t.name.toLowerCase().includes(q) || t.code.toLowerCase().includes(q) || t.num.toLowerCase().includes(q)))
    .sort((a,b) => a.cmin - b.cmin);
}
function apTable(list){
  return `<table><thead><tr><th>Queue no.</th><th>Patient</th><th>Service</th><th>Issued</th><th>Status</th><th>Code</th><th>Actions</th></tr></thead><tbody>
  ${list.length ? list.map(t => { const [k,l] = T_ST[t.status]; const live = ['waiting','called','serving'].includes(t.status);
    return `<tr><td class="mono"><b>${esc(t.num)}</b>${t.origNum ? `<span class="sub">was ${esc(t.origNum)}</span>` : ''}</td><td>${esc(t.name)}<span class="sub">${PRIO_SHORT[t.prio]} · ${t.source === 'walkin' ? 'Walk-in' : 'Online'}${t.contact ? ' · ' + esc(t.contact) : ''}</span></td><td>${esc(svcBy(t.svc).name)}</td><td class="num">${fmt(t.cmin)}</td>
      <td>${pill(k, l.split(' —')[0])} ${t.confirmed && live ? pill('ok','Verified',true) : ''}</td><td class="mono small">${esc(t.code)}</td>
      <td><div class="act">${live ? `${t.confirmed ? '' : `<button class="btn primary sm" data-act="confirm" data-id="${t.id}" type="button">Confirm</button>`}<button class="btn ghost sm" data-act="done" data-id="${t.id}" type="button">Completed</button><button class="btn ghost sm" data-act="voidT" data-id="${t.id}" data-confirm="Void?" type="button">No-show</button><button class="btn danger sm" data-act="cancelT" data-id="${t.id}" data-confirm="Cancel?" type="button">Cancel</button>`
        : t.status === 'void' ? `<button class="btn ghost sm" data-act="restore" data-id="${t.id}" type="button">Put back in line</button>` : '<span class="muted small">—</span>'}</div></td></tr>`; }).join('')
    : '<tr><td colspan="7" class="empty">No appointments match.</td></tr>'}
  </tbody></table>`;
}
function aAppts(){
  return `<div class="page-head"><div><div class="eyebrow">Appointment management</div><h1>Today's appointments</h1><p>Verify a patient by typing the code on their receipt (KLG-…).</p></div><button class="btn primary" type="button" data-act="walkin">${icon('walk')}Register walk-in</button></div>
  <div class="toolbar">
    <label class="search">${icon('search','',3)}<span class="sr">Search appointments</span><input type="search" id="apSearch" placeholder="Search name, queue no. or code" value="${esc(apQ)}" autocomplete="off"></label>
    <select data-change="apSvc" aria-label="Service" style="width:auto"><option value="all">All services</option>${S.services.map(s => `<option value="${s.code}" ${apSvc===s.code?'selected':''}>${esc(s.name)}</option>`).join('')}</select>
    <select data-change="apSrc" aria-label="Source" style="width:auto"><option value="all">Online &amp; walk-in</option><option value="online" ${apSrc==='online'?'selected':''}>Online only</option><option value="walkin" ${apSrc==='walkin'?'selected':''}>Walk-in only</option></select>
  </div>
  <div class="chips" style="margin-bottom:14px">${[['active','Active'],['all','All'],['served','Completed'],['void','No-show / voided'],['cancelled','Cancelled']].map(([v,l]) => `<button class="chip" type="button" data-act="apF" data-v="${v}" aria-pressed="${apF===v}">${l}</button>`).join('')}</div>
  <div class="table-wrap" id="apTable">${apTable(apList())}</div>`;
}

function aDoctors(){
  return `<div class="page-head"><div><div class="eyebrow">Doctor management</div><h1>Doctors &amp; staff</h1><p>Set schedules and daily consultation limits, and mark who is available today.</p></div><button class="btn primary" data-act="docEdit" type="button">${icon('plus')}Add doctor</button></div>
  <div class="table-wrap"><table><thead><tr><th>Name</th><th>Schedule</th><th>Limit / day</th><th>Today</th><th>Actions</th></tr></thead><tbody>
  ${S.doctors.map(d => { const st = docState(d); return `<tr><td><b>${esc(d.name)}</b><span class="sub">${esc(d.role)}</span></td>
    <td>${daysLabel(d.days)}<span class="sub num">${fmtT(d.start)} – ${fmtT(d.end)}</span></td><td class="num">${d.limit}</td>
    <td>${pill(st.k,st.t)}${d.note ? `<span class="sub">${esc(d.note)}</span>` : ''}</td>
    <td><div class="act"><button class="btn ${d.available?'ghost':'primary'} sm" data-act="docToggle" data-id="${d.id}" type="button">Mark ${d.available?'unavailable':'available'} today</button><button class="btn ghost sm" data-act="docLeave" data-id="${d.id}" type="button">Days off / leave${(d.leaves || []).some(l => l.last >= now().date) ? ` (${(d.leaves || []).filter(l => l.last >= now().date).length})` : ''}</button><button class="btn ghost sm" data-act="docEdit" data-id="${d.id}" type="button">Edit</button><button class="btn danger sm" data-act="docDel" data-id="${d.id}" data-confirm="Remove?" type="button">Remove</button></div></td></tr>`; }).join('')}
  </tbody></table></div>
  ${S.doctors.length ? `<div style="margin-top:20px">${dutyCalendar(true)}</div>` : ''}`;
}
function docForm(d){
  d = d || { id:'', name:'', role:'', days:[1,2,3,4,5], start:'08:00', end:'17:00', available:true, limit:20, note:'' };
  return `<h2>${d.id ? 'Edit doctor' : 'Add doctor'}</h2>
  <form data-form="doc" data-id="${d.id}" class="stack" novalidate>
    <div class="form-grid">
      <div class="field"><label for="dName">Name</label><input type="text" id="dName" name="name" value="${esc(d.name)}" placeholder="Dr. Juan Dela Cruz"></div>
      <div class="field"><label for="dRole">Specialty / role</label><input type="text" id="dRole" name="role" value="${esc(d.role)}" placeholder="General Medicine"></div>
      <div class="field"><label for="dStart">Available from</label><input type="time" id="dStart" name="start" value="${d.start}"></div>
      <div class="field"><label for="dEnd">Until</label><input type="time" id="dEnd" name="end" value="${d.end}"></div>
      <div class="field"><label for="dLimit">Patients per day</label><input type="number" id="dLimit" name="limit" min="1" value="${d.limit}"></div>
      <div class="field"><label for="dNote">Note shown to residents</label><input type="text" id="dNote" name="note" value="${esc(d.note)}" placeholder="e.g. On leave until Monday"></div>
    </div>
    <fieldset class="field" style="border:0;padding:0;margin:0"><legend class="lbl" style="margin-bottom:6px">Duty days</legend>
      <div class="btn-row">${[1,2,3,4,5,6,0].map(x => `<label class="check chip"><input type="checkbox" name="day" value="${x}" ${d.days.includes(x)?'checked':''}> ${DOW[x]}</label>`).join('')}</div></fieldset>
    <label class="check"><input type="checkbox" name="available" ${d.available?'checked':''}> Available</label>
    <p class="err hide" id="dErr" role="alert"></p>
    <div class="btn-row"><button class="btn primary" type="submit">Save</button><button class="btn ghost" type="button" data-act="closeModal">Cancel</button></div>
  </form>`;
}

function medAdminRows(){
  const list = medFiltered();
  if (!list.length) return `<tr><td colspan="5" class="empty">No medicine matches.</td></tr>`;
  return list.map(m => { const [k,t] = MED_ST[m.status], ro = needsReorder(m), pct = stockPct(m);
    return `<tr${ro ? ' class="row-alert"' : ''}><td><b>${esc(m.name)}</b>${isFrequent(m) ? ' <span class="pill info plain">★ frequent</span>' : ''}<span class="sub">${esc(m.form)} · ${m.freq||0} given / month · updated ${esc(dateShort(m.updated))}</span></td>
      <td><div class="act"><input class="inline-num" type="number" min="0" id="stock-${m.id}" value="${m.stock}" aria-label="Stock of ${esc(m.name)}"><span class="muted num">/ ${m.cap}</span><button class="btn ghost sm" data-act="medStock" data-id="${m.id}" type="button">Update</button></div></td>
      <td><div class="pct-cell"><div class="stk-track sm"><i class="${stockClass(m)}" style="width:${Math.max(m.stock ? 2 : 0, pct)}%"></i><b class="stk-mark" style="left:${restockPct()}%"></b></div><span class="num">${pct}%</span></div></td>
      <td>${pill(k,t)}${ro ? `<span class="sub">${pill('warn','Restock now',true)}</span>` : ''}</td>
      <td><div class="act">${ro ? `<button class="btn success sm" data-act="medRefill" data-id="${m.id}" type="button">Replenish</button>` : ''}<button class="btn ghost sm" data-act="medEdit" data-id="${m.id}" type="button">Edit</button><button class="btn danger sm" data-act="medDel" data-id="${m.id}" data-confirm="Remove?" type="button">Remove</button></div></td></tr>`; }).join('');
}
// order list for City Health: everything at or below the restock level, plus what residents asked for
function demand(){
  const open = S.medRequests.filter(r => ['pending','forwarded'].includes(r.status)), by = {};
  open.forEach(r => { by[r.medId] = by[r.medId] || { qty:0, n:0 }; by[r.medId].qty += r.qty; by[r.medId].n++; });
  S.medicines.filter(needsReorder).forEach(m => { by[m.id] = by[m.id] || { qty:0, n:0 }; });
  return Object.entries(by).map(([id, v]) => { const m = S.medicines.find(x => x.id === id); if (!m) return null; return { m, ...v, need:Math.max(0, m.cap - m.stock + v.qty) }; }).filter(Boolean).sort((a,b) => (a.m.stock / a.m.cap) - (b.m.stock / b.m.cap));
}

/* ---------- stock tracking graph ----------
   One bar per medicine: how full it is (% of full stock), a marker at the restock level,
   and a 14-day trend line from the stock history. Lowest stock first. */
// 14-day trend: line scaled to this medicine's own range (so real changes show), soft area
// underneath, the restock line only when it falls inside the chart, and the change in words.
function sparkline(m){
  const h = (S.stockHist || {})[m.id] || {}, days = Object.keys(h).sort().slice(-14), vals = days.map(d => h[d]);
  if (vals.length < 2) return '<span class="trend"><span class="trend-txt muted">No history yet</span></span>';
  const W = 132, H = 40, P = 4, lo0 = Math.min(...vals), hi0 = Math.max(...vals);
  const pad = Math.max((hi0 - lo0) * 0.2, m.cap * 0.03, 1), lo = Math.max(0, lo0 - pad), hi = hi0 + pad;
  const x = i => P + (i / (vals.length - 1)) * (W - P * 2), y = v => H - P - ((v - lo) / (hi - lo)) * (H - P * 2);
  const pts = vals.map((v,i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`), cls = stockClass(m), rl = m.cap * restockPct() / 100;
  const first = vals[0], last = vals[vals.length-1], diff = last - first, restocked = vals.some((v,i) => i && v > vals[i-1]);
  const txt = diff < 0 ? `<b class="down">▼ ${-diff}</b> used` : diff > 0 ? `<b class="up">▲ ${diff}</b>${restocked ? ' restocked' : ''}` : '<b>No change</b>';
  const tip = days.map((d,i) => `${dateShort(d).replace(/^\w+, /,'')}: ${vals[i]}`).join('\n');
  return `<span class="trend" title="${esc(m.name)} — last ${vals.length} days\n${esc(tip)}">
    <svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(m.name)}: ${first} to ${last} over the last ${vals.length} days">
      ${rl > lo && rl < hi ? `<line x1="${P}" x2="${W-P}" y1="${y(rl).toFixed(1)}" y2="${y(rl).toFixed(1)}" class="spark-mark"/>` : ''}
      <polygon points="${x(0).toFixed(1)},${H-P} ${pts.join(' ')} ${x(vals.length-1).toFixed(1)},${H-P}" class="spark-area ${cls}"/>
      <polyline points="${pts.join(' ')}" class="spark-line ${cls}"/>
      <circle cx="${x(vals.length-1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="3.2" class="spark-dot ${cls}"/>
    </svg>
    <span class="trend-txt"><span>${txt}</span><small>${first} → ${last}</small></span></span>`;
}function stockChart(limit){
  const list = S.medicines.slice().sort((a,b) => stockPct(a) - stockPct(b)).slice(0, limit || 999), rp = restockPct();
  return `<div class="stk-chart" role="table" aria-label="Stock level of each medicine">
    <div class="stk-row stk-head" role="row"><span role="columnheader">Medicine</span><span role="columnheader">Stock level (% of full)</span><span role="columnheader">Left / full</span><span role="columnheader">Trend · last 14 days</span></div>
    ${list.map(m => { const pct = stockPct(m); return `<div class="stk-row" role="row">
      <span class="stk-name" role="cell"><b>${esc(m.name)}</b></span>
      <span role="cell"><span class="stk-track"><i class="${stockClass(m)}" style="width:${Math.max(m.stock ? 1.5 : 0, pct)}%"></i><b class="stk-mark" style="left:${rp}%" title="Restock at ${rp}%"></b></span></span>
      <span class="stk-val num" role="cell"><b>${m.stock}</b>/${m.cap} · ${pct}%</span>
      <span role="cell">${sparkline(m)}</span></div>`; }).join('')}
    <div class="stk-legend small"><span><i class="ok"></i>Enough stock</span><span><i class="due"></i>At or below ${rp}% — restock</span><span><i class="low"></i>Low stock (residents see it)</span><span><i class="mark"></i>Restock line (${rp}%)</span></div>
  </div>`;
}
function restockBanner(){
  const due = S.medicines.filter(needsReorder).sort((a,b) => stockPct(a) - stockPct(b));
  if (!due.length) return `<div class="notice ok" style="margin-bottom:18px">${icon('check')}<div><b>All medicines are above ${restockPct()}% of full stock.</b> No restock needed right now.</div></div>`;
  return `<div class="restock-alert" role="alert">${icon('alert','',2.4)}<div>
      <b>Restock reminder: ${due.length} medicine${due.length>1?'s are':' is'} at or below ${restockPct()}% of full stock.</b>
      <div class="chip-list">${due.map(m => `<span class="pill ${m.status==='out'||m.status==='low'?'crit':'warn'} plain">${esc(m.name)} · ${m.stock}/${m.cap}</span>`).join('')}</div>
      <span class="small">A reminder is emailed to the pharmacy (${esc(S.center.pharmacyEmail || 'pharmacy')}) once a day while stock stays low.</span></div>
    <div class="act"><button class="btn white sm" type="button" data-act="csvDemand">${icon('download')}Order list</button><button class="btn white sm" type="button" data-act="remindNow">${icon('sms')}Send reminder now</button></div></div>`;
}
function aMeds(){
  const reqs = S.medRequests.slice().sort((a,b) => (a.status==='pending'?0:1)-(b.status==='pending'?0:1) || b.date.localeCompare(a.date));
  const dm = demand(), ro = S.medicines.filter(needsReorder);
  return `<div class="page-head"><div><div class="eyebrow">Medicine management</div><h1>Medicine inventory</h1><p>Stock is shown to residents as a count (for example 40/100).</p></div><button class="btn primary" data-act="medAdd" type="button">${icon('plus')}Add medicine</button></div>
  ${restockBanner()}
  <div class="kpis" style="--cols:4">${kpi(S.medicines.length,'Medicines listed')}${kpi(ro.length,`At or below ${restockPct()}% (restock)`, ro.length > 0)}${kpi(S.medicines.filter(m => m.status==='low').length,'Low stock')}${kpi(S.medicines.filter(m => m.status==='out').length,'Out of stock', S.medicines.some(m => m.status==='out'))}</div>
  <section class="card" style="margin-bottom:18px"><div class="card-head"><div><h2>Stock levels</h2><p class="small muted" style="margin-top:4px">Every medicine, lowest first. The dark line on each bar is the restock level.</p></div>
      <form data-form="restockPct" class="act" novalidate><label for="rpIn" class="small"><b>Remind at</b></label><input class="inline-num" type="number" id="rpIn" name="pct" min="5" max="60" value="${restockPct()}" aria-label="Restock reminder percent"><span class="small">% of full stock</span><button class="btn ghost sm" type="submit">Save</button></form></div>
    ${stockChart()}
  </section>
  ${medToolbar(true)}
  <div class="table-wrap" style="margin-bottom:24px"><table class="compact"><thead><tr><th>Medicine</th><th>Stock / full</th><th>Level</th><th>Status</th><th>Actions</th></tr></thead><tbody id="medBody">${medAdminRows()}</tbody></table></div>
  <div class="grid-2">
    <section class="card"><div class="card-head"><h2>Resident requests</h2><span class="small muted">${reqs.filter(r => r.status==='pending').length} waiting</span></div>
      ${reqs.length ? `<div class="list">${reqs.map(r => { const m = S.medicines.find(x => x.id === r.medId) || { name:'(removed)', status:'out' }; const [k,l] = REQ_ST[r.status];
        return `<div><div class="row-between"><div><b>${esc(m.name)}</b> × ${r.qty}<span class="sub muted small" style="display:block">${esc(r.name)} · ${esc(r.email || r.contact)} · <span class="mono">${esc(r.code)}</span> · ${esc(dateShort(r.date))}${r.note ? ' · ' + esc(r.note) : ''}</span></div>${pill(k,l)}</div>
          ${['pending','forwarded'].includes(r.status) ? `<div class="btn-row" style="margin-top:8px"><button class="btn success sm" type="button" data-act="reqSet" data-id="${r.id}" data-v="ready">Ready · notify patient</button>${r.status==='pending' ? `<button class="btn ghost sm" type="button" data-act="reqSet" data-id="${r.id}" data-v="forwarded">Request from City Health</button>` : ''}<button class="btn danger sm" type="button" data-act="reqSet" data-id="${r.id}" data-v="cancelled" data-confirm="Cancel?">Cancel</button></div>`
          : r.status === 'ready' ? `<div class="btn-row" style="margin-top:8px"><button class="btn ghost sm" type="button" data-act="reqSet" data-id="${r.id}" data-v="claimed">Mark claimed</button></div>` : ''}</div>`; }).join('')}</div>` : '<p class="muted">No requests yet.</p>'}
    </section>
    <section class="card"><div class="card-head"><h2>Order list for City Health</h2><button class="btn ghost sm" type="button" data-act="csvDemand">${icon('download')}Download</button></div>
      <p class="small muted" style="margin-bottom:12px">Medicines at or below ${restockPct()}% of full stock, plus resident requests. Order quantity = fill back to full stock + requests.</p>
      ${dm.length ? `<div class="table-wrap"><table class="compact"><thead><tr><th>Medicine</th><th>Stock</th><th>Requested</th><th>Order qty</th></tr></thead><tbody>${dm.map(d => `<tr><td>${esc(d.m.name)}<span class="sub">${pill(...MED_ST[d.m.status].slice(0,2))}</span></td><td class="num">${d.m.stock}/${d.m.cap}</td><td class="num">${d.qty}${d.n ? ` <span class="muted small">(${d.n})</span>` : ''}</td><td class="num"><b>${d.need}</b></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nothing to order.</p>'}
    </section>
  </div>`;
}
function medForm(m){
  m = m || { id:'', name:'', form:'Tablet', stock:0, cap:200, thr:30, freq:0, use:'' };
  return `<h2>${m.id ? 'Edit medicine' : 'Add medicine'}</h2><form data-form="med" data-id="${m.id}" class="stack" novalidate>
    <div class="form-grid">
      <div class="field"><label for="mName">Name and strength</label><input type="text" id="mName" name="name" value="${esc(m.name)}" placeholder="Paracetamol 500 mg"></div>
      <div class="field"><label for="mForm">Form</label><select id="mForm" name="form">${['Tablet','Capsule','Syrup','Suspension','Nebule','Sachet','Vial','Ointment','Drops'].map(f => `<option ${f===m.form?'selected':''}>${f}</option>`).join('')}</select></div>
      <div class="field"><label for="mStock">Stock on hand</label><input type="number" id="mStock" name="stock" min="0" value="${m.stock}"></div>
      <div class="field"><label for="mCap">Full stock</label><input type="number" id="mCap" name="cap" min="1" value="${m.cap}"><span class="hint">Shown to residents as stock / full, e.g. 40/100. Restock reminder at ${restockPct()}% of this.</span></div>
      <div class="field"><label for="mThr">Low-stock level</label><input type="number" id="mThr" name="thr" min="0" value="${m.thr}"><span class="hint">Residents see “Low stock” at or below this. Keep it at or below ${restockPct()}% of full stock.</span></div>
      <div class="field"><label for="mFreq">Given out per month</label><input type="number" id="mFreq" name="freq" min="0" value="${m.freq}"><span class="hint">The most-used medicines are shown first to residents.</span></div>
    </div>
    <div class="field"><label for="mUse">What it is for (shown to residents)</label><input type="text" id="mUse" name="use" value="${esc(m.use)}" placeholder="Fever, pain · Lagnat, sakit ng katawan"></div>
    <p class="err hide" id="mErr" role="alert"></p>
    <div class="btn-row"><button class="btn primary" type="submit">Save medicine</button><button class="btn ghost" type="button" data-act="closeModal">Cancel</button></div></form>`;
}

function aAnn(){
  const n = now();
  return `<div class="page-head"><div><div class="eyebrow">Announcements</div><h1>Post an announcement</h1><p>Doctor leaves, holiday schedules, cut-offs and health advisories appear on the residents' pages.</p></div></div>
  <div class="grid-2">
    <section class="card"><form data-form="ann" class="stack" novalidate>
      <div class="form-grid">
        <div class="field"><label for="aType">Type</label><select id="aType" name="type">${Object.entries(ANN_T).map(([v,[,l]]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
        <div class="field"><label for="aDate">Date</label><input type="date" id="aDate" name="date" value="${n.date}"></div>
      </div>
      <div class="field"><label for="aTitle">Title</label><input type="text" id="aTitle" name="title" placeholder="Dr. Santos on leave on Friday"></div>
      <div class="field"><label for="aBody">Details</label><textarea id="aBody" name="body" rows="4" placeholder="What residents need to know"></textarea></div>
      <label class="check"><input type="checkbox" name="pinned"> Pin to top</label>
      <p class="err hide" id="aErr" role="alert"></p>
      <div class="btn-row"><button class="btn primary" type="submit">Post announcement</button></div>
    </form></section>
    <section class="card"><div class="card-head"><h2>Holidays &amp; special dates</h2>${can('settings') ? '<button class="btn ghost sm" type="button" data-act="aTab" data-v="settings">Open calendar</button>' : ''}</div>
      <p class="small muted" style="margin-bottom:12px">Holidays and Holy Week are set automatically every year. Other dates are set in Settings → Calendar.</p>
      <div class="list">${upcomingDates(6).map(x => `<div class="row-between"><div><b>${esc(dateShort(x.date))}</b><p class="muted small">${esc(x.reason)}</p></div>${x.hours ? pill('warn', `${fmtT(x.open)} – ${fmtT(x.close)}`, true) : pill(x.auto ? 'info' : 'crit', x.auto ? 'Holiday' : 'Closed', true)}</div>`).join('') || '<p class="muted">Nothing coming up.</p>'}</div>
    </section>
  </div>
  <section class="card" style="margin-top:18px"><div class="card-head"><h2>Posted announcements</h2></div>
    <div class="list">${sortedAnn().map(a => `<div class="row-between" style="align-items:flex-start">${annItem(a)}<div class="btn-row"><button class="btn ghost sm" data-act="annPin" data-id="${a.id}" type="button">${a.pinned ? 'Unpin' : 'Pin'}</button><button class="btn danger sm" data-act="annDel" data-id="${a.id}" data-confirm="Delete?" type="button">Delete</button></div></div>`).join('') || '<p class="muted">No announcements.</p>'}</div>
  </section>`;
}

function aSms(){
  const q = smsQ.trim().toLowerCase();
  const list = S.sms.slice().sort((a,b) => b.ts - a.ts).filter(m => !q || m.to.toLowerCase().includes(q) || (m.num||'').toLowerCase().includes(q) || m.text.toLowerCase().includes(q)).slice(0, 150);
  const T = now().date, today = S.sms.filter(m => m.date === T);
  return `<div class="page-head"><div><div class="eyebrow">Automated notifications</div><h1>Notifications</h1><p>Patients are told when they get a number, when about 3 patients are ahead, when they are called, and when a number is voided. Schedule and cut-off changes go to everyone on the email list.</p></div></div>
  <div class="notice info" style="margin-bottom:16px">${icon('info')}<div><b>Email first, because it is free.</b> SMS costs money for every text, so it is ${S.center.smsOn ? '<b>on</b> only for patients who gave no email' : '<b>off</b>'} (change this in Settings). <br><span class="small">${SERVER.on && SERVER.mail ? 'Emails are sent automatically by the server. Text messages (SMS) are not connected yet.' : 'Email sending is not switched on yet, so messages are only listed here. The administrator can add the email settings to the server (see backend/README.md).'}</span></div></div>
  <div class="kpis" style="--cols:4">${kpi(today.filter(m => m.ch !== 'sms').length, 'Emails sent today')}${kpi(today.filter(m => m.ch === 'sms').length, 'SMS sent today (paid)')}${kpi((S.subs||[]).length, 'Email subscribers')}${kpi(S.sms.length, 'All messages saved')}</div>
  <div class="toolbar"><label class="search">${icon('search','',3)}<span class="sr">Search messages</span><input type="search" id="smsSearch" placeholder="Search email, number or message" value="${esc(smsQ)}" autocomplete="off"></label></div>
  <div class="table-wrap" id="smsTable" style="margin-bottom:22px"><table><thead><tr><th>Time</th><th>Channel</th><th>To</th><th>Queue no.</th><th>Message</th></tr></thead><tbody>
    ${list.length ? list.map(m => `<tr><td class="num" style="white-space:nowrap">${esc(dateShort(m.date))}<span class="sub">${clockOf(m.ts)}</span></td><td>${m.ch === 'sms' ? pill('warn','SMS',true) : pill('info','Email',true)}</td><td class="mono small">${esc(m.to)}</td><td class="mono">${esc(m.num||'—')}</td><td>${esc(m.text)}</td></tr>`).join('') : '<tr><td colspan="5" class="empty">No messages.</td></tr>'}
  </tbody></table></div>
  <section class="card"><div class="card-head"><h2>Email subscribers</h2><span class="small muted">Residents subscribe on the Announcements page</span></div>
    ${(S.subs||[]).length ? `<div class="btn-row">${S.subs.map(e => `<span class="pill neutral plain lg">${esc(e)} <button class="link-btn" type="button" data-act="subDel" data-v="${esc(e)}" aria-label="Remove ${esc(e)}">✕</button></span>`).join('')}</div>` : '<p class="muted">No subscribers yet.</p>'}
  </section>`;
}

/* ---------- settings: hours, calendar of special dates, cut-off rule, services ---------- */
function calendar(){
  const T = now().date; if (!calYM) calYM = T.slice(0,7);
  const [y, m] = calYM.split('-').map(Number), daysIn = new Date(Date.UTC(y, m, 0)).getUTCDate(), lead = dowOf(`${calYM}-01`);
  const title = new Date(Date.UTC(y, m-1, 1)).toLocaleDateString('en-US', { timeZone:'UTC', month:'long', year:'numeric' });
  let cells = ''; for (let i = 0; i < lead; i++) cells += '<span class="cal-blank"></span>';
  for (let d = 1; d <= daysIn; d++) {
    const ds = `${calYM}-${pad(d)}`, r = dayRule(ds), clinic = S.center.days.includes(dowOf(ds));
    const cls = r ? (r.closed ? (r.auto ? 'hol' : 'closed') : r.hours ? 'special' : 'reopen') : clinic ? 'open' : 'off';
    const lbl = r ? (r.hours ? `${fmtT(r.open).replace(':00','')}–${fmtT(r.close).replace(':00','')}` : r.reopen ? 'Open' : r.reason) : clinic ? '' : 'No clinic';
    cells += `<button type="button" class="cal-day ${cls} ${ds === T ? 'today' : ''}" data-act="calDay" data-date="${ds}" title="${esc(r ? r.reason : clinic ? 'Normal clinic day' : 'No clinic')}"><b>${d}</b><small>${esc(lbl)}</small></button>`;
  }
  return `<div class="cal">
    <div class="row-between" style="margin-bottom:10px"><button class="btn ghost sm" type="button" data-act="calNav" data-v="-1" aria-label="Previous month">‹</button><h3 aria-live="polite">${title}</h3><button class="btn ghost sm" type="button" data-act="calNav" data-v="1" aria-label="Next month">›</button></div>
    <div class="cal-grid cal-head">${DOW.map(d => `<span>${d}</span>`).join('')}</div>
    <div class="cal-grid">${cells}</div>
    <div class="cal-legend small"><span><i class="open"></i>Clinic day</span><span><i class="hol"></i>Holiday (automatic)</span><span><i class="closed"></i>Closed (set by staff)</span><span><i class="special"></i>Special hours</span><span><i class="off"></i>No clinic</span></div>
  </div>`;
}
function dateForm(ds){
  const m = S.closures.find(c => c.date === ds), h = S.center.autoHolidays ? phHolidays(+ds.slice(0,4))[ds] : null;
  const type = m ? m.type : 'closed';
  return `<h2>${esc(dateLong(ds))}</h2>
  ${h ? `<div class="notice info" style="margin-bottom:14px">${icon('info')}<div><b>Automatic holiday: ${esc(h)}.</b> The health center is closed without you doing anything. Choose “Open as usual” only if the center will operate on this day.</div></div>` : ''}
  <form data-form="dateRule" class="stack" novalidate>
    <input type="hidden" name="date" value="${ds}">
    <div class="field"><label for="drType">On this date the health center is…</label><select id="drType" name="type">
      <option value="closed" ${type==='closed'?'selected':''}>Closed all day</option>
      <option value="hours" ${type==='hours'?'selected':''}>Open on special hours (e.g. half day)</option>
      <option value="open" ${type==='open'?'selected':''}>Open as usual (even if it is a holiday)</option></select></div>
    <div class="form-grid">
      <div class="field"><label for="drOpen">Opens <span class="muted">(special hours)</span></label><input type="time" id="drOpen" name="open" value="${m && m.open || S.center.open}"></div>
      <div class="field"><label for="drClose">Closes <span class="muted">(special hours)</span></label><input type="time" id="drClose" name="close" value="${m && m.close || '12:00'}"></div>
    </div>
    <div class="field"><label for="drReason">Reason shown to residents</label><input type="text" id="drReason" name="reason" value="${esc(m ? m.reason : '')}" placeholder="e.g. Barangay fiesta, staff training, typhoon"></div>
    <label class="check"><input type="checkbox" name="announce" checked> Post an announcement and email everyone on the list</label>
    <p class="err hide" id="drErr" role="alert"></p>
    <div class="btn-row"><button class="btn primary" type="submit">Save date</button>${m ? `<button class="btn danger" type="button" data-act="closureDel" data-id="${m.id}">Remove special date</button>` : ''}<button class="btn ghost" type="button" data-act="closeModal">Cancel</button></div>
  </form>`;
}
function cutNowForm(){
  const waiting = todayTickets().filter(t => t.status === 'waiting').length;
  return `<h2>Emergency cut-off for today</h2>
  <div class="notice warn" style="margin-bottom:14px">${icon('alert')}<div>This stops new queue numbers <b>right now</b>, without the usual notice. Use it only for real emergencies (doctor called away, power outage, typhoon). The ${waiting} patient${waiting===1?'':'s'} already waiting keep their numbers, and everyone is notified with your reason.</div></div>
  <form data-form="cutNow" class="stack" novalidate>
    <div class="field"><label for="cnReason">Reason (shown to patients)</label><input type="text" id="cnReason" name="reason" placeholder="e.g. Doctor called to an emergency"></div>
    <p class="err hide" id="cnErr" role="alert"></p>
    <div class="btn-row"><button class="btn red" type="submit">Close today's queue now</button><button class="btn ghost" type="button" data-act="closeModal">Cancel</button></div>
  </form>`;
}
function aSettings(){
  const c = S.center, minDate = minNoticeDate(), cut = c.cutNow && c.cutNow.date === now().date ? c.cutNow : null;
  const special = upcomingDates(6);
  return `<div class="page-head"><div><div class="eyebrow">Settings</div><h1>Schedule, cut-off and services</h1></div></div>
  <div class="grid-2">
  <section class="card"><form data-form="center" class="stack" novalidate>
    <h2>Weekly schedule</h2>
    <div class="form-grid">
      <div class="field"><label for="cOpen">Opens</label><input type="time" id="cOpen" name="open" value="${c.open}"></div>
      <div class="field"><label for="cClose">Closes</label><input type="time" id="cClose" name="close" value="${c.close}"></div>
      <div class="field"><label for="cL1">Lunch from</label><input type="time" id="cL1" name="lunchStart" value="${c.lunchStart}"></div>
      <div class="field"><label for="cL2">Lunch until</label><input type="time" id="cL2" name="lunchEnd" value="${c.lunchEnd}"></div>
    </div>
    <fieldset class="field" style="border:0;padding:0;margin:0"><legend class="lbl" style="margin-bottom:6px">Clinic days</legend>
      <div class="btn-row">${[1,2,3,4,5,6,0].map(x => `<label class="check chip"><input type="checkbox" name="day" value="${x}" ${c.days.includes(x)?'checked':''}> ${DOW[x]}</label>`).join('')}</div></fieldset>
    <label class="check"><input type="checkbox" name="autoHolidays" ${c.autoHolidays?'checked':''}> Close automatically on Philippine holidays and Holy Week, every year<span class="tl">No need to set them by hand. Use the calendar for other dates.</span></label>
    <div class="form-grid">
      <div class="field"><label for="cGrace">Void a called number after (minutes)</label><input type="number" id="cGrace" name="grace" min="3" max="60" value="${c.grace}"></div>
      <div class="field"><label for="cNotice">Notice needed for cut-off changes (clinic days)</label><input type="number" id="cNotice" name="noticeDays" min="1" max="14" value="${c.noticeDays}"></div>
      <div class="field"><label for="cForce">Status today</label><select id="cForce" name="force">
        <option value="auto" ${c.force==='auto'?'selected':''}>Automatic (follow schedule)</option><option value="open" ${c.force==='open'?'selected':''}>Force open</option><option value="closed" ${c.force==='closed'?'selected':''}>Force closed</option></select></div>
      <div class="field"><label for="cNote">Reason shown to residents</label><input type="text" id="cNote" name="forceNote" value="${esc(c.forceNote)}" placeholder="e.g. Closed for disinfection"></div>
    </div>
    <label class="check"><input type="checkbox" name="smsOn" ${c.smsOn?'checked':''}> Also send SMS to patients who gave no email<span class="tl">SMS is paid per text. Email is free and always used first.</span></label>
    <label class="check"><input type="checkbox" name="lockSite" ${c.lockSite?'checked':''}> Resident website works only during clinic hours</label>
    <label class="check"><input type="checkbox" name="demo" ${c.demo?'checked':''}> Practice mode: allow queueing at any time (for training and presentations)</label>
    <div class="btn-row"><button class="btn primary" type="submit">Save schedule</button></div>
  </form></section>

  <section class="card stack">
    <div><h2>Calendar · special dates</h2><p class="muted small" style="margin-top:4px">Tap any date to close it, set special hours (for example a half day), or open on a holiday. Holidays and Holy Week are already filled in for every year.</p></div>
    ${calendar()}
    <div><h3 style="margin-bottom:8px">Coming up</h3>
      ${special.length ? `<div class="list">${special.map(x => `<div class="row-between"><div><b>${esc(dateShort(x.date))}</b> <span class="muted small">· ${esc(x.reason)}</span></div><div class="btn-row">${x.hours ? pill('warn', `${fmtT(x.open)} – ${fmtT(x.close)}`, true) : pill(x.auto ? 'info' : 'crit', x.auto ? 'Holiday' : 'Closed', true)}<button class="btn ghost sm" type="button" data-act="calDay" data-date="${x.date}">Change</button></div></div>`).join('')}</div>` : '<p class="muted">No special dates coming up.</p>'}</div>
  </section>
  </div>

  <div class="grid-2" style="margin-top:18px">
  <section class="card stack">
    <div><h2>Queue cut-off times</h2></div>
    <div class="rule-box"><b>Cut-off rule — no sudden cut-offs.</b>
      <ul><li>A change must be set at least <b>${c.noticeDays} clinic day${c.noticeDays>1?'s':''} ahead</b> (earliest: ${esc(dateShort(minDate))}).</li><li>It is posted as an announcement and emailed to patients automatically.</li><li>Only a real <b>emergency</b> may change it at once, and a reason is required.</li></ul></div>
    ${cut ? `<div class="notice crit">${icon('alert')}<div><b>Emergency cut-off is active today</b> (since ${fmt(cut.at)}): ${esc(cut.reason)}.<br><button class="btn ghost sm" type="button" data-act="cutNowUndo" style="margin-top:8px">Reopen today's queue</button></div></div>` : ''}
    <p>Now: <b>${esc(sessionsLabel())}</b></p>
    ${(S.pending||[]).length ? `<div class="list">${S.pending.slice().sort((a,b) => a.effective.localeCompare(b.effective)).map(x => `<div class="row-between"><div>${pill('info','Scheduled',true)} <b>${esc(dateShort(x.effective))}</b>: ${S.center.sessions.map((s,i) => x.sessions[i] ? `${esc(s.name)} ${fmtT(x.sessions[i].start)}–${fmtT(x.sessions[i].cutoff)}` : '').filter(Boolean).join(' · ')}<p class="muted small">${esc(x.reason)}</p></div><button class="btn danger sm" type="button" data-act="pendDel" data-id="${x.id}" data-confirm="Cancel change?">Cancel</button></div>`).join('')}</div>` : ''}
    <form data-form="cutoff" class="stack" novalidate>
      ${c.sessions.map((s,i) => `<div class="form-grid"><div class="field"><label for="ss${i}">${esc(s.name)} starts</label><input type="time" id="ss${i}" name="sStart${i}" value="${s.start}"></div><div class="field"><label for="sc${i}">${esc(s.name)} cut-off</label><input type="time" id="sc${i}" name="sCut${i}" value="${s.cutoff}"></div></div>`).join('')}
      <div class="form-grid">
        <div class="field"><label for="coEff">Starts on</label><input type="date" id="coEff" name="effective" min="${minDate}" value="${minDate}"></div>
        <div class="field"><label for="coReason">Reason (shown to patients)</label><input type="text" id="coReason" name="reason" placeholder="e.g. Doctor's new schedule"></div>
      </div>
      <label class="check"><input type="checkbox" name="emergency"> Emergency — apply now, without notice<span class="tl">Ignores the start date. Patients are notified at once.</span></label>
      <p class="err hide" id="coErr" role="alert"></p>
      <div class="btn-row"><button class="btn primary" type="submit">Schedule change &amp; notify patients</button>${cut ? '' : `<button class="btn danger" type="button" data-act="cutNowAsk">${icon('alert')}Emergency: close today's queue now</button>`}</div>
    </form>
  </section>

  <section class="card"><h2 style="margin-bottom:12px">Services &amp; daily limits</h2>
    <form data-form="services" class="stack" novalidate>
    <div class="table-wrap"><table><thead><tr><th>Service</th><th>Online slots</th><th>Walk-in slots</th><th>Avg. min</th><th>Offered</th></tr></thead><tbody>
    ${S.services.map(s => `<tr><td><b class="mono">${s.code}</b> ${esc(s.name)}<input type="text" name="note-${s.code}" value="${esc(s.note)}" placeholder="Note if not offered" aria-label="${esc(s.name)} note" style="margin-top:6px;min-height:40px;padding:6px 10px;font-size:.88rem"></td>
      <td><input class="inline-num" type="number" min="0" name="limit-${s.code}" value="${s.limit}" aria-label="${esc(s.name)} online slots"></td>
      <td><input class="inline-num" type="number" min="0" name="walkin-${s.code}" value="${s.walkin}" aria-label="${esc(s.name)} walk-in slots"></td>
      <td><input class="inline-num" type="number" min="1" name="avg-${s.code}" value="${s.avg}" aria-label="${esc(s.name)} average minutes"></td>
      <td><input type="checkbox" name="open-${s.code}" ${s.open?'checked':''} aria-label="${esc(s.name)} offered" style="width:26px;height:26px;accent-color:var(--brand)"></td></tr>`).join('')}
    </tbody></table></div>
    <p class="small muted">Walk-in slots are kept for patients who come in person, even when online slots are full. Turning a service off posts an announcement and notifies patients.</p>
    <div class="btn-row"><button class="btn primary" type="submit">Save services</button></div>
    </form></section>
  </div>
  ${dataCard()}`;
}

/* ---------- reports ---------- */
function rpDefault(){ const T = now().date; return { from:addDays(T,-13), to:T, svc:'all', src:'all' }; }
function reportData(){
  const f = rp;
  const list = S.tickets.filter(t => t.date >= f.from && t.date <= f.to && (f.svc === 'all' || t.svc === f.svc) && (f.src === 'all' || t.source === f.src));
  const dates = [...new Set([...list.map(t => t.date), ...Object.keys(S.turned).filter(d => d >= f.from && d <= f.to && f.svc === 'all' && f.src !== 'online')])].sort();
  const turnedTotal = f.svc === 'all' && f.src !== 'online' ? dates.reduce((a,d) => a + (S.turned[d]||0), 0) : 0;
  const hours = Array(9).fill(0); list.forEach(t => { const h = Math.floor(t.cmin/60) - 8; if (h >= 0 && h < 9) hours[h]++; });
  const waits = list.filter(t => t.calledMin != null && t.status !== 'void').map(t => t.calledMin - t.cmin);
  const svcT = list.filter(t => t.doneMin != null && t.calledMin != null).map(t => t.doneMin - t.calledMin);
  const avg = a => a.length ? Math.round(a.reduce((x,y) => x+y, 0) / a.length) : 0;
  const st = k => list.filter(t => t.status === k).length;
  const perDay = dates.map(d => { const L = list.filter(t => t.date === d); return { date:d, total:L.filter(t => t.status !== 'cancelled').length, served:L.filter(t => t.status==='served').length, void:L.filter(t => t.status==='void').length, cancelled:L.filter(t => t.status==='cancelled').length, turned:f.svc==='all' && f.src!=='online' ? (S.turned[d]||0) : 0, prio:L.filter(isPrio).length }; });
  const perSvc = S.services.map(s => { const L = list.filter(t => t.svc === s.code); const w = L.filter(t => t.calledMin != null && t.status !== 'void').map(t => t.calledMin - t.cmin); return { s, total:L.filter(t => t.status!=='cancelled').length, served:L.filter(t => t.status==='served').length, void:L.filter(t => t.status==='void').length, online:L.filter(t => t.source==='online').length, walkin:L.filter(t => t.source==='walkin').length, avg:avg(w) }; }).filter(r => f.svc === 'all' || r.s.code === f.svc);
  // average patients per weekday → the busiest day is the worst day for a day-off
  const byDow = [0,1,2,3,4,5,6].map(w => { const D = perDay.filter(x => dowOf(x.date) === w); return { w, days:D.length, avg:D.length ? Math.round(D.reduce((a,x) => a + x.total + x.turned, 0) / D.length) : 0 }; });
  const peakDow = byDow.filter(x => x.days).sort((a,b) => b.avg - a.avg)[0] || null, quietDow = byDow.filter(x => x.days).sort((a,b) => a.avg - b.avg)[0] || null;
  const concerns = Object.keys(CONCERNS).map(k => ({ k, n:list.filter(t => t.concern === k).length })).filter(x => x.n).sort((a,b) => b.n - a.n);
  return { list, dates, hours, byDow, peakDow, quietDow, concerns, turned:turnedTotal, total:list.filter(t => t.status !== 'cancelled').length, served:st('served'), void:st('void'), cancelled:st('cancelled'), waiting:st('waiting') + st('called') + st('serving'),
    online:list.filter(t => t.source === 'online').length, walkin:list.filter(t => t.source === 'walkin').length, prio:list.filter(isPrio).length,
    avgWait:avg(waits), avgSvc:avg(svcT), perDay, perSvc, stockouts:S.medicines.filter(m => m.status === 'out') };
}
function peakWindow(hours){
  let best = -1, bi = 0;
  for (let i = 0; i < hours.length - 1; i++) { const v = hours[i] + hours[i+1]; if (v > best) { best = v; bi = i; } }
  return best <= 0 ? '—' : `${fmt((8+bi)*60)} – ${fmt((10+bi)*60)}`;
}
function barChart(labels, series, opts){
  const W = opts.w || 460, H = opts.h || 240, L = 34, R = 6, Tp = 18, B = 28;
  const totals = labels.map((_,i) => opts.stacked ? series.reduce((a,s) => a + s.values[i], 0) : Math.max(...series.map(s => s.values[i])));
  const rawMax = Math.max(1, ...totals); const step = rawMax <= 5 ? 1 : rawMax <= 12 ? 2 : rawMax <= 30 ? 5 : rawMax <= 60 ? 10 : rawMax <= 150 ? 25 : 50;
  const max = Math.ceil(rawMax/step)*step; const y = v => Tp + (H-Tp-B) * (1 - v/max);
  const bw = (W-L-R)/labels.length; const barW = Math.min(34, bw*0.64);
  let g = '';
  for (let v = 0; v <= max; v += step) g += `<line x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}" style="stroke:var(--line)" stroke-width="1"/><text x="${L-6}" y="${y(v)+4}" text-anchor="end">${v}</text>`;
  labels.forEach((lb,i) => {
    const cx = L + bw*i + bw/2; let base = 0;
    series.forEach(s => { const v = s.values[i]; if (v > 0) { const top = y(base+v), bot = y(base); g += `<rect x="${cx-barW/2}" y="${top}" width="${barW}" height="${Math.max(0,bot-top)}" rx="3" style="fill:${s.color}${opts.hi!=null && opts.hi!==i ? ';opacity:.5' : ''}"><title>${esc(lb)}: ${v} ${esc(s.name)}</title></rect>`; } base += opts.stacked ? v : 0; });
    if (opts.labelsTop && totals[i]) g += `<text x="${cx}" y="${y(totals[i])-5}" text-anchor="middle" style="fill:var(--ink)">${totals[i]}</text>`;
    if (labels.length <= 14 || i % 2 === 0) g += `<text x="${cx}" y="${H-9}" text-anchor="middle">${esc(lb)}</text>`;
  });
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label)}">${g}</svg></div>`;
}
function reportText(d){
  const f = rp, sv = f.svc === 'all' ? 'All services' : svcBy(f.svc).name, src = { all:'Online and walk-in', online:'Online only', walkin:'Walk-in only' }[f.src];
  return `QUEUE SUMMARY REPORT
Barangay Kaligayahan Health Center
Period:  ${dateShort(f.from)} to ${dateShort(f.to)} (${d.dates.length} clinic days)
Filter:  ${sv} · ${src}

Total patients:        ${d.total + d.turned}
  Online / Walk-in:    ${d.online} / ${d.walkin}
  Priority lane:       ${d.prio}
Served:                ${d.served}
Turned away:           ${d.turned}
No-shows (voided):     ${d.void}
Cancelled:             ${d.cancelled}
Still in queue:        ${d.waiting}
Avg. waiting time:     ${d.avgWait} min
Avg. service time:     ${d.avgSvc} min
Peak period:           ${peakWindow(d.hours)}
Busiest day of week:   ${d.peakDow ? `${DOW_LONG[d.peakDow.w]} (avg ${d.peakDow.avg} patients) - avoid day-offs` : '-'}
Quietest day of week:  ${d.quietDow ? `${DOW_LONG[d.quietDow.w]} (avg ${d.quietDow.avg} patients)` : '-'}
Daily average:         ${d.dates.length ? Math.round((d.total + d.turned) / d.dates.length) : 0} patients
Medicine stock-outs:   ${d.stockouts.length}${d.stockouts.length ? '\n  - ' + d.stockouts.map(m => m.name).join('\n  - ') : ''}`;
}
/* ---------- staffing & surge planner ----------
   Uses monthly history to find months when many more patients come (for example the
   dengue season), so staff schedules, leaves and medicine stock can be prepared ahead. */
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const PREP = { fever:['Paracetamol','Oral Rehydration Salts'], cough:['Carbocisteine','Ambroxol','Lagundi'], bp:['Losartan','Amlodipine'], sugar:['Metformin'], diarrhea:['Oral Rehydration Salts','Zinc Sulfate'], wound:['Tetanus Toxoid','Amoxicillin'], other:[] };
const PER_DOCTOR = 25;     // consultations one doctor can handle in a day
function surgePlan(){
  const T = now().date, ymNow = T.slice(0,7);
  const cur = S.tickets.filter(t => t.date.startsWith(ymNow) && t.status !== 'cancelled'), curDays = new Set(cur.map(t => t.date)).size;
  const curC = {}; Object.keys(CONCERNS).forEach(k => { curC[k] = cur.filter(t => t.concern === k).length; });
  const months = [...(S.monthly || []).filter(x => x.ym < ymNow).slice(-12)];
  if (curDays) months.push({ ym:ymNow, days:curDays, avg:Math.round(cur.length / curDays), total:cur.length, concerns:curC, live:true });
  const sorted = months.map(x => x.avg).sort((a,b) => a - b), normal = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0;
  const docs = avg => Math.max(1, Math.ceil(avg * 0.45 / PER_DOCTOR));
  months.forEach(x => {
    x.pct = normal ? Math.round((x.avg / normal - 1) * 100) : 0; x.surge = normal > 0 && x.avg >= normal * 1.25;
    const top = Object.entries(x.concerns || {}).sort((a,b) => b[1] - a[1])[0]; x.top = top ? top[0] : 'other';
    const all = Object.values(x.concerns || {}).reduce((a,b) => a + b, 0); x.topShare = all && top ? Math.round(top[1] / all * 100) : 0;
    x.docs = docs(x.avg); x.label = MONTH_NAMES[+x.ym.slice(5) - 1];
  });
  // the next calendar month that was a surge month last year
  const surgeMonths = new Set(months.filter(x => x.surge).map(x => +x.ym.slice(5)));
  let next = null; const [y, m] = ymd(T);
  for (let i = 1; i <= 12 && !next; i++) { const d = new Date(Date.UTC(y, m - 1 + i, 1)); if (surgeMonths.has(d.getUTCMonth() + 1)) next = { label:`${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`, inMonths:i, ref:months.find(x => +x.ym.slice(5) === d.getUTCMonth() + 1) }; }
  return { months, normal, normalDocs:docs(normal), next, now:months.find(x => x.ym === ymNow) };
}
function plannerHtml(){
  const p = surgePlan(), surges = p.months.filter(x => x.surge);
  if (!p.months.length) return `<section class="card" style="margin-top:18px"><h2>Staffing &amp; surge planner</h2><p class="muted" style="margin-top:8px">No monthly history yet. The planner fills in as queue records are collected.</p></section>`;
  const prepList = k => PREP[k].map(n => { const m = S.medicines.find(x => x.name.startsWith(n)); return m ? `${esc(m.name)} <span class="muted">(${m.stock}/${m.cap})</span>` : esc(n); }).join(', ') || 'usual stock';
  return `<section class="card" style="margin-top:18px"><div class="card-head"><div><h2>Staffing &amp; surge planner</h2><p class="muted small" style="margin-top:4px">Average patients per day, month by month. A month is a <b>surge</b> when it is at least 25% above a normal month (${p.normal} patients/day).</p></div>
      <span class="small"><span class="pill plain" style="background:var(--brand-soft);color:var(--brand-deep)">Normal</span> <span class="pill crit plain">Surge</span></span></div>
    ${barChart(p.months.map(x => x.label.slice(0,3) + (x.live ? '*' : '')), [{ name:'patients/day (normal)', values:p.months.map(x => x.surge ? 0 : x.avg), color:'var(--brand)' },{ name:'patients/day (surge)', values:p.months.map(x => x.surge ? x.avg : 0), color:'var(--crit)' }], { label:'Average patients per day by month', stacked:true, labelsTop:true, h:220 })}
    <p class="small muted">* this month so far. All months are counted from the queue records.</p>
    ${p.now && p.now.surge ? `<div class="notice crit" style="margin-top:12px">${icon('alert')}<div><b>Surge month now:</b> ${p.now.avg} patients/day (${p.now.pct > 0 ? '+' : ''}${p.now.pct}% vs normal), mostly ${esc(CONCERNS[p.now.top].toLowerCase())}. Avoid approving leaves this month.</div></div>` : ''}
    ${p.next ? `<div class="notice warn" style="margin-top:12px">${icon('cal')}<div><b>Next expected surge: ${esc(p.next.label)}</b> (in ${p.next.inMonths} month${p.next.inMonths>1?'s':''}). Last time: about ${p.next.ref.avg} patients/day, mostly ${esc(CONCERNS[p.next.ref.top].toLowerCase())}. Prepare schedules and stock at least one month before.</div></div>` : ''}
    ${surges.length ? `<div class="table-wrap" style="margin-top:14px"><table><thead><tr><th>Surge month</th><th>Patients / day</th><th>Vs normal</th><th>Main reason for visit</th><th>Doctors needed / day</th><th>Prepare</th></tr></thead><tbody>
      ${surges.map(x => `<tr><td><b>${esc(x.label)} ${x.ym.slice(0,4)}</b></td><td class="num">${x.avg}</td><td class="num"><b style="color:var(--crit)">+${x.pct}%</b></td><td>${esc(CONCERNS[x.top])}<span class="sub">${x.topShare}% of check-ups</span></td>
        <td class="num"><b>${x.docs}</b> <span class="muted small">(normal ${p.normalDocs})</span></td><td class="small">${x.docs > p.normalDocs ? `Add ${x.docs - p.normalDocs} doctor${x.docs - p.normalDocs > 1 ? 's' : ''} on duty · ` : ''}no leaves on peak days · raise online slots<br>Stock up: ${prepList(x.top)}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="small muted" style="margin-top:8px">Doctors needed = check-ups per day (about 45% of patients) ÷ ${PER_DOCTOR} per doctor.</p>` : '<p class="muted" style="margin-top:10px">No surge months found in the history.</p>'}
  </section>`;
}
function dowHtml(d){
  if (!d.peakDow) return '<p class="muted">No data for these dates.</p>';
  const rows = d.byDow.filter(x => x.days), onPeak = S.doctors.filter(x => x.days.includes(d.peakDow.w));
  return `${barChart(rows.map(x => DOW[x.w]), [{ name:'patients (average)', values:rows.map(x => x.avg), color:'var(--brand)' }], { label:'Average patients by day of the week', labelsTop:true, hi:rows.findIndex(x => x.w === d.peakDow.w), h:200 })}
    <div class="notice warn" style="margin-top:10px">${icon('alert')}<div><b>${DOW_LONG[d.peakDow.w]} is the busiest day</b> (about ${d.peakDow.avg} patients). It is not a good day for a day-off or leave.${onPeak.length ? ` On duty that day: ${onPeak.map(x => esc(x.name)).join(', ')}.` : ''}${d.quietDow && d.quietDow.w !== d.peakDow.w ? ` Best day for a day-off: <b>${DOW_LONG[d.quietDow.w]}</b> (about ${d.quietDow.avg}).` : ''}</div></div>`;
}
function aReports(){
  if (!rp) rp = rpDefault();
  const d = reportData();
  const hrLabels = ['8AM','9AM','10AM','11AM','12PM','1PM','2PM','3PM','4PM'];
  const peakIdx = d.hours.indexOf(Math.max(...d.hours));
  const days = d.perDay.slice(-14);
  return `<div class="page-head"><div><div class="eyebrow">Reports</div><h1>Summary report</h1><p>Choose dates and a service, then download the itemized report for submission.</p></div>
    <div class="btn-row no-print"><button class="btn primary" data-act="csvItems" type="button">${icon('download')}Itemized (CSV)</button><button class="btn ghost" data-act="csvDaily" type="button">${icon('download')}Daily summary (CSV)</button><button class="btn ghost" data-act="print" type="button">${icon('print')}Print / PDF</button></div></div>
  <form data-form="report" class="card form-grid no-print" style="margin-bottom:18px;align-items:end" novalidate>
    <div class="field"><label for="rFrom">From</label><input type="date" id="rFrom" name="from" value="${rp.from}"></div>
    <div class="field"><label for="rTo">To</label><input type="date" id="rTo" name="to" value="${rp.to}"></div>
    <div class="field"><label for="rSvc">Service</label><select id="rSvc" name="svc"><option value="all">All services</option>${S.services.map(s => `<option value="${s.code}" ${rp.svc===s.code?'selected':''}>${esc(s.name)}</option>`).join('')}</select></div>
    <div class="field"><label for="rSrc">Source</label><select id="rSrc" name="src"><option value="all">Online &amp; walk-in</option><option value="online" ${rp.src==='online'?'selected':''}>Online</option><option value="walkin" ${rp.src==='walkin'?'selected':''}>Walk-in</option></select></div>
    <div class="btn-row"><button class="btn primary" type="submit">Apply</button><button class="btn ghost sm" type="button" data-act="rpQuick" data-v="0">Today</button><button class="btn ghost sm" type="button" data-act="rpQuick" data-v="6">7 days</button><button class="btn ghost sm" type="button" data-act="rpQuick" data-v="29">30 days</button></div>
  </form>
  <div class="kpis" style="--cols:5">
    ${kpi(d.total + d.turned, 'Total patients')}
    ${kpi(d.served, 'Served')}
    ${kpi(d.turned, 'Turned away', d.turned > 0)}
    ${kpi(d.void, 'No-shows (voided)', d.void > 0)}
    ${kpi(d.online + ' / ' + d.walkin, 'Online / walk-in')}
    ${kpi(d.avgWait + '<span class="muted" style="font-size:1rem"> min</span>', 'Avg. waiting time')}
    ${kpi(peakWindow(d.hours).replace(/:00/g,''), 'Peak period')}
    ${kpi(d.peakDow ? DOW_LONG[d.peakDow.w] : '—', 'Busiest day (avoid day-offs)')}
    ${kpi(d.prio, 'Priority lane (senior, PWD, pregnant)')}
    ${kpi(d.stockouts.length, 'Medicine stock-outs', d.stockouts.length > 0)}
  </div>
  <div class="grid-2">
    <section class="card"><div class="card-head"><h2>Arrivals by hour</h2><span class="small muted">Peak: <b style="color:var(--ink)">${peakWindow(d.hours)}</b></span></div>
      ${barChart(hrLabels, [{ name:'patients', values:d.hours, color:'var(--brand)' }], { label:'Patients who got a queue number per hour', labelsTop:true, hi:Math.max(...d.hours) > 0 ? peakIdx : null })}</section>
    <section class="card"><div class="card-head"><h2>Patients per day</h2><span class="small"><span class="pill plain" style="background:var(--brand-soft);color:var(--brand-deep)">Served</span> <span class="pill crit plain">Voided</span> <span class="pill warn plain">Turned away</span></span></div>
      ${days.length ? barChart(days.map(x => x.date === now().date ? 'Today' : `${+x.date.slice(5,7)}/${+x.date.slice(8)}`), [{ name:'served', values:days.map(x => x.served), color:'var(--brand)' },{ name:'voided', values:days.map(x => x.void), color:'var(--crit)' },{ name:'turned away', values:days.map(x => x.turned), color:'#D98A00' }], { label:'Served, voided and turned away per day', stacked:true, labelsTop:true }) : '<p class="muted">No data for these dates.</p>'}</section>
  </div>
  <div class="grid-2" style="margin-top:18px">
    <section class="card"><div class="card-head"><h2>Busiest day of the week</h2><span class="small muted">For day-off and leave decisions</span></div>${dowHtml(d)}</section>
    <section class="card"><div class="card-head"><h2>Reasons for visit</h2><span class="small muted">General check-up only</span></div>
      ${d.concerns.length ? `<div class="list">${d.concerns.map(x => { const tot = d.concerns.reduce((a,b) => a + b.n, 0), pc = Math.round(x.n / tot * 100); return `<div><div class="row-between"><b>${esc(CONCERNS[x.k])}</b><span class="num">${x.n} · ${pc}%</span></div><div class="med-bar" style="margin-top:6px"><i style="width:${pc}%;background:var(--brand)"></i></div></div>`; }).join('')}</div>` : '<p class="muted">No check-up records for these filters.</p>'}
    </section>
  </div>
  ${plannerHtml()}
  <div class="grid-2" style="margin-top:18px">
    <section class="card"><div class="card-head"><h2>By service</h2></div>
      <div class="table-wrap"><table><thead><tr><th>Service</th><th>Total</th><th>Served</th><th>No-show</th><th>Online / walk-in</th><th>Avg. wait</th></tr></thead><tbody>
      ${d.perSvc.map(r => `<tr><td>${esc(r.s.name)}</td><td class="num">${r.total}</td><td class="num">${r.served}</td><td class="num">${r.void}</td><td class="num">${r.online} / ${r.walkin}</td><td class="num">${r.total ? r.avg + ' min' : '—'}</td></tr>`).join('')}
      </tbody></table></div></section>
    <section class="card"><div class="card-head"><h2>Report preview</h2><button class="btn ghost sm no-print" data-act="copyReport" type="button">Copy</button></div><pre class="report" id="reportText">${esc(reportText(d))}</pre></section>
  </div>
  <section class="card" style="margin-top:18px"><div class="card-head"><h2>Daily breakdown</h2></div>
    <div class="table-wrap"><table><thead><tr><th>Date</th><th>Patients</th><th>Served</th><th>No-show</th><th>Cancelled</th><th>Turned away</th><th>Priority</th></tr></thead><tbody>
    ${d.perDay.length ? d.perDay.slice().reverse().map(x => `<tr><td>${esc(dateShort(x.date))}</td><td class="num">${x.total + x.turned}</td><td class="num">${x.served}</td><td class="num">${x.void}</td><td class="num">${x.cancelled}</td><td class="num">${x.turned}</td><td class="num">${x.prio}</td></tr>`).join('') : '<tr><td colspan="7" class="empty">No data for these dates.</td></tr>'}
    </tbody></table></div></section>`;
}

function viewAdmin(){
  const u = currentUser(); if (!u) return viewLogin();
  const V = { dash:aDash, queue:aQueue, appts:aAppts, doctors:aDoctors, meds:aMeds, ann:aAnn, sms:aSms, reports:aReports, settings:aSettings, users:aUsers, account:aAccount };
  const tabs = TABS.filter(([k]) => can(k) && (!u.mustChange || k === 'account')); if (!tabs.some(([k]) => k === adminTab)) adminTab = tabs[0][0];
  const badges = { queue:todayTickets().filter(t => t.status === 'called').length, meds:S.medRequests.filter(r => r.status === 'pending').length };
  return `
  ${u.mustChange && adminTab !== 'account' ? `<div class="notice warn" style="margin-bottom:14px">${icon('alert')}<div><b>You are using a default or temporary password.</b> Please change it now. <button class="link-btn" type="button" data-act="aTab" data-v="account">Change my password</button></div></div>` : ''}
  <div class="admin-shell">
    <nav class="side" aria-label="Staff sections">
      <div class="who">${icon('person')}<div><b>${esc(u.name)}</b><span>${esc(ROLES[u.role].label)}</span></div></div>
      ${tabs.map(([k,ic,l]) => `<button type="button" data-act="aTab" data-v="${k}" ${adminTab===k?'aria-current="page"':''}>${icon(ic)}${l}${badges[k] ? `<span class="badge-n">${badges[k]}</span>` : ''}</button>`).join('')}
      <button type="button" data-act="logout">${icon('logout')}Log out</button></nav>
    <div>${(V[adminTab] || aDash)()}</div></div>`;
}

/* ---------- my account / staff accounts ---------- */
function aAccount(){
  const u = currentUser();
  return `<div class="page-head"><div><div class="eyebrow">My account</div><h1>${esc(u.name)}</h1><p>Signed in as <b>${esc(u.user)}</b> · ${esc(ROLES[u.role].label)}</p></div></div>
  <section class="card" style="max-width:560px"><h2 style="margin-bottom:12px">Change password</h2>
    <form data-form="pwChange" class="stack" novalidate>
      <div class="field"><label for="pwOld">Current password</label><input type="password" id="pwOld" name="old" autocomplete="current-password"></div>
      <div class="field"><label for="pwNew">New password</label><input type="password" id="pwNew" name="pw" autocomplete="new-password"><span class="hint">At least 10 characters, with letters and numbers.</span></div>
      <div class="field"><label for="pwNew2">Type the new password again</label><input type="password" id="pwNew2" name="pw2" autocomplete="new-password"></div>
      <p class="err hide" id="pwErr" role="alert"></p>
      <button class="btn primary" type="submit">Save new password</button>
    </form></section>`;
}
function aUsers(){
  const me = currentUser();
  return `<div class="page-head"><div><div class="eyebrow">Staff accounts</div><h1>Who can log in</h1><p>Each person should have their own account. Roles decide which sections they see.</p></div></div>
  <div class="grid-2">
    <section class="card"><div class="table-wrap"><table class="compact"><thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead><tbody>
      ${S.users.map(u => `<tr><td><b>${esc(u.name)}</b><span class="sub">${esc(u.user)}${u.id === me.id ? ' · you' : ''}</span></td>
        <td><select data-change="userRole" data-id="${u.id}" aria-label="Role of ${esc(u.name)}" style="min-height:38px;padding:5px 8px">${Object.entries(ROLES).map(([k,r]) => `<option value="${k}" ${u.role===k?'selected':''}>${r.label}</option>`).join('')}</select></td>
        <td>${u.mustChange ? pill('warn','Must change password',true) : pill('ok','Active',true)}</td>
        <td><div class="act"><button class="btn ghost sm" type="button" data-act="userReset" data-id="${u.id}" data-confirm="Reset password?">Reset password</button>${u.id === me.id ? '' : `<button class="btn danger sm" type="button" data-act="userDel" data-id="${u.id}" data-confirm="Remove?">Remove</button>`}</div></td></tr>`).join('')}
    </tbody></table></div>
    <div class="small muted" style="margin-top:12px">${Object.values(ROLES).map(r => `<p><b>${r.label}:</b> ${r.tabs.filter(t => t !== 'account').map(t => (TABS.find(x => x[0] === t) || [, , t])[2]).join(', ')}</p>`).join('')}</div></section>
    <section class="card"><h2 style="margin-bottom:12px">Add a staff account</h2>
      <form data-form="userAdd" class="stack" novalidate>
        <div class="field"><label for="uaName">Full name</label><input type="text" id="uaName" name="name" placeholder="Lorna Bautista"></div>
        <div class="field"><label for="uaUser">Username</label><input type="text" id="uaUser" name="user" placeholder="lorna" autocapitalize="none" spellcheck="false"><span class="hint">3 to 20 small letters, numbers or dots.</span></div>
        <div class="field"><label for="uaRole">Role</label><select id="uaRole" name="role">${Object.entries(ROLES).map(([k,r]) => `<option value="${k}">${r.label}</option>`).join('')}</select></div>
        <p class="err hide" id="uaErr" role="alert"></p>
        <button class="btn primary" type="submit">${icon('plus')}Create account</button>
        <p class="small muted">A temporary password is shown once. The person must change it when they first log in.</p>
      </form></section>
  </div>`;
}
const tempPwModal = (u, pw) => `<h2>Temporary password</h2><p>Give this to <b>${esc(u.name)}</b> (username <b class="mono">${esc(u.user)}</b>). It is shown only once.</p>
  <p class="temp-pw mono">${esc(pw)}</p><p class="small muted">They will be asked to choose a new password when they log in.</p>
  <div class="btn-row" style="margin-top:12px"><button class="btn primary" type="button" data-act="closeModal">Done</button></div>`;

/* ---------- data & backup (Settings) ---------- */
let pendingRestore = null;
let SYS = null, sysLoading = false, showXlsPw = false, MSGSET = null;
function loadSys(){
  if (sysLoading) return; sysLoading = true;
  api('/api/staff/system').then(j => { SYS = j; return api('/api/staff/messaging'); }).then(j => { MSGSET = j; }).catch(e => { SYS = SYS || { error:e.message }; })
    .finally(() => { sysLoading = false; if (route() === 'admin' && adminTab === 'settings') render(); });   // dialogs are separate from the page, so this is safe
}
const whenMs = ms => ms ? new Date(ms).toLocaleString('en-PH', { timeZone:TZ, month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit' }) : '—';
function serverDataCard(){
  const head = `<div class="card-head"><h2>Database, backups &amp; live Excel</h2>`;
  if (!SYS) { loadSys(); return `<section class="card" style="margin-top:18px">${head}</div><p class="muted">Loading…</p></section>`; }
  if (SYS.error) return `<section class="card" style="margin-top:18px">${head}</div><p class="err">${esc(SYS.error)}</p></section>`;
  const b = SYS.backup, x = SYS.excel, a = SYS.audit, k = b.kinds || {};
  const lastB = b.last ? `${whenMs(b.last.at)} (${b.last.kind})` : (k.hourly && k.hourly.latest ? k.hourly.latest.replace(/^bkhc-\w+-|\.bkhc$/g, '').replace('_', ' ') : 'Not yet');
  return `<section class="card sys-card" style="margin-top:18px">${head}${a.ok ? pill('ok','Protected',true) : pill('crit','Check the activity log',true,'lg')}</div>
    <div class="sys-grid">
      <div class="sys-box"><h3>${icon('idcard','',2.4)}Secure database</h3>
        <ul class="sys-list">
          <li>${pill('ok','On',true)} Names, mobile numbers, emails, addresses and ticket codes are <b>encrypted</b> (AES-256).</li>
          <li>${pill('ok','On',true)} Staff passwords are stored as <b>Argon2</b> hashes; sessions end after 30 minutes idle.</li>
          <li>${a.ok ? pill('ok','Verified',true) : pill('crit','Changed!',true)} Activity log: ${a.entries.toLocaleString()} entries${a.ok ? ', nothing was altered' : `, broken at entry #${a.broken_at}`}.</li>
        </ul>
        <p class="small muted">${SYS.db.kind === 'supabase' ? `Stored on <b>Supabase</b>${SYS.db.region ? ' (' + esc(SYS.db.region) + ')' : ''}: private schema, row-level security, encrypted connection, with a working copy on this computer for fast reading` : 'Stored on this computer'} · ${SYS.db.size_kb.toLocaleString()} KB · ${SYS.https ? 'HTTPS on' : 'this computer only'}</p>
        <button class="btn ghost sm" type="button" data-act="sysAudit">View activity log</button></div>
      <div class="sys-box"><h3>${icon('download','',2.4)}Automatic backups</h3>
        <p>Last backup: <b>${esc(lastB)}</b></p>
        <p class="small">Kept: ${['hourly','daily','monthly'].map(t => `${(k[t] || {}).count || 0} ${t}`).join(' · ')} · ${b.total_mb} MB, encrypted</p>
        <p class="small muted mono" style="word-break:break-all">${esc(b.folder)}</p>
        ${b.mirror ? `<p class="small">Second copy: <span class="mono">${esc(b.mirror)}</span></p>` : '<p class="small muted">Tip: add a USB drive as a second backup folder in config.json.</p>'}
        ${b.last_error ? `<p class="err">${esc(b.last_error)}</p>` : ''}${b.mirror_error ? `<p class="err">${esc(b.mirror_error)}</p>` : ''}
        ${b.drill ? `<p class="small">${b.drill.ok ? pill('ok','Restore test passed',true) : pill('crit','Restore test failed',true)} ${esc(whenMs(b.drill.at))}</p>` : '<p class="small muted">Tip: test that a backup really opens once a month.</p>'}
        <div class="btn-row"><button class="btn primary sm" type="button" data-act="backupNow">Back up now</button><button class="btn ghost sm" type="button" data-act="backupTest">Test the latest backup</button><button class="btn ghost sm" type="button" data-act="backup">${icon('download')}Download a copy</button>
          <label class="btn ghost sm" for="restoreFile">Restore</label><input type="file" id="restoreFile" class="sr" accept=".json,application/json" data-change="restore"></div></div>
      <div class="sys-box sys-wide"><h3>${icon('chart','',2.4)}Live Excel</h3>
        <p>Workbook: <span class="mono small" style="word-break:break-all">${esc(x.file)}</span></p>
        <p>${x.waiting ? pill('warn','Waiting',true) + ' The file is open in Excel. It updates when it is closed.' : x.written ? pill('ok','Up to date',true) + ` Updated ${esc(whenMs(x.written))} · ${(x.rows || 0).toLocaleString()} rows` : 'Preparing…'}${x.error ? ` <span class="err">${esc(x.error)}</span>` : ''}</p>
        ${x.password ? `<p>File password: <b class="mono">${showXlsPw ? esc(x.password) : '••••-••••-••••-••••'}</b> <button class="link-btn" type="button" data-act="toggleXlsPw">${showXlsPw ? 'Hide' : 'Show'}</button>${showXlsPw ? ` · <button class="link-btn" type="button" data-act="copyText" data-v="${esc(x.password)}">Copy</button>` : ''}</p>` : ''}
        <details class="feed"><summary><b>Live link for Excel</b> (updates every minute while Excel is open)</summary>
          <ol class="small"><li>In Excel: <b>Data → From Web</b>, paste a link below, then <b>Load</b>.</li><li><b>Data → Queries &amp; Connections</b>, right-click the query → <b>Properties</b> → tick <b>Refresh every 1 minutes</b>.</li></ol>
          <div class="feed-list">${x.feeds.map(f => `<div class="row-between"><span>${esc(f.name)}</span><button class="btn ghost sm" type="button" data-act="copyText" data-v="${esc(f.html)}">Copy link</button></div>`).join('')}</div>
          <p class="small muted">The links contain a secret key and work only on this computer${x.remote ? ' and the clinic network' : ''}. <button class="link-btn" type="button" data-act="feedKey" data-confirm="Tap again to change the key">Change the key</button> if a link was shared by mistake.</p>
        </details></div>
    </div>
    ${messagingBox()}
  </section>`;
}
// Email and text-message (SMS) sending: entered here by an administrator, saved on the server.
function messagingBox(){
  if (!MSGSET) return '';
  const e = MSGSET.email, s = MSGSET.sms, st = MSGSET.status || {};
  return `<div class="sys-box sys-wide" style="margin-top:14px"><h3>${icon('sms','',2.4)}Email &amp; text messages</h3>
    <p class="small muted">Patients get their queue number, a "your turn is near" notice and schedule changes by email (free). Text messages (SMS) cost money per text and need an account with an SMS gateway.</p>
    <div class="grid-2" style="margin-top:8px">
      <form data-form="mailSet" class="stack" novalidate>
        <div class="row-between"><b>Email</b>${e.on ? pill('ok','On',true) : pill('warn','Off',true)}</div>
        <div class="form-grid">
          <div class="field"><label for="mHost">Mail server</label><input type="text" id="mHost" name="host" value="${esc(e.host)}" placeholder="smtp.gmail.com" autocomplete="off" spellcheck="false"></div>
          <div class="field"><label for="mPort">Port</label><input type="number" id="mPort" name="port" value="${e.port}" min="1" max="65535"></div>
          <div class="field"><label for="mUser">Username</label><input type="text" id="mUser" name="user" value="${esc(e.user)}" placeholder="kaligayahan.hc@gmail.com" autocomplete="off" spellcheck="false"></div>
          <div class="field"><label for="mPass">Password${e.passwordSet ? ' (saved)' : ''}</label><input type="password" id="mPass" name="password" placeholder="${e.passwordSet ? 'Leave blank to keep the saved one' : 'App password'}" autocomplete="new-password"></div>
          <div class="field" style="grid-column:1/-1"><label for="mFrom">Send from (email address)</label><input type="email" id="mFrom" name="sender" value="${esc(e.from)}" placeholder="kaligayahan.hc@gmail.com"></div>
        </div>
        <label class="check"><input type="checkbox" name="starttls" ${e.starttls ? 'checked' : ''}> Secure connection (STARTTLS) — keep on</label>
        <p class="small muted">Gmail: turn on 2-Step Verification, then create an <b>App password</b> (Google Account → Security → App passwords) and use it here, with server <span class="mono">smtp.gmail.com</span>, port <span class="mono">587</span>.</p>
        <p class="err hide" id="mErr" role="alert"></p>
        <div class="btn-row"><button class="btn primary sm" type="submit">Save email settings</button>${e.host ? '<button class="btn ghost sm" type="button" data-act="mailOff" data-confirm="Tap again to turn email off">Turn off</button>' : ''}</div>
        ${st.last_error ? `<p class="err">${esc(st.last_error)}</p>` : st.sent ? `<p class="small muted">${st.sent} sent since the server started.</p>` : ''}
      </form>
      <form data-form="smsSet" class="stack" novalidate>
        <div class="row-between"><b>Text messages (SMS)</b>${s.on ? pill('ok','On',true) : pill('warn','Off',true)}</div>
        <div class="field"><label for="sProv">SMS gateway</label><select id="sProv" name="provider"><option value="" ${!s.provider ? 'selected' : ''}>None (off)</option><option value="semaphore" ${s.provider === 'semaphore' ? 'selected' : ''}>Semaphore (semaphore.co)</option></select></div>
        <div class="field"><label for="sKey">API key${s.keySet ? ' (saved)' : ''}</label><input type="password" id="sKey" name="api_key" placeholder="${s.keySet ? 'Leave blank to keep the saved one' : 'From your Semaphore account'}" autocomplete="new-password"></div>
        <div class="field"><label for="sSender">Sender name (optional, max 11 letters, approved by Semaphore)</label><input type="text" id="sSender" name="sender" value="${esc(s.sender)}" maxlength="11" placeholder="BKHC"></div>
        <p class="small muted">Texts are only sent to patients who gave a mobile number but no email, and only when "Also send SMS to patients who gave no email" is ticked in the weekly schedule settings above.</p>
        <p class="err hide" id="sErr" role="alert"></p>
        <div class="btn-row"><button class="btn primary sm" type="submit">Save SMS settings</button></div>
        ${st.sms_last_error ? `<p class="err">${esc(st.sms_last_error)}</p>` : ''}
      </form>
    </div>
    <form data-form="tsSet" class="stack" style="margin-top:14px" novalidate>
      <div class="row-between"><b>"I am not a robot" check (Cloudflare Turnstile)</b>${MSGSET.turnstile && MSGSET.turnstile.on ? pill('ok','On',true) : pill('neutral','Off',true)}</div>
      <p class="small muted">A built-in anti-bot check is always on. For stronger protection on the public internet, create a free Turnstile widget in a Cloudflare account (for your website address) and paste its two keys here. Residents then tick a box before booking.</p>
      <div class="form-grid"><div class="field"><label for="tsSite">Site key</label><input type="text" id="tsSite" name="site_key" value="${esc((MSGSET.turnstile || {}).siteKey || '')}" autocomplete="off" spellcheck="false"></div>
        <div class="field"><label for="tsSecret">Secret key${(MSGSET.turnstile || {}).secretSet ? ' (saved)' : ''}</label><input type="password" id="tsSecret" name="secret" placeholder="${(MSGSET.turnstile || {}).secretSet ? 'Leave blank to keep the saved one' : 'Secret key'}" autocomplete="new-password"></div></div>
      <p class="err hide" id="tsErr" role="alert"></p>
      <div class="btn-row"><button class="btn primary sm" type="submit">Save</button></div>
    </form>
    <form data-form="msgTest" class="btn-row" style="margin-top:12px" novalidate><label class="sr" for="tTo">Send a test to</label><input type="text" id="tTo" name="to" placeholder="Your email or mobile number" style="flex:1 1 220px" autocomplete="off"><button class="btn ghost sm" type="submit">Send a test</button></form>
  </div>`;
}
function auditModal(j){
  return `<h2>Activity log</h2><p class="small">${j.check.ok ? pill('ok','Verified',true) + ' Every entry is linked to the one before it, so a deleted or changed entry would show here.' : pill('crit','Altered',true) + ` The log was changed at entry #${j.check.broken_at}.`}</p>
    <div class="table-wrap" style="max-height:55vh;overflow:auto;margin-top:10px"><table class="compact"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr></thead><tbody>
    ${j.entries.slice(0, 150).map(e => `<tr><td class="small">${esc(whenMs(e.ts))}</td><td>${esc(e.actor || '—')}</td><td>${esc(e.action)}</td><td class="small">${esc([e.target, e.detail].filter(Boolean).join(' · ').slice(0, 220))}</td></tr>`).join('')}
    </tbody></table></div><div class="btn-row" style="margin-top:12px"><button class="btn primary" type="button" data-act="closeModal">Close</button></div>`;
}
function dataCard(){
  if (SERVER.on) return serverDataCard();
  const used = storageUsed(), cap = 5 * 1024 * 1024, pct = Math.min(100, Math.round(used / cap * 100));
  return `<section class="card" style="margin-top:18px"><div class="card-head"><h2>Data &amp; backup</h2>${saveFailed ? pill('crit','Not saving!',true,'lg') : pill('ok','Saving normally',true)}</div>
    <div class="grid-2">
      <div class="stack">
        <div><div class="row-between small"><span>Storage used on this device</span><b>${Math.round(used/1024).toLocaleString()} KB of about 5,120 KB (${pct}%)</b></div>
          <div class="med-bar" style="margin-top:6px"><i style="width:${Math.max(1, pct)}%;background:${pct > 80 ? 'var(--crit)' : 'var(--brand)'}"></i></div></div>
        <p class="small muted">Cleaned up automatically every day: personal details are removed from records older than ${KEEP_PERSONAL_DAYS} days (counts stay for reports), records older than ${KEEP_RECORD_DAYS} days and messages older than ${KEEP_MESSAGE_DAYS} days are deleted.</p>
        <div class="btn-row"><button class="btn primary" type="button" data-act="backup">${icon('download')}Download backup</button>
          <label class="btn ghost" for="restoreFile">Restore from backup</label><input type="file" id="restoreFile" class="sr" accept=".json,application/json" data-change="restore"></div>
        <p class="small muted">Download a backup at least once a week and keep it somewhere safe. The backup holds personal data, so do not share it.</p>
      </div>
    </div></section>`;
}

/* ---------- walk-in registration (staff) ---------- */
function walkinForm(err, d){
  d = d || { svc:qSvc, prio:'regular' };
  return `<h2>Register walk-in patient</h2>
  <form data-form="walkin" class="stack" novalidate>
    <div class="form-grid">
      <div class="field"><label for="wSvc">Service</label><select id="wSvc" name="svc">${S.services.filter(s => s.open).map(s => { const c = counts(s.code); return `<option value="${s.code}" ${d.svc===s.code?'selected':''}>${esc(s.name)} — walk-in ${c.walkin}/${s.walkin}</option>`; }).join('')}</select></div>
      <div class="field"><label for="wPrio">Patient type</label><select id="wPrio" name="prio">${Object.keys(PRIO).map(k => `<option value="${k}" ${d.prio===k?'selected':''}>${PRIO[k]}</option>`).join('')}</select></div>
      <div class="field"><label for="wName">Full name</label><input type="text" id="wName" name="name" value="${esc(d.name||'')}"></div>
      <div class="field"><label for="wAge">Age</label><input type="number" id="wAge" name="age" min="0" max="120" value="${esc(d.age||'')}"></div>
      <div class="field"><label for="wContact">Mobile (optional)</label><input type="tel" id="wContact" name="contact" placeholder="09XX XXX XXXX" value="${esc(d.contact||'')}"></div>
      <div class="field"><label for="wEmail">Email (optional)</label><input type="email" id="wEmail" name="email" placeholder="for free updates" value="${esc(d.email||'')}"></div>
      <div class="field"><label for="wAddr">Purok / Street</label><input type="text" id="wAddr" name="address" value="${esc(d.address||'')}"></div>
    </div>
    <label class="check"><input type="checkbox" name="idOk" ${d.idOk?'checked':''}> Priority ID already checked at the desk</label>
    <label class="check"><input type="checkbox" name="override" ${d.override?'checked':''}> Accept even if walk-in slots are full</label>
    ${err ? `<p class="err" role="alert">${esc(err)}</p>` : ''}
    <div class="btn-row"><button class="btn primary" type="submit">Give queue number</button><button class="btn ghost" type="button" data-act="closeModal">Cancel</button></div>
  </form>`;
}
function slipHtml(t){
  const s = svcBy(t.svc);
  return `<div class="slip"><b>Barangay Kaligayahan Health Center</b><span class="small">${esc(dateLong(t.date))} · ${fmt(t.cmin)}</span>
    <span class="eyebrow">${esc(s.name)}</span><div class="big">${esc(t.num)}</div>${pill(isPrio(t)?'prio':'neutral', PRIO[t.prio], true)}
    <span>${esc(t.name)}</span><span class="small">Code <b class="mono">${esc(t.code)}</b> · ${lineFor(t.svc).findIndex(x => x.id === t.id)} ahead</span>
    <span class="small muted">Check your number at kaligayahan health center website · My ticket</span></div>
  <div class="btn-row no-print" style="margin-top:14px;justify-content:center"><button class="btn primary" type="button" data-act="printSlip">${icon('print')}Print slip</button><button class="btn ghost" type="button" data-act="closeModal">Close</button></div>`;
}

/* =========================================================
   ACTIONS, FORMS, ROUTING
   ========================================================= */
function toast(msg){
  const r = $('#toastRoot'); r.innerHTML = `<div class="toast" role="status">${esc(msg)}</div>`;
  clearTimeout(toast.t); toast.t = setTimeout(() => r.innerHTML = '', 3200);
}
let lastFocus = null;
function openModal(html){
  if (!$('#modalRoot').innerHTML) lastFocus = document.activeElement;
  $('#modalRoot').innerHTML = `<div class="modal-bg" data-act="bgClose"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">${html}</div></div>`;
  const h = $('#modalRoot h2'); if (h) h.id = 'modalTitle';
  const f = $('#modalRoot input, #modalRoot select, #modalRoot textarea, #modalRoot button'); if (f) f.focus();
}
function closeModal(){ $('#modalRoot').innerHTML = ''; document.body.classList.remove('print-slip'); if (lastFocus && lastFocus.isConnected) lastFocus.focus(); }
const tById = id => S.tickets.find(t => t.id === id);
const nowMin = () => now().min;

function markServed(t){ t.status = 'served'; if (t.calledMin == null) t.calledMin = nowMin(); t.doneMin = nowMin(); t.confirmed = true; }
function callTicket(t){
  t.status = 'called'; t.calledAt = nowMs(); t.calledMin = nowMin();
  sms(t, `It's your turn! ${t.num} is being called for ${svcBy(t.svc).name}. Please go to the triage desk within ${S.center.grace} minutes or your number will be voided.`);
  notifyNear(t.svc);
}
// returns the newly called ticket, null if the line is empty, or undefined if blocked
function callNext(code){
  const cur = currentFor(code);
  if (cur && cur.status === 'called') { toast(`${cur.num} is still being called. Mark as arrived or void first.`); return undefined; }
  if (cur) markServed(cur);
  const nx = lineFor(code)[0]; if (nx) callTicket(nx);
  return nx || null;
}
function download(name, text, type='text/csv'){
  const blob = new Blob(['﻿' + text], { type:type + ';charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
// Spreadsheet-safe CSV: a cell that starts with = + - @ (or tab / carriage return) could run as a
// formula in Excel, so it gets a leading apostrophe and is shown as plain text.
const csvCell = v => { let s = String(v ?? ''); if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csv = rows => rows.map(r => r.map(csvCell).join(',')).join('\r\n');

const A = {
  textSize(){ const order = ['md','lg','xl']; prefs.size = order[(order.indexOf(prefs.size || 'md') + 1) % 3]; ls.set(PKEY, JSON.stringify(prefs)); applyPrefs(); toast({ md:'Normal text size', lg:'Larger text', xl:'Largest text' }[prefs.size]); },
  contrast(){ prefs.contrast = !prefs.contrast; ls.set(PKEY, JSON.stringify(prefs)); applyPrefs(); toast(prefs.contrast ? 'High contrast on' : 'High contrast off'); },
  go(d){ location.hash = d.to; },
  tip(d){ tipIdx = (tipIdx + (+d.v) + TIPS.length) % TIPS.length; render(); },
  speakTip(){ const [t,b] = TIPS[tipIdx]; speak(`${t}. ${b}`); },
  speakStatus(){ speak(statusSpeech()); },
  speakDoctors(){ speak(S.doctors.map(d => { const st = docState(d); return `${d.name}, ${st.t}. ${st.duty ? `${fmtT(d.start)} to ${fmtT(d.end)}.` : st.sub + '.'}`; }).join(' ')); },
  speakTicket(d){ const t = tById(d.id); if (t) speak(ticketSpeech(t)); },
  speakRefill(){ const r = refill.result; if (r) speak(`Your medicine will last ${r.days} days. Come back on or before ${dateLong(r.back)}.`); },
  print(){ window.print(); },
  printSlip(){ document.body.classList.add('print-slip'); window.print(); setTimeout(() => document.body.classList.remove('print-slip'), 500); },
  // keep typed details when the patient type changes
  pickPrio(d){
    const f = document.querySelector('[data-form="book"]');
    if (f) flow.data = { ...Object.fromEntries(new FormData(f)), resident:f.resident.checked, smsOk:f.smsOk.checked };
    flow.prio = d.v; flow.err = ''; render();
    const b = document.querySelector(`[data-act="pickPrio"][data-v="${d.v}"]`); if (b) b.focus();
  },
  qNext(){
    const s = svcBy(flow.svc), st = serviceState(s);
    if (!st.ok) {
      if (s.open && st.left <= 0) { const k = 'ta-' + s.code + '-' + now().date; if (!ss.get(k)) { ss.set(k,'1');
        if (SERVER.on) api('/api/public/turned', { method:'POST', body:{ svc:s.code, device:deviceId() } }).catch(() => {});
        else { S.turned[now().date] = (S.turned[now().date]||0) + 1; save(); } } }
      toast(`${s.name}: ${st.t}. ${st.sub || ''}`); return;
    }
    flow.step = 2; flow.err = ''; render(); focusMain();
  },
  queueFor(d){ const q = queueState(); if (q.cut) { toast(q.reason + '.'); return; } flow = { step:1, prio:null, svc:d.v, err:'', data:{} }; location.hash = 'queue'; },
  flowStep(d){ flow.step = +d.v; flow.err = ''; render(); focusMain(); },
  homeSvc(d){ homeSvc = d.v; render(); const b = document.querySelector(`[data-act="homeSvc"][data-v="${d.v}"]`); if (b) b.focus(); },
  menu(){ const n = $('#nav'), b = $('#menuBtn'), open = !n.classList.contains('open'); n.classList.toggle('open', open); b.setAttribute('aria-expanded', open); b.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    document.documentElement.classList.toggle('menu-open', open);
    document.querySelectorAll('#tabbar [data-act="menu"]').forEach(x => x.setAttribute('aria-expanded', open)); },
  emgInfo(){ emgInfoOpen = !emgInfoOpen; render(); },
  showTicket(d){ viewTicketId = d.id; render(); },
  forgetMine(){ forgetMine(); render(); toast('Removed from this device. Keep your code to find it again.'); },
  cancelMine(d){
    if (SERVER.on) { api(`/api/public/tickets/${encodeURIComponent(d.id)}/cancel`, { method:'POST', body:{ code:myCodes()[d.id] || '' } }).then(j => { rememberTicket(j.ticket); return pull(true); }).then(() => { render(); toast('Your number was cancelled'); }).catch(e => toast(e.message)); return; }
    const t = tById(d.id); if (t && t.status === 'waiting') { t.status = 'cancelled'; sms(t, `${t.num} has been cancelled. Thank you.`); commit('Your number was cancelled'); } },
  medFilter(d){ medF = d.v; document.querySelectorAll('[data-act="medFilter"]').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === medF)); $('#medBody').innerHTML = d.admin === '1' ? medAdminRows() : medListHtml(); },
  prefillReq(){ reqDone = null; render(); const c = $('#reqCard'); if (c) { c.scrollIntoView({ behavior:'smooth', block:'start' }); const q = $('#rqQty'); if (q && refill.result) q.value = Math.ceil(refill.perDay * 30); } },
  reqAgain(){ reqDone = null; render(); },
  closeModal, bgClose(d, el, e){ if (e.target === el) closeModal(); },
  logout(){
    if (SERVER.on) {
      toast('Logging out…');
      flushSync().then(() => api('/api/auth/logout', { method:'POST' }).then(() => true, () => false)).then(ok => {
        clearStaffState(); render();
        toast(ok ? 'Logged out' : 'Logged out on this screen. The server could not be reached, so close the browser to be safe.');
        return pull(true).catch(() => {});
      }).then(() => render());
      return;
    }
    ss.del(AKEY); adminTab = 'dash'; if (PORTAL !== 'staff') location.hash = 'home'; render(); toast('Logged out'); },
  userReset(d){
    if (SERVER.on) { api(`/api/staff/users/${encodeURIComponent(d.id)}/reset`, { method:'POST' }).then(j => { S.users = j.users; render(); openModal(tempPwModal(j.user, j.tempPassword)); }).catch(e => toast(e.message)); return; } const u = S.users.find(x => x.id === d.id), pw = tempPassword(); u.salt = uid() + uid(); u.hash = hashPw(u.salt, pw); u.mustChange = true; save(); render(); openModal(tempPwModal(u, pw)); },
  userDel(d){ const u = S.users.find(x => x.id === d.id); if (!u || u.id === currentUser().id) return;
    if (SERVER.on) { api(`/api/staff/users/${encodeURIComponent(d.id)}`, { method:'DELETE' }).then(j => { S.users = j.users; render(); toast(`${u.name}'s account removed`); }).catch(e => toast(e.message)); return; }
    if (u.role === 'admin' && S.users.filter(x => x.role === 'admin').length < 2) { toast('Keep at least one administrator account.'); return; }
    S.users = S.users.filter(x => x.id !== d.id); commit(`${u.name}'s account removed`); },
  backup(){
    if (SERVER.on) { const a = document.createElement('a'); a.href = '/api/staff/export'; a.download = ''; document.body.appendChild(a); a.click(); a.remove(); toast('Backup downloading. It holds personal data: keep it somewhere safe.'); return; }
    const data = JSON.stringify({ app:'bkhc', exported:new Date().toISOString(), data:S }, null, 1);
    download(`bkhc-backup-${now().date}.json`, data, 'application/json'); S.lastBackup = now().date; save(); toast('Backup downloaded. Keep it somewhere safe.');
  },
  restoreYes(){ if (!pendingRestore) return;
    if (SERVER.on) { const d = pendingRestore; pendingRestore = null; closeModal(); serverRestore(d, 'Backup restored'); return; }
    S = pendingRestore; pendingRestore = null; migrate(); save(); closeModal(); render(); toast('Backup restored'); },
  mailOff(){ api('/api/staff/messaging/email', { method:'POST', body:{ host:'', port:587, user:'', password:'', sender:'', starttls:true } }).then(j => { MSGSET = j; SERVER.mail = false; render(); toast('Email is off.'); }).catch(e => toast(e.message)); },
  backupTest(){ toast('Opening and checking the latest backup…'); api('/api/staff/backup-test', { method:'POST' }).then(j => { openModal(j.ok ? `<h2>Backup test passed</h2><p>The latest backup (<span class="mono">${esc(j.file)}</span>) opened, passed the integrity check and its personal details can be read with this computer's key.</p><p>Inside: ${j.counts.tickets} queue records, ${j.counts.doctors} doctors, ${j.counts.medicines} medicines, ${j.counts.announcements} announcements, ${j.counts.users} staff accounts.</p><div class="btn-row"><button class="btn primary" type="button" data-act="closeModal">OK</button></div>` : `<h2>Backup test failed</h2><p class="err">${esc(j.error || 'The backup did not pass the check.')}</p><p>Make a new backup now (Back up now) and tell the administrator.</p><div class="btn-row"><button class="btn primary" type="button" data-act="closeModal">OK</button></div>`); SYS = null; render(); }).catch(e => toast(e.message)); },
  backupNow(){ toast('Backing up…'); api('/api/staff/backup-now', { method:'POST' }).then(j => { SYS = SYS ? { ...SYS, backup:j.status } : null; render(); toast('Backup saved: ' + j.file); }).catch(e => toast(e.message)); },
  toggleXlsPw(){ showXlsPw = !showXlsPw; render(); },
  copyText(d){ (navigator.clipboard ? navigator.clipboard.writeText(d.v) : Promise.reject()).then(() => toast('Copied')).catch(() => { openModal(`<h2>Copy this</h2><p class="mono" style="word-break:break-all;user-select:all">${esc(d.v)}</p><div class="btn-row"><button class="btn primary" type="button" data-act="closeModal">Done</button></div>`); }); },
  feedKey(){ api('/api/staff/excel-key', { method:'POST' }).then(() => { SYS = null; render(); toast('New feed key made. Update the links in Excel.'); }).catch(e => toast(e.message)); },
  sysAudit(){ api('/api/staff/audit').then(j => openModal(auditModal(j))).catch(e => toast(e.message)); },
  reload(){ location.reload(); },
  aTab(d){ if (d.v === 'settings') SYS = null; if (!can(d.v)) { toast('Your account cannot open this section.'); return; } adminTab = d.v; medQ = ''; medF = 'all'; render(); window.scrollTo({ top:0 }); },
  openDesk(d){ qSvc = d.v; adminTab = 'queue'; render(); window.scrollTo({ top:0 }); },
  qSvc(d){ qSvc = d.v; render(); },
  callNext(d){ const nx = callNext(d.v); if (nx !== undefined) commit(nx ? `Calling ${nx.num}` : 'No more patients waiting'); },
  doneNext(d){ const nx = callNext(d.v); if (nx !== undefined) commit(nx ? `Done. Now calling ${nx.num}` : 'Done. No more patients waiting'); },
  done(d){ const t = tById(d.id); markServed(t); notifyNear(t.svc); commit(`${t.num} completed`); },
  callThis(d){ const t = tById(d.id), cur = currentFor(t.svc);
    if (cur && cur.status === 'called') { toast(`${cur.num} is still being called. Mark as arrived or void first.`); return; }
    if (cur) markServed(cur); callTicket(t); commit(`Calling ${t.num}`); },
  arrived(d){ const t = tById(d.id); t.status = 'serving'; t.confirmed = true; if (t.val) t.val.status = 'approved'; commit(`${t.num} is now being served`); },
  badId(d){ const t = tById(d.id); t.origNum = t.num; t.origPrio = t.prio; t.prio = 'regular'; t.num = nextNum(t.svc, 'regular'); t.val.status = 'rejected'; t.status = 'waiting'; t.calledAt = null; t.calledMin = null; t.nNear = false;
    sms(t, `Your ID could not be validated, so ${t.origNum} was moved to the regular lane as ${t.num}.`); commit(`${t.origNum} moved to the regular lane as ${t.num}`); },
  voidT(d){ const t = tById(d.id); t.status = 'void'; t.voidAuto = false; sms(t, `${t.num} was voided because the patient was not present when called. Please ask at the triage desk.`); notifyNear(t.svc); commit(`${t.num} voided`); },
  restore(d){ const t = tById(d.id); t.status = 'waiting'; t.calledAt = null; t.calledMin = null; t.nNear = false; commit(`${t.num} is back in line`); },
  cancelT(d){ const t = tById(d.id); t.status = 'cancelled'; commit(`${t.num} cancelled`); },
  confirm(d){ const t = tById(d.id); t.confirmed = true; commit(`${t.num} verified`); },
  recallSms(d){ const t = tById(d.id); sms(t, `Reminder: ${t.num}, please go to the triage desk now.`); commit('Reminder text sent'); },
  turnAway(){ const T = now().date; S.turned[T] = (S.turned[T]||0) + 1; commit('Recorded 1 patient turned away'); },
  walkin(){ openModal(walkinForm()); },
  apF(d){ apF = d.v; render(); },
  docEdit(d){ openModal(docForm(d.id ? S.doctors.find(x => x.id === d.id) : null)); },
  docToggle(d){ const x = S.doctors.find(y => y.id === d.id); x.available = !x.available; if (x.available) x.note = ''; commit(`${x.name} marked ${x.available ? 'available' : 'unavailable'}`); },
  docLeave(d){ const x = S.doctors.find(y => y.id === d.id); if (x) openModal(leaveModal(x)); },
  leaveDel(d){ const x = S.doctors.find(y => y.id === d.id); if (!x) return; x.leaves = (x.leaves || []).filter(l => l.id !== d.v); commit('Day off removed'); openModal(leaveModal(x)); },
  dcalDay(d){ dcal.day = d.date; render(); const b = document.querySelector(`[data-act="dcalDay"][data-date="${d.date}"]`); if (b) b.focus(); },
  dcalNav(d){ const [y, m] = dcal.ym.split('-').map(Number), n = new Date(Date.UTC(y, m - 1 + (+d.v), 1)); dcal.ym = `${n.getUTCFullYear()}-${pad(n.getUTCMonth() + 1)}`; dcal.day = null; render(); },
  docDel(d){ S.doctors = S.doctors.filter(x => x.id !== d.id); commit('Doctor removed'); },
  medAdd(){ openModal(medForm()); },
  medStock(d){ const m = S.medicines.find(x => x.id === d.id); const v = Math.max(0, parseInt($('#stock-' + d.id).value, 10) || 0); m.stock = v; m.status = medStatusFor(v, m.thr); m.updated = now().date; commit(`${m.name}: ${v} in stock (${MED_ST[m.status][1].toLowerCase()})`); },
  medDel(d){ S.medicines = S.medicines.filter(x => x.id !== d.id); commit('Medicine removed'); },
  remindNow(){ restockReminder(true); commit('Restock reminder emailed to the pharmacy'); },
  medEdit(d){ openModal(medForm(S.medicines.find(x => x.id === d.id))); },
  medRefill(d){ const m = S.medicines.find(x => x.id === d.id); m.stock = m.cap; m.status = medStatusFor(m.stock, m.thr); m.updated = now().date; commit(`${m.name} replenished to ${m.cap}`); },
  medJump(d){ medQ = ''; medF = 'all'; render(); const el = document.getElementById('med-' + d.id); if (el) { el.scrollIntoView({ behavior:'smooth', block:'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 2400); } },
  reqSet(d){ const r = S.medRequests.find(x => x.id === d.id), m = S.medicines.find(x => x.id === r.medId); r.status = d.v;
    if (d.v === 'ready') sms({ contact:r.contact, email:r.email, date:now().date, id:r.id, num:r.code }, `Your requested medicine (${m ? m.name : 'medicine'} x${r.qty}, ${r.code}) is ready for pick-up at the health center. Please bring your prescription.`);
    if (d.v === 'forwarded') sms({ contact:r.contact, email:r.email, date:now().date, id:r.id, num:r.code }, `Your request ${r.code} for ${m ? m.name : 'medicine'} was forwarded to the City Health Office. We will message you when it arrives.`);
    commit(`Request ${r.code}: ${REQ_ST[d.v][1].toLowerCase()}`); },
  csvDemand(){ const dm = demand(); download(`bkhc-medicine-order-${now().date}.csv`, csv([['Medicine','Form','Status','Stock on hand','Full stock','% of full','Low-stock level','Resident requests (qty)','Order quantity'], ...dm.map(x => [x.m.name, x.m.form, MED_ST[x.m.status][1], x.m.stock, x.m.cap, stockPct(x.m) + '%', x.m.thr, x.qty, x.need])])); toast('Medicine order downloaded'); },
  annPin(d){ const a = S.announcements.find(x => x.id === d.id); a.pinned = !a.pinned; commit(a.pinned ? 'Pinned' : 'Unpinned'); },
  annDel(d){ S.announcements = S.announcements.filter(x => x.id !== d.id); commit('Announcement deleted'); },
  closureDel(d){ S.closures = S.closures.filter(x => x.id !== d.id); closeModal(); commit('Special date removed'); },
  calNav(d){ const [y,m] = calYM.split('-').map(Number), n = new Date(Date.UTC(y, m - 1 + (+d.v), 1)); calYM = `${n.getUTCFullYear()}-${pad(n.getUTCMonth()+1)}`; render(); },
  calDay(d){ openModal(dateForm(d.date)); },
  cutNowAsk(){ openModal(cutNowForm()); },
  cutNowUndo(){ S.center.cutNow = null; const t = 'Queue numbers are available again today', b = 'The earlier cut-off was lifted. You may get a queue number during the normal queue hours.'; postAnnouncement('cutoff', t, b); const n = broadcast(t, b); commit(`Queue reopened · ${n} people notified`); },
  pendDel(d){ const x = S.pending.find(y => y.id === d.id); S.pending = S.pending.filter(y => y.id !== d.id); if (x) { const t = 'Planned cut-off change cancelled', b = `The change planned for ${dateLong(x.effective)} will not happen. The current queue hours stay the same.`; postAnnouncement('cutoff', t, b); broadcast(t, b); } commit('Planned change cancelled'); },
  subDel(d){ S.subs = S.subs.filter(e => e !== d.v); commit('Subscriber removed'); },
  rpQuick(d){ const T = now().date; rp = { ...rp, from:addDays(T, -(+d.v)), to:T }; render(); },
  csvItems(){
    const dd = reportData();
    const rows = [['Date','Queue no.','Service','Patient type','Source','Name','Age','Purok','Issued','Called','Completed','Wait (min)','Status','Reason for visit','Verification code']];
    dd.list.slice().sort((a,b) => a.date.localeCompare(b.date) || a.cmin - b.cmin).forEach(t => rows.push([t.date, t.num, svcBy(t.svc).name, PRIO_SHORT[t.prio], t.source === 'walkin' ? 'Walk-in' : 'Online', t.name, t.age, t.address, fmt(t.cmin), t.calledMin != null ? fmt(t.calledMin) : '', t.doneMin != null ? fmt(t.doneMin) : '', t.calledMin != null && t.status !== 'void' ? t.calledMin - t.cmin : '', T_ST[t.status][1].split(' —')[0], t.concern ? CONCERNS[t.concern] : '', t.code]));
    download(`bkhc-itemized-${rp.from}-to-${rp.to}.csv`, csv(rows)); toast(`Downloaded ${dd.list.length} records`);
  },
  csvDaily(){
    const dd = reportData();
    const rows = [['Date','Total patients','Served','No-show (voided)','Cancelled','Turned away','Priority lane'], ...dd.perDay.map(x => [x.date, x.total + x.turned, x.served, x.void, x.cancelled, x.turned, x.prio]), ['TOTAL', dd.total + dd.turned, dd.served, dd.void, dd.cancelled, dd.turned, dd.prio]];
    download(`bkhc-daily-summary-${rp.from}-to-${rp.to}.csv`, csv(rows)); toast('Daily summary downloaded');
  },
  copyReport(){
    const txt = reportText(reportData());
    const fallback = () => { const el = $('#reportText'); const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast('Report selected. Press Ctrl+C to copy.'); };
    try { navigator.clipboard.writeText(txt).then(() => toast('Report copied'), fallback); } catch(e){ fallback(); }
  }
};

const digits = s => String(s || '').replace(/[\s-]/g, '');
async function serverBook(body, fail){
  const b = document.querySelector('[data-form="book"] [type="submit"]'); if (b) { b.disabled = true; b.dataset.label = b.innerHTML; b.textContent = 'Sending…'; }
  try {
    const form = document.querySelector('[data-form="book"]');
    await guard(body, form);
    const j = await api('/api/public/tickets', { method:'POST', body });
    rememberTicket(j.ticket); viewTicketId = j.ticket.id;
    if (j.ticket.existing) { flow = { step:1, prio:null, svc:null, err:'', data:{} }; try { await pull(true); } catch(e){} if (location.hash !== '#ticket') location.hash = 'ticket'; else render(); toast(`You already have number ${j.ticket.num} for this service from this phone. Here it is.`); return; }
    flow = { step:1, prio:null, svc:null, err:'', data:{} };
    try { await pull(true); } catch(e){}
    if (location.hash !== '#ticket') location.hash = 'ticket'; else render();
    toast(`Your queue number is ${j.ticket.num}`); window.scrollTo({ top:0 });
  } catch(e){ resetCaptcha(document.querySelector('[data-form="book"]')); if (b && b.isConnected) { b.disabled = false; b.innerHTML = b.dataset.label; } fail(e.message); }
}
const F = {
  book(fd){
    flow.data = Object.fromEntries(fd); flow.data.resident = !!fd.get('resident'); flow.data.smsOk = !!fd.get('smsOk');
    const name = (fd.get('name')||'').trim(), age = parseInt(fd.get('age'),10), contact = digits(fd.get('contact')), address = (fd.get('address')||'').trim(), email = (fd.get('email')||'').trim().toLowerCase();
    const fail = m => { flow.err = m; render(); const e = document.querySelector('.err'); if (e) e.scrollIntoView({ behavior:'smooth', block:'center' }); };
    if (!flow.prio) return fail('Please choose who the patient is: senior citizen, PWD, pregnant, or regular.');
    if (!name || name.length < 3) return fail('Please enter your full name.');
    if (!(age >= 0 && age <= 120)) return fail('Please enter your age.');
    if (contact && !/^(09|\+639)\d{9}$/.test(contact)) return fail('Please enter an 11-digit mobile number that starts with 09, or leave it blank.');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail('Please check the email address, or leave it blank.');
    if (!address) return fail('Please enter your purok or street.');
    if (!fd.get('resident')) return fail('Online queueing is for Barangay Kaligayahan residents. Please tick the box to continue.');
    if (!fd.get('consent')) return fail('Please tick the box to agree to the Privacy Notice. Your details are only used for your queue number and updates.');
    if (flow.prio === 'senior' && age < 60) return fail('The senior citizen lane is for ages 60 and above. Tap "change" and choose Regular patient.');
    if (flow.prio !== 'regular' && !fd.get('proof')) return fail('Please choose the ID or document you will show.');
    if (!queueState().open) return fail('Online queueing just closed. ' + queueState().reason + '.');
    const s = svcBy(flow.svc), st = serviceState(s);
    if (!st.ok) return fail(`${s.name}: ${st.t}. ${st.sub || ''}`);
    // one active number per person per service per day: same mobile, same email, or same phone/computer
    const onDevice = new Set([...myTickets(), ...memMine]);
    const dup = todayTickets().find(x => x.svc === s.code && ['waiting','called','serving'].includes(x.status) && ((contact && x.contact === contact) || (email && x.email === email) || onDevice.has(x.id)));
    if (dup) return fail(`There is already an active number (${dup.num}) for ${s.name} today from this ${dup.contact && dup.contact === contact ? 'mobile number' : dup.email && dup.email === email ? 'email address' : 'phone or computer'}. Only one number per person per service is allowed. If you no longer need it, cancel it on “My ticket” first.`);
    if (SERVER.on) return serverBook({ svc:s.code, prio:flow.prio, name, age, contact, email, address, concern:s.code === 'CU' ? (fd.get('concern') || 'other') : '', proof:fd.get('proof') || '', resident:true, consent:true, smsOk:!!fd.get('smsOk'), device:deviceId(), website:'', elapsed:+fd.get('elapsed') || 0 }, fail);
    const T = now().date;
    const t = { id:uid(), date:T, svc:s.code, prio:flow.prio, source:'online', consentAt:Date.now(), num:nextNum(s.code, flow.prio), name, age, contact, email, concern:s.code === 'CU' ? (fd.get('concern') || 'other') : '', address, code:vcode(), cmin:nowMin(), status:'waiting', confirmed:false, calledMin:null, calledAt:null, doneMin:null, smsOff:!fd.get('smsOk'),
      val: flow.prio === 'regular' ? null : { status:'pending', proof:fd.get('proof') } };
    S.tickets.push(t); addMyTicket(t.id); viewTicketId = t.id;
    sms(t, `Your queue number is ${t.num} for ${s.name}. Code ${t.code}. ${aheadOf(t)} ahead of you, about ${estWait(t)} min. We will message you when your turn is near.`);
    notifyNear(s.code);
    flow = { step:1, prio:null, svc:null, err:'', data:{} };
    save(); location.hash = 'ticket'; render(); toast(`Your queue number is ${t.num}`); window.scrollTo({ top:0 });
  },
  findTicket(fd){
    let code = String(fd.get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    code = /^KLG[A-Z0-9]{5,6}$/.test(code) ? 'KLG-' + code.slice(3) : /^[A-Z0-9]{5,6}$/.test(code) ? 'KLG-' + code : code;
    if (SERVER.on) {
      if (!/^KLG-[A-Z0-9]{5,6}$/.test(code)) { toast('No ticket today with that code. Check the letters and try again.'); return; }
      return api('/api/public/tickets/find', { method:'POST', body:{ code } }).then(j => { rememberTicket(j.ticket); viewTicketId = j.ticket.id; render(); toast(`Found ${j.ticket.num}`); }).catch(e => toast(e.message));
    }
    const t = S.tickets.find(x => x.code === code && x.date === now().date);
    if (!t) { toast('No ticket today with that code. Check the letters and try again.'); return; }
    addMyTicket(t.id); viewTicketId = t.id; render(); toast(`Found ${t.num}`);
  },
  refill(fd){
    const m = S.medicines.find(x => x.id === fd.get('med'));
    const perDay = parseFloat(fd.get('perDay')), have = parseInt(fd.get('have'), 10);
    refill.med = fd.get('med'); refill.perDay = perDay || 1; refill.have = have || 30;
    if (!(perDay > 0) || !(have > 0)) { toast('Please enter tablets per day and tablets you have.'); return; }
    const days = Math.floor(have / perDay), backDay = addDays(now().date, Math.max(0, days - 3));
    refill.result = { days, back:backDay, perMonth:Math.max(1, Math.round(30 / Math.max(days,1))), perYear:Math.max(1, Math.round(365 / Math.max(days,1))), status:m ? m.status : null };
    render();
  },
  medReq(fd){
    const e = $('#rqErr'), fail = m => { e.textContent = m; e.classList.remove('hide'); };
    if (queueState().cut) { render(); toast('Requests are closed for today: the cut-off has been reached.'); return; }
    const med = fd.get('med'), qty = parseInt(fd.get('qty'),10), name = (fd.get('name')||'').trim(), contact = digits(fd.get('contact')), email = (fd.get('email')||'').trim().toLowerCase();
    if (!med) return fail('Please choose a medicine.');
    if (!(qty > 0)) return fail('Please enter how many you need.');
    if (name.length < 3) return fail('Please enter your full name.');
    if (!email && !contact) return fail('Please enter your email address or mobile number so we can tell you when it is ready.');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail('Please check the email address.');
    if (contact && !/^(09|\+639)\d{9}$/.test(contact)) return fail('Please enter an 11-digit mobile number that starts with 09.');
    if (!fd.get('consent')) return fail('Please tick the box to agree to the Privacy Notice.');
    if (SERVER.on) { const form = document.querySelector('[data-form="medReq"]'); return guard({ medId:med, qty, name, contact, email, note:(fd.get('note')||'').trim(), consent:true, website:'', elapsed:+fd.get('elapsed') || 0 }, form).then(body => api('/api/public/med-requests', { method:'POST', body })).then(j => { reqDone = j.request; render(); toast('Request sent'); }).catch(err => { resetCaptcha(form); fail(err.message); }); }
    const r = { id:uid(), consentAt:Date.now(), code:'REQ-' + (Math.max(1040, ...S.medRequests.map(x => +x.code.slice(4) || 0)) + 1), date:now().date, name, contact, email, medId:med, qty, note:(fd.get('note')||'').trim(), status:'pending' };
    S.medRequests.push(r); reqDone = r;
    const m = S.medicines.find(x => x.id === med);
    sms({ contact, email, date:r.date, id:r.id, num:r.code }, `We received your request ${r.code} for ${m.name} x${qty}. We will message you when it is ready.`);
    commit('Request sent');
  },
  login(fd){
    const e = $('#lErr'), fail = m => { e.textContent = m; e.classList.remove('hide'); };
    if (SERVER.on) {
      const user = (fd.get('u') || '').trim(), pw = fd.get('p') || '';
      if (!user || !pw) return fail('Enter your username and password.');
      return api('/api/auth/login', { method:'POST', body:{ user, password:pw } }).then(async j => {
        setMe(j); await pull(true); adminTab = j.user.mustChange ? 'account' : j.tabs[0]; render();
        const due = can('meds') ? S.medicines.filter(needsReorder).length : 0;
        toast(j.user.mustChange ? `Welcome, ${j.user.name}. Please change your password first.` : due ? `Welcome, ${j.user.name} · Restock reminder: ${due} medicine${due>1?'s':''} at or below ${restockPct()}%` : `Welcome, ${j.user.name}`);
      }).catch(err => fail(err.message));
      return;
    }
    const lock = loginLockLeft(); if (lock) return fail(`Too many wrong tries. Please wait ${lock} seconds.`);
    const name = (fd.get('u') || '').trim().toLowerCase(), pw = fd.get('p') || '', u = (S.users || []).find(x => x.user.toLowerCase() === name);
    if (!u || hashPw(u.salt, pw) !== u.hash) {
      const n = (+ss.get('bkhc-fails') || 0) + 1;
      if (n >= 5) { ss.set('bkhc-fails', 0); ss.set('bkhc-lock', Date.now() + 60000); return fail('Too many wrong tries. Login is locked for 1 minute.'); }
      ss.set('bkhc-fails', n); return fail(`Wrong username or password. ${5 - n} ${5 - n === 1 ? 'try' : 'tries'} left.`);
    }
    ss.set('bkhc-fails', 0); ss.set(AKEY, u.id); u.lastLogin = Date.now(); save();
    adminTab = u.mustChange ? 'account' : ROLES[u.role].tabs[0]; render();
    const due = can('meds') ? S.medicines.filter(needsReorder).length : 0;
    toast(u.mustChange ? `Welcome, ${u.name}. Please change your password first.` : due ? `Welcome, ${u.name} · Restock reminder: ${due} medicine${due>1?'s':''} at or below ${restockPct()}%` : `Welcome, ${u.name}`);
  },
  pwChange(fd){
    const u = currentUser(), e = $('#pwErr'), fail = m => { e.textContent = m; e.classList.remove('hide'); };
    const old = fd.get('old') || '', pw = fd.get('pw') || '', pw2 = fd.get('pw2') || '';
    if (SERVER.on) {
      const p = pwProblem(pw, u.user); if (p) return fail(p);
      if (pw !== pw2) return fail('The two new passwords do not match.');
      return api('/api/auth/password', { method:'POST', body:{ old, new:pw } }).then(async j => { setMe(j); await pull(true); adminTab = j.tabs[0]; render(); toast('Password changed'); }).catch(err => fail(err.message));
      return;
    }
    if (hashPw(u.salt, old) !== u.hash) return fail('The current password is not correct.');
    const p = pwProblem(pw, u.user); if (p) return fail(p);
    if (pw !== pw2) return fail('The two new passwords do not match.');
    if (pw === old) return fail('Choose a password different from the current one.');
    u.salt = uid() + uid(); u.hash = hashPw(u.salt, pw); u.mustChange = false; adminTab = ROLES[u.role].tabs[0];
    commit('Password changed');
  },
  userAdd(fd){
    const e = $('#uaErr'), fail = m => { e.textContent = m; e.classList.remove('hide'); };
    const name = (fd.get('name') || '').trim(), user = (fd.get('user') || '').trim().toLowerCase(), role = fd.get('role');
    if (name.length < 2) return fail('Enter the full name.');
    if (!/^[a-z0-9.]{3,20}$/.test(user)) return fail('Username: 3 to 20 small letters, numbers or dots.');
    if (S.users.some(x => x.user === user)) return fail('That username is already taken.');
    if (!ROLES[role]) return fail('Choose a role.');
    if (SERVER.on) { return api('/api/staff/users', { method:'POST', body:{ name, user, role } }).then(j => { S.users = j.users; render(); openModal(tempPwModal(j.user, j.tempPassword)); }).catch(err => fail(err.message)); }
    const pw = tempPassword(), u = makeUser(user, name, role, pw); S.users.push(u); save(); render(); openModal(tempPwModal(u, pw));
  },
  walkin(fd){
    const d = Object.fromEntries(fd); d.idOk = !!fd.get('idOk'); d.override = !!fd.get('override');
    const name = (d.name||'').trim(), age = parseInt(d.age,10), contact = digits(d.contact);
    const again = m => openModal(walkinForm(m, d));
    if (name.length < 2) return again('Enter the patient name.');
    if (!(age >= 0 && age <= 120)) return again('Enter a valid age.');
    if (contact && !/^(09|\+639)\d{9}$/.test(contact)) return again('Mobile number should be 11 digits starting with 09.');
    if (d.email && !/^[^\s@<>"'`]+@[^\s@<>"'`]+\.[^\s@<>"'`]{2,}$/.test(String(d.email).trim())) return again('Please check the email address, or leave it blank.');
    const s = svcBy(d.svc), c = counts(s.code);
    if (c.walkin >= s.walkin && !d.override) return again(`Walk-in slots for ${s.name} are full (${c.walkin}/${s.walkin}). Tick "Accept even if full" to add anyway.`);
    const t = { id:uid(), date:now().date, svc:s.code, prio:d.prio, source:'walkin', num:nextNum(s.code, d.prio), name, age, contact, email:(d.email||'').trim().toLowerCase(), concern:s.code === 'CU' ? 'other' : '', address:(d.address||'').trim() || '—', code:vcode(), cmin:nowMin(), status:'waiting', confirmed:true, calledMin:null, calledAt:null, doneMin:null,
      val: d.prio === 'regular' ? null : { status:d.idOk ? 'approved' : 'pending', proof:PROOFS[d.prio][0] } };
    S.tickets.push(t);
    sms(t, `Your queue number is ${t.num} for ${s.name}. Code ${t.code}. Check your place in line on the health center website.`);
    if (SERVER.on) {
      save(); render(); openModal('<h2>Registering…</h2><p class="muted">Saving the walk-in on the server.</p>');
      flushSync().then(ok => { const saved = tById(t.id);
        if (ok && saved) { openModal(`<h2>Walk-in registered</h2>${slipHtml(saved)}`); toast(`Walk-in number ${saved.num}`); }
        else { closeModal(); toast('The walk-in was not saved. Check the connection and try again.'); } });
      return;
    }
    save(); render(); openModal(`<h2>Walk-in registered</h2>${slipHtml(t)}`); toast(`Walk-in number ${t.num}`);
  },
  doc(fd, f){
    const name = (fd.get('name')||'').trim(), days = fd.getAll('day').map(Number);
    const err = m => { const e = $('#dErr'); e.textContent = m; e.classList.remove('hide'); };
    if (!name) return err("Enter the doctor's name.");
    if (!days.length) return err('Choose at least one duty day.');
    if (!fd.get('start') || !fd.get('end')) return err('Enter the start and end time of the duty.');
    if (toMin(fd.get('end')) <= toMin(fd.get('start'))) return err('End time must be later than start time.');
    const data = { name, role:(fd.get('role')||'').trim() || 'General Medicine', days, start:fd.get('start'), end:fd.get('end'), limit:Math.max(1, parseInt(fd.get('limit'),10)||1), note:(fd.get('note')||'').trim(), available:!!fd.get('available') };
    if (f.dataset.id) Object.assign(S.doctors.find(x => x.id === f.dataset.id), data); else S.doctors.push({ id:uid(), ...data, leaves:[] });
    closeModal(); commit('Doctor saved');
  },
  med(fd, f){
    const name = (fd.get('name')||'').trim(), err = m => { const e = $('#mErr'); e.textContent = m; e.classList.remove('hide'); };
    const num = k => Math.max(0, parseInt(fd.get(k), 10) || 0);
    const stock = num('stock'), cap = Math.max(1, num('cap')), thr = num('thr');
    if (!name) return err('Enter the medicine name.');
    if (stock > cap) return err('Stock on hand cannot be more than the full stock. Raise the full stock first.');
    if (thr > Math.floor(cap * restockPct() / 100)) return err(`The low-stock level should be at or below ${restockPct()}% of full stock (${Math.floor(cap * restockPct() / 100)}), so staff are reminded to restock before residents see “Low stock”.`);
    const data = { name, form:fd.get('form'), stock, cap, thr, freq:num('freq'), use:(fd.get('use')||'').trim(), status:medStatusFor(stock,thr), updated:now().date };
    if (f.dataset.id) Object.assign(S.medicines.find(x => x.id === f.dataset.id), data); else S.medicines.push({ id:uid(), ...data });
    closeModal(); commit(`${name} saved`);
  },
  mailSet(fd){
    const e = $('#mErr'), fail = m => { e.textContent = m; e.classList.remove('hide'); };
    const pw = String(fd.get('password') || '');
    return api('/api/staff/messaging/email', { method:'POST', body:{ host:String(fd.get('host') || '').trim(), port:+fd.get('port') || 587, user:String(fd.get('user') || '').trim(),
      password:pw ? pw : null, sender:String(fd.get('sender') || '').trim().toLowerCase(), starttls:!!fd.get('starttls') } })
      .then(j => { MSGSET = j; SERVER.mail = j.email.on; render(); toast(j.email.on ? 'Email settings saved. Send a test to check them.' : 'Email is off.'); }).catch(err => fail(err.message));
  },
  smsSet(fd){
    const e = $('#sErr'), fail = m => { e.textContent = m; e.classList.remove('hide'); };
    const key = String(fd.get('api_key') || '').trim();
    return api('/api/staff/messaging/sms', { method:'POST', body:{ provider:fd.get('provider') || '', api_key:key ? key : null, sender:String(fd.get('sender') || '').trim() } })
      .then(j => { MSGSET = j; render(); toast(j.sms.on ? 'SMS settings saved. Send a test to check them.' : 'Text messages are off.'); }).catch(err => fail(err.message));
  },
  tsSet(fd){
    const e = $('#tsErr'), fail = m => { e.textContent = m; e.classList.remove('hide'); };
    const site = String(fd.get('site_key') || '').trim(), secret = String(fd.get('secret') || '').trim();
    return api('/api/staff/botguard', { method:'POST', body:{ site_key:site, secret:secret ? secret : (site ? null : '') } })
      .then(j => { MSGSET = j; render(); toast(j.turnstile.on ? 'Turnstile is on. Residents will see the check on the next page load.' : 'Turnstile is off.'); }).catch(err => fail(err.message));
  },
  msgTest(fd){
    const to = String(fd.get('to') || '').trim(), isMail = to.includes('@');
    if (!to) { toast('Enter your email or mobile number.'); return; }
    toast('Sending…');
    return api(isMail ? '/api/staff/messaging/test-email' : '/api/staff/messaging/test-sms', { method:'POST', body:{ to } })
      .then(() => toast(isMail ? 'Test email sent. Check the inbox (and spam folder).' : 'Test text sent.')).catch(err => toast(err.message));
  },
  leave(fd, f){
    const x = S.doctors.find(y => y.id === f.dataset.id), e = $('#lvErr'), fail = m => { e.textContent = m; e.classList.remove('hide'); };
    if (!x) return;
    const first = fd.get('first'), last = fd.get('last') || first, reason = String(fd.get('reason') || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(first || '') || !/^\d{4}-\d{2}-\d{2}$/.test(last)) return fail('Choose the first and last day.');
    if (last < first) return fail('The last day must be on or after the first day.');
    if (first < now().date) return fail('Past days cannot be added.');
    if (last > addDays(first, 365)) return fail('A leave can be at most one year long.');
    if ((x.leaves || []).some(l => l.first <= last && first <= l.last)) return fail('These days overlap a day off that is already entered.');
    if ((x.leaves || []).length >= 60) return fail('Remove some past entries first (at most 60).');
    x.leaves = [...(x.leaves || []), { id:uid(), first, last, reason }];
    commit(`Day off saved for ${x.name}`); openModal(leaveModal(x));
  },
  ann(fd){
    const title = (fd.get('title')||'').trim();
    if (!title) { const e = $('#aErr'); e.textContent = 'Add a title so residents know what this is about.'; e.classList.remove('hide'); return; }
    S.announcements.push({ id:uid(), type:fd.get('type'), title, body:(fd.get('body')||'').trim(), date:fd.get('date') || now().date, pinned:!!fd.get('pinned') });
    commit('Announcement posted');
  },
  // a special date: closed, special hours, or open as usual on a holiday
  dateRule(fd){
    const date = fd.get('date'), type = fd.get('type'), reason = (fd.get('reason')||'').trim(), err = m => { const e = $('#drErr'); e.textContent = m; e.classList.remove('hide'); };
    if (!date) return err('Choose a date.');
    if (type !== 'open' && !reason) return err('Add a reason so residents know why.');
    if (type === 'hours' && toMin(fd.get('close')) <= toMin(fd.get('open'))) return err('Closing time must be later than opening time.');
    S.closures = S.closures.filter(x => x.date !== date);
    S.closures.push({ id:uid(), date, type, open:type === 'hours' ? fd.get('open') : '', close:type === 'hours' ? fd.get('close') : '', reason:reason || 'Open as usual' });
    let sent = 0;
    if (fd.get('announce') && type !== 'open') {
      const title = type === 'closed' ? `Closed on ${dateLong(date)}` : `Special hours on ${dateLong(date)}`;
      const body = type === 'closed' ? `The health center will be closed: ${reason}.` : `The health center will be open only from ${fmtT(fd.get('open'))} to ${fmtT(fd.get('close'))}: ${reason}.`;
      postAnnouncement('schedule', title, body); sent = broadcast(title, body);
    }
    calYM = date.slice(0,7); closeModal(); commit(sent ? `Date saved · ${sent} people notified` : 'Date saved');
  },
  // Cut-off rule: changes need advance notice, are announced and emailed. Emergencies may apply at once, with a reason.
  cutoff(fd){
    const err = m => { const e = $('#coErr'); e.textContent = m; e.classList.remove('hide'); };
    const sessions = S.center.sessions.map((s,i) => ({ start:fd.get('sStart'+i) || s.start, cutoff:fd.get('sCut'+i) || s.cutoff }));
    const emergency = !!fd.get('emergency'), reason = (fd.get('reason')||'').trim(), eff = fd.get('effective'), minDate = minNoticeDate();
    if (sessions.some(s => toMin(s.cutoff) <= toMin(s.start))) return err('Each cut-off must be later than its start time.');
    if (!sessions.some((s,i) => s.start !== S.center.sessions[i].start || s.cutoff !== S.center.sessions[i].cutoff)) return err('These are already the current times. Change a time first.');
    if (!reason) return err('Give a reason. It is shown to patients in the announcement.');
    const times = S.center.sessions.map((s,i) => `${s.name} ${fmtT(sessions[i].start)}–${fmtT(sessions[i].cutoff)}`).join(', ');
    if (emergency) {
      S.center.sessions = S.center.sessions.map((s,i) => ({ ...s, ...sessions[i] }));
      const title = 'Urgent: queue cut-off changed today', body = `Starting now, queue numbers are given: ${times}. Reason: ${reason}.`;
      postAnnouncement('cutoff', title, body, true); const n = broadcast(title, body);
      return commit(`Emergency change applied now · ${n} people notified`);
    }
    if (!eff || eff < minDate) return err(`A normal change needs at least ${S.center.noticeDays} clinic day${S.center.noticeDays>1?'s':''} of notice. The earliest date is ${dateLong(minDate)}. For a real emergency, tick “Emergency”.`);
    S.pending = (S.pending || []).filter(x => x.effective !== eff); S.pending.push({ id:uid(), effective:eff, sessions, reason, created:now().date });
    const title = `Queue cut-off will change on ${dateLong(eff)}`, body = `From ${dateLong(eff)}, queue numbers will be given: ${times}. Reason: ${reason}.`;
    postAnnouncement('cutoff', title, body); const n = broadcast(title, body);
    commit(`Change scheduled for ${dateShort(eff)} · ${n} people notified`);
  },
  cutNow(fd){
    const reason = (fd.get('reason')||'').trim();
    if (!reason) { const e = $('#cnErr'); e.textContent = 'Give the reason for the emergency cut-off.'; e.classList.remove('hide'); return; }
    S.center.cutNow = { date:now().date, reason, at:nowMin() };
    const title = 'Urgent: no more queue numbers today', body = `Online queueing is closed for the rest of today. Reason: ${reason}. Patients who already have a number will still be served. For emergencies, go straight to the health center.`;
    postAnnouncement('cutoff', title, body, true); const n = broadcast(title, body);
    closeModal(); commit(`Queue closed for today · ${n} people notified`);
  },
  subscribe(fd){
    const email = (fd.get('email')||'').trim().toLowerCase(), e = $('#subErr');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { e.textContent = 'Please enter a valid email address.'; e.classList.remove('hide'); return; }
    if (SERVER.on) { const form = document.querySelector('[data-form="subscribe"]'); return guard({ email, website:'', elapsed:+fd.get('elapsed') || 0 }, form).then(body => api('/api/public/subscribe', { method:'POST', body })).then(j => { subDone = email; render(); toast(j.status === 'already' ? 'This email is already subscribed' : 'Check your email to confirm'); }).catch(err => { resetCaptcha(form); e.textContent = err.message; e.classList.remove('hide'); }); }
    S.subs = S.subs || []; if (!S.subs.includes(email)) S.subs.push(email);
    S.sms.push({ id:uid(), ts:Date.now(), date:now().date, ch:'email', to:email, tid:'', num:'ALL', text:'BKHC: You will now get email updates about schedule changes, holidays and cut-offs from the Barangay Kaligayahan Health Center.' });
    subDone = email; commit('You are subscribed');
  },
  center(fd){
    const days = fd.getAll('day').map(Number);
    if (!days.length) { toast('Choose at least one clinic day.'); return; }
    if (toMin(fd.get('close')) <= toMin(fd.get('open'))) { toast('Closing time must be later than opening time.'); return; }
    Object.assign(S.center, { open:fd.get('open'), close:fd.get('close'), lunchStart:fd.get('lunchStart'), lunchEnd:fd.get('lunchEnd'), days,
      grace:Math.min(60, Math.max(3, parseInt(fd.get('grace'),10) || 15)), force:fd.get('force'), forceNote:(fd.get('forceNote')||'').trim(), lockSite:!!fd.get('lockSite'), demo:!!fd.get('demo'),
      autoHolidays:!!fd.get('autoHolidays'), smsOn:!!fd.get('smsOn'), noticeDays:Math.min(14, Math.max(1, parseInt(fd.get('noticeDays'),10) || 1)) });
    commit('Hours saved');
  },
  services(fd){
    let told = 0;
    S.services.forEach(s => {
      const was = s.open;
      s.limit = Math.max(0, parseInt(fd.get('limit-'+s.code),10) || 0); s.walkin = Math.max(0, parseInt(fd.get('walkin-'+s.code),10) || 0); s.avg = Math.max(1, parseInt(fd.get('avg-'+s.code),10) || s.avg); s.open = !!fd.get('open-'+s.code); s.note = (fd.get('note-'+s.code)||'').trim();
      if (was && !s.open) { const title = `${s.name} is not available today`, body = `${s.note || 'This service is temporarily unavailable'}. Patients already in line, please ask at the triage desk.`; postAnnouncement('cutoff', title, body); told += broadcast(title, body); }
    });
    commit(told ? `Services saved · ${told} people notified` : 'Services saved');
  },
  restockPct(fd){
    const v = parseInt(fd.get('pct'), 10);
    if (!(v >= 5 && v <= 60)) { toast('Choose a percent from 5 to 60.'); return; }
    S.center.restockPct = v; if (!SERVER.on) { S.lastRestockMail = null; restockReminder(false); } commit(`Restock reminder set to ${v}% of full stock`);
  },
  search(fd){ searchQ = String(fd.get('q') || '').trim(); if (route() === 'search') render(); else location.hash = 'search'; },
  report(fd){
    let from = fd.get('from'), to = fd.get('to');
    if (!from || !to) { toast('Choose both dates.'); return; }
    if (from > to) [from, to] = [to, from];
    rp = { from, to, svc:fd.get('svc'), src:fd.get('src') }; render(); toast('Report updated');
  }
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  if (el.dataset.confirm && !el.dataset.armed) {
    el.dataset.armed = '1'; const old = el.innerHTML; el.textContent = el.dataset.confirm;
    setTimeout(() => { if (el.isConnected) { delete el.dataset.armed; el.innerHTML = old; } }, 3500); return;
  }
  const need = ACT_TAB[el.dataset.act];
  if (need && !can(need)) { if (el.tagName === 'A') e.preventDefault(); toast(isAdmin() ? 'Your account cannot do this.' : 'Please log in as staff.'); return; }
  const fn = A[el.dataset.act]; if (fn) { if (el.tagName === 'A') e.preventDefault(); fn(el.dataset, el, e); }
});
document.addEventListener('submit', e => {
  const f = e.target; if (!f.dataset.form || !F[f.dataset.form]) return;
  e.preventDefault();
  const need = FORM_TAB[f.dataset.form];
  if (need && !can(need)) { toast(isAdmin() ? 'Your account cannot do this.' : 'Please log in as staff.'); return; }
  if (f.dataset.sending) return;                           // already sending: ignore a double tap
  const fd = new FormData(f);
  if (fd.get('website')) return;                           // hidden field only bots fill in
  if (f.dataset.shown && ['book','medReq','subscribe'].includes(f.dataset.form)) fd.set('elapsed', String(Date.now() - +f.dataset.shown));
  f.querySelectorAll('[data-touched]').forEach(x => delete x.dataset.touched);
  const out = F[f.dataset.form](fd, f);
  if (out && typeof out.then === 'function') {             // async (server) forms: lock the button until done
    f.dataset.sending = '1'; const b = f.querySelector('[type="submit"]'); if (b) b.disabled = true;
    out.finally(() => { delete f.dataset.sending; if (b && b.isConnected) b.disabled = false; });
  }
});
document.addEventListener('input', e => {
  if (e.target.matches && e.target.matches('input, textarea, select') && e.target.closest('form')) e.target.dataset.touched = '1';
  if (e.target.id === 'medSearch') { medQ = e.target.value; $('#medBody').innerHTML = route() === 'admin' ? medAdminRows() : medListHtml(); }
  if (e.target.id === 'apSearch') { apQ = e.target.value; $('#apTable').innerHTML = apTable(apList()); }
  if (e.target.id === 'smsSearch') { smsQ = e.target.value; const pos = e.target.selectionStart; render(); const s = $('#smsSearch'); if (s) { s.focus(); s.setSelectionRange(pos,pos); } }
});
document.addEventListener('change', e => {
  const k = e.target.dataset && e.target.dataset.change; if (!k) return;
  if (k === 'medStatus') { const m = S.medicines.find(x => x.id === e.target.dataset.id); m.status = e.target.value; m.updated = now().date; commit(`${m.name} set to ${MED_ST[m.status][1].toLowerCase()}`); }
  if (k === 'dcalDoc') { dcal.doc = e.target.value; render(); const s = document.querySelector('[data-change="dcalDoc"]'); if (s) s.focus(); }
  if (k === 'apSvc') { apSvc = e.target.value; render(); }
  if (k === 'apSrc') { apSrc = e.target.value; render(); }
  if (k === 'qsvc') { flow.svc = e.target.value; render(); const s = $('#qSvcSel'); if (s) s.focus(); }
  if (k === 'userRole') {
    if (!can('users')) return;
    const u = S.users.find(x => x.id === e.target.dataset.id), next = e.target.value;
    if (u.role === 'admin' && next !== 'admin' && S.users.filter(x => x.role === 'admin').length < 2) { e.target.value = 'admin'; toast('Keep at least one administrator account.'); return; }
    if (SERVER.on) { api(`/api/staff/users/${encodeURIComponent(u.id)}/role`, { method:'POST', body:{ role:next } }).then(j => { S.users = j.users; render(); toast(`${u.name} is now: ${ROLES[next].label}. It applies at their next login.`); }).catch(err => { toast(err.message); render(); }); return; }
    u.role = next; commit(`${u.name} is now: ${ROLES[next].label}`);
  }
  if (k === 'restore') {
    if (!can('settings')) return;
    const file = e.target.files && e.target.files[0]; e.target.value = ''; if (!file) return;
    if (file.size > 20 * 1024 * 1024) { toast('That file is too big to be a backup.'); return; }
    const rd = new FileReader();
    rd.onload = () => {
      let o; try { o = JSON.parse(String(rd.result).replace(/^\uFEFF/, '')); } catch(err){ toast('This file is not a valid backup.'); return; }
      const d = o && o.data ? o.data : o;
      if (!d || d.v !== 2 || !Array.isArray(d.tickets) || !Array.isArray(d.medicines) || !Array.isArray(d.services) || !d.center) { toast('This file is not a backup from this website.'); return; }
      pendingRestore = SERVER.on ? d : sanitizeImport(d);
      openModal(`<h2>Restore this backup?</h2><p>Backup from <b>${esc(o.exported ? new Date(o.exported).toLocaleString('en-PH', { timeZone:TZ }) : 'an unknown date')}</b>: ${d.tickets.length} queue records, ${d.medicines.length} medicines, ${(d.users || []).length} staff accounts.</p>
        <div class="notice warn" style="margin:12px 0">${icon('alert')}<div>Everything currently on this device will be <b>replaced</b>. Download a backup of the current data first if you might need it.</div></div>
        <div class="btn-row"><button class="btn danger" type="button" data-act="restoreYes">Replace with this backup</button><button class="btn ghost" type="button" data-act="closeModal">Cancel</button></div>`);
    };
    rd.readAsText(file);
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('#modalRoot').innerHTML) closeModal();
  if (e.key === 'Tab' && $('#modalRoot').innerHTML) {            // keep keyboard focus inside the open dialog
    const f = [...document.querySelectorAll('#modalRoot a[href], #modalRoot button, #modalRoot input, #modalRoot select, #modalRoot textarea')].filter(x => !x.disabled && x.offsetParent !== null);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    else if (!document.querySelector('#modalRoot').contains(document.activeElement)) { e.preventDefault(); f[0].focus(); }
  }
});
// which staff section each action / form belongs to (checked against the signed-in role)
const ACT_TAB = {
  openDesk:'queue', qSvc:'queue', callNext:'queue', doneNext:'queue', done:'queue', callThis:'queue', arrived:'queue', badId:'queue', voidT:'queue', restore:'queue', recallSms:'queue', turnAway:'queue', walkin:'queue', printSlip:'queue',
  cancelT:'appts', confirm:'appts', apF:'appts',
  docEdit:'doctors', docToggle:'doctors', docDel:'doctors', docLeave:'doctors', leaveDel:'doctors',
  medAdd:'meds', medStock:'meds', medDel:'meds', medEdit:'meds', medRefill:'meds', reqSet:'meds', csvDemand:'meds', remindNow:'meds',
  annPin:'ann', annDel:'ann', subDel:'sms',
  rpQuick:'reports', csvItems:'reports', csvDaily:'reports', copyReport:'reports',
  backupNow:'settings', mailOff:'settings', backupTest:'settings', toggleXlsPw:'settings', copyText:'settings', feedKey:'settings', sysAudit:'settings',
  calNav:'settings', calDay:'settings', closureDel:'settings', cutNowAsk:'settings', cutNowUndo:'settings', pendDel:'settings', backup:'settings', restoreYes:'settings',
  userReset:'users', userDel:'users'
};
const FORM_TAB = { tsSet:'settings', mailSet:'settings', smsSet:'settings', msgTest:'settings', walkin:'queue', doc:'doctors', leave:'doctors', med:'meds', restockPct:'meds', ann:'ann', report:'reports', dateRule:'settings', cutoff:'settings', cutNow:'settings', center:'settings', services:'settings', userAdd:'users', pwChange:'account' };

function focusMain(){ window.scrollTo({ top:0 }); app.focus({ preventScroll:true }); }

function cutBanner(){
  const q = queueState();
  if (q.cut) return `<div class="cut-banner" role="status"><div class="wrap">${icon('clock','',2.6)}<div><b>${q.hard ? `Cut-off reached (${fmtT(q.at)}). All services are closed for today.` : 'All services are closed for today.'}</b> ${esc(q.hard ? `Queue numbers and requests open again ${nextOpen()}.` : q.reason + '.')}<span class="tl">Sarado na ang pila ngayong araw. Para sa emergency, pumunta agad sa health center.</span></div><a class="btn white sm" href="#emergency">Emergency?</a></div></div>`;
  if (q.open && q.until && q.left != null && q.left <= 30 && q.left > 0) return `<div class="cut-banner soon" role="status"><div class="wrap">${icon('clock','',2.6)}<div><b>Cut-off in ${q.left} minute${q.left===1?'':'s'} (${fmtT(q.until)}).</b> Get your queue number now. After that, nothing can be submitted.</div></div></div>`;
  return '';
}
function route(){
  if (PORTAL === 'staff') return 'admin';
  const r = (location.hash.slice(1) || 'home').toLowerCase();
  return r === 'admin' ? 'home' : r;
}
// Update the live page to match new HTML without rebuilding it: typed text, focus, open details,
// drawn QR codes and the map frame are kept, and nothing flickers.
function morph(from, to){
  const a = [...from.childNodes], b = [...to.childNodes];
  for (let i = 0; i < b.length; i++) {
    const o = a[i], n = b[i];
    if (!o) { from.appendChild(n); continue; }
    if (o.nodeType !== n.nodeType || o.nodeName !== n.nodeName || (o.nodeType === 1 && (o.id || n.id) && o.id !== n.id)) { from.replaceChild(n, o); continue; }
    if (o.nodeType !== 1) { if (o.nodeValue !== n.nodeValue) o.nodeValue = n.nodeValue; continue; }
    if (o.nodeName === 'IFRAME' && o.getAttribute('src') === n.getAttribute('src')) continue;
    if (o.classList.contains('cf-turnstile') && o.dataset.wid) continue;
    if (o.classList.contains('qrbox') && o.querySelector('canvas, img') && o.id === n.id) continue;
    for (const at of [...o.attributes]) if (!n.hasAttribute(at.name) && !['data-touched','data-shown','data-sending','data-wid'].includes(at.name) && !(at.name === 'open' && o.nodeName === 'DETAILS')) o.removeAttribute(at.name);
    for (const at of [...n.attributes]) if (o.getAttribute(at.name) !== at.value) o.setAttribute(at.name, at.value);
    const field = /^(INPUT|TEXTAREA|SELECT)$/.test(o.nodeName), keep = field && (o === document.activeElement || o.dataset.touched);
    if (o.nodeName !== 'TEXTAREA') morph(o, n);
    if (field && !keep) {
      if (o.type === 'checkbox' || o.type === 'radio') o.checked = n.hasAttribute('checked');
      else if (o.nodeName === 'SELECT') { const sel = n.querySelector('option[selected]') || n.querySelector('option'); if (sel) o.value = sel.getAttribute('value') ?? sel.textContent; }
      else if (o.nodeName === 'TEXTAREA') o.value = n.textContent;
      else if (o.type !== 'file') o.value = n.getAttribute('value') ?? '';
    }
  }
  for (let i = a.length - 1; i >= b.length; i--) if (a[i].parentNode === from) from.removeChild(a[i]);
}
let renderKey = '';
function render(){
  try { renderPage(); }
  catch(err){
    console.error(err);
    app.innerHTML = `<div class="wrap page"><section class="card" style="max-width:640px;margin:20px auto;text-align:center"><h1>Something went wrong on this page</h1><p class="muted">Please go back to the home page or reload. If it keeps happening, call 0963-154-1440.</p><div class="btn-row" style="justify-content:center;margin-top:12px"><a class="btn primary" href="${PORTAL === 'staff' ? 'staff' : '#home'}">Go back</a><button class="btn ghost" type="button" data-act="reload">Reload</button></div></section></div>`;
    renderKey = '';
  }
}
// the same limits the server enforces, so a too-long entry is stopped while typing
const LIMITS = [['[name="name"]',80],['[data-form="userAdd"] [name="name"]',60],['[name="title"]',150],['[name="body"]',2000],['[name="note"]',200],['[name^="note-"]',200],
  ['[name="reason"]',200],['[name="forceNote"]',200],['[name="address"]',120],['[name="email"]',120],['[name="contact"]',13],['[name="role"]:not(select)',100],
  ['[name="use"]',200],['[name="form"]:not(select)',30],['[name="q"]',100],['[name="u"]',40],['[name="p"]',200],['[name="old"]',200],['[name="pw"]',200],['[name="pw2"]',200],
  ['[name="user"]',20],['[name="code"]',12],['[name="proof"]:not(select)',80]];
const MAXNUM = [['[name="age"]',120],['[name="qty"]',1000],['[name="limit"]',1000],['[name^="limit-"]',1000],['[name^="walkin-"]',1000],['[name^="avg-"]',240],
  ['[name="grace"]',60],['[name="noticeDays"]',14],['[name="stock"]',10000000],['[name="cap"]',10000000],['[name="thr"]',10000000],['[name="freq"]',10000000],['[name="pct"]',60]];
function applyLimits(root){
  LIMITS.forEach(([s, n]) => root.querySelectorAll(`input${s}, textarea${s}`).forEach(el => { if (!el.maxLength || el.maxLength < 0 || el.maxLength > n) el.maxLength = n; }));
  MAXNUM.forEach(([s, n]) => root.querySelectorAll(`input${s}`).forEach(el => { el.max = n; if (!el.min) el.min = 0; }));
}
new MutationObserver(() => { applyLimits(app); const m = $('#modalRoot'); if (m) applyLimits(m); }).observe(document.body, { childList:true, subtree:true });
function renderPage(){
  renderFooter(); renderNav();
  const r = route();
  const V = { status:viewStatus, availability:viewDoctors, doctors:viewDoctors, medicines:viewMedicines, services:viewServices, queue:viewQueue, announcements:viewAnnouncements,
    ticket:viewTicket, contact:viewContact, emergency:viewEmergency, search:viewSearch, privacy:viewPrivacy, admin:viewAdmin };
  const locked = r !== 'admin' && r !== 'emergency' && r !== 'privacy' && siteLocked();
  const html = (r === 'admin' ? '' : cutBanner()) + (locked ? viewLocked() : V[r] ? `<div class="wrap page${r === 'admin' ? ' admin-wide' : ''}">${V[r]()}</div>` : r === 'home' ? viewHome() : viewNotFound());
  const key = r + '|' + (r === 'admin' ? adminTab + '|' + !!currentUser() : r === 'queue' ? flow.step : '');
  const fresh = key !== renderKey; renderKey = key;
  if (fresh) app.innerHTML = html;
  else { const tpl = document.createElement('template'); tpl.innerHTML = html; morph(app, tpl.content); }
  drawQR(); tickClock(); labelTables();
  app.querySelectorAll('form[data-form]').forEach(f => { if (!f.dataset.shown) f.dataset.shown = String(Date.now()); });
  mountCaptcha();
  // phones: keep the active staff section visible in the swipeable tab strip
  const sideOn = app.querySelector('.side [aria-current="page"]'), side = sideOn && sideOn.parentElement;
  if (side && side.scrollWidth > side.clientWidth) side.scrollLeft += sideOn.getBoundingClientRect().left - side.getBoundingClientRect().left - 60;
  document.body.dataset.route = r;
  if (fresh) { app.classList.remove('enter'); void app.offsetWidth; app.classList.add('enter'); }
  const titles = { home:'Home', status:'Hours & status', availability:'Health personnel', doctors:'Health personnel', medicines:'Medicines', services:'Services', queue:'Online Queue', announcements:'Announcements', ticket:'My ticket', contact:'Contact', emergency:'Emergency', search:'Search', privacy:'Privacy Notice', admin:'Staff' };
  document.title = PORTAL === 'staff' ? 'Staff portal · Kaligayahan Health Center' : `${titles[r] || 'Home'} · Kaligayahan Health Center`;
}
// re-rendering is safe while typing (the page is updated in place); only an open dialog is left alone
function busy(){ return !!$('#modalRoot').innerHTML; }
function viewNotFound(){
  return `<div class="wrap page"><section class="card" style="max-width:640px;margin:20px auto;text-align:center"><h1>Page not found<span class="tl">Hindi makita ang pahina</span></h1><p class="muted">The link may be mistyped or old.</p><div class="btn-row" style="justify-content:center;margin-top:12px"><a class="btn primary" href="#home">${icon('home')}Go to the home page</a></div></section></div>`;
}

window.addEventListener('hashchange', () => {
  if (PORTAL === 'staff') return;
  if (route() !== 'medicines') reqDone = null;
  const n = $('#nav'); if (n.classList.contains('open')) A.menu();
  render(); focusMain();
});
window.addEventListener('storage', e => { if (!SERVER.on && e.key === KEY) { load(); if (!busy()) render(); else { renderFooter(); renderNav(); } } });

applyPrefs();
// Start-up. Served by the health center server -> always use the server (keep retrying if it is
// unreachable). Opened as a file, or from a plain file server for previews -> the offline prototype.
const sleep = ms => new Promise(r => setTimeout(r, ms));
function bootScreen(msg, sub){
  app.innerHTML = `<div class="boot" role="status"><span class="boot-spin" aria-hidden="true"></span><b>${esc(msg)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</div>`;
}
async function detectServer(){
  for (let attempt = 0; ; attempt++) {
    let r = null;
    try {
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 15000);
      r = await fetch('/api/public/state?rev=-1', { headers:{ Accept:'application/json' }, cache:'no-store', signal:ctl.signal });
      clearTimeout(t);
      const json = (r.headers.get('content-type') || '').includes('application/json');
      if (json && r.ok) { const j = await r.json(); if (j && j.state) return j; }
      if (!json && r.status === 404) return null;            // a plain file server: offline prototype
    } catch(e){}
    const wait = Math.min(30, 3 * 2 ** Math.min(attempt, 4));
    bootScreen('Connecting to the health center server…', r && r.status === 429 ? `Many people are online right now. Trying again in ${wait} seconds.` : `The connection is slow or offline. Trying again in ${wait} seconds.`);
    await sleep(wait * 1000);
  }
}
async function boot(){
  if (location.protocol.startsWith('http')) {
    const first = await detectServer();
    if (first) {
      SERVER.on = true; SERVER.mail = !!first.mail; SERVER.sms = !!first.sms; SERVER.captcha = first.captcha || ''; SERVER.cloud = typeof first.cloud === 'string' ? first.cloud : (first.cloud ? 'the cloud' : '');
      if (first.serverTime) CLOCK.offset = first.serverTime.ts - Date.now();
      if (PORTAL === 'staff') {
        try { const me = await api('/api/auth/me'); setMe(me.user ? me : null); }
        catch(e){ setMe(null); if (e.status === 404) { app.innerHTML = `<div class="wrap page"><section class="card" style="max-width:560px;margin:30px auto;text-align:center"><h1>Not available here</h1><p class="muted">The staff portal only works on the health center's own computers and network.</p></section></div>`; return; } }
      }
      if (SERVER.me) { try { await pull(true); } catch(e){ applyServer(first.state, first.rev); } }
      else applyServer(first.state, first.rev);
    }
  }
  if (!SERVER.on) { load(); checkAuto(); }
  render();
  if (loadWarning) toast(loadWarning);
  startTimers();
  if (SERVER.on && !SERVER.me) refreshMine().then(() => { overlayMine(); render(); });
}
boot();
function startTimers(){
// keep every screen up to date with the server; slow down when the server is busy or unreachable
if (SERVER.on) {
  let delay = 4000, fails = 0;
  const poll = async () => {
    if (!document.hidden && !SERVER.syncing && !SERVER.pending) {
      try {
        if (await pull(false)) { if (!busy()) render(); else { renderFooter(); renderNav(); } }
        delay = 4000; fails = 0;
      } catch(e){
        fails++; delay = Math.min(60000, delay * 2);
        if (fails >= 2 && e.status !== 401) netWarning(true);
      }
    }
    setTimeout(poll, delay);
  };
  setTimeout(poll, delay);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !SERVER.syncing && !SERVER.pending) pull(false).then(ch => { if (ch && !busy()) render(); }).catch(() => {}); });
}
setInterval(tickClock, 1000);
let lastMin = now().min, lastOpen = queueState().open;
setInterval(() => {
  const changed = checkAuto(), m = now().min, q = queueState();
  if (lastOpen && !q.open && q.cut) {          // cut-off just hit
    lastOpen = false; lastMin = m;
    // residents: close the form at once. Staff: don't wipe what they are typing.
    if (route() !== 'admin') { closeModal(); flow = { step:1, prio:null, svc:flow.svc, err:'', data:{} }; render(); }
    else if (!busy()) render();
    toast('Cut-off reached. All services are now closed for today.'); return;
  }
  lastOpen = q.open;
  if (changed || m !== lastMin) { lastMin = m; if (!busy()) render(); else { renderFooter(); renderNav(); } }
}, 5000);
window.addEventListener('load', () => setTimeout(drawQR, 60));
}
// tables that update without a full render (e.g. medicine stock) get their labels too
new MutationObserver(() => labelTables()).observe(app, { childList:true, subtree:true });
// header gets a shadow once the page is scrolled
const onScroll = () => document.documentElement.classList.toggle('scrolled', scrollY > 8);
addEventListener('scroll', onScroll, { passive:true }); onScroll();
// close the phone menu with Escape
addEventListener('keydown', e => { const n = $('#nav'); if (e.key === 'Escape' && n && n.classList.contains('open')) A.menu(); });
})();
