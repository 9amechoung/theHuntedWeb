/* HUNTED 작업실 · Firebase 연결
   사이트 코드가 쓰던 저장소 모양(db · assets)을 그대로 흉내 내서 Firestore에 붙인다. */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, addDoc, updateDoc, deleteDoc, setDoc, getDoc, getDocFromCache, writeBatch
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyC-pkboBK8fh2lUOYwaVsVMwGJuKXsMJE4',
  authDomain: 'hunted-team-web.firebaseapp.com',
  projectId: 'hunted-team-web',
  storageBucket: 'hunted-team-web.firebasestorage.app',
  messagingSenderId: '294580489607',
  appId: '1:294580489607:web:1d448b94d3f490ab585722'
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// 한 번 받은 문서(이미지 포함)는 브라우저에 남겨 두고 다시 받지 않음 → 무료 사용량 절약
let fs;
try {
  fs = initializeFirestore(app, {localCache: persistentLocalCache({tabManager: persistentMultipleTabManager(), cacheSizeBytes: 200 * 1024 * 1024})});
} catch {
  fs = initializeFirestore(app, {});
}

/* ---------- 오류 코드: 사이트가 이미 아는 이름으로 바꿈 ---------- */
const CODE = {'permission-denied': 'invalid_argument', 'unauthenticated': 'invalid_argument', 'resource-exhausted': 'resource_exhausted'};
const wrapErr = e => { const x = new Error((e && e.message) || '오류'); x.code = CODE[e && e.code] || (e && e.code); return x; };
const w = p => p.catch(e => { throw wrapErr(e); });

/* ---------- db ---------- */
export const db = {
  collection: path => ({
    add: data => w(addDoc(collection(fs, path), data)),
    onSnapshot: (cb, err) => onSnapshot(collection(fs, path),
      s => cb({docs: s.docs.map(d => ({id: d.id, data: () => d.data()}))}),
      e => err && err(wrapErr(e)))
  }),
  doc: path => {
    const r = doc(fs, path);
    return {
      set: data => w(setDoc(r, data)),
      update: data => w(updateDoc(r, data)),
      delete: () => w(deleteDoc(r)),
      onSnapshot: (cb, err) => onSnapshot(r,
        s => cb({exists: s.exists(), data: () => s.data()}),
        e => err && err(wrapErr(e)))
    };
  }
};

/* ---------- 이미지: 줄여서 blobs 컬렉션에 저장 (원본 id, 목록용 id_t) ---------- */
const FULL_SIDE = 2048, FULL_MAX = 900000;   // 문서 1MB 한도 안쪽
const THUMB_SIDE = 560, THUMB_MAX = 60000;

function loadImage(file){
  return new Promise((res, rej) => {
    const u = URL.createObjectURL(file), img = new Image();
    img.onload = () => { URL.revokeObjectURL(u); res(img); };
    img.onerror = () => { URL.revokeObjectURL(u); const x = new Error('이미지를 읽지 못했어요.'); x.code = 'unsupported_type'; rej(x); };
    img.src = u;
  });
}
function encode(img, maxSide, maxChars){
  const W = img.naturalWidth, H = img.naturalHeight;
  let side = maxSide, q = 0.86;
  for (let n = 0; n < 14; n++) {
    const s = Math.min(1, side / Math.max(W, H));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(W * s)); c.height = Math.max(1, Math.round(H * s));
    const g = c.getContext('2d');
    let url = c.toDataURL('image/webp', q);
    const webp = url.startsWith('data:image/webp');
    if (!webp) { g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height); }
    g.drawImage(img, 0, 0, c.width, c.height);
    url = webp ? c.toDataURL('image/webp', q) : c.toDataURL('image/jpeg', q);
    if (url.length <= maxChars) return url;
    if (q > 0.6) q -= 0.08; else side = Math.round(side * 0.8);
  }
  const x = new Error('이미지가 너무 커요.'); x.code = 'too_large'; throw x;
}
export async function makeImage(file){
  const img = await loadImage(file);
  return {full: encode(img, FULL_SIDE, FULL_MAX), thumb: encode(img, THUMB_SIDE, THUMB_MAX)};
}
export async function putImage(id, file){
  const {full, thumb} = await makeImage(file);
  const b = writeBatch(fs), now = Date.now();
  b.set(doc(fs, 'blobs', id), {data: full, createdAt: now});
  b.set(doc(fs, 'blobs', id + '_t'), {data: thumb, createdAt: now});
  await w(b.commit());
}

export const assets = {
  async upload(file){
    const id = doc(collection(fs, 'blobs')).id;
    await putImage(id, file);
    return {id};
  },
  async delete(id){
    const b = writeBatch(fs);
    b.delete(doc(fs, 'blobs', id));
    b.delete(doc(fs, 'blobs', id + '_t'));
    await w(b.commit());
  },
  // thumb=true면 목록용 작은 이미지. 캐시에 있으면 네트워크를 쓰지 않음
  async get(id, thumb){
    const r = doc(fs, 'blobs', thumb ? id + '_t' : id);
    let s = null;
    try { s = await getDocFromCache(r); } catch {}
    if (!s || !s.exists()) s = await getDoc(r);
    if (!s.exists()) return thumb ? this.get(id, false) : null;
    return s.data().data || null;
  }
};

/* ---------- 로그인 ---------- */
// 팀원 명단 · 팀 목록은 이 계정만 고칠 수 있음 (Firestore 보안 규칙에서도 같은 이메일로 막음)
export const ADMIN_EMAIL = 'haimin@admin.km';
export const isAdminUser = u => !!(u && u.email && u.email.toLowerCase() === ADMIN_EMAIL);
export const onAuth = cb => onAuthStateChanged(auth, cb);
export const login = (email, pw) => signInWithEmailAndPassword(auth, email, pw);
export const logout = () => signOut(auth);
export const setRaw = (col, id, data) => w(setDoc(doc(fs, col, id), data));

export const AUTH_MSG = code => ({
  'auth/invalid-credential': '이메일이나 비밀번호가 맞지 않아요.',
  'auth/wrong-password': '이메일이나 비밀번호가 맞지 않아요.',
  'auth/user-not-found': '이메일이나 비밀번호가 맞지 않아요.',
  'auth/invalid-email': '이메일 형식이 맞지 않아요.',
  'auth/too-many-requests': '너무 여러 번 시도했어요. 잠시 후 다시 해 주세요.',
  'auth/network-request-failed': '인터넷 연결을 확인해 주세요.'
}[code] || '로그인하지 못했어요. 잠시 후 다시 해 주세요.');
